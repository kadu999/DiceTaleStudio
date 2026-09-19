import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { CellMask, decodeRle, regionsToMask, worldRectOf } from "@dts/grid";
import { createMapObject, createSceneObject, type SceneObjectDoc } from "@dts/document";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { fogPreviewLayer } from "../src/panels/scene/grid-paint";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";

/**
 * 战争雾：**属性面板的「指定雾区 / 显示」+ store 的涂抹**。
 *
 * Mask 窗口本身（画布 + 指针）不在这里驱动：它要真画布（jsdom 的
 * `getContext("2d")` 返回 null，渲染器会直接抛「无法获取 2D 绘图上下文」），
 * 与场景画布一样由 e2e 覆盖。这里钉住的是三件最容易出错的：
 *
 * 1. 「指定雾区」把哪几个区域写进文档（规范化、可撤销、解除绑定不删数据）；
 * 2. 涂抹 / 擦除的**位运算语义**（叠加、橡皮只清已指定的雾区位、清空只清绑定位）；
 * 3. 画布预览层（纯函数）与「显示」开关的偏好落盘。
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

const mapCells = (): Uint8Array => {
  const object = useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === "map-1");
  return decodeRle(object?.map?.cells.runs ?? [], GRID.width * GRID.height);
};

/** 一格的掩码（格坐标）。 */
const cellAt = (x: number, y: number): number => mapCells()[y * GRID.width + x] ?? -1;

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    selectedAssetId: null,
    fogMask: false,
    fogMaskTarget: null,
  });
  window.localStorage.clear();
});

describe("属性面板：指定雾区", () => {
  it("地图对象有「战争雾」的入口，精灵没有", () => {
    seedScene([mapObject(), createSceneObject({ id: "sprite", name: "精灵" })], ["map-1"]);
    const { unmount } = render(<InspectorPanel />);

    expect(screen.getByTestId("fog-mask-open")).toBeDefined();
    expect(screen.getByTestId("fog-cell-count")).toBeDefined();

    unmount();
    seedScene([mapObject(), createSceneObject({ id: "sprite", name: "精灵" })], ["sprite"]);
    render(<InspectorPanel />);

    expect(screen.queryByTestId("fog-mask-open")).toBeNull();
  });

  it("点区域按钮指定 / 取消雾区，并写进文档（可撤销）", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    // 一开始一个都没指定：窗口打不开，也数不出雾格
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

  it("已覆盖：数的是含任意已指定雾区位的格子", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    expect(screen.getByTestId("fog-cell-count").textContent).toBe("0 格");

    // 直接改 store 也要裹 `act`：属性面板是**重新渲染**后才数出新格数的
    act(() => {
      useEditorStore.getState().setFogRegions("map-1", [CellMask.Fog1]);
      useEditorStore.getState().paintFogStroke("map-1", { x: 0, y: 0 }, { x: 1, y: 0 }, {
        mask: CellMask.Fog1,
        brushSize: 1,
      });
    });

    expect(screen.getByTestId("fog-cell-count").textContent).toBe("2 格");
  });

  it("「打开 Mask 窗口…」把目标地图写进 store", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    act(() => useEditorStore.getState().setFogRegions("map-1", [CellMask.Fog1]));
    fireEvent.click(screen.getByTestId("fog-mask-open"));

    expect(useEditorStore.getState().fogMask).toBe(true);
    expect(useEditorStore.getState().fogMaskTarget).toBe("map-1");

    // 关闭（对话框的 onClose 走同一个入口）
    useEditorStore.getState().openFogMask(null);
    expect(useEditorStore.getState().fogMask).toBe(false);
    expect(useEditorStore.getState().fogMaskTarget).toBeNull();
  });

  it("显示开关写进编辑器偏好（不动文档）", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    expect(useEditorStore.getState().gridPaint.showFog).toBe(false);
    fireEvent.click(screen.getByTestId("fog-preview-toggle"));

    expect(useEditorStore.getState().gridPaint.showFog).toBe(true);
    // 偏好落在浏览器本地：不改文档，也不进撤销栈
    const stored = JSON.parse(window.localStorage.getItem("dts.editor.gridPaint") ?? "{}") as {
      showFog?: boolean;
    };
    expect(stored.showFog).toBe(true);
    expect(useEditorStore.getState().canUndo).toBe(false);
  });
});

describe("战争雾：涂抹与擦除的位运算", () => {
  /** 指定雾区 + 进一笔。 */
  function begin(regions: readonly number[]): void {
    seedScene([mapObject()], ["map-1"]);
    useEditorStore.getState().setFogRegions("map-1", regions);
  }

  it("涂抹按位叠加：同一格可以是两个雾区", () => {
    begin([CellMask.Fog1, CellMask.Fog2]);

    useEditorStore.getState().paintFogStroke("map-1", { x: 2, y: 2 }, { x: 2, y: 2 }, {
      mask: CellMask.Fog1,
      brushSize: 1,
    });
    useEditorStore.getState().paintFogStroke("map-1", { x: 2, y: 2 }, { x: 2, y: 2 }, {
      mask: CellMask.Fog2,
      brushSize: 1,
    });

    expect(cellAt(2, 2)).toBe(CellMask.Fog1 | CellMask.Fog2);
  });

  it("橡皮只清已指定的雾区位：同格的其它区域位保留", () => {
    begin([CellMask.Fog1]);

    // 一格「区域1 + 区域4」，但只指定了区域4
    useEditorStore.setState((state) => ({
      scenes: [
        {
          name: "Map001",
          objects: [
            {
              ...state.scenes[0]!.objects[0]!,
              map: {
                ...state.scenes[0]!.objects[0]!.map!,
                cells: { encoding: "rle", runs: [[CellMask.Obstacle | CellMask.Fog1, GRID.width * GRID.height]] },
              },
            },
          ],
        },
      ],
    }));

    // 起点用当前文档重新喂给历史容器，避免 store 与历史容器脱节
    sceneHistory.reset(useEditorStore.getState().scenes);
    useEditorStore.getState().paintFogStroke("map-1", { x: 0, y: 0 }, { x: 0, y: 0 }, {
      mask: CellMask.Empty,
      brushSize: 1,
    });

    // 区域4 被擦掉，区域1 还在（这就是「不整格清零」与标注橡皮的区别）
    expect(cellAt(0, 0)).toBe(CellMask.Obstacle);
  });

  it("没指定雾区时擦除什么都不做（要擦的范围是空的）", () => {
    seedScene([mapObject()], ["map-1"]);
    // 先画一格区域1，再在没有指定雾区的情况下擦
    useEditorStore.getState().paintFogStroke("map-1", { x: 0, y: 0 }, { x: 0, y: 0 }, {
      mask: CellMask.Obstacle,
      brushSize: 1,
    });

    const changed = useEditorStore.getState().paintFogStroke("map-1", { x: 0, y: 0 }, { x: 0, y: 0 }, {
      mask: CellMask.Empty,
      brushSize: 1,
    });

    // eraseMask = 0 = 一位都不清，所以「没变更」
    expect(changed).toBe(false);
    expect(cellAt(0, 0)).toBe(CellMask.Obstacle);
  });

  it("一整笔合并成一条撤销记录；清空只清绑定位", () => {
    begin([CellMask.Fog1]);

    // 落笔 → 拖 → 抬手 = 一条记录
    useEditorStore.getState().paintFogStroke("map-1", { x: 0, y: 0 }, { x: 1, y: 0 }, {
      mask: CellMask.Fog1,
      brushSize: 1,
    });
    useEditorStore.getState().paintFogStroke("map-1", { x: 1, y: 0 }, { x: 3, y: 0 }, {
      mask: CellMask.Fog1,
      brushSize: 1,
    });
    useEditorStore.getState().endFogStroke();
    expect(cellAt(0, 0)).toBe(CellMask.Fog1);
    expect(cellAt(3, 0)).toBe(CellMask.Fog1);

    // 另一格里放一个**别的**区域位（不在绑定里，清空不该动它）
    useEditorStore.getState().setFogRegions("map-1", [CellMask.Fog1]);
    useEditorStore.getState().paintFogStroke("map-1", { x: 5, y: 5 }, { x: 5, y: 5 }, {
      mask: CellMask.Difficult,
      brushSize: 1,
    });
    // 再绑定区域2 并给它也画一笔，然后只解除区域2
    useEditorStore.getState().setFogRegions("map-1", [CellMask.Fog1, CellMask.Difficult]);
    useEditorStore.getState().clearFog("map-1");

    expect(cellAt(0, 0)).toBe(0);
    expect(cellAt(5, 5)).toBe(0);
    // 绑定还在（清空雾是清数据，不是解除绑定）
    expect(mapFog()).toEqual([CellMask.Difficult, CellMask.Fog1]);
    expect(useEditorStore.getState().undoLabel).toBe("清空战争雾");
  });
});

describe("画布预览层：fogPreviewLayer", () => {
  const RECT = worldRectOf({ x: 0, y: 0 }, { width: 400, height: 300 });

  it("没指定雾区 / 一个雾格都没有时返回 undefined（不追加这一层）", () => {
    const cells = new Uint8Array(GRID.width * GRID.height).fill(CellMask.Fog1);
    expect(fogPreviewLayer(RECT, GRID, cells, 0)).toBeUndefined();
    expect(
      fogPreviewLayer(RECT, GRID, new Uint8Array(GRID.width * GRID.height), CellMask.Fog1),
    ).toBeUndefined();
  });

  it("只在含已指定雾区位的格子上给雾罩色", () => {
    const cells = new Uint8Array(GRID.width * GRID.height);
    cells[0] = CellMask.Fog1;
    cells[1] = CellMask.Difficult;

    const layer = fogPreviewLayer(RECT, GRID, cells, regionsToMask([CellMask.Fog1]));
    expect(layer).toBeDefined();
    // 雾格：一层浅色雾罩（对齐运行时 fogColor）；别的区域位与空格子都不画
    expect(layer?.cellColors?.(CellMask.Fog1)).toHaveLength(1);
    expect(layer?.cellColors?.(CellMask.Difficult)).toEqual([]);
    expect(layer?.cellColors?.(CellMask.Empty)).toEqual([]);
    // 网格线与格子共用同一块矩形
    expect(layer?.rect).toEqual(RECT);
    expect(layer?.grid).toEqual(GRID);
  });
});
