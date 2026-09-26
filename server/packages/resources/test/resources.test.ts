import { describe, expect, it } from "vitest";
import {
  PROJECT_FOLDERS,
  assetIdOfMetaId,
  assetMetaIdOf,
  configId,
  formatResourceId,
  isAssetMetaPath,
  parseResourceId,
  projectAssetId,
  projectFileId,
  projectFolderId,
  projectNameFromFileId,
  projectNameFromId,
  projectRelativePathFromId,
  projectSceneBytesId,
  projectSceneImageId,
} from "../src/ids";
import { createMemoryResourceProvider } from "../src/memory";
import { defaultAppConfig, parseAppConfig } from "../src/config";

describe("资源逻辑 ID（只有两类：编辑器配置 / 项目）", () => {
  it("类别只有 config 与 project", () => {
    expect(parseResourceId("config:app.json")).toEqual({ kind: "config", path: "app.json" });
    expect(parseResourceId("project:我的项目/project.json")).toEqual({
      kind: "project",
      path: "我的项目/project.json",
    });
  });

  it("反斜杠被规范化", () => {
    expect(parseResourceId("project:a\\b.json").path).toBe("a/b.json");
  });

  it("缺少类别前缀或路径时抛错", () => {
    expect(() => parseResourceId("app.json")).toThrow(/缺少类别前缀/);
    expect(() => parseResourceId("config:")).toThrow(/缺少路径/);
  });

  it("旧类别已移除（避免两套模型并存）", () => {
    for (const kind of ["map", "image", "audio", "campaign", "item-lib"]) {
      expect(() => parseResourceId(`${kind}:x`)).toThrow(/未知资源类别/);
    }
  });

  it("拒绝越出资源根的路径", () => {
    expect(() => parseResourceId("project:../secret")).toThrow(/不允许越出资源根/);
    expect(() => parseResourceId("project:a/../../b")).toThrow(/不允许越出资源根/);
    expect(() => parseResourceId("project:/etc/passwd")).toThrow(/不允许越出资源根/);
    // 结尾那一段的 `..` / `.`（只查 `includes("/../")` 会漏掉）
    expect(() => parseResourceId("project:a/..")).toThrow(/不允许越出资源根/);
    expect(() => parseResourceId("project:a/./..")).toThrow(/不允许越出资源根/);
    expect(() => parseResourceId("project:Assets/images/..")).toThrow(/不允许越出资源根/);
    expect(() => parseResourceId("project:a/b/.")).toThrow(/不允许越出资源根/);
  });

  it("项目文件是固定名：一个项目一个文件夹 + 一个 project.json", () => {
    expect(projectFileId("我的项目")).toBe("project:我的项目/project.json");
    expect(projectNameFromFileId(projectFileId("我的项目"))).toBe("我的项目");
    // 项目名不再进文件名，重命名项目只动文件夹一处
    expect(projectFileId("另一个项目")).toBe("project:另一个项目/project.json");
  });

  it("项目内标准路径约定集中在这里（一切都在 Assets/ 下）", () => {
    expect(projectSceneBytesId("C", "Map001")).toBe("project:C/Assets/scenes/Map001.bytes");
    expect(projectSceneImageId("C", "Map001")).toBe("project:C/Assets/images/Map001.png");
    expect(projectFolderId("C", PROJECT_FOLDERS.scenes)).toBe("project:C/Assets/scenes");
    expect(projectAssetId("C", "Assets/audio/bgm.mp3")).toBe("project:C/Assets/audio/bgm.mp3");
  });

  it("除项目文件外，标准目录全都在 Assets/ 下", () => {
    // 对齐 Unity：项目根只有「项目文件 + Assets」，不随功能增长变乱
    for (const folder of Object.values(PROJECT_FOLDERS)) {
      expect(folder === PROJECT_FOLDERS.assets || folder.startsWith("Assets/")).toBe(true);
    }

    // 地图只是场景里的一个对象（数据放 Assets/scenes/）；道具库存在项目文件里，不单开目录
    expect(Object.values(PROJECT_FOLDERS)).not.toContain("maps");
    expect(Object.values(PROJECT_FOLDERS)).not.toContain("items");
  });

  it("从 ID 反推项目名与相对路径", () => {
    const id = projectSceneImageId("我的项目", "Map001");
    expect(projectNameFromId(id)).toBe("我的项目");
    expect(projectRelativePathFromId(id)).toBe("Assets/images/Map001.png");
  });

  it("反推时校验类别与是否是项目文件", () => {
    expect(() => projectNameFromId("config:app.json")).toThrow(/不是项目资源 ID/);
    expect(() => projectNameFromId("project:C")).toThrow(/缺少项目名/);
    expect(() => projectNameFromFileId(projectSceneBytesId("C", "Map001"))).toThrow(
      /不是项目文件 ID/,
    );
  });

  it("编辑器全局配置 ID", () => {
    expect(configId("app")).toBe("config:app.json");
    expect(formatResourceId("project", "C/x")).toBe("project:C/x");
  });
});

describe("内存资源实现", () => {
  it("读写文本与二进制", async () => {
    const provider = createMemoryResourceProvider();
    await provider.writeText(configId("editor"), '{"theme":"dark"}');
    expect(await provider.readText(configId("editor"))).toBe('{"theme":"dark"}');

    await provider.writeBinary(projectSceneBytesId("C", "Map001"), new Uint8Array([1, 2, 3]).buffer);
    expect(
      new Uint8Array(await provider.readBinary(projectSceneBytesId("C", "Map001"))),
    ).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("list 按类别过滤并带 size", async () => {
    const provider = createMemoryResourceProvider({
      "project:C/a.json": "{}",
      "config:app.json": "{}",
    });

    expect((await provider.list("project")).map((entry) => entry.id)).toEqual(["project:C/a.json"]);
    expect((await provider.list()).length).toBe(2);
  });

  it("ensureFolder 登记目录且不报错（重复调用也安全）", async () => {
    const provider = createMemoryResourceProvider();
    await provider.ensureFolder(projectFolderId("C", "Assets/scenes"));
    await provider.ensureFolder(projectFolderId("C", "Assets/scenes"));
    expect(provider.listFolders()).toEqual(["project:C/Assets/scenes"]);
  });

  it("读取不存在的资源抛错", async () => {
    const provider = createMemoryResourceProvider();
    await expect(provider.readText(projectFileId("Nope"))).rejects.toThrow(/资源不存在/);
    expect(await provider.exists(projectFileId("Nope"))).toBe(false);
  });

  it("非法 ID 不落盘", async () => {
    const provider = createMemoryResourceProvider();
    await expect(provider.writeText("bogus:x", "y")).rejects.toThrow(/未知资源类别/);
    await expect(provider.ensureFolder("project:../x")).rejects.toThrow(/不允许越出资源根/);
  });

  it("rename 文件：换 ID、内容不变（重命名场景 = 重命名文件，不重写内容）", async () => {
    const sceneA = projectAssetId("C", "Assets/scenes/Map001.json");
    const sceneB = projectAssetId("C", "Assets/scenes/Map002.json");
    const provider = createMemoryResourceProvider({ [sceneA]: '{"name":"Map001"}' });

    await provider.rename(sceneA, sceneB);

    expect(await provider.exists(sceneA)).toBe(false);
    expect(await provider.readText(sceneB)).toBe('{"name":"Map001"}');
    expect((await provider.list("project")).map((entry) => entry.id)).toEqual([sceneB]);
  });

  it("rename 绝不覆盖：目标已存在时抛错，两侧都原样保留", async () => {
    const sceneA = projectAssetId("C", "Assets/scenes/Map001.json");
    const sceneB = projectAssetId("C", "Assets/scenes/Map002.json");
    const provider = createMemoryResourceProvider({ [sceneA]: "A", [sceneB]: "B" });

    await expect(provider.rename(sceneA, sceneB)).rejects.toThrow(`资源已存在: ${sceneB}`);
    expect(await provider.readText(sceneA)).toBe("A");
    expect(await provider.readText(sceneB)).toBe("B");
  });

  it("rename 源不存在时抛错（消息与文件系统实现一致）", async () => {
    const provider = createMemoryResourceProvider();
    await expect(
      provider.rename(
        projectAssetId("C", "Assets/scenes/Nope.json"),
        projectAssetId("C", "Assets/scenes/Other.json"),
      ),
    ).rejects.toThrow(`资源不存在: project:C/Assets/scenes/Nope.json`);
  });

  it("rename 两侧类别不同时抛错", async () => {
    const provider = createMemoryResourceProvider({ "config:app.json": "{}" });
    await expect(provider.rename("config:app.json", "project:C/app.json")).rejects.toThrow(
      /类别必须一致/,
    );
    // 拒绝之后源仍在原处
    expect(await provider.readText("config:app.json")).toBe("{}");
  });

  it("rename 目录：连同其下所有条目一起搬（前缀替换）", async () => {
    const folderA = projectFolderId("C", "Assets/scenes/第一章");
    const folderB = projectFolderId("C", "Assets/scenes/序章");
    const provider = createMemoryResourceProvider();
    await provider.ensureFolder(folderA);
    await provider.writeText(projectAssetId("C", "Assets/scenes/第一章/Map001.json"), "1");
    await provider.writeText(projectAssetId("C", "Assets/scenes/第一章/Map002.json"), "2");
    // 名字前缀相同但不在目录内的兄弟目录不受影响
    await provider.writeText(projectAssetId("C", "Assets/scenes/第一章外传/Map003.json"), "3");

    await provider.rename(folderA, folderB);

    expect(provider.listFolders()).toEqual([folderB]);
    expect(await provider.exists(projectAssetId("C", "Assets/scenes/第一章/Map001.json"))).toBe(false);
    expect(await provider.readText(projectAssetId("C", "Assets/scenes/序章/Map001.json"))).toBe("1");
    expect(await provider.readText(projectAssetId("C", "Assets/scenes/序章/Map002.json"))).toBe("2");
    expect(await provider.readText(projectAssetId("C", "Assets/scenes/第一章外传/Map003.json"))).toBe(
      "3",
    );
  });
});

describe("应用配置", () => {
  it("缺省时给出内置默认值", () => {
    const config = defaultAppConfig();
    expect(config.resourceRoot).toBe("resources");
    expect(config.server.port).toBe(1420);
    expect(config.defaultCellPixels).toBe(30);
    expect(config.dirs.config).toBe("config");
    expect(config.dirs.project).toBe("projects");
    expect(config.projectFolders).toContain("Assets/scenes");
    expect(config.projectFolders).toContain("Assets/images");
    expect(config.projectFolders).not.toContain("maps");
    expect(config.projectFolders).not.toContain("items");
  });

  it("自定义目录名生效（代码不硬编码目录）", () => {
    const config = parseAppConfig({ dirs: { ...defaultAppConfig().dirs, project: "runs" } });
    expect(config.dirs.project).toBe("runs");
  });

  it("非法配置抛出带路径的错误", () => {
    expect(() => parseAppConfig({ server: { port: 99999 } })).toThrow(/app 配置校验失败/);
    expect(() => parseAppConfig({ resourceRoot: "" })).toThrow(/app 配置校验失败/);
  });
});

describe("素材 meta（每个素材旁边一个 .meta）", () => {
  it("meta 的文件名与 ID 都由素材路径派生，能双向还原", () => {
    const asset = projectAssetId("我的项目", "Assets/images/A.png");
    const meta = assetMetaIdOf(asset);

    expect(meta).toBe("project:我的项目/Assets/images/A.png.meta");
    expect(isAssetMetaPath("Assets/images/A.png.meta")).toBe(true);
    expect(isAssetMetaPath("Assets/images/A.png")).toBe(false);
    // 反推回素材（键少了后缀那一截）
    expect(assetIdOfMetaId(meta)).toBe(asset);
    expect(assetIdOfMetaId(asset)).toBeUndefined();
  });

  it("meta 不出现在资源列表里（它是元数据，不是素材）", async () => {
    const provider = createMemoryResourceProvider();
    const asset = projectAssetId("我的项目", "Assets/images/A.png");
    await provider.writeText(asset, "png-bytes-as-text");
    await provider.writeText(assetMetaIdOf(asset), '{"formatVersion":1}');

    const listed = await provider.list("project");
    expect(listed.map((entry) => entry.path)).toEqual(["我的项目/Assets/images/A.png"]);
    // 但按 ID 直接读得到（写 meta 走的就是这条路）
    expect(await provider.readText(assetMetaIdOf(asset))).toBe('{"formatVersion":1}');
  });

  it("resource lifecycle keeps a sidecar identity", async () => {
    const provider = createMemoryResourceProvider();
    const asset = projectAssetId("C", "Assets/images/A.png");
    const renamed = projectAssetId("C", "Assets/images/B.png");

    await provider.writeBinary(asset, new Uint8Array([1, 2, 3]).buffer);
    const metaId = assetMetaIdOf(asset);
    const originalMeta = JSON.parse(await provider.readText(metaId)) as { guid: string; importer: string };
    expect(originalMeta.importer).toBe("texture");
    expect(originalMeta.guid).toMatch(/^[0-9a-f]{32}$/);

    await provider.writeText(metaId, JSON.stringify({ ...originalMeta, custom: "keep" }));
    await provider.writeBinary(asset, new Uint8Array([4]).buffer);
    expect(await provider.readText(metaId)).toContain('"custom":"keep"');

    await provider.rename(asset, renamed);
    expect(await provider.exists(asset)).toBe(false);
    expect(await provider.exists(metaId)).toBe(false);
    const renamedMeta = JSON.parse(await provider.readText(assetMetaIdOf(renamed))) as {
      guid: string;
      custom: string;
    };
    expect(renamedMeta.guid).toBe(originalMeta.guid);
    expect(renamedMeta.custom).toBe("keep");

    await provider.remove(renamed);
    expect(await provider.exists(assetMetaIdOf(renamed))).toBe(false);
  });

  it("listing discovers new assets and generates a prefab sidecar", async () => {
    const provider = createMemoryResourceProvider();
    const prefab = projectAssetId("C", "Assets/prefabs/Avatar.prefab");
    provider.seed(prefab, "prefab");

    const entries = await provider.list("project");
    expect(entries.map((entry) => entry.id)).toContain(prefab);
    const meta = JSON.parse(await provider.readText(assetMetaIdOf(prefab))) as {
      guid: string;
      importer: string;
    };
    expect(meta.importer).toBe("prefab");
    expect(meta.guid).toMatch(/^[0-9a-f]{32}$/);
  });

  it("folders also have sidecar identities", async () => {
    const provider = createMemoryResourceProvider();
    const folder = projectFolderId("C", "Assets/images/old");
    const renamed = projectFolderId("C", "Assets/images/new");

    await provider.ensureFolder(folder);
    const metaId = assetMetaIdOf(folder);
    const meta = JSON.parse(await provider.readText(metaId)) as { guid: string; folderAsset: boolean };
    expect(meta.folderAsset).toBe(true);

    await provider.rename(folder, renamed);
    expect(await provider.exists(metaId)).toBe(false);
    expect((JSON.parse(await provider.readText(assetMetaIdOf(renamed))) as { guid: string }).guid).toBe(meta.guid);
  });
});
