import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http/server";
import { createTempResourceRoot } from "./helpers/temp-root";
import { FsResourceProvider } from "../src/resources/fs-provider";
import { RuntimeHub } from "../src/ws/hub";

/**
 * 资源重命名接口（`POST /api/resources/rename`）的 HTTP 测试。
 *
 * 场景马上会变成 `Assets/scenes/<场景名>.json`：**重命名场景 = 重命名文件**，
 * 因此这里重点看「搬完内容一个字节都不变、旧 ID 立刻失效、绝不覆盖已有文件」。
 *
 * 脚手架与 `project-api.test.ts` 相同：每个用例跑在**临时资源根**上，不碰仓库 `resources/`。
 */

const PROJECT = "__测试项目__";
const SCENE_A = `project:${PROJECT}/Assets/scenes/Map001.json`;
const SCENE_B = `project:${PROJECT}/Assets/scenes/Map002.json`;

describe("资源重命名 API", () => {
  let server: Server;
  let hub: RuntimeHub;
  let baseUrl: string;
  let provider: FsResourceProvider;
  let disposeRoot: () => Promise<void>;

  beforeEach(async () => {
    const temp = await createTempResourceRoot();
    disposeRoot = temp.dispose;
    const { config } = temp;
    provider = new FsResourceProvider(config.resourceRoot, config.dirs);

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

  function rename(body: unknown, method = "POST"): Promise<Response> {
    return fetch(`${baseUrl}/api/resources/rename`, {
      method,
      ...(method === "POST"
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
  }

  function readText(id: string): Promise<Response> {
    return fetch(`${baseUrl}/api/resources/text?id=${encodeURIComponent(id)}`);
  }

  async function writeText(id: string, text: string): Promise<void> {
    const response = await fetch(`${baseUrl}/api/resources/text?id=${encodeURIComponent(id)}`, {
      method: "PUT",
      body: text,
    });
    expect(response.status).toBe(200);
  }

  it("重命名文件：新 ID 读得到且内容不变、旧 ID 404", async () => {
    await writeText(SCENE_A, '{"name":"Map001"}');

    const response = await rename({ from: SCENE_A, to: SCENE_B });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, id: SCENE_B });

    const moved = await readText(SCENE_B);
    expect(moved.status).toBe(200);
    expect(await moved.text()).toBe('{"name":"Map001"}');

    expect((await readText(SCENE_A)).status).toBe(404);
    expect(await provider.exists(SCENE_A)).toBe(false);
    expect(await provider.exists(SCENE_B)).toBe(true);
  });

  it("目标已存在返回 400，且不覆盖已有文件", async () => {
    await writeText(SCENE_A, "A");
    await writeText(SCENE_B, "B");

    const response = await rename({ from: SCENE_A, to: SCENE_B });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: `资源已存在: ${SCENE_B}`,
    });

    expect(await (await readText(SCENE_A)).text()).toBe("A");
    expect(await (await readText(SCENE_B)).text()).toBe("B");
  });

  it("源不存在返回 400", async () => {
    const response = await rename({ from: SCENE_A, to: SCENE_B });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: `资源不存在: ${SCENE_A}`,
    });
  });

  it("缺少 from / to 返回 400", async () => {
    for (const body of [{}, { from: SCENE_A }, { to: SCENE_B }, { from: "   ", to: SCENE_B }]) {
      const response = await rename(body);
      expect(response.status).toBe(400);
      expect((await response.json()) as { error: string }).toMatchObject({ error: /缺少/ });
    }
  });

  it("非法 ID 返回 400", async () => {
    const response = await rename({ from: "bogus:x", to: SCENE_B });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: /未知资源类别/ });
  });

  it("方法不对返回 405", async () => {
    const response = await rename({ from: SCENE_A, to: SCENE_B }, "GET");
    expect(response.status).toBe(405);
    expect((await response.json()) as { error: string }).toMatchObject({ error: /不支持的方法/ });
  });

  it("重命名目录：连同其下资源一起搬（章节改名场景）", async () => {
    const chapterA = `project:${PROJECT}/Assets/scenes/第一章/Map001.json`;
    const chapterB = `project:${PROJECT}/Assets/scenes/第一章/Map002.json`;
    await writeText(chapterA, "1");
    await writeText(chapterB, "2");

    const response = await rename({
      from: `project:${PROJECT}/Assets/scenes/第一章`,
      to: `project:${PROJECT}/Assets/scenes/序章`,
    });
    expect(response.status).toBe(200);

    expect(await (await readText(`project:${PROJECT}/Assets/scenes/序章/Map001.json`)).text()).toBe("1");
    expect(await (await readText(`project:${PROJECT}/Assets/scenes/序章/Map002.json`)).text()).toBe("2");
    expect((await readText(chapterA)).status).toBe(404);
    expect((await readText(chapterB)).status).toBe(404);
  });
});
