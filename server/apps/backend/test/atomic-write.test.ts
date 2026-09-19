import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsResourceProvider } from "../src/resources/fs-provider";
import { projectAssetId, projectFileId, formatResourceId, projectPath } from "@dts/resources";
import { createTempResourceRoot } from "./helpers/temp-root";

/**
 * 资源写入是**原子的**：任何时刻读到的一定是「旧内容」或「新内容」，不会是半截。
 *
 * 为什么值得单独钉一条：场景文件是「随时随地自动存」的，编辑器、e2e 用例、外部工具都可能在
 * 写的同时读它。以前 `writeFile` 是「先截断再写」，并发读能读到空文件，于是冒出
 * `Unexpected end of JSON input` 这种和操作毫不相干的偶发错误。
 */

const PROJECT = "__原子写__";
const FILE = projectAssetId(PROJECT, "Assets/scenes/Map001.json");

describe("资源写入的原子性", () => {
  let provider: FsResourceProvider;
  let dispose: () => Promise<void>;

  beforeEach(async () => {
    const temp = await createTempResourceRoot();
    dispose = temp.dispose;
    provider = new FsResourceProvider(temp.config.resourceRoot, temp.config.dirs);
  });

  afterEach(async () => {
    await dispose();
  });

  it("读写交错时，每次读到的都是完整的旧内容或新内容", async () => {
    // 内容做大一点，把「截断 → 写完」之间的窗口撑开，让并发读更容易撞上
    const oldText = JSON.stringify({ version: "old", payload: "a".repeat(200_000) });
    const newText = JSON.stringify({ version: "new", payload: "b".repeat(200_000) });
    await provider.writeText(FILE, oldText);

    const writes = Array.from({ length: 8 }, (_, index) => index).map((index) =>
      provider.writeText(FILE, index % 2 === 0 ? newText : oldText),
    );
    const reads = Array.from({ length: 24 }, () => provider.readText(FILE));

    const results = await Promise.all([...writes, ...reads]);
    const readBack = results.slice(writes.length) as string[];

    for (const text of readBack) {
      // 半截 JSON 会在这里炸（正是要避免的那种偶发失败）
      const parsed = JSON.parse(text) as { version: string; payload: string };
      expect(["old", "new"]).toContain(parsed.version);
      expect(parsed.payload).toHaveLength(200_000);
    }
  });

  it("临时文件不会出现在资源列表里", async () => {
    await provider.writeText(FILE, "{}");

    const entries = await provider.list("project");
    expect(entries.some((entry) => entry.path.endsWith(".dts-tmp"))).toBe(false);
    // 项目根、项目文件与这个资源都照常在
    expect((await provider.list("project")).map((entry) => entry.path)).toContain(
      projectPath(PROJECT),
    );
    expect(await provider.exists(projectFileId(PROJECT))).toBe(false);
    expect(formatResourceId("project", projectPath(PROJECT, "Assets/scenes/Map001.json"))).toBe(FILE);
    expect(await provider.readText(FILE)).toBe("{}");
  });
});
