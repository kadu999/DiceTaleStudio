import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http/server";
import { createTempResourceRoot } from "./helpers/temp-root";
import { FsResourceProvider } from "../src/resources/fs-provider";
import { RuntimeHub } from "../src/ws/hub";
import type { LoadedConfig } from "../src/config";

/**
 * 资源包接口：`GET /api/resources/manifest` 与 `GET /api/resources/bundle`。
 *
 * 单测（`resources-bundle.test.ts`）量的是「包里的字节对不对」；这里量的是**HTTP 契约**：
 * 清单字段、指纹不变就 304、素材改了会重打包、超大回 413、项目不存在回 404。
 * 跑在临时资源根上，不碰仓库 `resources/`。
 */

const PROJECT = "__打包项目__";

describe("资源包 API", () => {
  let server: Server;
  let hub: RuntimeHub;
  let baseUrl: string;
  let config: LoadedConfig;
  let disposeRoot: () => Promise<void>;

  beforeEach(async () => {
    const temp = await createTempResourceRoot();
    disposeRoot = temp.dispose;
    config = temp.config;
    const provider = new FsResourceProvider(config.resourceRoot, config.dirs);

    hub = new RuntimeHub(() => {});
    server = createHttpServer({ config, provider, hub, log: () => {} });
    hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disposeRoot();
  });

  async function writeText(id: string, text: string): Promise<void> {
    const response = await fetch(`${baseUrl}/api/resources/text?id=${encodeURIComponent(id)}`, {
      method: "PUT",
      body: text,
    });
    expect(response.status).toBe(200);
  }

  async function seedProject(): Promise<void> {
    await writeText(`project:${PROJECT}/project.json`, '{"formatVersion":10}');
    await writeText(`project:${PROJECT}/Assets/images/Map001.png`, "PNG");
    await writeText(`project:${PROJECT}/Assets/audio/step1.mp3`, "MP3");
  }

  const manifestUrl = (): string =>
    `${baseUrl}/api/resources/manifest?project=${encodeURIComponent(PROJECT)}`;
  const bundleUrl = (v?: string): string =>
    `${baseUrl}/api/resources/bundle?project=${encodeURIComponent(PROJECT)}${v === undefined ? "" : `&v=${v}`}`;

  it("清单只列 Assets/ 下的文件，并给出指纹与字节数", async () => {
    await seedProject();

    const response = await fetch(manifestUrl());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      project: string;
      fingerprint: string;
      bytes: number;
      fileCount: number;
      files: Array<{ id: string; path: string; size: number }>;
    };

    expect(body.project).toBe(PROJECT);
    expect(body.fileCount).toBe(2);
    expect(body.bytes).toBe(6); // "PNG" + "MP3"
    expect(body.files.map((file) => file.path).sort()).toEqual([
      "Assets/audio/step1.mp3",
      "Assets/images/Map001.png",
    ]);
    expect(body.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("整包下载：返回 zip，响应头带指纹，包内条目与源文件一致", async () => {
    await seedProject();

    const response = await fetch(bundleUrl());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("x-dts-project")).toBe(encodeURIComponent(PROJECT));
    expect(response.headers.get("x-dts-file-count")).toBe("2");

    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04])); // PK\x03\x04
    // 包内出现两个素材名 + 清单名
    const text = bytes.toString("latin1");
    expect(text).toContain("Assets/images/Map001.png");
    expect(text).toContain("Assets/audio/step1.mp3");
    expect(text).toContain("dts-bundle.json");
  });

  it("指纹没变 → 304（客户端不必重下整包）", async () => {
    await seedProject();
    const manifest = (await (await fetch(manifestUrl())).json()) as { fingerprint: string };

    const same = await fetch(bundleUrl(manifest.fingerprint));
    expect(same.status).toBe(304);
    expect(await same.text()).toBe("");

    const stale = await fetch(bundleUrl("0000000000000000"));
    expect(stale.status).toBe(200);
  });

  it("素材改了：指纹变、缓存失效、重下拿到新内容", async () => {
    await seedProject();
    const before = (await (await fetch(manifestUrl())).json()) as { fingerprint: string };

    await writeText(`project:${PROJECT}/Assets/images/Map001.png`, "PNG-CHANGED-LONGER");
    const after = (await (await fetch(manifestUrl())).json()) as { fingerprint: string; bytes: number };
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.bytes).toBe(Buffer.byteLength("PNG-CHANGED-LONGER") + Buffer.byteLength("MP3"));

    // 拿旧指纹问：不能给 304（否则前端会一直用旧素材）
    const response = await fetch(bundleUrl(before.fingerprint));
    expect(response.status).toBe(200);

    const text = Buffer.from(await response.arrayBuffer()).toString("latin1");
    expect(text).toContain("PNG-CHANGED-LONGER");

    // 新指纹再问：这次才是 304
    expect((await fetch(bundleUrl(after.fingerprint))).status).toBe(304);
  });

  it("超过 bundle.maxTotalBytes → 413（前端据此退回逐文件）", async () => {
    await seedProject();
    (config.app as { bundle: { maxTotalBytes: number } }).bundle.maxTotalBytes = 4;

    const response = await fetch(bundleUrl());
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/超过上限/);
  });

  it("项目不存在 → 404；缺 project 参数 → 400", async () => {
    const missing = await fetch(`${baseUrl}/api/resources/bundle?project=${encodeURIComponent("没有这个项目")}`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toMatch(/不存在/);

    expect((await fetch(`${baseUrl}/api/resources/bundle`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/resources/manifest`)).status).toBe(400);
  });
});
