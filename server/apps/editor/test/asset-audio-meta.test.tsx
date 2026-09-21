import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createEmptyProject } from "@dts/document";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { projectHistory, sceneHistory, useEditorStore } from "../src/state/editor-store";
import type { ResourceTreeNode } from "../src/services/project-api";

/**
 * **音频文件的属性面板**（v17 / v18）：显示名 + 标签**就地改**。
 *
 * 「音频文件」那个列表窗口在 v18 删掉了——「选中哪个就改哪个」本来就是这个面板的用法，
 * 多一个窗口只是让人多跳一次。所以这一份钉住：
 * 1. 名称仍是**真实文件名**，显示名是就地可改的输入框（留空 = 退回文件名）；
 * 2. 标签按**名字**显示（文档里是整数 ID），`×` = 只从这个文件上摘掉；
 * 3. 「＋ 标签」打开**选择标签**框（给这个文件勾 / 去）；「标签…」打开**标签表**窗口；
 * 4. 图片 / 视频资源不出现这两行。
 */

const PROJECT = "测试";
const CLIP_A = `project:${PROJECT}/Assets/audio/theme.mp3`;
const CLIP_B = `project:${PROJECT}/Assets/audio/battle.wav`;
const IMAGE = `project:${PROJECT}/Assets/images/Map001.png`;

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
      {
        name: "images",
        path: "Assets/images",
        id: `project:${PROJECT}/Assets/images`,
        type: "folder",
        children: [
          { name: "Map001.png", path: "Assets/images/Map001.png", id: IMAGE, type: "file" },
        ],
      },
    ],
  },
];

function seed(input: {
  readonly assetId: string;
  readonly tags?: (string | null)[];
  readonly meta?: Record<string, { name?: string; tags?: number[] }>;
}): void {
  projectHistory.reset({
    ...createEmptyProject(PROJECT),
    ...(input.tags === undefined ? {} : { audioTags: [...input.tags] }),
    ...(input.meta === undefined ? {} : { audioMeta: input.meta }),
  });
  useEditorStore.setState({
    doc: projectHistory.current,
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    selectedAssetId: input.assetId,
    project: { list: [], current: PROJECT, tree: TREE, busy: false, error: "" },
  });
}

const docOf = (): ReturnType<typeof useEditorStore.getState>["doc"] =>
  useEditorStore.getState().doc;

const nameField = (): HTMLInputElement =>
  screen.getByTestId("asset-audio-name") as HTMLInputElement;

const tagChip = (id: number): HTMLElement => {
  const chip = screen
    .getAllByTestId("asset-audio-tag")
    .find((item) => item.getAttribute("data-id") === String(id));
  if (chip === undefined) {
    throw new Error(`面板里没有这个标签：${id}`);
  }

  return chip;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sceneHistory.reset([]);
  projectHistory.reset(createEmptyProject());
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    selectedAssetId: null,
    mode: "edit",
    audioTags: false,
    projectSaveState: "saved",
    project: { list: [], current: null, tree: [], busy: false, error: "" },
  });
});

describe("显示名", () => {
  it("名称是真实文件名；显示名就地改（Enter 提交），留空 = 退回文件名", () => {
    seed({ assetId: CLIP_A, tags: ["战斗"], meta: { [CLIP_A]: { tags: [0] } } });
    render(<InspectorPanel />);

    const properties = screen.getByTestId("asset-properties");
    expect(properties.textContent).toContain("theme.mp3");
    // 没起过名字：输入框空着，占位就是文件名
    expect(nameField().value).toBe("");
    expect(nameField().placeholder).toBe("theme.mp3");

    fireEvent.change(nameField(), { target: { value: "开场曲" } });
    fireEvent.keyDown(nameField(), { key: "Enter" });

    expect(docOf().audioMeta?.[CLIP_A]).toEqual({ name: "开场曲", tags: [0] });

    // Esc 还原（改一半不提交）
    fireEvent.change(nameField(), { target: { value: "改一半" } });
    fireEvent.keyDown(nameField(), { key: "Escape" });
    expect(nameField().value).toBe("开场曲");

    // 留空 = 清掉名字（标签留着，于是这一条不消失）
    fireEvent.change(nameField(), { target: { value: "   " } });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    expect(docOf().audioMeta?.[CLIP_A]).toEqual({ tags: [0] });
  });

  it("属性面板是**可撤销**的（走工程文件那条历史）", () => {
    seed({ assetId: CLIP_A });
    render(<InspectorPanel />);

    fireEvent.change(nameField(), { target: { value: "开场曲" } });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    expect(docOf().audioMeta?.[CLIP_A]?.name).toBe("开场曲");

    act(() => {
      useEditorStore.getState().undo();
    });
    expect(docOf().audioMeta).toBeUndefined();
  });
});

describe("标签", () => {
  it("按**名字**列出已勾的标签（文档里是整数 ID）；没有标签时写「没有标签」", () => {
    seed({
      assetId: CLIP_A,
      tags: ["战斗", "紧张"],
      meta: { [CLIP_A]: { tags: [1] } },
    });
    render(<InspectorPanel />);

    expect(screen.getAllByTestId("asset-audio-tag")).toHaveLength(1);
    expect(tagChip(1).textContent).toContain("紧张");
    expect(tagChip(1).getAttribute("data-tag")).toBe("紧张");
  });

  it("× = 只从这个文件上摘掉那个 tag（标签本身还在表里）", () => {
    seed({ assetId: CLIP_A, tags: ["战斗"], meta: { [CLIP_A]: { tags: [0] }, [CLIP_B]: { tags: [0] } } });
    render(<InspectorPanel />);

    fireEvent.click(
      tagChip(0).querySelector('[data-testid="asset-audio-tag-remove"]') as HTMLElement,
    );

    expect(docOf().audioMeta?.[CLIP_A]).toBeUndefined();
    expect(docOf().audioMeta?.[CLIP_B]?.tags).toEqual([0]);
    expect(docOf().audioTags).toEqual(["战斗"]);
  });

  it("「＋ 标签」打开选择标签框（给这个文件勾）；「标签…」打开标签表窗口", () => {
    seed({ assetId: CLIP_A, tags: ["战斗"], meta: {} });
    render(<InspectorPanel />);

    expect(screen.queryByTestId("audio-tag-dialog")).toBeNull();

    fireEvent.click(screen.getByTestId("asset-audio-add-tag"));
    expect(screen.getByTestId("audio-tag-dialog")).toBeDefined();
    // 目标就是这个文件（标题里是它的显示名 / 文件名）
    expect(screen.getByTestId("audio-tag-dialog").textContent).toContain("theme");

    // 在框里勾上那个标签 → 属性面板的 chip 跟着出现
    fireEvent.click(
      screen
        .getAllByTestId("audio-tag-toggle")
        .find((item) => item.getAttribute("data-id") === "0") as HTMLElement,
    );
    expect(docOf().audioMeta?.[CLIP_A]?.tags).toEqual([0]);

    fireEvent.click(screen.getByTestId("asset-audio-open-tags"));
    expect(useEditorStore.getState().audioTags).toBe(true);
  });
});

describe("只对音频出现", () => {
  it("图片资源没有显示名 / 标签这两行", () => {
    seed({ assetId: IMAGE });
    render(<InspectorPanel />);

    expect(screen.getByTestId("asset-properties").textContent).toContain("Map001.png");
    expect(screen.queryByTestId("asset-audio-name")).toBeNull();
    expect(screen.queryByTestId("asset-audio-tags")).toBeNull();
    expect(screen.queryByTestId("asset-audio-add-tag")).toBeNull();
    expect(screen.getByTestId("asset-preview-image")).toBeDefined();
  });
});
