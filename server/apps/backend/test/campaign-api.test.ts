import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http/server";
import { createTempResourceRoot } from "./helpers/temp-root";
import { FsResourceProvider } from "../src/resources/fs-provider";
import { RuntimeHub } from "../src/ws/hub";
import { listCampaigns, type ResourceTreeNode } from "@dts/resources";

/**
 * 跑团工程（一个跑团 = 一个文件夹 + 一个工程文件）的 HTTP 接口测试。
 *
 * 每个用例跑在**临时资源根**上（不碰仓库 resources/），互不干扰。
 */

const TEST_CAMPAIGN = "__测试跑团__";

describe("跑团工程 API", () => {
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
    const response = await fetch(`${baseUrl}/api/campaigns/tree?name=${encodeURIComponent(name)}`);
    const body = (await response.json()) as { tree: ResourceTreeNode[] };
    return body.tree;
  }

  it("初始状态下没有跑团（或至少不含测试跑团）", async () => {
    const response = await fetch(`${baseUrl}/api/campaigns`);
    const body = (await response.json()) as { campaigns: Array<{ name: string }> };
    expect(response.status).toBe(200);
    expect(body.campaigns.some((item) => item.name === TEST_CAMPAIGN)).toBe(false);
  });

  it("创建跑团：生成工程文件与标准子目录", async () => {
    const created = await postJson("/api/campaigns", { name: TEST_CAMPAIGN });
    expect(created.status).toBe(201);

    const response = await fetch(`${baseUrl}/api/campaigns`);
    const body = (await response.json()) as {
      campaigns: Array<{ name: string; hasProject: boolean; fileCount: number }>;
    };
    const summary = body.campaigns.find((item) => item.name === TEST_CAMPAIGN);
    expect(summary?.hasProject).toBe(true);
    expect(summary?.fileCount).toBeGreaterThan(0);

    const nodes = await tree(TEST_CAMPAIGN);
    const projectFile = nodes.find((node) => node.name === `${TEST_CAMPAIGN}.dtproj.json`);
    expect(projectFile?.type).toBe("file");

    // 标准子目录（map / images/maps 等）应当已经存在，即使是空的
    const folderNames = nodes.filter((node) => node.type === "folder").map((node) => node.name);
    expect(folderNames).toContain("maps");
    expect(folderNames).toContain("images");
    expect(folderNames).toContain("items");
  });

  it("工程文件是合法的项目文档（可被编辑器直接打开）", async () => {
    await postJson("/api/campaigns", { name: TEST_CAMPAIGN });

    const id = `campaign:${TEST_CAMPAIGN}/${TEST_CAMPAIGN}.dtproj.json`;
    const response = await fetch(`${baseUrl}/api/resources/text?id=${encodeURIComponent(id)}`);
    expect(response.status).toBe(200);

    const doc = JSON.parse(await response.text()) as {
      formatVersion: number;
      name: string;
      maps: unknown[];
    };
    expect(doc.formatVersion).toBe(1);
    expect(doc.name).toBe(TEST_CAMPAIGN);
    expect(doc.maps).toEqual([]);
  });

  it("重名跑团返回 400（不覆盖已有工程）", async () => {
    await postJson("/api/campaigns", { name: TEST_CAMPAIGN });
    const again = await postJson("/api/campaigns", { name: TEST_CAMPAIGN });
    expect(again.status).toBe(400);
    expect((await again.json()) as { error: string }).toMatchObject({ error: /已存在/ });
  });

  it("非法跑团名返回 400 且不落盘", async () => {
    for (const name of ["a/b", "../escape", "CON", ""]) {
      const response = await postJson("/api/campaigns", { name });
      expect(response.status).toBe(400);
    }

    const campaigns = await listCampaigns(provider);
    expect(campaigns.some((item) => item.name === TEST_CAMPAIGN)).toBe(false);
  });

  it("新建目录后可出现在资源树里", async () => {
    await postJson("/api/campaigns", { name: TEST_CAMPAIGN });

    const created = await postJson("/api/campaigns/folder", {
      campaign: TEST_CAMPAIGN,
      path: "maps/第一章",
    });
    expect(created.status).toBe(201);

    const nodes = await tree(TEST_CAMPAIGN);
    const maps = nodes.find((node) => node.name === "maps");
    expect(maps?.children?.map((node) => node.name)).toContain("第一章");
  });

  it("非法目录路径返回 400（挡住目录穿越）", async () => {
    await postJson("/api/campaigns", { name: TEST_CAMPAIGN });
    const response = await postJson("/api/campaigns/folder", {
      campaign: TEST_CAMPAIGN,
      path: "../../escape",
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: /不允许越出跑团目录/,
    });
  });

  it("上传资源 → 出现在树里 → 可删除", async () => {
    await postJson("/api/campaigns", { name: TEST_CAMPAIGN });
    const id = `campaign:${TEST_CAMPAIGN}/images/maps/Map001.png`;

    const uploaded = await fetch(`${baseUrl}/api/resources/raw?id=${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: new Uint8Array([137, 80, 78, 71]).buffer,
    });
    expect(uploaded.status).toBe(200);

    const nodes = await tree(TEST_CAMPAIGN);
    const images = nodes.find((node) => node.name === "images");
    expect(images?.children?.map((node) => node.name)).toContain("maps");

    const removed = await fetch(`${baseUrl}/api/resources/raw?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);

    const after = await tree(TEST_CAMPAIGN);
    const imagesAfter = after.find((node) => node.name === "images");
    const mapsAfter = imagesAfter?.children?.find((node) => node.name === "maps");
    expect(mapsAfter?.children ?? []).toEqual([]);
  });

  it("删除跑团会连工程与资源一起清掉", async () => {
    await postJson("/api/campaigns", { name: TEST_CAMPAIGN });
    await fetch(
      `${baseUrl}/api/resources/text?id=${encodeURIComponent(
        `campaign:${TEST_CAMPAIGN}/maps/Map001.json`,
      )}`,
      { method: "PUT", body: "{}" },
    );

    const removed = await fetch(
      `${baseUrl}/api/campaigns?name=${encodeURIComponent(TEST_CAMPAIGN)}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect(await tree(TEST_CAMPAIGN)).toEqual([]);
  });

  it("删除不存在的跑团返回 400", async () => {
    const response = await fetch(`${baseUrl}/api/campaigns?name=不存在的团`, { method: "DELETE" });
    expect(response.status).toBe(400);
  });

  it("缺少 name 参数时树接口返回 400", async () => {
    const response = await fetch(`${baseUrl}/api/campaigns/tree`);
    expect(response.status).toBe(400);
  });
});
