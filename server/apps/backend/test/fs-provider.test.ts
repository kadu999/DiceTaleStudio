import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createTempResourceRoot } from "./helpers/temp-root";
import { FsResourceProvider } from "../src/resources/fs-provider";
import { assetMetaIdOf, projectAssetId } from "@dts/resources";

/**
 * 文件系统资源实现的单元测试（从旧的 `run-state.test.ts` 拆出来）：
 * 资源路径不会逃出资源根，读写往返一致。
 */

describe("文件系统资源实现", () => {
  /** 只读用例：直接读仓库里真实的 resources/。 */
  async function realProvider(): Promise<FsResourceProvider> {
    const config = await loadConfig();
    return new FsResourceProvider(config.resourceRoot, config.dirs);
  }

  /** 写盘用例：临时资源根，避免写入仓库 resources/ 或与其它进程抢目录。 */
  async function withTempProvider(): Promise<{
    provider: FsResourceProvider;
    dispose: () => Promise<void>;
  }> {
    const temp = await createTempResourceRoot();
    return {
      provider: new FsResourceProvider(temp.config.resourceRoot, temp.config.dirs),
      dispose: temp.dispose,
    };
  }

  it("按配置解析资源根，只列出真实文件（跳过 .gitkeep）", async () => {
    const provider = await realProvider();
    const entries = await provider.list("config");

    expect(entries.map((entry) => entry.id)).toContain("config:app.json");
    expect(entries.every((entry) => entry.id.endsWith(".gitkeep"))).toBe(false);
  });

  it("全部资源列出时包含配置目录下的文件", async () => {
    const provider = await realProvider();
    const entries = await provider.list();
    expect(entries.some((entry) => entry.kind === "config")).toBe(true);
  });

  it("读写往返一致，删除时连目录一起清掉", async () => {
    const { provider, dispose } = await withTempProvider();
    const id = "project:__arch_test/project.json";

    try {
      await provider.writeText(id, "{\"hello\":\"世界\"}");
      expect(await provider.exists(id)).toBe(true);
      expect(await provider.readText(id)).toBe("{\"hello\":\"世界\"}");
    } finally {
      // 连目录一起清掉：writeText 会自动建出父目录，只删文件会留下空目录
      await provider.remove("project:__arch_test");
      await dispose();
    }

    expect(await provider.exists(id)).toBe(false);
  });

  it("目录也会被列出（编辑器要能看到空目录）", async () => {
    const { provider, dispose } = await withTempProvider();
    try {
      await provider.ensureFolder("project:C/maps");

      // 文件系统会同时列出中间目录（C）与目标目录（C/maps）
      const entries = await provider.list("project");
      const described = entries.map((entry) => `${entry.type}:${entry.path}`);
      expect(described).toContain("folder:C");
      expect(described).toContain("folder:C/maps");
      expect(entries.every((entry) => entry.size === 0)).toBe(true);
    } finally {
      await dispose();
    }
  });

  it("二进制读写往返一致", async () => {
    const { provider, dispose } = await withTempProvider();
    const id = "project:__arch_test/maps/__arch_test.bytes";

    try {
      const payload = new Uint8Array([1, 2, 3, 250]).buffer;
      await provider.writeBinary(id, payload);
      expect(new Uint8Array(await provider.readBinary(id))).toEqual(new Uint8Array([1, 2, 3, 250]));
    } finally {
      await dispose();
    }
  });

  it("listing creates missing sidecars for externally added assets", async () => {
    const { provider, dispose } = await withTempProvider();
    const imageId = projectAssetId("external", "Assets/images/new.png");
    try {
      await provider.writeBinary(imageId, new Uint8Array([1, 2, 3]).buffer);
      await provider.remove(assetMetaIdOf(imageId));

      const entries = await provider.list("project");
      expect(entries.map((entry) => entry.id)).toContain(imageId);
      const meta = JSON.parse(await provider.readText(assetMetaIdOf(imageId))) as {
        guid: string;
        importer: string;
      };
      expect(meta.importer).toBe("texture");
      expect(meta.guid).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      await dispose();
    }
  });

  it("拒绝越出资源根的路径", async () => {
    const provider = await realProvider();
    await expect(provider.readText("config:../../package.json")).rejects.toThrow(
      /不允许越出资源根/,
    );
  });

  it("配置里的绝对路径目录被拒绝（防止写到仓库外）", async () => {
    const config = await loadConfig();
    expect(
      () =>
        new FsResourceProvider(config.resourceRoot, {
          ...config.dirs,
          project: "C:\\Windows",
        }),
    ).toThrow(/不允许是绝对路径/);
  });

  it("配置里的相对逃逸目录被拒绝", async () => {
    const config = await loadConfig();
    expect(
      () =>
        new FsResourceProvider(config.resourceRoot, {
          ...config.dirs,
          project: "../outside",
        }),
    ).toThrow(/越出资源根/);
  });
});
