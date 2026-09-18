import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http/server";
import { createTempResourceRoot } from "./helpers/temp-root";
import { FsResourceProvider } from "../src/resources/fs-provider";
import { RuntimeHub } from "../src/ws/hub";
import { PROJECT_FILE_NAME, listProjects, projectFileId, type ResourceTreeNode } from "@dts/resources";

/**
 * 项目（一个项目 = 一个文件夹 + 一个 `project.json`）的 HTTP 接口测试。
 *
 * 每个用例跑在**临时资源根**上（不碰仓库 resources/），互不干扰。
 */

const TEST_PROJECT = "__测试项目__";

describe("项目 API", () => {
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

  function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function tree(name: string): Promise<ResourceTreeNode[]> {
    const response = await fetch(`${baseUrl}/api/projects/tree?name=${encodeURIComponent(name)}`);
    const body = (await response.json()) as { tree: ResourceTreeNode[] };
    return body.tree;
  }

  it("初始状态下没有项目（或至少不含测试项目）", async () => {
    const response = await fetch(`${baseUrl}/api/projects`);
    const body = (await response.json()) as { projects: Array<{ name: string }> };
    expect(response.status).toBe(200);
    expect(body.projects.some((item) => item.name === TEST_PROJECT)).toBe(false);
  });

  it("创建项目：生成 project.json 与标准子目录", async () => {
    const created = await postJson("/api/projects", { name: TEST_PROJECT });
    expect(created.status).toBe(201);

    const response = await fetch(`${baseUrl}/api/projects`);
    const body = (await response.json()) as {
      projects: Array<{ name: string; fileCount: number }>;
    };
    const summary = body.projects.find((item) => item.name === TEST_PROJECT);
    expect(summary?.fileCount).toBeGreaterThan(0);

    const nodes = await tree(TEST_PROJECT);
    // 项目文件是特殊文件：不作为资源出现在树里，但它确实被写出来了
    expect(nodes.some((node) => node.name === PROJECT_FILE_NAME)).toBe(false);
    expect(await provider.exists(projectFileId(TEST_PROJECT))).toBe(true);

    // 项目根只有 Assets，标准目录都在它下面（对齐 Unity 模板）
    expect(nodes.map((node) => node.name)).toEqual(["Assets"]);

    const folderNames = (nodes[0]?.children ?? [])
      .filter((node) => node.type === "folder")
      .map((node) => node.name);
    expect(folderNames).toContain("scenes");
    expect(folderNames).toContain("images");
    expect(folderNames).toContain("audio");
    // 地图只是场景里的对象、道具库存在项目文件里：不再有 maps / items 目录
    expect(folderNames).not.toContain("maps");
    expect(folderNames).not.toContain("items");
  });

  it("没有 project.json 的目录不算项目，不出现在列表里", async () => {
    await postJson("/api/projects", { name: TEST_PROJECT });
    // 直接落一个只有资源、没有 project.json 的目录
    await provider.writeText(`project:${TEST_PROJECT}残骸/maps/Map001.json`, "{}");

    const response = await fetch(`${baseUrl}/api/projects`);
    const body = (await response.json()) as { projects: Array<{ name: string }> };
    expect(body.projects.map((item) => item.name)).toEqual([TEST_PROJECT]);
  });

  it("项目文件是合法的项目文档（可被编辑器直接打开）", async () => {
    await postJson("/api/projects", { name: TEST_PROJECT });

    const id = `project:${TEST_PROJECT}/${PROJECT_FILE_NAME}`;
    const response = await fetch(`${baseUrl}/api/resources/text?id=${encodeURIComponent(id)}`);
    expect(response.status).toBe(200);

    const doc = JSON.parse(await response.text()) as {
      formatVersion: number;
      name: string;
    };
    expect(doc.formatVersion).toBe(5);
    expect(doc.name).toBe(TEST_PROJECT);
    // v3 起项目文件只带项目级数据：场景是 Assets/scenes/<场景名>.json 独立文件，不再有 scenes 数组
    expect("scenes" in doc).toBe(false);
  });

  it("重名项目返回 400（不覆盖已有项目）", async () => {
    await postJson("/api/projects", { name: TEST_PROJECT });
    const again = await postJson("/api/projects", { name: TEST_PROJECT });
    expect(again.status).toBe(400);
    expect((await again.json()) as { error: string }).toMatchObject({ error: /已存在/ });
  });

  it("非法项目名返回 400 且不落盘", async () => {
    for (const name of ["a/b", "../escape", "CON", ""]) {
      const response = await postJson("/api/projects", { name });
      expect(response.status).toBe(400);
    }

    const projects = await listProjects(provider);
    expect(projects.some((item) => item.name === TEST_PROJECT)).toBe(false);
  });

  it("新建目录后可出现在资源树里", async () => {
    await postJson("/api/projects", { name: TEST_PROJECT });

    const created = await postJson("/api/projects/folder", {
      project: TEST_PROJECT,
      path: "Assets/scenes/第一章",
    });
    expect(created.status).toBe(201);

    const nodes = await tree(TEST_PROJECT);
    const scenes = nodes[0]?.children?.find((node) => node.name === "scenes");
    expect(scenes?.children?.map((node) => node.name)).toContain("第一章");
  });

  it("非法目录路径返回 400（挡住目录穿越）", async () => {
    await postJson("/api/projects", { name: TEST_PROJECT });
    const response = await postJson("/api/projects/folder", {
      project: TEST_PROJECT,
      path: "../../escape",
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: /不允许越出项目目录/,
    });
  });

  it("上传资源 → 出现在树里 → 可删除", async () => {
    await postJson("/api/projects", { name: TEST_PROJECT });
    const id = `project:${TEST_PROJECT}/Assets/images/Map001.png`;

    const uploaded = await fetch(`${baseUrl}/api/resources/raw?id=${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: new Uint8Array([137, 80, 78, 71]).buffer,
    });
    expect(uploaded.status).toBe(200);

    const nodes = await tree(TEST_PROJECT);
    const images = nodes[0]?.children?.find((node) => node.name === "images");
    expect(images?.children?.map((node) => node.name)).toContain("Map001.png");

    const removed = await fetch(`${baseUrl}/api/resources/raw?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);

    const after = await tree(TEST_PROJECT);
    const imagesAfter = after[0]?.children?.find((node) => node.name === "images");
    expect(imagesAfter?.children ?? []).toEqual([]);
  });

  it("删除项目会连项目文件与资源一起清掉", async () => {
    await postJson("/api/projects", { name: TEST_PROJECT });
    await fetch(
      `${baseUrl}/api/resources/text?id=${encodeURIComponent(
        `project:${TEST_PROJECT}/Assets/scenes/Map001.bytes`,
      )}`,
      { method: "PUT", body: "{}" },
    );

    const removed = await fetch(
      `${baseUrl}/api/projects?name=${encodeURIComponent(TEST_PROJECT)}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect(await tree(TEST_PROJECT)).toEqual([]);
  });

  it("删除不存在的项目返回 400", async () => {
    const response = await fetch(`${baseUrl}/api/projects?name=不存在的项目`, { method: "DELETE" });
    expect(response.status).toBe(400);
  });

  it("缺少 name 参数时树接口返回 400", async () => {
    const response = await fetch(`${baseUrl}/api/projects/tree`);
    expect(response.status).toBe(400);
  });
});
