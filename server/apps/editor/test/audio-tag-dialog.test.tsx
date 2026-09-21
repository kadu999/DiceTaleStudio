import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createEmptyProject } from "@dts/document";
import { AudioTagDialog } from "../src/app/AudioTagDialog";
import { projectHistory, sceneHistory, useEditorStore } from "../src/state/editor-store";
import type { ResourceTreeNode } from "../src/services/project-api";

/**
 * **「选择标签」框**（v18）：给一个音频文件**勾标签**——只做加 / 去。
 *
 * 标签是整数（名字住在标签表里），所以这一份钉住：
 * 1. 列的是**标签表里的全部标签**（含还没人用到的），带「N 个文件在用」；
 * 2. 点一行 = 给这个文件加上 / 去掉那个 **tag ID**（写进 `audioMeta`、可撤销）；
 * 3. 「新建」= 建出一个 tag ID **并立刻挂到这个文件上**（一条撤销记录）；
 * 4. 空态 / 目标文件查不到时的提示。
 */

const PROJECT = "测试";
const CLIP_A = `project:${PROJECT}/Assets/audio/theme.mp3`;
const CLIP_B = `project:${PROJECT}/Assets/audio/battle.wav`;
const GONE = `project:${PROJECT}/Assets/audio/deleted.mp3`;

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
  });
}

const docOf = (): ReturnType<typeof useEditorStore.getState>["doc"] =>
  useEditorStore.getState().doc;

const rowFor = (id: number): HTMLElement => {
  const row = screen
    .getAllByTestId("audio-tag-row")
    .find((item) => item.getAttribute("data-id") === String(id));
  if (row === undefined) {
    throw new Error(`选择框里没有这个 tag：${id}`);
  }

  return row;
};

const toggleFor = (id: number): HTMLElement =>
  rowFor(id).querySelector('[data-testid="audio-tag-toggle"]') as HTMLElement;

afterEach(() => {
  cleanup();
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

describe("列标签 / 勾选", () => {
  it("列出标签表里的全部标签（含没人用的），按用量排序并标 ID", () => {
    seed({
      tags: ["战斗", "紧张", "环境"],
      meta: { [CLIP_A]: { tags: [0, 1] }, [CLIP_B]: { tags: [0] } },
    });
    render(<AudioTagDialog clipId={CLIP_A} onClose={() => undefined} />);

    expect(screen.getAllByTestId("audio-tag-row").map((row) => row.getAttribute("data-id"))).toEqual([
      "0",
      "1",
      "2",
    ]);
    expect(rowFor(0).getAttribute("data-count")).toBe("2");
    expect(rowFor(0).textContent).toContain("#0");
    expect(rowFor(0).textContent).toContain("2 个文件在用");
    expect(rowFor(2).textContent).toContain("0 个文件在用");

    // 这个文件本来就有 0 / 1 → 勾着；2 没有
    expect(rowFor(0).getAttribute("data-selected")).toBe("true");
    expect(rowFor(1).getAttribute("data-selected")).toBe("true");
    expect(rowFor(2).getAttribute("data-selected")).toBe("false");
  });

  it("点一行 = 给这个文件加上那个 tag ID；再点 = 去掉（写进 audioMeta，可撤销）", () => {
    seed({ tags: ["战斗", "紧张"], meta: { [CLIP_A]: { tags: [0] }, [CLIP_B]: { tags: [1] } } });
    render(<AudioTagDialog clipId={CLIP_A} onClose={() => undefined} />);

    fireEvent.click(toggleFor(1));
    expect(docOf().audioMeta?.[CLIP_A]?.tags).toEqual([0, 1]);

    act(() => {
      useEditorStore.getState().undo();
    });
    expect(docOf().audioMeta?.[CLIP_A]?.tags).toEqual([0]);
    expect(rowFor(1).getAttribute("data-selected")).toBe("false");

    // 去掉 #0（别的文件上那份不受影响）
    fireEvent.click(toggleFor(0));
    expect(docOf().audioMeta?.[CLIP_A]).toBeUndefined();
    expect(docOf().audioMeta?.[CLIP_B]?.tags).toEqual([1]);
  });

  it("洞（删过的 tag）不出现在列表里", () => {
    seed({ tags: ["战斗", null, "环境"], meta: { [CLIP_A]: { tags: [2] } } });
    render(<AudioTagDialog clipId={CLIP_A} onClose={() => undefined} />);

    expect(screen.getAllByTestId("audio-tag-row").map((row) => row.getAttribute("data-id"))).toEqual([
      "2",
      "0",
    ]);
  });

  it("「标签…」入口：先收起本框，再打开标签表窗口（改名 / 删除在那边做）", () => {
    seed({ tags: ["战斗"], meta: { [CLIP_A]: { tags: [0] } } });
    let closed = 0;
    render(
      <AudioTagDialog
        clipId={CLIP_A}
        onClose={() => {
          closed += 1;
        }}
      />,
    );

    fireEvent.click(screen.getByTestId("audio-tag-open-editor"));

    expect(useEditorStore.getState().audioTags).toBe(true);
    expect(closed).toBe(1);
  });
});

describe("新建标签", () => {
  it("敲一个名字回车：建出一个 tag ID 并**立刻挂到这个文件上**（一条撤销记录）", () => {
    seed({ tags: ["战斗"], meta: { [CLIP_A]: { tags: [0] } } });
    render(<AudioTagDialog clipId={CLIP_A} onClose={() => undefined} />);

    const input = screen.getByTestId("audio-tag-new") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  开场  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(docOf().audioTags).toEqual(["战斗", "开场"]);
    expect(docOf().audioMeta?.[CLIP_A]?.tags).toEqual([0, 1]);
    expect(input.value).toBe("");
    expect(rowFor(1).getAttribute("data-selected")).toBe("true");

    // 一条撤销记录把两件事一起退回（表里那条也没了）
    act(() => {
      useEditorStore.getState().undo();
    });
    expect(docOf().audioTags).toEqual(["战斗"]);
    expect(docOf().audioMeta?.[CLIP_A]?.tags).toEqual([0]);
  });

  it("表里已有同名（含首尾空白差异）：复用那个 ID，只做勾选", () => {
    seed({ tags: ["战斗"], meta: { [CLIP_B]: { tags: [0] } } });
    render(<AudioTagDialog clipId={CLIP_A} onClose={() => undefined} />);

    fireEvent.change(screen.getByTestId("audio-tag-new"), { target: { value: " 战斗 " } });
    fireEvent.keyDown(screen.getByTestId("audio-tag-new"), { key: "Enter" });

    expect(docOf().audioTags).toEqual(["战斗"]);
    expect(docOf().audioMeta?.[CLIP_A]?.tags).toEqual([0]);
    expect(docOf().audioMeta?.[CLIP_B]?.tags).toEqual([0]);
  });

  it("标签表是空的：空态提示 + 空名字按钮点不动", () => {
    seed();
    render(<AudioTagDialog clipId={CLIP_A} onClose={() => undefined} />);

    expect(screen.getByTestId("audio-tag-empty").textContent).toContain("标签表还是空的");
    expect((screen.getByTestId("audio-tag-create") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId("audio-tag-new"), { target: { value: "战斗" } });
    fireEvent.click(screen.getByTestId("audio-tag-create"));

    expect(docOf().audioTags).toEqual(["战斗"]);
    expect(docOf().audioMeta?.[CLIP_A]?.tags).toEqual([0]);
  });
});

describe("目标与关闭", () => {
  it("标题写清是哪个文件；关掉调用 onClose", () => {
    seed({ tags: ["战斗"], meta: { [CLIP_A]: { name: "开场曲", tags: [0] } } });
    const onClose = () => undefined;
    render(<AudioTagDialog clipId={CLIP_A} onClose={onClose} />);

    expect(screen.getByTestId("audio-tag-dialog").textContent).toContain("开场曲");

    fireEvent.click(screen.getByTestId("audio-tag-close"));
  });

  it("目标文件已从盘上删掉（missing 行）：照旧能勾选", () => {
    seed({ tags: ["战斗"], meta: { [GONE]: { name: "删掉的那首", tags: [0] } } });
    render(<AudioTagDialog clipId={GONE} onClose={() => undefined} />);

    expect(screen.getByTestId("audio-tag-dialog").textContent).toContain("删掉的那首");
    expect(rowFor(0).getAttribute("data-selected")).toBe("true");

    fireEvent.click(toggleFor(0));
    expect(docOf().audioMeta?.[GONE]).toEqual({ name: "删掉的那首" });
  });

  it("目标 id 在清单里查不到（防御分支）：只提示、不再给新建那一行", () => {
    seed({ tags: ["战斗"] });
    render(
      <AudioTagDialog
        clipId={`project:${PROJECT}/Assets/audio/unknown.mp3`}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByTestId("audio-tag-dialog").textContent).toContain("这个音频文件已经不在了");
    expect(screen.queryByTestId("audio-tag-new")).toBeNull();
  });
});
