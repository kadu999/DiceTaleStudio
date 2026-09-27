import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectAssetId } from "@dts/resources";
import sharp from "sharp";
import { createHttpServer } from "../src/http/server";
import { createTempResourceRoot } from "./helpers/temp-root";
import { FsResourceProvider } from "../src/resources/fs-provider";
import { RuntimeHub } from "../src/ws/hub";

/**
 * AI 生图接口（`POST /api/tools/generate-image`）的 HTTP 测试。
 *
 * 这里**不出网**：`fetch` 被替换成「拦下生图那家的地址、其余原样转发（测试自己的请求要能用）」。
 * 于是可以逐字断言「发给供应商的 body 与头是什么」，也可以让它回 401 / 坏 JSON / 只给 url。
 *
 * 重点看四件事：**图真的落成项目素材**（连 meta 的 GUID 一起回）、**密钥不下发**、
 * **没配密钥时明确 400**、**供应商出错时是 502 而不是 500**。
 */

const PROJECT = "__生图测试__";
const API_BASE = "https://api.test/v1";
const GENERATIONS_URL = `${API_BASE}/images/generations`;

describe("AI 生图 API", () => {
  let server: Server;
  let hub: RuntimeHub;
  let baseUrl: string;
  let provider: FsResourceProvider;
  let disposeRoot: () => Promise<void>;
  let realFetch: typeof globalThis.fetch;
  let pngBase64: string;
  let calls: { url: string; init: RequestInit | undefined }[];
  let response: () => Response;

  beforeEach(async () => {
    const temp = await createTempResourceRoot();
    disposeRoot = temp.dispose;
    const { config } = temp;
    provider = new FsResourceProvider(config.resourceRoot, config.dirs);

    // 夹具：一张真 PNG（路由要用 sharp 读它的宽高，写盘的也得是真图）
    pngBase64 = (
      await sharp({
        create: { width: 8, height: 6, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
      })
        .png()
        .toBuffer()
    ).toString("base64");

    calls = [];
    response = () =>
      new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(API_BASE)) {
        calls.push({ url, init });
        return Promise.resolve(response());
      }

      return realFetch(input as RequestInfo, init);
    });

    process.env.DTS_IMAGE_API_BASE = API_BASE;
    process.env.DTS_IMAGE_API_KEY = "__Key__";

    hub = new RuntimeHub(() => {});
    server = createHttpServer({ config, provider, hub, log: () => {} });
    hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // 项目得先存在（路由会查 project.json，免得凭空造出一个空项目）
    await provider.writeText(projectAssetId(PROJECT, "project.json"), '{"name":"x"}');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.DTS_IMAGE_API_BASE;
    delete process.env.DTS_IMAGE_API_KEY;
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disposeRoot();
  });

  function generate(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/tools/generate-image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("画一张并**落成项目素材**：回 id / path / guid / 宽高，盘上有文件、meta 有 GUID", async () => {
    const res = await generate({ project: PROJECT, prompt: "一把旧钥匙", size: "512x512" });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      id: string;
      path: string;
      guid: string;
      width: number;
      height: number;
    };

    expect(body.path.startsWith("Assets/images/generated/")).toBe(true);
    expect(body.path.endsWith(".png")).toBe(true);
    expect(body.id).toBe(projectAssetId(PROJECT, body.path));
    expect(body.guid).toMatch(/^[0-9a-f]{32}$/);
    expect(body.width).toBe(8);
    expect(body.height).toBe(6);

    // 盘上真的有这份素材，而且读得回来是一张 PNG
    expect(await provider.exists(body.id)).toBe(true);
    const raw = await fetch(`${baseUrl}/api/resources/raw?id=${encodeURIComponent(body.id)}`);
    expect(raw.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await raw.arrayBuffer()).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    // meta 也落了一份（身份跟着素材走）
    const meta = await fetch(
      `${baseUrl}/api/resources/text?id=${encodeURIComponent(`${body.id}.meta`)}`,
    );
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { guid: string }).guid).toBe(body.guid);
  });

  it("发给供应商的请求：OpenAI 兼容的 URL / body 与 Bearer 密钥", async () => {
    await generate({ project: PROJECT, prompt: "一把旧钥匙", size: "512x512" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(GENERATIONS_URL);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer __Key__");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      model: "gpt-image-1",
      prompt: "一把旧钥匙",
      size: "512x512",
      n: 1,
    });
  });

  it("供应商只回 url（Dall·E 那种）：照样下载下来存成素材", async () => {
    response = () =>
      new Response(JSON.stringify({ data: [{ url: "https://cdn.test/a.png" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    // 图片地址走的是另一台主机：也拦下来（否则测试会真的出网）
    const passthrough = realFetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://cdn.test/")) {
        return Promise.resolve(
          new Response(Buffer.from(pngBase64, "base64"), { headers: { "content-type": "image/png" } }),
        );
      }

      if (url.startsWith(API_BASE)) {
        calls.push({ url, init });
        return Promise.resolve(response());
      }

      return passthrough(input as RequestInfo, init);
    });

    const res = await generate({ project: PROJECT, prompt: "海边的灯塔" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { width: number }).width).toBe(8);
  });

  it("尺寸 / 提示词：空提示词与非法尺寸都是 400，且**一个请求都没发出去**", async () => {
    const empty = await generate({ project: PROJECT, prompt: "   " });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toMatch(/提示词/);

    const badSize = await generate({ project: PROJECT, prompt: "x", size: "很大" });
    expect(badSize.status).toBe(400);
    expect(((await badSize.json()) as { error: string }).error).toMatch(/宽x高/);

    expect(calls).toHaveLength(0);
  });

  it("没配密钥：明确 400 说清怎么配，不发请求", async () => {
    delete process.env.DTS_IMAGE_API_KEY;

    const res = await generate({ project: PROJECT, prompt: "一把旧钥匙" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/DTS_IMAGE_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it("项目不存在：404，不去调供应商", async () => {
    const res = await generate({ project: "__没有这个项目__", prompt: "一把旧钥匙" });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("供应商出错（401）：502 并把它的原话带出来（不是 500「内部错误」）", async () => {
    response = () =>
      new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });

    const res = await generate({ project: PROJECT, prompt: "一把旧钥匙" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/Incorrect API key/);
  });

  it("`name` 只当文件名：路径分隔符被清洗掉，还是落在配置的输出目录里", async () => {
    const res = await generate({ project: PROJECT, prompt: "x", name: "../../evil" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe("Assets/images/generated/evil.png");
  });
});
