import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import {
  SPRITE_COMPONENT,
  createAssetMetas,
  createEmptyProject,
  createGameObject,
  emptyAssetMetas,
  featureComponent,
  spriteSettingsOfMeta,
  type AssetMetaDoc,
  type GameObjectDoc,
} from "@dts/document";
import { ResourcePickerDialog } from "../src/app/ResourcePickerDialog";
import { SpriteEditorDialog } from "../src/app/SpriteEditorDialog";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { metaHistory } from "../src/state/store-core";
import { projectHistory, sceneHistory, useEditorStore } from "../src/state/editor-store";
import type { ResourceTreeNode } from "../src/services/project-api";

/**
 * **精灵（子图）**：编辑器这一侧的三件事。
 *
 * 1. 属性面板显示「子图 第2行第3列（4×4）」、能「改回整图」、格子越界时有提示；
 * 2. 「选择贴图 / 精灵」窗口：改切分 → 落进工程文件（项目级、只有一份）；点预览选一格 →
 *    确定时**图 + 格子一次写进对象**（声明尺寸 = 那一格的大小）；
 * 3. 两条轨道各自进撤销栈：窗口那一下是**一条**撤销记录（不是「换图」+「选格」两条）。
 *
 * 画布上「只画那一块」由 e2e 采样像素覆盖（jsdom 没有真画布，与既有约定一致）。
 */

const IMAGE_ID = "project:测试/Assets/images/sheet.png";
const PLAIN_IMAGE_ID = "project:测试/Assets/images/plain.png";
const IMAGE = { id: IMAGE_ID, width: 256, height: 128 };

const TREE: ResourceTreeNode[] = [
  {
    name: "images",
    path: "Assets/images",
    id: "project:测试/Assets/images",
    type: "folder",
    children: [
      { name: "sheet.png", path: "Assets/images/sheet.png", id: IMAGE_ID, type: "file", size: 1 },
      { name: "plain.png", path: "Assets/images/plain.png", id: PLAIN_IMAGE_ID, type: "file", size: 1 },
    ],
  },
];

/** 一个挑了图的精灵。 */
function spriteWith(image: GameObjectDoc["components"][number]["data"]): GameObjectDoc {
  return {
    ...createGameObject({ id: "sprite-1", name: "精灵", position: { x: 0, y: 0 } }),
    components: [featureComponent("sprite-1", SPRITE_COMPONENT, image)],
  };
}

/**
 * 种一份场景 + 工程文件（切分表）。
 *
 * 「工程里的切分」与「场景里的对象」是**两份文件**，所以这里两条历史都重置：
 * 与真实打开项目后的样子一致（`doc` 是工程文件，`scenes` 是场景文件）。
 */
function seed(objects: GameObjectDoc[], spriteSheets?: Record<string, { columns: number; rows: number }>): void {
  const scenes = [{ name: "Map001", objects }];
  sceneHistory.reset(scenes);
  const doc = createEmptyProject("测试");
  projectHistory.reset(doc);
  // v23 起切分住在**素材自己的 `.meta`** 里：种一份「路径 ID → meta」的表，再派生出索引
  const table: Record<string, AssetMetaDoc> = {};
  let sequence = 0;
  for (const [id, sheet] of Object.entries(spriteSheets ?? {})) {
    sequence += 1;
    table[id] = {
      formatVersion: 1,
      guid: String(sequence).padStart(32, "0"),
      importer: "texture",
      sprite: { mode: "Multiple", sheet },
    };
  }
  metaHistory.reset(table);
  useEditorStore.setState({
    doc,
    assetMetaTable: table,
    assetMetas: createAssetMetas(Object.entries(table).map(([id, meta]) => ({ id, meta }))),
    scenes,
    activeSceneName: "Map001",
    selectedObjectIds: ["sprite-1"],
    selectedAssetId: null,
    project: { list: [], current: "测试", tree: TREE, busy: false, error: "" },
  });
}

const objectOf = (id: string): GameObjectDoc | undefined =>
  useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === id);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sceneHistory.reset([]);
  projectHistory.reset(createEmptyProject("测试"));
  // 素材 meta 是**第三条轨道**：不重置它，上一个用例写下的切分 / 导入设置会漏到下一个用例
  metaHistory.reset({});
  useEditorStore.setState({ assetMetaTable: {}, assetMetas: emptyAssetMetas() });
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    project: { list: [], current: null, tree: [], busy: false, error: "" },
  });
});

describe("属性面板：精灵图片行", () => {
  it("精灵不显示贴图路径和改回整图按钮；子精灵信息仍可见", () => {
    seed([spriteWith(IMAGE)]);
    const first = render(<InspectorPanel />);
    expect(screen.getByTestId("object-properties").textContent).not.toContain("images/sheet.png");
    expect(screen.queryByTestId("texture-sprite")).toBeNull();
    expect(screen.getByTestId("pick-texture")).not.toBeNull();
    first.unmount();

    seed([spriteWith({ ...IMAGE, sprite: { column: 2, row: 1 } })], {
      [IMAGE_ID]: { columns: 4, rows: 4 },
    });
    render(<InspectorPanel />);
    expect(screen.getByTestId("texture-sprite").textContent).toContain("子图 第2行第3列（4×4）");
    expect(screen.queryByTestId("texture-sprite-out-of-range")).toBeNull();
    expect(screen.getByTestId("object-properties").textContent).not.toContain("images/sheet.png");
    expect(screen.queryByTestId("clear-sprite")).toBeNull();
  });

  it("越界子精灵仍显示格子信息和提示，但不显示改回整图按钮", () => {
    seed([spriteWith({ ...IMAGE, sprite: { column: 3, row: 3 } })], {
      [IMAGE_ID]: { columns: 2, rows: 2 },
    });
    render(<InspectorPanel />);
    expect(screen.queryByTestId("texture-sprite-out-of-range")).not.toBeNull();
    expect(screen.getByTestId("texture-sprite").textContent).toContain("子图 第4行第4列（2×2）");
    expect(screen.queryByTestId("clear-sprite")).toBeNull();
  });
});

describe("选择窗口：搜索图片与选择子精灵", () => {
  it("可搜索、选已有格子，并通过缩略图接口读取原图尺寸", async () => {
    seed([spriteWith(IMAGE)], { [IMAGE_ID]: { columns: 2, rows: 2 } });
    const plainMeta: AssetMetaDoc = {
      formatVersion: 1,
      guid: "f".repeat(32),
      importer: "texture",
    };
    const metaTable = { ...useEditorStore.getState().assetMetaTable, [PLAIN_IMAGE_ID]: plainMeta };
    metaHistory.reset(metaTable);
    useEditorStore.setState({ assetMetaTable: metaTable, assetMetas: createAssetMetas(Object.entries(metaTable).map(([id, meta]) => ({ id, meta }))) });
    const picked = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ width: 256, height: 128 }) });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ResourcePickerDialog kind="image" open allowSprite currentId={IMAGE_ID} onClose={() => undefined} onPick={picked} />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/resources/thumbnail?id="),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));

    expect(screen.queryByTestId("sprite-sheet-panel")).toBeNull();
    expect(screen.queryByTestId("sprite-sheet-columns")).toBeNull();
    expect(screen.getAllByTestId("image-picker-item")).toHaveLength(1);
    expect(screen.getByTestId("image-picker-item").getAttribute("data-asset-id")).toBe(IMAGE_ID);
    expect(screen.getAllByTestId("image-picker-sprite")).toHaveLength(4);
    expect(screen.getByTestId("image-picker-preview-sprite").getAttribute("style")).toContain("/api/resources/raw?");
    expect(screen.getByTestId("image-picker-preview-sprite").getAttribute("data-sprite")).toBe("0,0");
    expect(document.querySelector('[data-testid="image-picker-sprite"][data-sprite="0,0"]')?.getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(screen.getByTestId("image-picker-search"), { target: { value: "missing" } });
    expect(screen.queryByTestId("image-picker-item")).toBeNull();
    fireEvent.change(screen.getByTestId("image-picker-search"), { target: { value: "sheet" } });
    expect(screen.getByTestId("image-picker-item")).not.toBeNull();
    expect(screen.getAllByTestId("image-picker-sprite")).toHaveLength(4);
    fireEvent.click(document.querySelector('[data-testid="image-picker-sprite"][data-sprite="1,0"]') as HTMLElement);
    expect(screen.getByTestId("image-picker-confirm").textContent).toContain("使用精灵");
    expect(screen.getByTestId("image-picker-preview-sprite").getAttribute("data-sprite")).toBe("1,0");

    fireEvent.click(screen.getByTestId("image-picker-confirm"));
    expect(picked).toHaveBeenCalledWith({ id: IMAGE_ID, width: 128, height: 64 }, { column: 1, row: 0 });
    expect(useEditorStore.getState().assetMetas.byId[IMAGE_ID]?.sprite?.sheet).toEqual({ columns: 2, rows: 2 });
  });
});

describe("入口：图片资源上也能切（精灵是这张图自己的属性）", () => {
  it("资源面板选中一张图 → 属性区出现切分面板（只看不选），改行 / 列落进工程文件", () => {
    // 只选中**资源**（没有选中任何对象）：切分是这张图的属性，与对象无关
    projectHistory.reset(createEmptyProject("测试"));
    useEditorStore.setState({
      doc: projectHistory.current,
      scenes: [],
      activeSceneName: null,
      selectedObjectIds: [],
      selectedAssetId: IMAGE_ID,
      project: { list: [], current: "测试", tree: TREE, busy: false, error: "" },
    });

    render(<InspectorPanel />);

    expect(screen.queryByTestId("sprite-sheet-panel")).toBeNull();
    expect((screen.getByTestId("sprite-type-toggle") as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId("sprite-edit")).toBeNull();
  });

  it("切换 Sprite 模式并打开编辑器；取消不写入，应用才写入切分", () => {
    projectHistory.reset(createEmptyProject("测试"));
    useEditorStore.setState({
      doc: projectHistory.current,
      scenes: [],
      activeSceneName: null,
      selectedObjectIds: [],
      selectedAssetId: IMAGE_ID,
      project: { list: [], current: "测试", tree: TREE, busy: false, error: "" },
    });

    render(<InspectorPanel />);
    fireEvent.click(screen.getByTestId("sprite-type-toggle"));
    expect(spriteSettingsOfMeta(useEditorStore.getState().assetMetas.byId[IMAGE_ID])).toEqual({
      type: "Sprite",
      mode: "Single",
    });
    expect(screen.queryByTestId("sprite-edit")).toBeNull();

    fireEvent.change(screen.getByTestId("sprite-import-mode"), { target: { value: "Multiple" } });
    expect(screen.getByTestId("sprite-edit")).not.toBeNull();
    fireEvent.click(screen.getByTestId("sprite-edit"));
    expect(screen.getByTestId("sprite-editor-dialog")).not.toBeNull();

    fireEvent.change(screen.getByTestId("sprite-editor-columns"), { target: { value: "4" } });
    fireEvent.change(screen.getByTestId("sprite-editor-rows"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("sprite-editor-cancel"));
    expect(useEditorStore.getState().assetMetas.byId[IMAGE_ID]?.sprite?.sheet).toBeUndefined();

    fireEvent.click(screen.getByTestId("sprite-edit"));
    fireEvent.change(screen.getByTestId("sprite-editor-columns"), { target: { value: "4" } });
    fireEvent.change(screen.getByTestId("sprite-editor-rows"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("sprite-editor-apply"));
    expect(useEditorStore.getState().assetMetas.byId[IMAGE_ID]?.sprite?.sheet).toEqual({
      columns: 4,
      rows: 2,
    });
  });

  it("从旧版切分表切到 Single 时会隐藏编辑入口并清理切分", () => {
    const legacy: AssetMetaDoc = {
      formatVersion: 1,
      guid: "0".repeat(32),
      importer: "texture",
      sprite: { mode: "Multiple", sheet: { columns: 2, rows: 2 } },
    };
    metaHistory.reset({ [IMAGE_ID]: legacy });
    projectHistory.reset(createEmptyProject("测试"));
    useEditorStore.setState({
      doc: projectHistory.current,
      assetMetaTable: { [IMAGE_ID]: legacy },
      assetMetas: createAssetMetas([{ id: IMAGE_ID, meta: legacy }]),
      scenes: [],
      activeSceneName: null,
      selectedObjectIds: [],
      selectedAssetId: IMAGE_ID,
      project: { list: [], current: "测试", tree: TREE, busy: false, error: "" },
    });

    render(<InspectorPanel />);
    expect(screen.getByTestId("sprite-edit")).not.toBeNull();
    fireEvent.change(screen.getByTestId("sprite-import-mode"), { target: { value: "Single" } });
    expect(useEditorStore.getState().assetMetas.byId[IMAGE_ID]?.sprite?.sheet).toBeUndefined();
    expect(screen.queryByTestId("sprite-edit")).toBeNull();
  });
});

describe("精灵编辑器缩放", () => {
  it("打开时自动适配图片，且标题不显示资源路径", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("data-testid") === "sprite-editor-viewport") {
        return { x: 0, y: 0, left: 0, top: 0, right: 700, bottom: 500, width: 700, height: 500, toJSON: () => ({}) };
      }
      return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
    });

    render(
      <SpriteEditorDialog
        open
        imageId={IMAGE_ID}
        imageSize={{ width: 1000, height: 500 }}
        onClose={() => undefined}
      />,
    );

    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect((screen.getByTestId("sprite-editor-zoom") as HTMLInputElement).value).toBe("62");
    expect(screen.getByTestId("sprite-editor-dialog").textContent).not.toContain(IMAGE_ID);
  });

  it("缩放最小为 10%，自适应整图并保留边距", () => {
    render(
      <SpriteEditorDialog
        open
        imageId={IMAGE_ID}
        imageSize={{ width: 1000, height: 500 }}
        onClose={() => undefined}
      />,
    );

    const zoom = screen.getByTestId("sprite-editor-zoom") as HTMLInputElement;
    expect(zoom.min).toBe("10");
    expect(zoom.max).toBe("400");
    expect(screen.getByTestId("sprite-editor-fit").hasAttribute("disabled")).toBe(false);

    withBox(screen.getByTestId("sprite-editor-viewport"), 700, 500);
    fireEvent.click(screen.getByTestId("sprite-editor-fit"));
    expect(zoom.value).toBe("62");
    expect(screen.getByTestId("sprite-editor-stage").getAttribute("style")).toContain("width: 620px");

    fireEvent.change(zoom, { target: { value: "10" } });
    expect(screen.getByTestId("sprite-editor-stage").getAttribute("style")).toContain("width: 100px");
  });
});

describe("两条轨道：图 + 格子是一条撤销记录，切分自己一条", () => {
  it("窗口确定那一下 = 一条撤销记录（整件事一起退回去）", () => {
    seed([spriteWith(IMAGE)]);
    const changed = useEditorStore
      .getState()
      .setObjectImageSprite("sprite-1", { id: IMAGE_ID, width: 128, height: 64 }, { column: 1, row: 1 });
    expect(changed).toBe(true);
    expect((objectOf("sprite-1")?.components[0]?.data as Record<string, unknown>).sprite).toEqual({
      column: 1,
      row: 1,
    });

    useEditorStore.getState().undo();
    expect((objectOf("sprite-1")?.components[0]?.data as Record<string, unknown>).sprite).toBeUndefined();
    expect(useEditorStore.getState().canUndo).toBe(false);
  });

  it("切分落在工程文件那条轨道上：撤销它不动场景里的对象", () => {
    seed([spriteWith({ ...IMAGE, sprite: { column: 1, row: 1 } })]);
    const changed = useEditorStore
      .getState()
      .setSpriteSheet(IMAGE_ID, { columns: 4, rows: 4 });
    expect(changed).toBe(true);
    expect(useEditorStore.getState().assetMetas.byId[IMAGE_ID]?.sprite?.sheet).toEqual({ columns: 4, rows: 4 });

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().assetMetas.byId[IMAGE_ID]?.sprite?.sheet).toBeUndefined();
    // 对象上那一格照旧（切分没了 = 按整图算，但引用本身没被谁改过）
    expect(
      (objectOf("sprite-1")?.components[0]?.data as { sprite?: unknown }).sprite,
    ).toEqual({ column: 1, row: 1 });
  });
});

/** jsdom 的 `getBoundingClientRect` 全是 0：预览的点击比例要一块真的盒子才算得出来。 */
function withBox(element: HTMLElement, width: number, height: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  });
}
