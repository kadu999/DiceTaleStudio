import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import * as pathApi from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http/server";
import { createTempResourceRoot } from "./helpers/temp-root";
import { FsResourceProvider } from "../src/resources/fs-provider";
import type { LoadedConfig } from "../src/config";
import { RuntimeHub } from "../src/ws/hub";
import { PROJECT_FILE_NAME, assetMetaIdOf, listProjects, projectAssetId, projectFileId, type ResourceTreeNode } from "@dts/resources";
import { DOCUMENT_FORMAT_VERSION } from "@dts/document";

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
  let config: LoadedConfig;
  let root: string;
  /** 被「打开」的目录（真的去调系统命令会弹资源管理器窗口，所以整条链路都注入假的）。 */
  let openedFolders: string[];
  /** 被要求「选中」的文件（`selectFile` 为真时）。 */
  let selectedFiles: (string | undefined)[];
  let failNextOpen: boolean;

  beforeEach(async () => {
    const temp = await createTempResourceRoot();
    disposeRoot = temp.dispose;
    config = temp.config;
    root = temp.root;
    provider = new FsResourceProvider(config.resourceRoot, config.dirs);

    openedFolders = [];
    selectedFiles = [];
    failNextOpen = false;

    hub = new RuntimeHub(() => {});
    server = createHttpServer({
      config,
      provider,
      hub,
      log: () => {},
      openFolder: async (folder, selectFile) => {
        if (failNextOpen) {
          failNextOpen = false;
          throw new Error("没有可用的文件管理器");
        }

        openedFolders.push(folder);
        selectedFiles.push(selectFile);
      },
    });
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

  it("素材 meta：一个项目一次拿全，坏 meta 跳过但单独列出来，`.meta` 不进资源树", async () => {
    await postJson("/api/projects", { name: TEST_PROJECT });
    const imageId = projectAssetId(TEST_PROJECT, "Assets/images/A.png");
    const guid = "a".repeat(32);
    await provider.writeText(imageId, "png");
    await provider.writeText(
      assetMetaIdOf(imageId),
      JSON.stringify({ formatVersion: 1, guid, importer: "texture" }),
    );

    // 坏 JSON：跳过（并记一条日志），不该把整次加载打掉
    const brokenId = projectAssetId(TEST_PROJECT, "Assets/images/B.png");
    await provider.writeText(brokenId, "png");
    await provider.writeText(assetMetaIdOf(brokenId), "{ 这不是 JSON");

    const response = await fetch(`${baseUrl}/api/projects/meta?name=${encodeURIComponent(TEST_PROJECT)}`);
    const body = (await response.json()) as {
      metas: Record<string, unknown>;
      unreadable: string[];
    };
    expect(response.status).toBe(200);
    // 键是**素材**的逻辑 ID（不是 meta 文件自己的 ID）
    expect(Object.keys(body.metas)).toEqual([imageId]);
    expect(body.metas[imageId]).toMatchObject({ guid, importer: "texture" });

    /*
      读不出来的那一份要**单独列出来**：调用方据此知道「盘上有 meta、只是读不懂」——
      不列的话它跟「压根没有 meta」长得一样，调用方会给它补一份新 meta（新 GUID），
      把用户盘上那份盖掉、引用旧 GUID 的地方一起断。
    */
    expect(body.unreadable).toEqual([brokenId]);

    // meta 是元数据：资源树里看不到它，但按 ID 读得到（写 meta 走的就是资源接口）
    const nodes = await tree(TEST_PROJECT);
    const images = nodes[0]?.children?.find((node) => node.name === "images");
    expect((images?.children ?? []).map((node) => node.name).sort()).toEqual(["A.png", "B.png"]);
    expect(await provider.exists(assetMetaIdOf(imageId))).toBe(true);
  });

  it("按 GUID 返回素材当前的逻辑 ID 和项目相对路径", async () => {
    await postJson("/api/projects", { name: TEST_PROJECT });
    const imageId = projectAssetId(TEST_PROJECT, "Assets/images/Renamed.png");
    const guid = "c".repeat(32);
    await provider.writeText(imageId, "image");
    await provider.writeText(
      assetMetaIdOf(imageId),
      JSON.stringify({ formatVersion: 1, guid, importer: "texture" }),
    );

    const response = await fetch(
      `${baseUrl}/api/projects/asset?name=${encodeURIComponent(TEST_PROJECT)}&guid=${guid}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      guid,
      id: imageId,
      path: "Assets/images/Renamed.png",
    });
  });

  it("GUID 形状不合法时返回 400，不存在时返回 404", async () => {
    await postJson("/api/projects", { name: TEST_PROJECT });
    const malformed = await fetch(
      `${baseUrl}/api/projects/asset?name=${encodeURIComponent(TEST_PROJECT)}&guid=not-a-guid`,
    );
    expect(malformed.status).toBe(400);

    const missing = await fetch(
      `${baseUrl}/api/projects/asset?name=${encodeURIComponent(TEST_PROJECT)}&guid=${"d".repeat(32)}`,
    );
    expect(missing.status).toBe(404);
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
    expect(doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
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

  describe("打开项目目录（/api/projects/reveal）", () => {
    // 真的去调系统命令会在跑测试的机器上弹出资源管理器，所以注入假的、只记下被打开的路径
    it("打开已存在的项目：路径由服务端按配置拼出，且落在该项目目录上", async () => {
      await postJson("/api/projects", { name: TEST_PROJECT });

      const response = await postJson("/api/projects/reveal", { name: TEST_PROJECT });
      expect(response.status).toBe(200);

      const body = (await response.json()) as { path: string };
      expect(openedFolders).toEqual([body.path]);

      // 路径必须是「资源根 / projects / 项目名」，而不是客户端说去哪儿就去哪儿
      const expected = pathApi.join(root, config.dirs.project, TEST_PROJECT);
      expect(pathApi.resolve(body.path)).toBe(pathApi.resolve(expected));
    });

    it("项目不存在返回 404，且不会去打开任何目录", async () => {
      const response = await postJson("/api/projects/reveal", { name: "不存在的项目" });
      expect(response.status).toBe(404);
      expect(openedFolders).toEqual([]);
    });

    it("项目名非法（含路径分隔符 / 穿越）返回 400，绝不越出资源根", async () => {
      for (const name of ["../escape", "a/b", "a\\b", "", "  "]) {
        const response = await postJson("/api/projects/reveal", { name });
        expect(response.status).toBe(400);
      }

      expect(openedFolders).toEqual([]);
    });

    it("非 POST 返回 405", async () => {
      const response = await fetch(`${baseUrl}/api/projects/reveal`);
      expect(response.status).toBe(405);
      expect(openedFolders).toEqual([]);
    });

    it("系统打不开目录时如实报错（不是「点了没反应」）", async () => {
      await postJson("/api/projects", { name: TEST_PROJECT });

      // 让注入的实现失败一次
      failNextOpen = true;
      const response = await postJson("/api/projects/reveal", { name: TEST_PROJECT });
      expect(response.status).toBe(500);
      expect((await response.json()) as { error: string }).toMatchObject({
        error: /没有可用的文件管理器/,
      });
    });

    it("带 path 时打开的是**项目内的那一层**（资源面板选中的目录）", async () => {
      await postJson("/api/projects", { name: TEST_PROJECT });

      const response = await postJson("/api/projects/reveal", {
        name: TEST_PROJECT,
        path: "Assets/images",
      });
      expect(response.status).toBe(200);

      const expected = pathApi.join(root, config.dirs.project, TEST_PROJECT, "Assets", "images");
      expect(pathApi.resolve(openedFolders[0] ?? "")).toBe(pathApi.resolve(expected));
      expect(selectedFiles).toEqual([undefined]);
    });

    it("selectFile 指向存在的文件时：打开它所在的目录并选中它", async () => {
      await postJson("/api/projects", { name: TEST_PROJECT });
      await fetch(`${baseUrl}/api/resources/raw?id=${encodeURIComponent(`project:${TEST_PROJECT}/Assets/images/Map001.png`)}`, {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: Buffer.from([137, 80, 78, 71]),
      });

      const response = await postJson("/api/projects/reveal", {
        name: TEST_PROJECT,
        path: "Assets/images/Map001.png",
        selectFile: true,
      });
      expect(response.status).toBe(200);

      const file = pathApi.join(
        root,
        config.dirs.project,
        TEST_PROJECT,
        "Assets",
        "images",
        "Map001.png",
      );
      expect(pathApi.resolve(selectedFiles[0] ?? "")).toBe(pathApi.resolve(file));
      // 打开的是它所在的目录（explorer 的 `/select,` 会自己把窗口定位到那个文件）
      expect(pathApi.resolve(openedFolders[0] ?? "")).toBe(pathApi.resolve(pathApi.dirname(file)));
    });

    it("selectFile 指向目录时按打开目录处理（不给 explorer 传一个目录去选中）", async () => {
      await postJson("/api/projects", { name: TEST_PROJECT });

      const response = await postJson("/api/projects/reveal", {
        name: TEST_PROJECT,
        path: "Assets/images",
        selectFile: true,
      });
      expect(response.status).toBe(200);
      expect(selectedFiles).toEqual([undefined]);
    });

    it("selectFile 指向不存在的文件返回 404，且不会去打开任何目录", async () => {
      await postJson("/api/projects", { name: TEST_PROJECT });

      const response = await postJson("/api/projects/reveal", {
        name: TEST_PROJECT,
        path: "Assets/images/没有这个文件.png",
        selectFile: true,
      });
      expect(response.status).toBe(404);
      expect(openedFolders).toEqual([]);
    });

    it("path 试图越出项目目录时返回 400，绝不越出", async () => {
      await postJson("/api/projects", { name: TEST_PROJECT });

      const escaped = ["../别的项目", "Assets/../..", "Assets/images/..", "/abs", "a//b"];
      for (const path of escaped) {
        const response = await postJson("/api/projects/reveal", { name: TEST_PROJECT, path });
        expect([path, response.status]).toEqual([path, 400]);
      }

      expect(openedFolders).toEqual([]);
    });
  });
});
