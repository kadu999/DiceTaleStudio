import { describe, expect, it } from "vitest";
import {
  defaultEditorPrefs,
  isTransformTool,
  parseEditorPrefs,
  readEditorPrefs,
  writeEditorPrefs,
} from "../src/services/editor-prefs";

/**
 * 编辑器界面偏好（浏览器本地）。
 *
 * 与网格标注偏好（`grid-paint-prefs`）同一套约定：**坏数据一律退回默认值，绝不抛错**。
 * 存储是用户能改的、也能被旧版本写坏，编辑器不该因为一条脏记录就打不开。
 */

describe("默认值", () => {
  it("默认是「拖动」——正是手柄出现之前那个行为", () => {
    expect(defaultEditorPrefs()).toEqual({ tool: "none" });
  });
});

describe("解析", () => {
  it("认得四个工具", () => {
    expect(parseEditorPrefs({ tool: "none" }).tool).toBe("none");
    expect(parseEditorPrefs({ tool: "move" }).tool).toBe("move");
    expect(parseEditorPrefs({ tool: "rotate" }).tool).toBe("rotate");
    expect(parseEditorPrefs({ tool: "scale" }).tool).toBe("scale");
  });

  it("认不出的工具名退回默认值（而不是塞进状态里让画布拿到一个不存在的工具）", () => {
    expect(parseEditorPrefs({ tool: "delete" }).tool).toBe("none");
    expect(parseEditorPrefs({ tool: 42 }).tool).toBe("none");
    expect(parseEditorPrefs({}).tool).toBe("none");
  });

  it("非对象一律退回默认值", () => {
    for (const raw of [null, undefined, "scale", 7, ["scale"]]) {
      expect(parseEditorPrefs(raw).tool).toBe("none");
    }
  });

  it("用具名判定函数而不是内联比较（存储是外部输入）", () => {
    expect(isTransformTool("rotate")).toBe(true);
    expect(isTransformTool("Rotate")).toBe(false);
    expect(isTransformTool(null)).toBe(false);
  });
});

describe("读写", () => {
  it("写进去能读回来", () => {
    writeEditorPrefs({ tool: "rotate" });

    expect(readEditorPrefs().tool).toBe("rotate");
  });

  it("没有记录时读默认值", () => {
    window.localStorage.clear();

    expect(readEditorPrefs().tool).toBe("none");
  });

  it("内容损坏（不是 JSON）时读默认值，不抛错", () => {
    window.localStorage.setItem("dts.editor.ui", "{ 这不是 JSON");

    expect(readEditorPrefs().tool).toBe("none");
  });

  it("存储不可用时照样工作（隐私模式下不该打不开编辑器）", () => {
    const original = window.localStorage.getItem;
    window.localStorage.getItem = () => {
      throw new Error("拒绝访问");
    };

    try {
      expect(readEditorPrefs().tool).toBe("none");
    } finally {
      window.localStorage.getItem = original;
    }
  });
});
