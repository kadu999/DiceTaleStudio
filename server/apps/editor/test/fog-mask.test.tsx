import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { CellMask, defaultCellMaskColors, regionsToMask, worldRectOf } from "@dts/grid";
import { createMapObject, createSceneObject, type SceneObjectDoc } from "@dts/document";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { fogPreviewLayer } from "../src/panels/scene/grid-paint";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";

/**
 * 战争雾：**属性面板的开关 / 指定雾区**（雾区是文档数据，开关是编辑器偏好）。
 *
 * Mask 窗口本身不在这里驱动：它是**像素级**的（真 canvas + ImageData），jsdom 里
 * `getContext("2d")` 返回 null，与场景画布一样由 e2e 覆盖；它用到的那几个纯函数
 * （补点 / 软边擦除 / 把雾格画成黑罩）在 `mask-math.test.ts` 里钉。
 *
 * 这里钉住三件事：
 * 1. 「战争雾」开关是整组的闸门（关着时雾区设置与编辑入口都不显示），并且写进编辑器偏好；
 * 2. 「指定雾区」把哪几个区域写进文档（规范化、可撤销、解除绑定不删数据）；
 * 3. 画布预览层是纯函数（按区域颜色、只画雾格）。
 */

const IMAGE = { id: "project:测试/Assets/images/Map001.png", width: 400, height: 300 };
const GRID = { width: 8, height: 6 };

function mapObject(): SceneObjectDoc {
  return createMapObject({ id: "map-1", name: "网格地图", image: IMAGE, grid: GRID });
}

/**
 * 把 store 摆成「打开了一个项目、里面有一个场景」的样子（不碰磁盘）。
 *
 * **必须同时 `sceneHistory.reset`**：对象编辑走的是历史容器，
 * 忘了这一步 `applyScenes` 会在空数组里找场景、永远「没产生变更」。
 */
function seedScene(objects: SceneObjectDoc[], selected: readonly string[]): void {
  const scenes = [{ name: "Map001", objects }];
  sceneHistory.reset(scenes);
  useEditorStore.setState({
    scenes,
    activeSceneName: "Map001",
    selectedObjectIds: [...selected],
    selectedAssetId: null,
    project: { list: [], current: "测试", tree: [], busy: false, error: "" },
  });
}

/** 场景里那张地图的 fog 绑定。 */
const mapFog = (): readonly number[] =>
  useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === "map-1")?.map?.fog
    ?.regions ?? [];

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    selectedAssetId: null,
    // 开关也是**编辑器偏好**，会跨用例留着：每个用例都从「没开战争雾」开始
    gridPaint: {
      mask: CellMask.Obstacle,
      brushSize: 1,
      hiddenMask: 0,
      colors: {},
      showGridLines: true,
      showAnnotations: true,
      showFog: false,
    },
    fogMask: false,
    fogMaskTarget: null,
  });
  window.localStorage.clear();
});

describe("属性面板：战争雾开关与雾区", () => {
  it("地图对象有「战争雾」的开关，精灵没有", () => {
    seedScene([mapObject(), createSceneObject({ id: "sprite", name: "精灵" })], ["map-1"]);
    const { unmount } = render(<InspectorPanel />);

    expect(screen.getByTestId("fog-enable")).toBeDefined();
    // 关着时只留这一个开关：雾区设置与编辑入口都还没露面
    expect(screen.queryByTestId("fog-region-1")).toBeNull();
    expect(screen.queryByTestId("fog-mask-open")).toBeNull();

    unmount();
    seedScene([mapObject(), createSceneObject({ id: "sprite", name: "精灵" })], ["sprite"]);
    render(<InspectorPanel />);

    expect(screen.queryByTestId("fog-enable")).toBeNull();
  });

  it("打开开关才露出雾区设置；关掉又收起来（偏好落盘、不动文档）", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    expect(useEditorStore.getState().gridPaint.showFog).toBe(false);
    fireEvent.click(screen.getByTestId("fog-enable"));

    expect(useEditorStore.getState().gridPaint.showFog).toBe(true);
    expect(screen.getByTestId("fog-region-1")).toBeDefined();
    expect(screen.getByTestId("fog-mask-open")).toBeDefined();

    // 偏好落在浏览器本地：不改文档，也不进撤销栈
    const stored = JSON.parse(window.localStorage.getItem("dts.editor.gridPaint") ?? "{}") as {
      showFog?: boolean;
    };
    expect(stored.showFog).toBe(true);
    expect(useEditorStore.getState().canUndo).toBe(false);

    // 关掉：设置收起来，但文档里那套绑定一个字节不动（偏好不是文档数据）
    act(() => useEditorStore.getState().setFogRegions("map-1", [CellMask.Fog1]));
    fireEvent.click(screen.getByTestId("fog-enable"));
    expect(screen.queryByTestId("fog-region-1")).toBeNull();
    expect(mapFog()).toEqual([CellMask.Fog1]);
  });

  it("点区域按钮指定 / 取消雾区，并写进文档（可撤销）", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    // 先打开战争雾：关着时连雾区设置都不显示
    fireEvent.click(screen.getByTestId("fog-enable"));

    // 一开始一个都没指定：窗口打不开
    expect(mapFog()).toEqual([]);
    expect(screen.getByTestId("fog-mask-open").hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByTestId(`fog-region-${CellMask.Fog1}`));
    expect(mapFog()).toEqual([CellMask.Fog1]);
    expect(screen.getByTestId(`fog-region-${CellMask.Fog1}`).getAttribute("data-bound")).toBe("true");
    expect(screen.getByTestId("fog-mask-open").hasAttribute("disabled")).toBe(false);

    // 再点一下取消：**字段整个删掉**（没指定 = 没有这个配置）
    fireEvent.click(screen.getByTestId(`fog-region-${CellMask.Fog1}`));
    expect(mapFog()).toEqual([]);
    expect(
      useEditorStore.getState().scenes[0]?.objects[0]?.map?.fog,
    ).toBeUndefined();

    // 指定是一次文档编辑：撤销就回到「没指定」
    fireEvent.click(screen.getByTestId(`fog-region-${CellMask.Obstacle}`));
    expect(mapFog()).toEqual([CellMask.Obstacle]);
    useEditorStore.getState().undo();
    expect(mapFog()).toEqual([]);
  });

  it("「编辑」把目标地图写进 store（Mask 窗口）", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    fireEvent.click(screen.getByTestId("fog-enable"));
    act(() => useEditorStore.getState().setFogRegions("map-1", [CellMask.Fog1]));
    fireEvent.click(screen.getByTestId("fog-mask-open"));

    expect(useEditorStore.getState().fogMask).toBe(true);
    expect(useEditorStore.getState().fogMaskTarget).toBe("map-1");

    // 关闭（对话框的 onClose 走同一个入口）
    useEditorStore.getState().openFogMask(null);
    expect(useEditorStore.getState().fogMask).toBe(false);
    expect(useEditorStore.getState().fogMaskTarget).toBeNull();
  });

});

describe("画布预览层：fogPreviewLayer", () => {
  const RECT = worldRectOf({ x: 0, y: 0 }, { width: 400, height: 300 });
  /** 与调色板同一份偏好的配色（默认色就够用）。 */
  const COLORS = defaultCellMaskColors();

  it("没指定雾区 / 一个雾格都没有时返回 undefined（不追加这一层）", () => {
    const cells = new Uint8Array(GRID.width * GRID.height).fill(CellMask.Fog1);
    expect(fogPreviewLayer(RECT, GRID, cells, 0, COLORS)).toBeUndefined();
    expect(
      fogPreviewLayer(RECT, GRID, new Uint8Array(GRID.width * GRID.height), CellMask.Fog1, COLORS),
    ).toBeUndefined();
  });

  it("雾格按**区域自己的颜色**画，别的区域位与空格子都不画", () => {
    const cells = new Uint8Array(GRID.width * GRID.height);
    cells[0] = CellMask.Fog1;
    cells[1] = CellMask.Difficult;

    const layer = fogPreviewLayer(RECT, GRID, cells, regionsToMask([CellMask.Fog1]), COLORS);
    expect(layer).toBeDefined();

    // 区域4 的默认色是 #d9d9d9（α0.55）：按区域配色画，而不是统一的雾色
    expect(layer?.cellColors?.(CellMask.Fog1)).toEqual(["rgba(217,217,217,0.55)"]);
    // 没被指定为雾区的区域位（区域2）与空格子都不画
    expect(layer?.cellColors?.(CellMask.Difficult)).toEqual([]);
    expect(layer?.cellColors?.(CellMask.Empty)).toEqual([]);
    // 网格线与格子共用同一块矩形
    expect(layer?.rect).toEqual(RECT);
    expect(layer?.grid).toEqual(GRID);
  });

  it("两个雾区各有各的颜色（编辑时看得出哪块是哪区）", () => {
    // 至少要有雾格，这一层才会被追加（见上一条）
    const cells = new Uint8Array(GRID.width * GRID.height).fill(CellMask.Fog1);
    const layer = fogPreviewLayer(
      RECT,
      GRID,
      cells,
      regionsToMask([CellMask.Fog1, CellMask.Fog2]),
      COLORS,
    );

    const first = layer?.cellColors?.(CellMask.Fog1) ?? [];
    const second = layer?.cellColors?.(CellMask.Fog2) ?? [];
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).not.toBe(second[0]);

    // 一格同时属于两个雾区：两层颜色都画（高位先画、低位在上）
    expect(layer?.cellColors?.(CellMask.Fog1 | CellMask.Fog2)).toHaveLength(2);
  });
});
