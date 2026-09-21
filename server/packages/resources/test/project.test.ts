import { describe, expect, it } from "vitest";
import {
  belongsToProject,
  buildResourceTree,
  createProject,
  deleteProject,
  listProjects,
  projectExists,
  readProjectEntries,
  readProjectFile,
  validateProjectName,
  validateProjectRelativePath,
} from "../src/project";
import {
  DEFAULT_PROJECT_FOLDERS,
  PROJECT_FILE_NAME,
  PROJECT_FOLDERS,
  projectAssetId,
  projectFileId,
  projectSceneBytesId,
  projectSceneImageId,
} from "../src/ids";
import { createMemoryResourceProvider } from "../src/memory";

const LAYOUT = { folders: DEFAULT_PROJECT_FOLDERS, project: { formatVersion: 1, kind: "test" } };

describe("项目名校验（会直接成为文件夹名）", () => {
  it("接受正常名字（含中文、空格、点、连字符）", () => {
    for (const name of ["我的项目", "Curse of Strahd", "run-01", "v1.2 模组"]) {
      expect(validateProjectName(name)).toBeUndefined();
    }
  });

  it("拒绝空名字与首尾空白", () => {
    expect(validateProjectName("")).toMatch(/不能为空/);
    expect(validateProjectName("   ")).toMatch(/不能为空/);
    expect(validateProjectName(" x")).toMatch(/首尾不能有空白/);
    expect(validateProjectName("x ")).toMatch(/首尾不能有空白/);
  });

  it("拒绝路径分隔符与 Windows 非法字符", () => {
    for (const name of ["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b"]) {
      expect(validateProjectName(name)).toMatch(/不能包含/);
    }
  });

  it("拒绝 . 与 .. 以及系统保留名", () => {
    expect(validateProjectName(".")).toMatch(/不合法/);
    expect(validateProjectName("..")).toMatch(/不合法/);
    for (const name of ["CON", "nul", "Com1", "LPT9"]) {
      expect(validateProjectName(name)).toMatch(/保留名/);
    }
  });

  it("拒绝超长名字", () => {
    expect(validateProjectName("x".repeat(65))).toMatch(/64/);
  });
});

describe("项目内相对路径校验", () => {
  it("接受多级正常路径", () => {
    expect(validateProjectRelativePath("maps/Map001.json")).toBeUndefined();
    expect(validateProjectRelativePath("images/tokens")).toBeUndefined();
  });

  it("拒绝越界、空段与非法段", () => {
    expect(validateProjectRelativePath("")).toMatch(/不能为空/);
    expect(validateProjectRelativePath("../x")).toMatch(/不允许越出/);
    expect(validateProjectRelativePath("a/../../b")).toMatch(/不允许越出/);
    expect(validateProjectRelativePath("/abs")).toMatch(/不允许越出/);
    expect(validateProjectRelativePath("a//b")).toMatch(/空的目录名/);
    expect(validateProjectRelativePath("a/con/b")).toMatch(/保留名/);
  });

  it("逐段拒绝 . 与 ..（它们不含分隔符，能绕开 `/../` 那条检查）", () => {
    // `Assets/images/..` 拼进真实路径后会把结果抬到项目目录之外，必须挡在这里
    expect(validateProjectRelativePath("Assets/images/..")).toMatch(/\.\./);
    expect(validateProjectRelativePath("a/..")).toMatch(/\.\./);
    expect(validateProjectRelativePath("..")).toMatch(/\.\./);
    expect(validateProjectRelativePath("a/./b")).toMatch(/\./);
  });
});

describe("创建 / 打开 / 删除项目", () => {
  it("创建项目：写入 project.json 并建立标准子目录", async () => {
    const provider = createMemoryResourceProvider();
    await createProject(provider, "我的项目", LAYOUT);

    expect(await provider.exists(projectFileId("我的项目"))).toBe(true);
    expect(JSON.parse(await readProjectFile(provider, "我的项目"))).toEqual(LAYOUT.project);

    const folders = provider.listFolders();
    expect(folders).toContain("project:我的项目/Assets/scenes");
    expect(folders).toContain("project:我的项目/Assets/images");
  });

  it("项目文件是人类可读的 JSON（带缩进与结尾换行）", async () => {
    const provider = createMemoryResourceProvider();
    await createProject(provider, "C", LAYOUT);
    const text = await readProjectFile(provider, "C");
    expect(text).toContain("\n  ");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("重名项目被拒绝（不覆盖用户数据）", async () => {
    const provider = createMemoryResourceProvider();
    await createProject(provider, "C", LAYOUT);
    await expect(createProject(provider, "C", LAYOUT)).rejects.toThrow(/已存在/);
  });

  it("非法名字直接拒绝", async () => {
    const provider = createMemoryResourceProvider();
    await expect(createProject(provider, "a/b", LAYOUT)).rejects.toThrow(/不能包含/);
  });

  it("只有含 project.json 的目录才算项目", async () => {
    const provider = createMemoryResourceProvider();
    await createProject(provider, "乙项目", LAYOUT);
    await createProject(provider, "甲项目", LAYOUT);
    // 造一个只有资源、没有 project.json 的目录（半途创建 / 残骸）
    await provider.writeText(projectSceneBytesId("残缺", "Map001"), "{}");

    const list = await listProjects(provider);
    expect(list.map((item) => item.name)).toEqual(["甲项目", "乙项目"]);
    expect(list.find((item) => item.name === "甲项目")?.fileCount).toBe(1);

    expect(await projectExists(provider, "甲项目")).toBe(true);
    expect(await projectExists(provider, "残缺")).toBe(false);
  });

  it("读取项目资源只返回该项目的条目", async () => {
    const provider = createMemoryResourceProvider();
    await createProject(provider, "A", LAYOUT);
    await createProject(provider, "B", LAYOUT);
    await provider.writeText(projectSceneBytesId("A", "Map001"), "{}");

    const entries = await readProjectEntries(provider, "A");
    expect(entries.every((entry) => entry.path.startsWith("A/"))).toBe(true);
    expect(entries.map((entry) => entry.path)).toContain("A/Assets/scenes/Map001.bytes");
  });

  it("删除项目会连同资源与目录一起清掉", async () => {
    const provider = createMemoryResourceProvider();
    await createProject(provider, "C", LAYOUT);
    await provider.writeText(projectSceneBytesId("C", "Map001"), "{}");
    await provider.writeText(projectSceneImageId("C", "Map001"), "png");

    const result = await deleteProject(provider, "C");
    expect(result.removed).toBe(3); // project.json + 地图 + 贴图；目录随根目录一并递归删除
    expect(await readProjectEntries(provider, "C")).toEqual([]);
    expect(provider.listFolders().filter((id) => id.includes("C/"))).toEqual([]);
  });

  it("删除不存在的项目抛错（残骸目录也不算存在）", async () => {
    const provider = createMemoryResourceProvider();
    await expect(deleteProject(provider, "Ghost")).rejects.toThrow(/不存在/);

    // 有资源但没 project.json：仍然不是项目，不能删
    await provider.writeText(projectSceneBytesId("空壳", "Map001"), "{}");
    await expect(deleteProject(provider, "空壳")).rejects.toThrow(/不存在/);
  });
});

describe("资源树（编辑器 Assets 面板用）", () => {
  it("顶层只有 Assets，标准目录在它下面且目录排在文件前面", async () => {
    const provider = createMemoryResourceProvider();
    await createProject(provider, "C", LAYOUT);
    await provider.writeText(projectSceneBytesId("C", "Map001"), "{}");
    await provider.writeText(projectSceneImageId("C", "Map001"), "png");

    const tree = buildResourceTree("C", await readProjectEntries(provider, "C"), DEFAULT_PROJECT_FOLDERS);

    // 项目根只有 Assets（项目文件是特殊文件，不显示）
    expect(tree.map((node) => node.name)).toEqual([PROJECT_FOLDERS.assets]);

    const assets = tree[0];
    expect(assets?.children?.map((node) => node.name)).toEqual([
      "audio",
      "config",
      "images",
      "scenes",
      "video",
    ]);

    const scenes = assets?.children?.find((node) => node.name === "scenes");
    expect(scenes?.children?.map((node) => node.name)).toEqual(["Map001.bytes"]);

    // 贴图与场景同名，直接放 Assets/images/ 下
    const images = assets?.children?.find((node) => node.name === "images");
    expect(images?.children?.map((node) => node.name)).toEqual(["Map001.png"]);
  });

  it("空目录也会显示（新建项目后即可看到标准结构）", async () => {
    const provider = createMemoryResourceProvider();
    await createProject(provider, "C", LAYOUT);

    const tree = buildResourceTree("C", await readProjectEntries(provider, "C"), DEFAULT_PROJECT_FOLDERS);
    const assets = tree.find((node) => node.name === PROJECT_FOLDERS.assets);
    expect(assets).toBeDefined();
    expect(assets?.children).toHaveLength(DEFAULT_PROJECT_FOLDERS.length);

    // 叶子目录是空数组，而不是「没有 children」（否则面板里展不开）
    const scenes = assets?.children?.find((node) => node.name === "scenes");
    expect(scenes?.children).toEqual([]);
  });

  it("目录来自真实条目，而不是凭空补出来的", async () => {
    const provider = createMemoryResourceProvider();
    // 只写一个真实文件、不建任何目录
    await provider.writeText(projectSceneBytesId("C", "Map001"), "{}");

    const tree = buildResourceTree("C", await readProjectEntries(provider, "C"), []);
    // 只有文件路径里出现过的目录；不传标准目录时，别的目录不会被凭空补出来
    expect(tree.map((node) => node.name)).toEqual([PROJECT_FOLDERS.assets]);
    const assets = tree[0];
    expect(assets?.children?.map((node) => node.name)).toEqual(["scenes"]);
    expect(assets?.children?.[0]?.children?.map((node) => node.name)).toEqual(["Map001.bytes"]);
    expect(assets?.children?.find((node) => node.name === "images")).toBeUndefined();
  });

  it("项目文件是特殊文件：不作为资源显示（但文件真的在）", async () => {
    const provider = createMemoryResourceProvider();
    await createProject(provider, "C", LAYOUT);
    await provider.writeText(projectSceneBytesId("C", "Map001"), "{}");

    const tree = buildResourceTree("C", await readProjectEntries(provider, "C"), DEFAULT_PROJECT_FOLDERS);
    expect(tree.find((node) => node.name === PROJECT_FILE_NAME)).toBeUndefined();
    expect(await provider.exists(projectFileId("C"))).toBe(true);
  });

  it("只隐藏项目根的那个特殊文件，子目录里同名的文件照常显示", async () => {
    const provider = createMemoryResourceProvider();
    await createProject(provider, "C", LAYOUT);
    await provider.writeText(projectAssetId("C", "Assets/scenes/project.json"), "{}");

    const tree = buildResourceTree("C", await readProjectEntries(provider, "C"), DEFAULT_PROJECT_FOLDERS);
    const scenes = tree[0]?.children?.find((node) => node.name === "scenes");
    expect(scenes?.children?.map((node) => node.name)).toEqual(["project.json"]);
  });
});

describe("归属校验", () => {
  it("belongsToProject 判断资源是否属于某项目", () => {
    expect(belongsToProject(projectSceneBytesId("A", "Map001"), "A")).toBe(true);
    expect(belongsToProject(projectSceneBytesId("AB", "Map001"), "A")).toBe(false);
    expect(belongsToProject("config:app.json", "A")).toBe(false);
    expect(belongsToProject("bogus:x", "A")).toBe(false);
  });
});
