import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import {
  SPRITE_COMPONENT,
  createEmptyProject,
  createSceneObject,
  featureComponent,
  type SceneObjectDoc,
} from "@dts/document";
import { ImagePickerDialog } from "../src/app/ImagePickerDialog";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
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
const IMAGE = { id: IMAGE_ID, width: 256, height: 128 };

const TREE: ResourceTreeNode[] = [
  {
    name: "images",
    path: "Assets/images",
    id: "project:测试/Assets/images",
    type: "folder",
    children: [
      { name: "sheet.png", path: "Assets/images/sheet.png", id: IMAGE_ID, type: "file", size: 1 },
    ],
  },
];

/** 一个挑了图的精灵。 */
function spriteWith(image: SceneObjectDoc["components"][number]["data"]): SceneObjectDoc {
  return {
    ...createSceneObject({ id: "sprite-1", name: "精灵", position: { x: 0, y: 0 } }),
    components: [featureComponent("sprite-1", SPRITE_COMPONENT, image)],
  };
}

/**
 * 种一份场景 + 工程文件（切分表）。
 *
 * 「工程里的切分」与「场景里的对象」是**两份文件**，所以这里两条历史都重置：
 * 与真实打开项目后的样子一致（`doc` 是工程文件，`scenes` 是场景文件）。
 */
function seed(objects: SceneObjectDoc[], spriteSheets?: Record<string, { columns: number; rows: number }>): void {
  const scenes = [{ name: "Map001", objects }];
  sceneHistory.reset(scenes);
  const doc = { ...createEmptyProject("测试"), ...(spriteSheets === undefined ? {} : { spriteSheets }) };
  projectHistory.reset(doc);
  useEditorStore.setState({
    doc,
    scenes,
    activeSceneName: "Map001",
    selectedObjectIds: ["sprite-1"],
    selectedAssetId: null,
    project: { list: [], current: "测试", tree: TREE, busy: false, error: "" },
  });
}

const objectOf = (id: string): SceneObjectDoc | undefined =>
  useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === id);

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  projectHistory.reset(createEmptyProject("测试"));
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    project: { list: [], current: null, tree: [], busy: false, error: "" },
  });
});

describe("属性面板：子图那一行", () => {
  it("整图时不显示子图信息；有子图时写清第几行第几列与切分", () => {
    seed([spriteWith(IMAGE)]);
    const first = render(<InspectorPanel />);
    expect(screen.getByTestId("object-properties").textContent).toContain("images/sheet.png");
    expect(screen.queryByTestId("texture-sprite")).toBeNull();
    expect(screen.queryByTestId("clear-sprite")).toBeNull();
    first.unmount();

    seed([spriteWith({ ...IMAGE, sprite: { column: 2, row: 1 } })], {
      [IMAGE_ID]: { columns: 4, rows: 4 },
    });
    render(<InspectorPanel />);
    expect(screen.getByTestId("texture-sprite").textContent).toContain("子图 第2行第3列（4×4）");
    expect(screen.queryByTestId("texture-sprite-out-of-range")).toBeNull();
  });

  it("「改回整图」清掉引用（切分留着——别的对象还在用）", () => {
    seed([spriteWith({ ...IMAGE, sprite: { column: 1, row: 1 } })], {
      [IMAGE_ID]: { columns: 2, rows: 2 },
    });
    render(<InspectorPanel />);
    fireEvent.click(screen.getByTestId("clear-sprite"));

    const image = objectOf("sprite-1")?.components[0]?.data as Record<string, unknown>;
    expect(image.sprite).toBeUndefined();
    expect(useEditorStore.getState().doc.spriteSheets).toEqual({ [IMAGE_ID]: { columns: 2, rows: 2 } });

    // 一条撤销记录就退回去（还是原来那一格）
    useEditorStore.getState().undo();
    expect(
      (objectOf("sprite-1")?.components[0]?.data as { sprite?: unknown }).sprite,
    ).toEqual({ column: 1, row: 1 });
  });

  it("切分被改小之后，越界的格子有提示（渲染按最后一格，但要说出来）", () => {
    seed([spriteWith({ ...IMAGE, sprite: { column: 3, row: 3 } })], {
      [IMAGE_ID]: { columns: 2, rows: 2 },
    });
    render(<InspectorPanel />);
    expect(screen.queryByTestId("texture-sprite-out-of-range")).not.toBeNull();
    expect(screen.getByTestId("texture-sprite").textContent).toContain("子图 第4行第4列（2×2）");
  });
});

describe("选择窗口：切分与选格", () => {
  it("改行 / 列落进工程文件；点预览选一格；确定时图 + 格子一起写进对象", () => {
    seed([spriteWith(IMAGE)]);
    const picked = vi.fn();
    render(
      <ImagePickerDialog
        open
        allowSprite
        currentId={IMAGE_ID}
        onClose={() => undefined}
        onPick={picked}
      />,
    );

    // 缩略图加载完成才知道真实像素（jsdom 不会真加载图片，这里手动触发一次）
    fireEvent.load(thumbnailOf(IMAGE_ID));

    // 切成 2×2：立刻落进工程文件（项目级数据，与取消窗口无关）
    const columns = screen.getByTestId("sprite-sheet-columns");
    const rows = screen.getByTestId("sprite-sheet-rows");
    fireEvent.change(columns, { target: { value: "2" } });
    fireEvent.blur(columns);
    fireEvent.change(rows, { target: { value: "2" } });
    fireEvent.blur(rows);
    expect(useEditorStore.getState().doc.spriteSheets).toEqual({ [IMAGE_ID]: { columns: 2, rows: 2 } });

    // 点预览的右下角那一格（比例 0.75 / 0.75 → 列 1、行 1）
    const preview = screen.getByTestId("sprite-preview");
    withBox(preview, 200, 100);
    fireEvent.click(preview, { clientX: 150, clientY: 75 });

    expect(preview.getAttribute("data-cell")).toBe("1,1");
    expect(screen.getByTestId("sprite-current-cell").textContent).toContain("第2行第2列 · 2×2");
    expect(screen.getByTestId("image-picker-confirm").textContent).toContain("使用第2行第2列");
    // 确定：声明尺寸 = 那一格的大小（256×128 切 2×2 → 128×64）
    fireEvent.click(screen.getByTestId("image-picker-confirm"));
    expect(picked).toHaveBeenCalledWith({ id: IMAGE_ID, width: 128, height: 64 }, { column: 1, row: 1 });
  });

  it("刚切完就顺手选上第一格（否则按钮还是「使用这张贴图」，看着像没有转精灵的按钮）", () => {
    seed([spriteWith(IMAGE)]);
    const picked = vi.fn();
    render(
      <ImagePickerDialog open allowSprite currentId={IMAGE_ID} onClose={() => undefined} onPick={picked} />,
    );
    fireEvent.load(thumbnailOf(IMAGE_ID));

    // 还没切：整图
    const preview = screen.getByTestId("sprite-preview");
    expect(preview.getAttribute("data-cell")).toBe("");
    expect(screen.getByTestId("image-picker-confirm").textContent).toContain("使用这张贴图");

    // 切成 2×2：自动选上第一格，按钮跟着变成「使用第1行第1列」
    const columns = screen.getByTestId("sprite-sheet-columns");
    const rows = screen.getByTestId("sprite-sheet-rows");
    fireEvent.change(columns, { target: { value: "2" } });
    fireEvent.blur(columns);
    fireEvent.change(rows, { target: { value: "2" } });
    fireEvent.blur(rows);
    expect(preview.getAttribute("data-cell")).toBe("0,0");
    expect(screen.getByTestId("image-picker-confirm").textContent).toContain("使用第1行第1列");

    fireEvent.click(screen.getByTestId("image-picker-confirm"));
    expect(picked).toHaveBeenCalledWith({ id: IMAGE_ID, width: 128, height: 64 }, { column: 0, row: 0 });
  });

  it("「使用整图」把格子报成 null；地图对象没有切分面板", () => {
    seed([spriteWith({ ...IMAGE, sprite: { column: 1, row: 0 } })], {
      [IMAGE_ID]: { columns: 2, rows: 2 },
    });
    const picked = vi.fn();
    const { unmount } = render(
      <ImagePickerDialog
        open
        allowSprite
        currentId={IMAGE_ID}
        currentSprite={{ column: 1, row: 0 }}
        onClose={() => undefined}
        onPick={picked}
      />,
    );

    fireEvent.load(thumbnailOf(IMAGE_ID));

    // 打开时高亮当前那一格
    expect(screen.getByTestId("sprite-preview").getAttribute("data-cell")).toBe("1,0");
    fireEvent.click(screen.getByTestId("image-picker-whole"));
    expect(picked).toHaveBeenCalledWith({ id: IMAGE_ID, width: 256, height: 128 }, null);
    unmount();

    // 地图：整块切分面板都不出现（地图的贴图住在 GridMap 里，不支持子图）
    render(
      <ImagePickerDialog
        open
        allowSprite={false}
        currentId={IMAGE_ID}
        onClose={() => undefined}
        onPick={() => undefined}
      />,
    );
    expect(screen.queryByTestId("sprite-preview")).toBeNull();
    expect(screen.queryByTestId("image-picker-whole")).toBeNull();
    expect(screen.getByTestId("image-picker-confirm").textContent).toContain("使用这张贴图");
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
    expect(useEditorStore.getState().doc.spriteSettings?.[IMAGE_ID]).toEqual({
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
    expect(useEditorStore.getState().doc.spriteSheets).toBeUndefined();

    fireEvent.click(screen.getByTestId("sprite-edit"));
    fireEvent.change(screen.getByTestId("sprite-editor-columns"), { target: { value: "4" } });
    fireEvent.change(screen.getByTestId("sprite-editor-rows"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("sprite-editor-apply"));
    expect(useEditorStore.getState().doc.spriteSheets).toEqual({
      [IMAGE_ID]: { columns: 4, rows: 2 },
    });
  });

  it("从旧版切分表切到 Single 时会隐藏编辑入口并清理切分", () => {
    projectHistory.reset({
      ...createEmptyProject("测试"),
      spriteSheets: { [IMAGE_ID]: { columns: 2, rows: 2 } },
    });
    useEditorStore.setState({
      doc: projectHistory.current,
      scenes: [],
      activeSceneName: null,
      selectedObjectIds: [],
      selectedAssetId: IMAGE_ID,
      project: { list: [], current: "测试", tree: TREE, busy: false, error: "" },
    });

    render(<InspectorPanel />);
    expect(screen.getByTestId("sprite-edit")).not.toBeNull();
    fireEvent.change(screen.getByTestId("sprite-import-mode"), { target: { value: "Single" } });
    expect(useEditorStore.getState().doc.spriteSheets).toBeUndefined();
    expect(screen.queryByTestId("sprite-edit")).toBeNull();
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
    expect(useEditorStore.getState().doc.spriteSheets).toEqual({ [IMAGE_ID]: { columns: 4, rows: 4 } });

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().doc.spriteSheets).toBeUndefined();
    // 对象上那一格照旧（切分没了 = 按整图算，但引用本身没被谁改过）
    expect(
      (objectOf("sprite-1")?.components[0]?.data as { sprite?: unknown }).sprite,
    ).toEqual({ column: 1, row: 1 });
  });
});

/** jsdom 不会真的加载图片：手动给 `naturalWidth/Height` 再触发 `load`。 */
function thumbnailOf(assetId: string): HTMLImageElement {
  const item = document.querySelector(`[data-testid="image-picker-item"][data-asset-id="${assetId}"]`);
  const image = item?.querySelector("img") ?? null;
  if (!(image instanceof HTMLImageElement)) {
    throw new Error(`列表里没有这张图的缩略图：${assetId}`);
  }

  Object.defineProperty(image, "naturalWidth", { configurable: true, value: 256 });
  Object.defineProperty(image, "naturalHeight", { configurable: true, value: 128 });
  return image;
}

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
