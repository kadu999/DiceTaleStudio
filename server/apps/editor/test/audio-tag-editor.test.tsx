import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createEmptyProject } from "@dts/document";
import { AudioTagEditorDialog } from "../src/app/AudioTagEditorDialog";
import { projectHistory, sceneHistory, useEditorStore } from "../src/state/editor-store";
import type { ResourceTreeNode } from "../src/services/project-api";

/**
 * **「标签」窗口**（v18）：标签表本身的编辑页——新建 / 改名 / 删除。
 *
 * 学 Unity：**tag 是个整数**（表的下标 `#0`、`#1`…），名字只是显示文本。这一份钉住：
 * 1. 列出表里每个 ID + 名字 + 「N 个文件在用」（洞不显示）；
 * 2. **改名字只改表**：文件里记的 ID 一个字节都不动；
 * 3. 新建：往后发 ID；删过的洞优先复用；
 * 4. 删除：从所有文件上摘掉 + 表里留洞（二次确认；取消什么都不做）；
 * 5. 空名字不提交（要「不显示」就删掉它）。
 */

const PROJECT = "测试";
const CLIP_A = `project:${PROJECT}/Assets/audio/theme.mp3`;
const CLIP_B = `project:${PROJECT}/Assets/audio/battle.wav`;

const TREE: ResourceTreeNode[] = [
  {
    name: "Assets",
    path: "Assets",
    id: `project:${PROJECT}/Assets`,
    type: "folder",
    children: [
      {
        name: "audio",
        path: "Assets/audio",
        id: `project:${PROJECT}/Assets/audio`,
        type: "folder",
        children: [
          { name: "theme.mp3", path: "Assets/audio/theme.mp3", id: CLIP_A, type: "file" },
          { name: "battle.wav", path: "Assets/audio/battle.wav", id: CLIP_B, type: "file" },
        ],
      },
    ],
  },
];

function seed(input?: {
  readonly tags?: (string | null)[];
  readonly meta?: Record<string, { name?: string; tags?: number[] }>;
}): void {
  projectHistory.reset({
    ...createEmptyProject(PROJECT),
    ...(input?.tags === undefined ? {} : { audioTags: [...input.tags] }),
    ...(input?.meta === undefined ? {} : { audioMeta: input.meta }),
  });
  useEditorStore.setState({
    doc: projectHistory.current,
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    project: { list: [], current: PROJECT, tree: TREE, busy: false, error: "" },
    audioTags: true,
  });
}

const docOf = (): ReturnType<typeof useEditorStore.getState>["doc"] =>
  useEditorStore.getState().doc;

const rowFor = (id: number): HTMLElement => {
  const row = screen
    .getAllByTestId("audio-tag-editor-row")
    .find((item) => item.getAttribute("data-id") === String(id));
  if (row === undefined) {
    throw new Error(`窗口里没有这个 tag：${id}`);
  }

  return row;
};

const nameInputFor = (id: number): HTMLInputElement =>
  rowFor(id).querySelector<HTMLInputElement>('[data-testid="audio-tag-editor-name"]') as HTMLInputElement;

const deleteFor = (id: number): HTMLElement =>
  rowFor(id).querySelector('[data-testid="audio-tag-editor-delete"]') as HTMLElement;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sceneHistory.reset([]);
  projectHistory.reset(createEmptyProject());
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    mode: "edit",
    audioTags: false,
    projectSaveState: "saved",
    project: { list: [], current: null, tree: [], busy: false, error: "" },
  });
});

describe("列出标签表", () => {
  it("每个 ID 一行：名字 + 用量；洞不显示", () => {
    seed({
      tags: ["战斗", null, "环境"],
      meta: { [CLIP_A]: { tags: [0, 2] }, [CLIP_B]: { tags: [0] } },
    });
    render(<AudioTagEditorDialog />);

    expect(
      screen.getAllByTestId("audio-tag-editor-row").map((row) => row.getAttribute("data-id")),
    ).toEqual(["0", "2"]);
    expect(rowFor(0).textContent).toContain("#0");
    expect(rowFor(0).textContent).toContain("2 个文件在用");
    expect(rowFor(2).textContent).toContain("1 个文件在用");
    expect(nameInputFor(0).value).toBe("战斗");
  });

  it("表是空的：空态提示", () => {
    seed();
    render(<AudioTagEditorDialog />);

    expect(screen.getByTestId("audio-tag-editor-empty").textContent).toContain("还没有标签");
  });
});

describe("改名（只改表）", () => {
  it("改名字：表变了，文件里的 ID 一个字节不动", () => {
    seed({ tags: ["战斗", "紧张"], meta: { [CLIP_A]: { tags: [0, 1] } } });
    render(<AudioTagEditorDialog />);

    const input = nameInputFor(0);
    fireEvent.change(input, { target: { value: "交战" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(docOf().audioTags).toEqual(["交战", "紧张"]);
    expect(docOf().audioMeta?.[CLIP_A]?.tags).toEqual([0, 1]);
    expect(nameInputFor(0).value).toBe("交战");
  });

  it("Esc 还原；空名字不提交（要「不显示」就删掉它）", () => {
    seed({ tags: ["战斗"], meta: { [CLIP_A]: { tags: [0] } } });
    render(<AudioTagEditorDialog />);

    const input = nameInputFor(0);
    fireEvent.change(input, { target: { value: "改一半" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(docOf().audioTags).toEqual(["战斗"]);
    expect(nameInputFor(0).value).toBe("战斗");

    fireEvent.change(nameInputFor(0), { target: { value: "   " } });
    fireEvent.keyDown(nameInputFor(0), { key: "Enter" });
    expect(docOf().audioTags).toEqual(["战斗"]);
  });
});

describe("新建", () => {
  it("后面接着发 ID；同名复用已有的那个", () => {
    seed({ tags: ["战斗"], meta: {} });
    render(<AudioTagEditorDialog />);

    fireEvent.change(screen.getByTestId("audio-tag-editor-new"), { target: { value: "紧张" } });
    fireEvent.keyDown(screen.getByTestId("audio-tag-editor-new"), { key: "Enter" });

    expect(docOf().audioTags).toEqual(["战斗", "紧张"]);
    expect(
      screen.getAllByTestId("audio-tag-editor-row").map((row) => row.getAttribute("data-id")),
    ).toEqual(["0", "1"]);

    fireEvent.change(screen.getByTestId("audio-tag-editor-new"), { target: { value: " 战斗 " } });
    fireEvent.click(screen.getByTestId("audio-tag-editor-add"));

    expect(docOf().audioTags).toEqual(["战斗", "紧张"]);
  });

  it("删过的洞优先复用（ID 不位移）", () => {
    seed({ tags: ["战斗", "紧张"], meta: { [CLIP_A]: { tags: [1] } } });
    render(<AudioTagEditorDialog />);

    // 先删 #0 → 留洞
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(deleteFor(0));
    expect(docOf().audioTags).toEqual([null, "紧张"]);

    // 新建：占回 #0
    fireEvent.change(screen.getByTestId("audio-tag-editor-new"), { target: { value: "追击" } });
    fireEvent.keyDown(screen.getByTestId("audio-tag-editor-new"), { key: "Enter" });

    expect(docOf().audioTags).toEqual(["追击", "紧张"]);
    // 文件上指向 #1 的引用没动
    expect(docOf().audioMeta?.[CLIP_A]?.tags).toEqual([1]);
  });

  it("空名字：按钮点不动、回车也不建", () => {
    seed({ tags: ["战斗"], meta: {} });
    render(<AudioTagEditorDialog />);

    expect((screen.getByTestId("audio-tag-editor-add") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId("audio-tag-editor-new"), { target: { value: "   " } });
    fireEvent.keyDown(screen.getByTestId("audio-tag-editor-new"), { key: "Enter" });
    expect(docOf().audioTags).toEqual(["战斗"]);
  });
});

describe("删除（从所有文件上摘掉 + 留洞）", () => {
  it("确认后：表里留洞、两边文件都没了；能撤销", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    seed({
      tags: ["战斗", "紧张"],
      meta: { [CLIP_A]: { tags: [0, 1] }, [CLIP_B]: { tags: [0] } },
    });
    render(<AudioTagEditorDialog />);

    fireEvent.click(deleteFor(0));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("2 个音频文件"));
    expect(docOf().audioTags).toEqual([null, "紧张"]);
    expect(docOf().audioMeta).toEqual({ [CLIP_A]: { tags: [1] } });

    act(() => {
      useEditorStore.getState().undo();
    });
    expect(docOf().audioTags).toEqual(["战斗", "紧张"]);
    expect(docOf().audioMeta?.[CLIP_B]?.tags).toEqual([0]);
  });

  it("取消确认：什么都不动", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    seed({ tags: ["战斗"], meta: { [CLIP_A]: { tags: [0] } } });
    render(<AudioTagEditorDialog />);

    fireEvent.click(deleteFor(0));

    expect(docOf().audioTags).toEqual(["战斗"]);
    expect(docOf().audioMeta?.[CLIP_A]?.tags).toEqual([0]);
  });

  it("删掉最后一个标签：audioTags / audioMeta 都收干净", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    seed({ tags: ["战斗"], meta: { [CLIP_A]: { tags: [0] } } });
    render(<AudioTagEditorDialog />);

    fireEvent.click(deleteFor(0));

    expect(docOf().audioTags).toBeUndefined();
    expect(docOf().audioMeta).toBeUndefined();
    expect(screen.getByTestId("audio-tag-editor-empty")).toBeDefined();
  });
});

describe("关闭", () => {
  it("「关闭」把窗口关掉", () => {
    seed({ tags: ["战斗"], meta: {} });
    render(<AudioTagEditorDialog />);

    fireEvent.click(screen.getByTestId("audio-tag-editor-close"));

    expect(useEditorStore.getState().audioTags).toBe(false);
  });
});
