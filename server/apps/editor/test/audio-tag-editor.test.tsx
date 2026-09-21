import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createEmptyProject } from "@dts/document";
import { AudioTagEditorDialog } from "../src/app/AudioTagEditorDialog";
import { projectHistory, sceneHistory, useEditorStore } from "../src/state/editor-store";
import type { ResourceTreeNode } from "../src/services/project-api";

/**
 * **「标签」窗口**（v18）：标签表本身的编辑页——**序号预先定好，只填名字**（对齐 Unity 的 TagManager）。
 *
 * 这一份钉住：
 * 1. 一列 `#0`…`#7` 一开始就在，已有槽位（哪怕超过一页）也全列出来；洞不画；
 * 2. **改名字只改表**：文件里记的 ID 一个字节都不动；
 * 3. 往哪个格子填名字，那个序号就是 ID（中间的空槽一起补出来），填满最后格自动续一页；
 * 4. 界面上**没有**新建输入框 / 新建按钮 / 删除按钮；
 * 5. 空名字不写进数据，Esc 还原。
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
  it("序号是预先铺好的：一列 #0…#15，已用过的名字在里面", () => {
    seed({
      tags: ["战斗", null, "环境"],
      meta: { [CLIP_A]: { tags: [0, 2] }, [CLIP_B]: { tags: [0] } },
    });
    render(<AudioTagEditorDialog />);

    // 16 个格子一开始就在（手填的是名字，序号不用自己挣）；洞（#1）那一格不给行
    expect(
      screen.getAllByTestId("audio-tag-editor-row").map((row) => row.getAttribute("data-id")),
    ).toEqual([
      "0",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
      "14",
      "15",
    ]);

    expect(nameInputFor(0).value).toBe("战斗");
    expect(nameInputFor(2).value).toBe("环境");
    // 还没起名字的格子：空的
    expect(nameInputFor(5).value).toBe("");
  });

  it("行里没有「多少个文件在用」（这一页只跟标签表打交道）", () => {
    seed({ tags: ["战斗"], meta: { [CLIP_A]: { tags: [0] } } });
    render(<AudioTagEditorDialog />);

    expect(screen.queryByTestId("audio-tag-editor-count")).toBeNull();
    expect(rowFor(0).textContent).not.toContain("个文件在用");
    // 序号直接写数字（不写 `#`）
    expect(rowFor(0).textContent).toContain("0");
  });

  it("已有数据比一屏长时：全列出来（序号不会被截断）", () => {
    seed({ tags: Array.from({ length: 20 }, (_, i) => `t${i}`), meta: {} });
    render(<AudioTagEditorDialog />);

    expect(screen.getAllByTestId("audio-tag-editor-row")).toHaveLength(20);
  });
});

describe("只填名字（没有新建 / 删除）", () => {
  it("界面上没有添加输入框、添加按钮、删除按钮", () => {
    seed({ tags: ["战斗"], meta: {} });
    render(<AudioTagEditorDialog />);

    expect(screen.queryByTestId("audio-tag-editor-new")).toBeNull();
    expect(screen.queryByTestId("audio-tag-editor-add")).toBeNull();
    expect(screen.queryByTestId("audio-tag-editor-delete")).toBeNull();
    expect(screen.queryByTestId("audio-tag-editor-empty")).toBeNull();
  });

  it("往空格子填名字：那个序号就是它的 ID（中间的空槽一起补出来）", () => {
    seed({ tags: ["战斗"], meta: {} });
    render(<AudioTagEditorDialog />);

    // #2 还空着，直接填它 → 表补到 3 格，#1 是「还没起名字」
    const input = nameInputFor(2);
    fireEvent.change(input, { target: { value: "环境" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(docOf().audioTags).toEqual(["战斗", "", "环境"]);
    expect(nameInputFor(1).value).toBe("");
  });

  it("填满最后一屏的最后一个格子会自动再接一屏（序号够用）", () => {
    seed({ tags: Array.from({ length: 15 }, (_, i) => `t${i}`), meta: {} });
    render(<AudioTagEditorDialog />);

    // 现在列到 #15（16 格）
    expect(screen.getAllByTestId("audio-tag-editor-row")).toHaveLength(16);

    const input = nameInputFor(15);
    fireEvent.change(input, { target: { value: "t15" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(docOf().audioTags).toHaveLength(16);
    // 后面又铺出一屏：#16 已经能填了
    expect(nameInputFor(16).value).toBe("");
  });

  it("空名字不写进数据（打开窗口随手点一下就关，不会留下空槽）", () => {
    seed({ tags: ["战斗"], meta: {} });
    render(<AudioTagEditorDialog />);

    const input = nameInputFor(3);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(docOf().audioTags).toEqual(["战斗"]);
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

  it("Esc 还原；空名字不提交", () => {
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

describe("关闭", () => {
  it("「关闭」把窗口关掉", () => {
    seed({ tags: ["战斗"], meta: {} });
    render(<AudioTagEditorDialog />);

    fireEvent.click(screen.getByTestId("audio-tag-editor-close"));

    expect(useEditorStore.getState().audioTags).toBe(false);
  });
});
