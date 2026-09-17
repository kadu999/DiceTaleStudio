import { describe, expect, it } from "vitest";
import {
  configId,
  formatResourceId,
  itemLibraryId,
  mapBytesId,
  mapDocumentId,
  mapImageId,
  mapNameFromDocumentId,
  parseResourceId,
  projectId,
} from "../src/ids";
import { createMemoryResourceProvider } from "../src/memory";
import { defaultAppConfig, parseAppConfig } from "../src/config";

describe("资源逻辑 ID", () => {
  it("按类别 + 相对路径解析", () => {
    expect(parseResourceId("image:maps/Map001.png")).toEqual({
      kind: "image",
      path: "maps/Map001.png",
    });
  });

  it("反斜杠被规范化", () => {
    expect(parseResourceId("image:maps\\Map001.png").path).toBe("maps/Map001.png");
  });

  it("缺少类别前缀或路径时抛错", () => {
    expect(() => parseResourceId("Map001.png")).toThrow(/缺少类别前缀/);
    expect(() => parseResourceId("image:")).toThrow(/缺少路径/);
  });

  it("未知类别抛错", () => {
    expect(() => parseResourceId("texture:foo.png")).toThrow(/未知资源类别/);
  });

  it("拒绝越出资源根的路径", () => {
    expect(() => parseResourceId("image:../secret.png")).toThrow(/不允许越出资源根/);
    expect(() => parseResourceId("image:a/../../b.png")).toThrow(/不允许越出资源根/);
    expect(() => parseResourceId("image:/etc/passwd")).toThrow(/不允许越出资源根/);
  });

  it("同名约定集中在这里：地图数据、网格、贴图同名", () => {
    expect(mapDocumentId("Map001")).toBe("map:Map001.json");
    expect(mapBytesId("Map001")).toBe("map:Map001.bytes");
    expect(mapImageId("Map001")).toBe("image:maps/Map001.png");
    expect(mapNameFromDocumentId(mapDocumentId("Map001"))).toBe("Map001");
  });

  it("其它类别的 ID 规则", () => {
    expect(configId("app")).toBe("config:app.json");
    expect(itemLibraryId()).toBe("item-lib:items.json");
    expect(projectId("demo")).toBe("project:demo.dtproj.json");
    expect(formatResourceId("audio", "bgm/theme.mp3")).toBe("audio:bgm/theme.mp3");
  });

  it("mapNameFromDocumentId 拒绝非地图文档 ID", () => {
    expect(() => mapNameFromDocumentId("image:maps/Map001.png")).toThrow(/不是地图文档/);
    expect(() => mapNameFromDocumentId("map:Map001.bytes")).toThrow(/不是地图文档/);
  });
});

describe("内存资源实现", () => {
  it("读写文本与二进制", async () => {
    const provider = createMemoryResourceProvider();
    await provider.writeText(configId("editor"), "{\"theme\":\"dark\"}");
    expect(await provider.readText(configId("editor"))).toBe("{\"theme\":\"dark\"}");

    const buffer = new Uint8Array([1, 2, 3]).buffer;
    await provider.writeBinary(mapBytesId("Map001"), buffer);
    expect(new Uint8Array(await provider.readBinary(mapBytesId("Map001")))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("list 按类别过滤并带 size", async () => {
    const provider = createMemoryResourceProvider({
      "map:Map001.json": "{}",
      "image:maps/Map001.png": new Uint8Array(10),
    });

    const maps = await provider.list("map");
    expect(maps.map((entry) => entry.id)).toEqual(["map:Map001.json"]);
    expect(maps[0]?.path).toBe("Map001.json");

    const all = await provider.list();
    expect(all.length).toBe(2);
    expect(all.find((entry) => entry.id === "image:maps/Map001.png")?.size).toBe(10);
  });

  it("读取不存在的资源抛错", async () => {
    const provider = createMemoryResourceProvider();
    await expect(provider.readText(mapDocumentId("Nope"))).rejects.toThrow(/资源不存在/);
    expect(await provider.exists(mapDocumentId("Nope"))).toBe(false);
  });

  it("写入非法 ID 抛错（不落盘到任意位置）", async () => {
    const provider = createMemoryResourceProvider();
    await expect(provider.writeText("bogus:x", "y")).rejects.toThrow(/未知资源类别/);
  });

  it("remove 删除资源", async () => {
    const provider = createMemoryResourceProvider({ "map:Map001.json": "{}" });
    await provider.remove(mapDocumentId("Map001"));
    expect(await provider.exists(mapDocumentId("Map001"))).toBe(false);
  });
});

describe("应用配置", () => {
  it("缺省时给出内置默认值", () => {
    const config = defaultAppConfig();
    expect(config.resourceRoot).toBe("resources");
    expect(config.server.port).toBe(1420);
    expect(config.defaultCellPixels).toBe(30);
    expect(config.dirs.map).toBe("maps");
    expect(config.dirs.image).toBe("images");
    expect(config.dirs.config).toBe("config");
  });

  it("自定义目录名生效（代码不硬编码目录）", () => {
    const config = parseAppConfig({ dirs: { ...defaultAppConfig().dirs, map: "worlds" } });
    expect(config.dirs.map).toBe("worlds");
  });

  it("非法配置抛出带路径的错误", () => {
    expect(() => parseAppConfig({ server: { port: 99999 } })).toThrow(/app 配置校验失败/);
    expect(() => parseAppConfig({ resourceRoot: "" })).toThrow(/app 配置校验失败/);
  });
});
