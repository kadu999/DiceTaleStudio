import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_FOLDERS,
  campaignFileId,
  campaignFolderId,
  campaignItemsId,
  campaignMapBytesId,
  campaignMapId,
  campaignMapImageId,
  campaignNameFromId,
  campaignNameFromProjectId,
  campaignProjectFileName,
  campaignProjectId,
  campaignRelativePathFromId,
  configId,
  formatResourceId,
  parseResourceId,
} from "../src/ids";
import { createMemoryResourceProvider } from "../src/memory";
import { defaultAppConfig, parseAppConfig } from "../src/config";

describe("资源逻辑 ID（只有两类：编辑器配置 / 跑团工程）", () => {
  it("类别只有 config 与 campaign", () => {
    expect(parseResourceId("config:app.json")).toEqual({ kind: "config", path: "app.json" });
    expect(parseResourceId("campaign:我的跑团/我的跑团.dtproj.json")).toEqual({
      kind: "campaign",
      path: "我的跑团/我的跑团.dtproj.json",
    });
  });

  it("反斜杠被规范化", () => {
    expect(parseResourceId("campaign:a\\b.json").path).toBe("a/b.json");
  });

  it("缺少类别前缀或路径时抛错", () => {
    expect(() => parseResourceId("app.json")).toThrow(/缺少类别前缀/);
    expect(() => parseResourceId("config:")).toThrow(/缺少路径/);
  });

  it("旧类别已移除（避免两套模型并存）", () => {
    for (const kind of ["map", "image", "audio", "project", "item-lib"]) {
      expect(() => parseResourceId(`${kind}:x`)).toThrow(/未知资源类别/);
    }
  });

  it("拒绝越出资源根的路径", () => {
    expect(() => parseResourceId("campaign:../secret")).toThrow(/不允许越出资源根/);
    expect(() => parseResourceId("campaign:a/../../b")).toThrow(/不允许越出资源根/);
    expect(() => parseResourceId("campaign:/etc/passwd")).toThrow(/不允许越出资源根/);
  });

  it("跑团工程：一个跑团一个文件夹，工程文件是单独一个文件", () => {
    expect(campaignProjectFileName("我的跑团")).toBe("我的跑团.dtproj.json");
    expect(campaignProjectId("我的跑团")).toBe("campaign:我的跑团/我的跑团.dtproj.json");
    expect(campaignNameFromProjectId(campaignProjectId("我的跑团"))).toBe("我的跑团");
  });

  it("跑团内标准路径约定集中在这里", () => {
    expect(campaignMapId("C", "Map001")).toBe("campaign:C/maps/Map001.json");
    expect(campaignMapBytesId("C", "Map001")).toBe("campaign:C/maps/Map001.bytes");
    expect(campaignMapImageId("C", "Map001")).toBe("campaign:C/images/maps/Map001.png");
    expect(campaignItemsId("C")).toBe("campaign:C/items/items.json");
    expect(campaignFolderId("C", CAMPAIGN_FOLDERS.maps)).toBe("campaign:C/maps");
    expect(campaignFileId("C", "audio/bgm.mp3")).toBe("campaign:C/audio/bgm.mp3");
  });

  it("从 ID 反推跑团名与相对路径", () => {
    const id = campaignMapImageId("我的跑团", "Map001");
    expect(campaignNameFromId(id)).toBe("我的跑团");
    expect(campaignRelativePathFromId(id)).toBe("images/maps/Map001.png");
  });

  it("反推时校验类别与工程文件名", () => {
    expect(() => campaignNameFromId("config:app.json")).toThrow(/不是跑团资源 ID/);
    expect(() => campaignNameFromId("campaign:C")).toThrow(/缺少跑团名/);
    expect(() => campaignNameFromProjectId(campaignMapId("C", "Map001"))).toThrow(
      /不是跑团工程文件 ID/,
    );
  });

  it("编辑器全局配置 ID", () => {
    expect(configId("app")).toBe("config:app.json");
    expect(formatResourceId("campaign", "C/x")).toBe("campaign:C/x");
  });
});

describe("内存资源实现", () => {
  it("读写文本与二进制", async () => {
    const provider = createMemoryResourceProvider();
    await provider.writeText(configId("editor"), '{"theme":"dark"}');
    expect(await provider.readText(configId("editor"))).toBe('{"theme":"dark"}');

    await provider.writeBinary(campaignMapBytesId("C", "Map001"), new Uint8Array([1, 2, 3]).buffer);
    expect(
      new Uint8Array(await provider.readBinary(campaignMapBytesId("C", "Map001"))),
    ).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("list 按类别过滤并带 size", async () => {
    const provider = createMemoryResourceProvider({
      "campaign:C/a.json": "{}",
      "config:app.json": "{}",
    });

    expect((await provider.list("campaign")).map((entry) => entry.id)).toEqual(["campaign:C/a.json"]);
    expect((await provider.list()).length).toBe(2);
  });

  it("ensureFolder 登记目录且不报错（重复调用也安全）", async () => {
    const provider = createMemoryResourceProvider();
    await provider.ensureFolder(campaignFolderId("C", "maps"));
    await provider.ensureFolder(campaignFolderId("C", "maps"));
    expect(provider.listFolders()).toEqual(["campaign:C/maps"]);
  });

  it("读取不存在的资源抛错", async () => {
    const provider = createMemoryResourceProvider();
    await expect(provider.readText(campaignProjectId("Nope"))).rejects.toThrow(/资源不存在/);
    expect(await provider.exists(campaignProjectId("Nope"))).toBe(false);
  });

  it("非法 ID 不落盘", async () => {
    const provider = createMemoryResourceProvider();
    await expect(provider.writeText("bogus:x", "y")).rejects.toThrow(/未知资源类别/);
    await expect(provider.ensureFolder("campaign:../x")).rejects.toThrow(/不允许越出资源根/);
  });
});

describe("应用配置", () => {
  it("缺省时给出内置默认值", () => {
    const config = defaultAppConfig();
    expect(config.resourceRoot).toBe("resources");
    expect(config.server.port).toBe(1420);
    expect(config.defaultCellPixels).toBe(30);
    expect(config.dirs.config).toBe("config");
    expect(config.dirs.campaign).toBe("campaigns");
    expect(config.campaignFolders).toContain("maps");
    expect(config.campaignFolders).toContain("images/maps");
  });

  it("自定义目录名生效（代码不硬编码目录）", () => {
    const config = parseAppConfig({ dirs: { ...defaultAppConfig().dirs, campaign: "runs" } });
    expect(config.dirs.campaign).toBe("runs");
  });

  it("非法配置抛出带路径的错误", () => {
    expect(() => parseAppConfig({ server: { port: 99999 } })).toThrow(/app 配置校验失败/);
    expect(() => parseAppConfig({ resourceRoot: "" })).toThrow(/app 配置校验失败/);
  });
});
