import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { assetTagsOfMeta, createAssetMetas, createEmptyProject, emptyAssetMetas } from "@dts/document";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { metaHistory } from "../src/state/store-core";
import { projectHistory, sceneHistory, useEditorStore } from "../src/state/editor-store";
import type { ResourceTreeNode } from "../src/services/project-api";
import { audioMetaTable } from "./asset-meta-fixtures";

/**
 * **素材文件的属性面板**：显示名 + 标签**就地改**。
 *
 * 「音频文件」那个列表窗口在 v18 删掉了——「选中哪个就改哪个」本来就是这个面板的用法，
 * 多一个窗口只是让人多跳一次。所以这一份钉住：
 * 1. 名称仍是**真实文件名**，显示名是就地可改的输入框（留空 = 退回文件名；显示名只有音频有）；
 * 2. 标签按**名字**显示（文档里是整数 ID），`×` = 只从这个文件上摘掉——**任何素材**
 *    （图 / 音频 / 视频）都有这一行；
 * 3. 「＋ 标签」打开**选择标签**框（给这个文件勾 / 去）；「标签…」打开**标签表**窗口；
 * 4. 图片 / 视频资源没有显示名那一行。
 *
 * 数据住哪（v24 起）：显示名与标签在**那个文件自己的 `.meta`**（显示名在 `audio` 段、
 * 标签在顶层 `tags`），所以这里种的是 `assetMetaTable`；改动落在**素材 meta 那条轨道**上
 * （`metaHistory`），标签的**名字**仍在工程文件的 `audioTags` 里。
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
  });
  // v24 起显示名与标签住在**那个文件自己的 `.meta`** 里：种一张「路径 ID → meta」的表，
  // 再派生出索引（属性面板读真源表，别的面板读索引——与真实打开项目后的样子一致）
  const table = audioMetaTable(input.meta ?? {});
  metaHistory.reset(table);
  useEditorStore.setState({
    doc: projectHistory.current,
    assetMetaTable: table,
    assetMetas: createAssetMetas(Object.entries(table).map(([id, meta]) => ({ id, meta }))),
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    selectedAssetId: input.assetId,
    project: { list: [], current: PROJECT, tree: TREE, busy: false, error: "" },
  });
}

const docOf = (): ReturnType<typeof useEditorStore.getState>["doc"] =>
  useEditorStore.getState().doc;

/** 素材 meta 的真源表（v24 起音频的显示名 / 标签就在它的 `audio` 段里）。 */
const metas = (): ReturnType<typeof useEditorStore.getState>["assetMetaTable"] =>
  useEditorStore.getState().assetMetaTable;

/** 读这个文件的标签（任何素材都写顶层 `tags`，音频旧数据在 `audio.tags`——统一走 `assetTagsOfMeta`）。 */
const audioOf = (id: string): { name?: string; tags?: number[] } | undefined => {
  const meta = metas()[id];
  // 名字与标签都空了 = 「没整理过」（meta 只剩 guid / importer 那个壳，等同 undefined）
  if (meta === undefined || (meta.audio === undefined && assetTagsOfMeta(meta).length === 0)) {
    return undefined;
  }

  const tags = assetTagsOfMeta(meta);
  return { name: meta.audio?.name, tags: tags.length === 0 ? undefined : [...tags] };
};

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
  // 素材 meta 是**第三条轨道**：不重置它，上一个用例写下的显示名 / 标签会漏到下一个用例
  metaHistory.reset({});
  useEditorStore.setState({ assetMetaTable: {}, assetMetas: emptyAssetMetas() });
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

    expect(audioOf(CLIP_A)).toEqual({ name: "开场曲", tags: [0] });

    // Esc 还原（改一半不提交）
    fireEvent.change(nameField(), { target: { value: "改一半" } });
    fireEvent.keyDown(nameField(), { key: "Escape" });
    expect(nameField().value).toBe("开场曲");

    // 留空 = 清掉名字（标签留着，于是这一条不消失）
    fireEvent.change(nameField(), { target: { value: "   " } });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    expect(audioOf(CLIP_A)).toEqual({ tags: [0] });
  });

  it("属性面板是**可撤销**的（走素材 meta 那条历史）", () => {
    seed({ assetId: CLIP_A });
    render(<InspectorPanel />);

    fireEvent.change(nameField(), { target: { value: "开场曲" } });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    expect(audioOf(CLIP_A)?.name).toBe("开场曲");

    act(() => {
      useEditorStore.getState().undo();
    });
    // 撤销把那份 meta 整个撤掉（种下来时这个文件还没有 meta）
    expect(audioOf(CLIP_A)).toBeUndefined();
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

    // 这个文件那份 meta 的 `audio` 段整个摘掉（没名字也没标签了），别的文件一个字节不动
    expect(audioOf(CLIP_A)).toBeUndefined();
    expect(audioOf(CLIP_B)?.tags).toEqual([0]);
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
    expect(audioOf(CLIP_A)?.tags).toEqual([0]);

    fireEvent.click(screen.getByTestId("asset-audio-open-tags"));
    expect(useEditorStore.getState().audioTags).toBe(true);
  });
});

describe("按资源类型出现", () => {
  it("图片资源没有显示名那一行，但有标签行（任何文件都能打标签）", () => {
    seed({ assetId: IMAGE });
    render(<InspectorPanel />);

    expect(screen.getByTestId("asset-properties").textContent).toContain("Map001.png");
    expect(screen.queryByTestId("asset-audio-name")).toBeNull();
    expect(screen.getByTestId("asset-audio-tags")).toBeDefined();
    expect(screen.getByTestId("asset-audio-add-tag")).toBeDefined();
    expect(screen.getByTestId("asset-preview-image")).toBeDefined();
  });
});
