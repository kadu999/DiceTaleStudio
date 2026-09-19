import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { CellMask, PAINTABLE_MASKS, decodeRle, maskToLabel, type RleRun } from "@dts/grid";
import { createMapObject, createSceneObject, type SceneObjectDoc } from "@dts/document";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { cellColorsOf } from "../src/panels/scene/grid-paint";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";

/**
 * 「网格标注」在**属性面板 + store** 两侧的行为。
 *
 * 画布本身不好在这里驱动（要 rAF、要真画布），所以这里钉住的是三件最容易出错的：
 * 1. 开关进入标注模式、调色板把画笔 / 显示 / 颜色写进 store；
 * 2. 涂抹真的把掩码写进地图的 RLE（并且整笔可撤销）；
 * 3. 显示开关只影响颜色，不影响数据。
 *
 * 点击一律用 `fireEvent`（内部包了 `act`）：zustand 的更新要等 React 冲刷完，
 * 直接 `.click()` 之后立刻查 DOM 会读到还没重渲染的旧树。
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

const mapCells = (): Uint8Array => {
  const object = useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === "map-1");
  return decodeRle(object?.map?.cells.runs ?? [], GRID.width * GRID.height);
};

const mapRuns = (): readonly RleRun[] =>
  useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === "map-1")?.map?.cells.runs ??
  [];

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    gridPaint: {
      active: false,
      mapObjectId: null,
      mask: CellMask.Obstacle,
      brushSize: 1,
      hiddenMask: 0,
      colors: {},
      showGridLines: true,
      showAnnotations: true,
      showFog: false,
    },
  });
});

describe("属性面板：标注开关", () => {
  it("地图对象有「开始标注」，精灵没有", () => {
    seedScene([mapObject(), createSceneObject({ id: "sprite", name: "精灵" })], ["map-1"]);
    const { unmount } = render(<InspectorPanel />);
    expect(screen.getByTestId("grid-paint-enter")).toBeDefined();
    unmount();

    seedScene([mapObject(), createSceneObject({ id: "sprite", name: "精灵" })], ["sprite"]);
    render(<InspectorPanel />);
    expect(screen.queryByTestId("grid-paint-enter")).toBeNull();
  });

  it("点「开始标注」把目标地图写进 store，并露出调色板", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    fireEvent.click(screen.getByTestId("grid-paint-enter"));

    expect(useEditorStore.getState().gridPaint.active).toBe(true);
    expect(useEditorStore.getState().gridPaint.mapObjectId).toBe("map-1");
    // 调色板：画笔大小 + 橡皮擦 + 8 种类型
    expect(screen.getByTestId("grid-brush-size")).toBeDefined();
    expect(screen.getByTestId(`grid-type-${CellMask.Empty}`)).toBeDefined();
    for (const bit of [1, 2, 4, 8, 16, 32, 64, 128]) {
      expect(screen.getByTestId(`grid-type-${bit}`)).toBeDefined();
    }
  });

  it("隐藏的地图不让标注（画布上根本点不到它）", () => {
    seedScene([{ ...mapObject(), active: false }], ["map-1"]);
    render(<InspectorPanel />);

    const enter = screen.getByTestId("grid-paint-enter") as HTMLButtonElement;
    expect(enter.disabled).toBe(true);
    expect(screen.getByText(/对象已隐藏/)).toBeDefined();
  });

  it("「打开编辑窗口…」只写窗口状态，不进标注模式", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    fireEvent.click(screen.getByTestId("grid-editor-open"));

    expect(useEditorStore.getState().gridEditor).toBe(true);
    expect(useEditorStore.getState().gridEditorTarget).toBe("map-1");
    // 窗口与画布标注是两条路：画布没有进入标注模式
    expect(useEditorStore.getState().gridPaint.active).toBe(false);

    useEditorStore.getState().openGridEditor(null);
    expect(useEditorStore.getState().gridEditor).toBe(false);
    expect(useEditorStore.getState().gridEditorTarget).toBeNull();
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

describe("调色板：画笔 / 显示 / 颜色", () => {
  function enter(): void {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);
    fireEvent.click(screen.getByTestId("grid-paint-enter"));
  }

  it("默认是区域1 画笔、1 号画笔、全部显示", () => {
    enter();
    const paint = useEditorStore.getState().gridPaint;
    expect(paint.mask).toBe(CellMask.Obstacle);
    expect(paint.brushSize).toBe(1);
    expect(paint.hiddenMask).toBe(0);
  });

  it("类型名按顺序显示成区域1–8，后面跟着掩码值", () => {
    enter();

    // 编号是**序号**（区域1–8），括号里是**位值**（1/2/4/8…）——两者故意不是一回事，
    // 所以这里两个都钉住：只改一个（例如把编号写成位值）就会被这条用例拦住
    for (const [index, bit] of PAINTABLE_MASKS.entries()) {
      expect(screen.getByTestId(`grid-type-${bit}`).textContent).toBe(`区域${index + 1} (${bit})`);
    }

    // 橡皮擦照旧是 0，不在「区域」编号里
    expect(screen.getByTestId(`grid-type-${CellMask.Empty}`).textContent).toBe("橡皮擦 (0)");
  });

  it("点类型名换画笔，点橡皮擦回到 0", () => {
    enter();

    fireEvent.click(screen.getByTestId(`grid-type-${CellMask.Fog3}`));
    expect(useEditorStore.getState().gridPaint.mask).toBe(CellMask.Fog3);
    expect(screen.getByTestId(`grid-type-${CellMask.Fog3}`).getAttribute("data-active")).toBe(
      "true",
    );

    fireEvent.click(screen.getByTestId(`grid-type-${CellMask.Empty}`));
    expect(useEditorStore.getState().gridPaint.mask).toBe(CellMask.Empty);
  });

  it("画笔大小写进 store，并换算成实际覆盖边长（1/3/5 号 → 1/3/5 格）", () => {
    enter();

    for (const [input, effective] of [
      [3, "3×3"],
      [5, "5×5"],
      [2, "1×1"],
    ] as const) {
      fireEvent.change(screen.getByTestId("grid-brush-size"), { target: { value: String(input) } });
      expect(useEditorStore.getState().gridPaint.brushSize).toBe(input);
      expect(screen.getByTestId("grid-brush-size-label").textContent).toContain(effective);
    }
  });

  it("显示开关只改 hiddenMask（数据不动）", () => {
    enter();

    fireEvent.click(screen.getByTestId(`grid-type-visible-${CellMask.Obstacle}`));
    expect(useEditorStore.getState().gridPaint.hiddenMask).toBe(CellMask.Obstacle);

    // 再点一下恢复显示
    fireEvent.click(screen.getByTestId(`grid-type-visible-${CellMask.Obstacle}`));
    expect(useEditorStore.getState().gridPaint.hiddenMask).toBe(0);
  });

  it("改颜色写进 store（只收 #rrggbb）", () => {
    enter();

    fireEvent.change(screen.getByTestId(`grid-type-color-${CellMask.Water}`), {
      target: { value: "#112233" },
    });
    expect(useEditorStore.getState().gridPaint.colors[CellMask.Water]).toBe("#112233");

    // 脏值（不是 #rrggbb）一律忽略，不要写进画笔偏好
    useEditorStore.getState().setGridTypeColor(CellMask.Water, "red");
    expect(useEditorStore.getState().gridPaint.colors[CellMask.Water]).toBe("#112233");
  });

  it("退出标注后调色板收起（画笔偏好留着）", () => {
    enter();
    fireEvent.click(screen.getByTestId("grid-type-128"));
    fireEvent.click(screen.getByTestId("grid-paint-exit-panel"));

    expect(useEditorStore.getState().gridPaint.active).toBe(false);
    expect(useEditorStore.getState().gridPaint.mapObjectId).toBeNull();
    expect(useEditorStore.getState().gridPaint.mask).toBe(CellMask.Fog5);
    expect(screen.getByTestId("grid-paint-enter")).toBeDefined();
  });
});

describe("涂抹：写进 RLE，整笔可撤销", () => {
  it("一笔刷到直线经过的每一格", () => {
    seedScene([mapObject()], ["map-1"]);
    useEditorStore.getState().enterGridPaint("map-1");

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
    useEditorStore.getState().enterGridPaint("map-1");

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
    useEditorStore.getState().enterGridPaint("map-1");

    useEditorStore.getState().setGridBrush(CellMask.Fog1);
    useEditorStore.getState().paintGridStroke("map-1", null, { x: 2, y: 2 });
    useEditorStore.getState().setGridBrush(CellMask.Obstacle);
    useEditorStore.getState().paintGridStroke("map-1", null, { x: 2, y: 2 });

    expect(mapCells()[2 * GRID.width + 2]).toBe(CellMask.Obstacle | CellMask.Fog1);
  });

  it("橡皮擦整格清零", () => {
    seedScene([mapObject()], ["map-1"]);
    useEditorStore.getState().enterGridPaint("map-1");

    useEditorStore.getState().setGridBrush(CellMask.Obstacle);
    useEditorStore.getState().paintGridStroke("map-1", null, { x: 2, y: 2 });

    useEditorStore.getState().setGridBrush(CellMask.Empty);
    useEditorStore.getState().paintGridStroke("map-1", null, { x: 2, y: 2 });

    expect([...mapCells()].every((mask) => mask === 0)).toBe(true);
  });

  it("落笔在网格外什么都不做（不夹到边缘格）", () => {
    seedScene([mapObject()], ["map-1"]);
    useEditorStore.getState().enterGridPaint("map-1");

    const changed = useEditorStore
      .getState()
      .paintGridStroke("map-1", { x: 99, y: 99 }, { x: 99, y: 99 });

    expect(changed).toBe(false);
    expect(mapRuns()).toEqual([[0, GRID.width * GRID.height]]);
  });

  it("换选中对象就退出标注（目标必须一直选中）", () => {
    seedScene([mapObject(), createSceneObject({ id: "sprite", name: "精灵" })], ["map-1"]);
    useEditorStore.getState().enterGridPaint("map-1");
    expect(useEditorStore.getState().gridPaint.active).toBe(true);

    useEditorStore.getState().setSelection(["sprite"]);
    expect(useEditorStore.getState().gridPaint.active).toBe(false);
  });

  it("「清空」把整张网格恢复成空游程（仍可撤销）", () => {
    seedScene([mapObject()], ["map-1"]);
    useEditorStore.getState().enterGridPaint("map-1");
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

  it("不标注时也能关（想看清贴图就关掉网格线）", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    fireEvent.click(screen.getByTestId("grid-lines-toggle"));
    expect(useEditorStore.getState().gridPaint.showGridLines).toBe(false);
    // 关掉的是「显示」：没进标注模式，画笔也没被改
    expect(useEditorStore.getState().gridPaint.active).toBe(false);
    expect(useEditorStore.getState().gridPaint.mask).toBe(CellMask.Obstacle);
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
    seedScene([mapObject(), createSceneObject({ id: "sprite", name: "精灵" })], ["sprite"]);
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

  it("类型名字与掩码值一起给（调色板行的文案）", () => {
    expect(maskToLabel(CellMask.Fog5)).toBe("区域8");
  });
});
