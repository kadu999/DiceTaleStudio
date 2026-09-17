import { describe, expect, it } from "vitest";
import {
  buildResourceTree,
  belongsToCampaign,
  createCampaign,
  deleteCampaign,
  listCampaigns,
  readCampaignEntries,
  readCampaignProject,
  validateCampaignName,
  validateCampaignRelativePath,
} from "../src/campaign";
import { campaignMapImageId, campaignMapId, campaignProjectId, DEFAULT_CAMPAIGN_FOLDERS } from "../src/ids";
import { createMemoryResourceProvider } from "../src/memory";

const LAYOUT = { folders: DEFAULT_CAMPAIGN_FOLDERS, project: { formatVersion: 1, kind: "test" } };

describe("跑团名校验（会直接成为文件夹名）", () => {
  it("接受正常名字（含中文、空格、点、连字符）", () => {
    for (const name of ["我的跑团", "Curse of Strahd", "run-01", "v1.2 模组"]) {
      expect(validateCampaignName(name)).toBeUndefined();
    }
  });

  it("拒绝空名字与首尾空白", () => {
    expect(validateCampaignName("")).toMatch(/不能为空/);
    expect(validateCampaignName("   ")).toMatch(/不能为空/);
    expect(validateCampaignName(" x")).toMatch(/首尾不能有空白/);
    expect(validateCampaignName("x ")).toMatch(/首尾不能有空白/);
  });

  it("拒绝路径分隔符与 Windows 非法字符", () => {
    for (const name of ["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b"]) {
      expect(validateCampaignName(name)).toMatch(/不能包含/);
    }
  });

  it("拒绝 . 与 .. 以及系统保留名", () => {
    expect(validateCampaignName(".")).toMatch(/不合法/);
    expect(validateCampaignName("..")).toMatch(/不合法/);
    for (const name of ["CON", "nul", "Com1", "LPT9"]) {
      expect(validateCampaignName(name)).toMatch(/保留名/);
    }
  });

  it("拒绝超长名字", () => {
    expect(validateCampaignName("x".repeat(65))).toMatch(/64/);
  });
});

describe("跑团内相对路径校验", () => {
  it("接受多级正常路径", () => {
    expect(validateCampaignRelativePath("maps/Map001.json")).toBeUndefined();
    expect(validateCampaignRelativePath("images/maps")).toBeUndefined();
  });

  it("拒绝越界、空段与非法段", () => {
    expect(validateCampaignRelativePath("")).toMatch(/不能为空/);
    expect(validateCampaignRelativePath("../x")).toMatch(/不允许越出/);
    expect(validateCampaignRelativePath("a/../../b")).toMatch(/不允许越出/);
    expect(validateCampaignRelativePath("/abs")).toMatch(/不允许越出/);
    expect(validateCampaignRelativePath("a//b")).toMatch(/空的目录名/);
    expect(validateCampaignRelativePath("a/con/b")).toMatch(/保留名/);
  });
});

describe("创建 / 打开 / 删除跑团", () => {
  it("创建跑团：写入工程文件并建立标准子目录", async () => {
    const provider = createMemoryResourceProvider();
    await createCampaign(provider, "我的跑团", LAYOUT);

    const projectId = campaignProjectId("我的跑团");
    expect(await provider.exists(projectId)).toBe(true);
    expect(JSON.parse(await readCampaignProject(provider, "我的跑团"))).toEqual(LAYOUT.project);

    const folders = provider.listFolders();
    expect(folders).toContain("campaign:我的跑团/maps");
    expect(folders).toContain("campaign:我的跑团/images/maps");
  });

  it("工程文件是人类可读的 JSON（带缩进与结尾换行）", async () => {
    const provider = createMemoryResourceProvider();
    await createCampaign(provider, "C", LAYOUT);
    const text = await readCampaignProject(provider, "C");
    expect(text).toContain("\n  ");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("重名跑团被拒绝（不覆盖用户数据）", async () => {
    const provider = createMemoryResourceProvider();
    await createCampaign(provider, "C", LAYOUT);
    await expect(createCampaign(provider, "C", LAYOUT)).rejects.toThrow(/已存在/);
  });

  it("非法名字直接拒绝", async () => {
    const provider = createMemoryResourceProvider();
    await expect(createCampaign(provider, "a/b", LAYOUT)).rejects.toThrow(/不能包含/);
  });

  it("列出跑团：名字、是否有工程文件、文件数", async () => {
    const provider = createMemoryResourceProvider();
    await createCampaign(provider, "乙团", LAYOUT);
    await createCampaign(provider, "甲团", LAYOUT);
    // 造一个只有资源、没有工程文件的目录（不完整）
    await provider.writeText(campaignMapId("残缺", "Map001"), "{}");

    const list = await listCampaigns(provider);
    expect(list.map((item) => item.name)).toEqual(["残缺", "甲团", "乙团"]);
    expect(list.find((item) => item.name === "甲团")?.hasProject).toBe(true);
    expect(list.find((item) => item.name === "残缺")?.hasProject).toBe(false);
    expect(list.find((item) => item.name === "残缺")?.fileCount).toBe(1);
  });

  it("读取跑团资源只返回该跑团的条目", async () => {
    const provider = createMemoryResourceProvider();
    await createCampaign(provider, "A", LAYOUT);
    await createCampaign(provider, "B", LAYOUT);
    await provider.writeText(campaignMapId("A", "Map001"), "{}");

    const entries = await readCampaignEntries(provider, "A");
    expect(entries.every((entry) => entry.path.startsWith("A/"))).toBe(true);
    expect(entries.map((entry) => entry.path)).toContain("A/maps/Map001.json");
  });

  it("删除跑团会连同资源与目录一起清掉", async () => {
    const provider = createMemoryResourceProvider();
    await createCampaign(provider, "C", LAYOUT);
    await provider.writeText(campaignMapId("C", "Map001"), "{}");
    await provider.writeText(campaignMapImageId("C", "Map001"), "png");

    const result = await deleteCampaign(provider, "C");
    expect(result.removed).toBe(3); // 只统计文件；目录随根目录一并递归删除
    expect(await readCampaignEntries(provider, "C")).toEqual([]);
    expect(provider.listFolders().filter((id) => id.includes("C/"))).toEqual([]);
  });

  it("删除不存在的跑团抛错", async () => {
    const provider = createMemoryResourceProvider();
    await expect(deleteCampaign(provider, "Ghost")).rejects.toThrow(/不存在/);
  });
});

describe("资源树（编辑器 Assets 面板用）", () => {
  it("按目录分组，目录排在文件前面", async () => {
    const provider = createMemoryResourceProvider();
    await createCampaign(provider, "C", LAYOUT);
    await provider.writeText(campaignMapId("C", "Map001"), "{}");
    await provider.writeText(campaignMapImageId("C", "Map001"), "png");

    const tree = buildResourceTree("C", await readCampaignEntries(provider, "C"), DEFAULT_CAMPAIGN_FOLDERS);

    // 顶层目录优先，且顺序稳定
    const topFolders = tree.filter((node) => node.type === "folder").map((node) => node.name);
    expect(topFolders).toEqual(["audio", "config", "images", "items", "maps", "video"]);

    const maps = tree.find((node) => node.name === "maps");
    expect(maps?.children?.map((node) => node.name)).toEqual(["Map001.json"]);

    const images = tree.find((node) => node.name === "images");
    expect(images?.children?.map((node) => node.name)).toEqual(["maps"]);
  });

  it("空目录也会显示（新建跑团后即可看到标准结构）", async () => {
    const provider = createMemoryResourceProvider();
    await createCampaign(provider, "C", LAYOUT);

    const tree = buildResourceTree("C", await readCampaignEntries(provider, "C"), DEFAULT_CAMPAIGN_FOLDERS);
    const maps = tree.find((node) => node.name === "maps");
    expect(maps).toBeDefined();
    expect(maps?.children).toEqual([]);
  });

  it("目录来自真实条目，而不是凭空补出来的", async () => {
    const provider = createMemoryResourceProvider();
    // 只写一个工程文件、不建任何目录
    await provider.writeText(campaignProjectId("C"), "{}");

    const tree = buildResourceTree("C", await readCampaignEntries(provider, "C"), []);
    expect(tree.map((node) => node.name)).toEqual(["C.dtproj.json"]);
    expect(tree[0]?.type).toBe("file");
  });

  it("工程文件带 size 与正确的 ID", async () => {
    const provider = createMemoryResourceProvider();
    await createCampaign(provider, "C", LAYOUT);

    const tree = buildResourceTree("C", await readCampaignEntries(provider, "C"), []);
    const projectFile = tree.find((node) => node.name === "C.dtproj.json");
    expect(projectFile?.id).toBe("campaign:C/C.dtproj.json");
    expect(projectFile?.type).toBe("file");
    expect(projectFile?.size).toBeGreaterThan(0);
  });
});

describe("归属校验", () => {
  it("belongsToCampaign 判断资源是否属于某跑团", () => {
    expect(belongsToCampaign(campaignMapId("A", "Map001"), "A")).toBe(true);
    expect(belongsToCampaign(campaignMapId("AB", "Map001"), "A")).toBe(false);
    expect(belongsToCampaign("config:app.json", "A")).toBe(false);
    expect(belongsToCampaign("bogus:x", "A")).toBe(false);
  });
});
