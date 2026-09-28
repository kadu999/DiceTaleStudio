import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectAssetId } from "@dts/resources";
import sharp from "sharp";
import { createHttpServer } from "../src/http/server";
import { createTempResourceRoot } from "./helpers/temp-root";
import type { LoadedConfig } from "../src/config";
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
  let config: LoadedConfig;
  let disposeRoot: () => Promise<void>;
  let realFetch: typeof globalThis.fetch;
  let pngBase64: string;
  let calls: { url: string; init: RequestInit | undefined }[];
  let response: () => Response;

  beforeEach(async () => {
    const temp = await createTempResourceRoot();
    disposeRoot = temp.dispose;
    config = temp.config;
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

    // 地址 / 模型 / 密钥现在都从配置来（临时根没有 app.json，这里直接给配置对象）
    config.app.imageGen.platforms.volcengine = {
      baseUrl: API_BASE,
      model: "doubao-seedream-4-0-250828",
      apiKey: "__Key__",
    };
    config.app.imageGen.platforms.openai = {
      baseUrl: API_BASE,
      model: "gpt-image-1",
      apiKey: "__Key__",
    };

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
    delete process.env.DTS_IMAGE_PLATFORM;
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

  it("发给供应商的请求：OpenAI 兼容的 URL / body 与 Bearer 密钥（默认火山 Seedream：带 response_format）", async () => {
    await generate({ project: PROJECT, prompt: "一把旧钥匙", size: "512x512" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(GENERATIONS_URL);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer __Key__");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      model: "doubao-seedream-4-0-250828",
      prompt: "一把旧钥匙",
      size: "512x512",
      n: 1,
      // 平台配置里的 extraBody：Seedream 靠它直接回 b64（省一次下载），并关掉默认水印
      response_format: "b64_json",
      watermark: false,
    });
  });

  it("切到 openai 平台：请求体回到最小形状（不带 Seedream 的额外字段）", async () => {
    process.env.DTS_IMAGE_PLATFORM = "openai";
    await generate({ project: PROJECT, prompt: "一把旧钥匙", size: "512x512" });

    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      model: "gpt-image-1",
      prompt: "一把旧钥匙",
      size: "512x512",
      n: 1,
    });
  });

  it("Seedream 的尺寸档位（`2K`）被接受；openai 平台不认它", async () => {
    const ok = await generate({ project: PROJECT, prompt: "海边的灯塔", size: "2K" });
    expect(ok.status).toBe(200);
    expect(calls).toHaveLength(1);

    process.env.DTS_IMAGE_PLATFORM = "openai";
    const rejected = await generate({ project: PROJECT, prompt: "海边的灯塔", size: "2K" });
    expect(rejected.status).toBe(400);
    expect(calls).toHaveLength(1);
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

  it("供应商回 JPEG（火山 Seedream 就是这样）：统一转成 PNG 落盘", async () => {
    const jpegBase64 = (
      await sharp({
        create: { width: 16, height: 12, channels: 3, background: { r: 10, g: 120, b: 200 } },
      })
        .jpeg()
        .toBuffer()
    ).toString("base64");

    response = () =>
      new Response(JSON.stringify({ data: [{ b64_json: jpegBase64 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const res = await generate({ project: PROJECT, prompt: "一盏台灯" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; path: string };

    // 落盘的那份一定是 PNG（后缀 .png + 真正的 PNG 魔数）
    const raw = await fetch(`${baseUrl}/api/resources/raw?id=${encodeURIComponent(body.id)}`);
    expect(raw.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await raw.arrayBuffer());
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("图生图 / 修图：给项目内素材 ID，后端读它的字节并当输入图发给平台", async () => {
    // 先在项目里放一张「原图」
    const seed = projectAssetId(PROJECT, "Assets/images/seed.png");
    const seedBytes = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
    })
      .png()
      .toBuffer();
    await provider.writeBinary(
      seed,
      seedBytes.buffer.slice(seedBytes.byteOffset, seedBytes.byteOffset + seedBytes.byteLength) as ArrayBuffer,
    );

    const res = await generate({
      project: PROJECT,
      prompt: "把它改成蓝色",
      size: "512x512",
      inputImages: [seed],
    });
    expect(res.status).toBe(200);

    // 发出去的 body 里带上了原图的 data URI（火山 Seedream 的形状）
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(Array.isArray(body.image)).toBe(true);
    expect(String((body.image as string[])[0])).toMatch(/^data:image\/png;base64,/);
  });

  it("输入图不存在 / 不是图片 / 不属于本项目：404 或 400，且一个请求都不发", async () => {
    const missing = await generate({
      project: PROJECT,
      prompt: "x",
      inputImages: [projectAssetId(PROJECT, "Assets/images/nope.png")],
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toMatch(/输入图不存在/);

    const notImage = await generate({
      project: PROJECT,
      prompt: "x",
      inputImages: [projectAssetId(PROJECT, "project.json")],
    });
    expect(notImage.status).toBe(400);
    expect(((await notImage.json()) as { error: string }).error).toMatch(/图片格式/);

    const foreign = await generate({
      project: PROJECT,
      prompt: "x",
      inputImages: ["project:别的项目/Assets/images/a.png"],
    });
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as { error: string }).error).toMatch(/不属于当前项目/);

    expect(calls).toHaveLength(0);
  });

  it("蒙版局部重绘：切到支持蒙版的 openai，mask 作为 multipart 文件发出去；火山不支持则 400", async () => {
    // 底图 + 蒙版两张素材
    const seed = projectAssetId(PROJECT, "Assets/images/seed.png");
    const maskId = projectAssetId(PROJECT, "Assets/images/mask.png");
    const bytes = async (): Promise<ArrayBuffer> => {
      const b = await sharp({
        create: { width: 8, height: 8, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
      })
        .png()
        .toBuffer();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    };
    await provider.writeBinary(seed, await bytes());
    await provider.writeBinary(maskId, await bytes());

    // 火山平台不声明 supportsMask：带 mask → 400，且不发请求
    const volcRejected = await generate({
      project: PROJECT,
      prompt: "只重画这块",
      inputImages: [seed],
      mask: maskId,
    });
    expect(volcRejected.status).toBe(400);
    expect(((await volcRejected.json()) as { error: string }).error).toMatch(/蒙版/);
    expect(calls).toHaveLength(0);

    // 切到 openai：mask 走 /images/edits 的 multipart
    process.env.DTS_IMAGE_PLATFORM = "openai";
    const accepted = await generate({
      project: PROJECT,
      prompt: "只重画这块",
      inputImages: [seed],
      mask: maskId,
    });
    expect(accepted.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.endsWith("/images/edits")).toBe(true);
    const form = calls[0]!.init?.body;
    expect(form).toBeInstanceOf(FormData);
    const fields = [...(form as FormData).entries()].map(([key]) => key);
    expect(fields).toContain("mask");
  });

  it("抠背景：请求里带 removeBackground，落盘的 PNG 有透明像素", async () => {
    // 白底 + 中间一块红：抠掉四角的白
    const white = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 0, b: 0 } },
          })
            .png()
            .toBuffer(),
          left: 6,
          top: 6,
        },
      ])
      .png()
      .toBuffer();

    response = () =>
      new Response(JSON.stringify({ data: [{ b64_json: white.toString("base64") }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const res = await generate({ project: PROJECT, prompt: "一个红色方块", removeBackground: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };

    const raw = await fetch(`${baseUrl}/api/resources/raw?id=${encodeURIComponent(body.id)}`);
    const out = await sharp(Buffer.from(await raw.arrayBuffer()))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, channels } = out.info;
    // 角上是背景 → 透明；中心是主体 → 不透明
    expect(out.data[3]).toBe(0);
    const center = (10 * width + 10) * channels + 3;
    expect(out.data[center]).toBe(255);
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

  it("没配密钥：明确 400 说清缺什么，不发请求", async () => {
    config.app.imageGen.platforms.volcengine = {
      baseUrl: API_BASE,
      model: "doubao-seedream-4-0-250828",
      apiKey: "",
    };

    const res = await generate({ project: PROJECT, prompt: "一把旧钥匙" });
    expect(res.status).toBe(400);
    const message = ((await res.json()) as { error: string }).error;
    expect(message).toMatch(/apiKey/);
    expect(message).toMatch(/没配好/);
    expect(calls).toHaveLength(0);
  });

  it("没配地址 / 模型（部署参数只在配置里）：同样 400，不发请求", async () => {
    config.app.imageGen.platforms.volcengine = {
      baseUrl: "",
      model: "doubao-seedream-4-0-250828",
      apiKey: "__Key__",
    };
    const noBase = await generate({ project: PROJECT, prompt: "一把旧钥匙" });
    expect(noBase.status).toBe(400);
    expect(((await noBase.json()) as { error: string }).error).toMatch(/baseUrl/);

    config.app.imageGen.platforms.volcengine = {
      baseUrl: API_BASE,
      model: "",
      apiKey: "__Key__",
    };
    const noModel = await generate({ project: PROJECT, prompt: "一把旧钥匙" });
    expect(noModel.status).toBe(400);
    expect(((await noModel.json()) as { error: string }).error).toMatch(/model/);

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
