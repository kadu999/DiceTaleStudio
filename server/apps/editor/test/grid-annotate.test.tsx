import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import {
  CellMask,
  PAINTABLE_MASKS,
  brushEffectiveSize,
  decodeRle,
  maskToLabel,
  type RleRun,
} from "@dts/grid";
import { createGridMapObject, createGameObject, mapDataOf, type GameObjectDoc } from "@dts/document";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { cellColorsOf } from "../src/panels/scene/grid-paint";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";

/**
 * 「网格标注」在**属性面板 + store** 两侧的行为。
 *
 * 涂格子只在「编辑窗口」（`GridEditDialog`）里做，窗口要真 canvas（jsdom 里
 * `getContext("2d")` 返回 null），所以那边由 e2e 覆盖；这里钉住的是三件最容易出错的：
 * 1. 属性面板只留一个入口，点它开窗口（不碰画笔、也不进任何模式）；
 * 2. 画笔 / 每类显示 / 颜色写进 store 与浏览器本地偏好；
 * 3. 涂抹真的把掩码写进地图的 RLE（整笔一条撤销记录），显示开关只影响颜色。
 *
 * 点击一律用 `fireEvent`（内部包了 `act`）：zustand 的更新要等 React 冲刷完，
 * 直接 `.click()` 之后立刻查 DOM 会读到还没重渲染的旧树。
 */

const IMAGE = { id: "project:测试/Assets/images/Map001.png", width: 400, height: 300 };
const GRID = { width: 8, height: 6 };

function mapObject(): GameObjectDoc {
  return createGridMapObject({ id: "map-1", name: "网格地图", image: IMAGE, grid: GRID });
}

/**
 * 把 store 摆成「打开了一个项目、里面有一个场景」的样子（不碰磁盘）。
 *
 * **必须同时 `sceneHistory.reset`**：对象编辑走的是历史容器，
 * 忘了这一步 `applyScenes` 会在空数组里找场景、永远「没产生变更」。
 */
function seedScene(objects: GameObjectDoc[], selected: readonly string[]): void {
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

const mapCells = (): Uint8Array => {
  const object = useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === "map-1");
  return decodeRle((object === undefined ? undefined : mapDataOf(object))?.cells.runs ?? [], GRID.width * GRID.height);
};

const mapRuns = (): readonly RleRun[] => {
  const object = useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === "map-1");
  return (object === undefined ? undefined : mapDataOf(object))?.cells.runs ?? [];
};

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    gridPaint: {
      mask: CellMask.Obstacle,
      brushSize: 1,
      hiddenMask: 0,
      colors: {},
      showGridLines: true,
      showAnnotations: true,
    },
  });
  window.localStorage.clear();
});

describe("属性面板：编辑窗口入口", () => {
  it("地图对象有「编辑」入口，精灵没有", () => {
    seedScene([mapObject(), createGameObject({ id: "sprite", name: "精灵" })], ["map-1"]);
    const { unmount } = render(<InspectorPanel />);
    expect(screen.getByTestId("grid-editor-open")).toBeDefined();
    unmount();

    seedScene([mapObject(), createGameObject({ id: "sprite", name: "精灵" })], ["sprite"]);
    render(<InspectorPanel />);
    expect(screen.queryByTestId("grid-editor-open")).toBeNull();
  });

  it("点「编辑」把目标地图写进 store，画笔偏好一个都不动", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    fireEvent.click(screen.getByTestId("grid-editor-open"));

    expect(useEditorStore.getState().gridEditor).toBe(true);
    expect(useEditorStore.getState().gridEditorTarget).toBe("map-1");

    // 涂格子只在窗口里做：点入口不该顺手改画笔 / 显示偏好
    const paint = useEditorStore.getState().gridPaint;
    expect(paint.mask).toBe(CellMask.Obstacle);
    expect(paint.brushSize).toBe(1);
    expect(paint.hiddenMask).toBe(0);
  });

  it("隐藏 / 未放置的地图也能开编辑窗口（窗口自带视口，不靠拾取）", () => {
    seedScene([{ ...mapObject(), active: false }], ["map-1"]);
    render(<InspectorPanel />);

    const open = screen.getByTestId("grid-editor-open") as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    fireEvent.click(open);
    expect(useEditorStore.getState().gridEditorTarget).toBe("map-1");
  });

  it("两个格子编辑窗口互斥：开一个就把另一个关掉", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    useEditorStore.getState().openFogMask("map-1");
    expect(useEditorStore.getState().fogMask).toBe(true);

    useEditorStore.getState().openGridEditor("map-1");
    expect(useEditorStore.getState().gridEditor).toBe(true);
    // 同时开两层模态遮罩谁也点不到，所以开网格窗口时 Mask 窗口自动关掉
    expect(useEditorStore.getState().fogMask).toBe(false);
    expect(useEditorStore.getState().fogMaskTarget).toBeNull();

    useEditorStore.getState().openFogMask("map-1");
    expect(useEditorStore.getState().fogMask).toBe(true);
    expect(useEditorStore.getState().gridEditor).toBe(false);
    expect(useEditorStore.getState().gridEditorTarget).toBeNull();
  });

  it("地图被删掉时编辑窗口跟着关（别留一个指向不存在对象的窗口）", () => {
    seedScene([mapObject()], ["map-1"]);
    useEditorStore.getState().openGridEditor("map-1");
    expect(useEditorStore.getState().gridEditor).toBe(true);

    act(() => useEditorStore.getState().deleteObjects(["map-1"]));

    expect(useEditorStore.getState().gridEditor).toBe(false);
    expect(useEditorStore.getState().gridEditorTarget).toBeNull();
  });
});

describe("画笔偏好：写进 store 也写进浏览器本地", () => {
  const prefs = (): Record<string, unknown> =>
    JSON.parse(window.localStorage.getItem("dts.editor.gridPaint") ?? "{}") as Record<
      string,
      unknown
    >;

  it("默认是区域1 画笔、1 号画笔、全部显示", () => {
    const paint = useEditorStore.getState().gridPaint;
    expect(paint.mask).toBe(CellMask.Obstacle);
    expect(paint.brushSize).toBe(1);
    expect(paint.hiddenMask).toBe(0);
  });

  it("选画笔只认橡皮擦 + 8 个区域，别的值一律忽略", () => {
    for (const bit of PAINTABLE_MASKS) {
      useEditorStore.getState().setGridBrush(bit);
      expect(useEditorStore.getState().gridPaint.mask).toBe(bit);
    }

    useEditorStore.getState().setGridBrush(CellMask.Empty);
    expect(useEditorStore.getState().gridPaint.mask).toBe(CellMask.Empty);

    useEditorStore.getState().setGridBrush(3);
    expect(useEditorStore.getState().gridPaint.mask).toBe(CellMask.Empty);
  });

  it("画笔大小夹到 1..5，并换算成实际覆盖边长（1/3/5 号 → 1/3/5 格）", () => {
    for (const [input, effective] of [
      [3, 3],
      [5, 5],
      [2, 1],
      [9, 5], // 越界往上夹
      [0, 1], // 越界往下夹
    ] as const) {
      useEditorStore.getState().setGridBrushSize(input);
      const size = useEditorStore.getState().gridPaint.brushSize;
      expect(brushEffectiveSize(size)).toBe(effective);
    }

    // 坏值（NaN）不写：滑杆抖动不该把偏好改成 NaN
    useEditorStore.getState().setGridBrushSize(Number.NaN);
    expect(useEditorStore.getState().gridPaint.brushSize).toBe(1);
  });

  it("每类的显示开关只翻 hiddenMask 的那一位", () => {
    useEditorStore.getState().toggleGridTypeVisible(CellMask.Obstacle);
    expect(useEditorStore.getState().gridPaint.hiddenMask).toBe(CellMask.Obstacle);

    useEditorStore.getState().toggleGridTypeVisible(CellMask.Fog5);
    expect(useEditorStore.getState().gridPaint.hiddenMask).toBe(
      CellMask.Obstacle | CellMask.Fog5,
    );

    // 再点一下恢复显示
    useEditorStore.getState().toggleGridTypeVisible(CellMask.Obstacle);
    expect(useEditorStore.getState().gridPaint.hiddenMask).toBe(CellMask.Fog5);

    // 橡皮擦没有「显示」可言（它不是一条类型位）
    useEditorStore.getState().toggleGridTypeVisible(CellMask.Empty);
    expect(useEditorStore.getState().gridPaint.hiddenMask).toBe(CellMask.Fog5);
  });

  it("改颜色只收 #rrggbb", () => {
    useEditorStore.getState().setGridTypeColor(CellMask.Water, "#112233");
    expect(useEditorStore.getState().gridPaint.colors[CellMask.Water]).toBe("#112233");

    // 脏值一律忽略，不要写进画笔偏好
    useEditorStore.getState().setGridTypeColor(CellMask.Water, "red");
    expect(useEditorStore.getState().gridPaint.colors[CellMask.Water]).toBe("#112233");
  });

  it("画笔 / 大小 / 显示 / 颜色都落盘（下次打开还是这个样子）", () => {
    useEditorStore.getState().setGridBrush(CellMask.Fog1);
    useEditorStore.getState().setGridBrushSize(4);
    useEditorStore.getState().toggleGridTypeVisible(CellMask.Water);
    useEditorStore.getState().setGridTypeColor(CellMask.Water, "#112233");

    expect(prefs()).toMatchObject({
      mask: CellMask.Fog1,
      brushSize: 4,
      hiddenMask: CellMask.Water,
      colors: { [CellMask.Water]: "#112233" },
    });
  });
});

describe("涂抹：写进 RLE，整笔可撤销", () => {
  it("一笔刷到直线经过的每一格", () => {
    seedScene([mapObject()], ["map-1"]);

    const changed = useEditorStore
      .getState()
      .paintGridStroke("map-1", { x: 1, y: 2 }, { x: 4, y: 2 });
    expect(changed).toBe(true);

    const cells = mapCells();
    for (let x = 1; x <= 4; x += 1) {
      expect(cells[2 * GRID.width + x]).toBe(CellMask.Obstacle);
    }

    expect([...cells].filter((mask) => mask !== 0)).toHaveLength(4);
  });

  it("整笔只留一条撤销记录：撤销回到全空，重做又回来", () => {
    seedScene([mapObject()], ["map-1"]);

    // 模拟一次拖动：按下 + 若干次 pointermove
    useEditorStore.getState().paintGridStroke("map-1", null, { x: 0, y: 0 });
    useEditorStore.getState().paintGridStroke("map-1", { x: 0, y: 0 }, { x: 3, y: 0 });
    useEditorStore.getState().paintGridStroke("map-1", { x: 3, y: 0 }, { x: 3, y: 3 });
    useEditorStore.getState().endGridStroke();

    expect([...mapCells()].filter((mask) => mask !== 0)).toHaveLength(7);
    expect(useEditorStore.getState().undoLabel).toBe("标注网格");

    useEditorStore.getState().undo();
    expect([...mapCells()].every((mask) => mask === 0)).toBe(true);

    useEditorStore.getState().redo();
    expect([...mapCells()].filter((mask) => mask !== 0)).toHaveLength(7);
  });

  it("换画笔后画上去的是新的类型位（叠加不清除旧的）", () => {
    seedScene([mapObject()], ["map-1"]);

    useEditorStore.getState().setGridBrush(CellMask.Fog1);
    useEditorStore.getState().paintGridStroke("map-1", null, { x: 2, y: 2 });
    useEditorStore.getState().setGridBrush(CellMask.Obstacle);
    useEditorStore.getState().paintGridStroke("map-1", null, { x: 2, y: 2 });

    expect(mapCells()[2 * GRID.width + 2]).toBe(CellMask.Obstacle | CellMask.Fog1);
  });

  it("橡皮擦整格清零", () => {
    seedScene([mapObject()], ["map-1"]);

    useEditorStore.getState().setGridBrush(CellMask.Obstacle);
    useEditorStore.getState().paintGridStroke("map-1", null, { x: 2, y: 2 });

    useEditorStore.getState().setGridBrush(CellMask.Empty);
    useEditorStore.getState().paintGridStroke("map-1", null, { x: 2, y: 2 });

    expect([...mapCells()].every((mask) => mask === 0)).toBe(true);
  });

  it("落笔在网格外什么都不做（不夹到边缘格）", () => {
    seedScene([mapObject()], ["map-1"]);

    const changed = useEditorStore
      .getState()
      .paintGridStroke("map-1", { x: 99, y: 99 }, { x: 99, y: 99 });

    expect(changed).toBe(false);
    expect(mapRuns()).toEqual([[0, GRID.width * GRID.height]]);
  });

  it("「清空」把整张网格恢复成空游程（仍可撤销）", () => {
    seedScene([mapObject()], ["map-1"]);
    useEditorStore.getState().paintGridStroke("map-1", null, { x: 1, y: 1 });

    expect(useEditorStore.getState().clearGrid("map-1")).toBe(true);
    // 写回的是铺满网格的空游程，不是空数组（否则校验与改尺寸都会判成坏数据）
    expect(mapRuns()).toEqual([[0, GRID.width * GRID.height]]);

    useEditorStore.getState().undo();
    expect(mapCells()[1 * GRID.width + 1]).toBe(CellMask.Obstacle);
  });
});

describe("显示开关：网格线与网格标注", () => {
  it("两者默认都显示", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    expect((screen.getByTestId("grid-lines-toggle") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("grid-annotations-toggle") as HTMLInputElement).checked).toBe(true);
  });

  it("想看清贴图就关掉网格线（关的是显示，画笔偏好不动）", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    fireEvent.click(screen.getByTestId("grid-lines-toggle"));
    expect(useEditorStore.getState().gridPaint.showGridLines).toBe(false);
    // 关掉的是「显示」：格子数据与画笔都没被改
    expect(useEditorStore.getState().gridPaint.mask).toBe(CellMask.Obstacle);
    expect([...mapCells()].every((mask) => mask === 0)).toBe(true);
  });

  it("两个开关都写进偏好（下次打开还是这个样子）", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    fireEvent.click(screen.getByTestId("grid-annotations-toggle"));

    const stored = JSON.parse(
      window.localStorage.getItem("dts.editor.gridPaint") ?? "{}",
    ) as Record<string, unknown>;
    expect(stored.showAnnotations).toBe(false);
    expect(stored.showGridLines).toBe(true);
  });

  it("精灵没有这两个开关（格子是地图的事）", () => {
    seedScene([mapObject(), createGameObject({ id: "sprite", name: "精灵" })], ["sprite"]);
    render(<InspectorPanel />);

    expect(screen.queryByTestId("grid-lines-toggle")).toBeNull();
    expect(screen.queryByTestId("grid-annotations-toggle")).toBeNull();
  });
});

describe("格子颜色：只画可见的类型位，按低位在上叠加", () => {
  const colors = { [CellMask.Obstacle]: "#ff0000", [CellMask.Fog1]: "#d9d9d9" };

  it("单个位就是它自己的颜色（透明度来自类型）", () => {
    expect(cellColorsOf(CellMask.Obstacle, 0, colors)).toEqual(["rgba(255,0,0,0.6)"]);
  });

  it("多位按高位先画（低位在上）", () => {
    expect(cellColorsOf(CellMask.Obstacle | CellMask.Fog1, 0, colors)).toEqual([
      "rgba(217,217,217,0.55)",
      "rgba(255,0,0,0.6)",
    ]);
  });

  it("被隐藏的位不画，空格子返回空数组", () => {
    expect(cellColorsOf(CellMask.Obstacle | CellMask.Fog1, CellMask.Fog1, colors)).toEqual([
      "rgba(255,0,0,0.6)",
    ]);
    expect(cellColorsOf(CellMask.Empty, 0, colors)).toEqual([]);
  });

  it("没有自定义颜色时用 Unity 的默认配色", () => {
    expect(cellColorsOf(CellMask.Water, 0, {})).toEqual(["rgba(0,128,255,0.6)"]);
  });

  it("类型名字与掩码值一起给（右侧面板行的文案）", () => {
    expect(maskToLabel(CellMask.Fog5)).toBe("区域8");
  });
});
