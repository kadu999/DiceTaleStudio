import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { CellMask } from "@dts/grid";
import {
  FEATURE_COMPONENT,
  createMapObject,
  createSceneObject,
  isMapFogEnabled,
  mapDataOf,
  withFeature,
  type SceneObjectDoc,
} from "@dts/document";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";
import { emptyFogReveal } from "../src/services/fog-reveal";

/**
 * 战争雾：**属性面板的开关 / 指定雾区**（两者都是文档数据，跟着场景存盘下发）。
 *
 * Mask 窗口本身不在这里驱动：它是**像素级**的（真 canvas + ImageData），jsdom 里
 * `getContext("2d")` 返回 null，与场景画布一样由 e2e 覆盖；它用到的那几个纯函数
 * （补点 / 软边擦除 / 把雾格画成区域色）在 `mask-math.test.ts` 里钉。
 *
 * 这里钉住三件事：
 * 1. 「战争雾」开关是整组的闸门（关着时雾区设置与编辑入口都不显示），并且写进**文档**——
 *    只有它跟着场景下发，前端才知道该不该生成那一层雾（它不再是浏览器本地偏好）；
 * 2. 关掉开关**不清雾区绑定**（再打开就回来）；
 * 3. 「指定雾区」把哪几个区域写进文档（规范化、可撤销、解除绑定不删数据）。
 *
 * **画布与战争雾无关**：雾用的是区域数据（`map.cells` 的 8 个区域位），画布上只画区域着色，
 * 雾只在它自己的 Mask 窗口里看——所以这里没有「雾罩图层」可钉（见 `ScenePanel`）。
 */

const IMAGE = { id: "project:测试/Assets/images/Map001.png", width: 400, height: 300 };
const GRID = { width: 8, height: 6 };

function mapObject(): SceneObjectDoc {
  return createMapObject({ id: "map-1", name: "网格地图", image: IMAGE, grid: GRID });
}

/** 一张**开了战争雾、绑了「区域4」**的地图（揭示记账只认这样的地图）。 */
function fogMap(): SceneObjectDoc {
  const object = mapObject();
  const map = mapDataOf(object);
  if (map === undefined) {
    throw new Error("createMapObject 应当带 GridMap 组件");
  }

  return withFeature(object, FEATURE_COMPONENT.map, {
    ...map,
    fog: { enabled: true, regions: [CellMask.Fog1] },
  });
}

/** 一张**开了战争雾、但还没指定雾区**的地图（揭示记账会明确拒绝它，与「开关关着」不是一回事）。 */
function enabledMapWithoutRegions(): SceneObjectDoc {
  const object = mapObject();
  const map = mapDataOf(object);
  if (map === undefined) {
    throw new Error("createMapObject 应当带 GridMap 组件");
  }

  return withFeature(
    { ...object, id: "map-2", name: "开了没绑的地图" },
    FEATURE_COMPONENT.map,
    { ...map, fog: { enabled: true, regions: [] } },
  );
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
const mapFog = (): readonly number[] => {
  const object = useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === "map-1");
  return (object === undefined ? undefined : mapDataOf(object))?.fog?.regions ?? [];
};

/** 场景里那张地图的战争雾开关（缺省 = 没开）。 */
const mapFogEnabled = (): boolean => {
  const object = useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === "map-1");
  const map = object === undefined ? undefined : mapDataOf(object);
  return map !== undefined && isMapFogEnabled(map);
};

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    selectedAssetId: null,
    gridPaint: {
      mask: CellMask.Obstacle,
      brushSize: 1,
      hiddenMask: 0,
      colors: {},
      showGridLines: true,
      showAnnotations: true,
    },
    fogMask: false,
    fogMaskTarget: null,
    // 揭示记账与运行态都是跨用例留着的：每个用例都从「编辑态、什么都没擦」开始
    mode: "edit",
    fogReveal: emptyFogReveal(),
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

  it("打开开关才露出雾区设置；关掉又收起来，但雾区绑定留着（开关是文档数据、可撤销）", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    expect(mapFogEnabled()).toBe(false);
    fireEvent.click(screen.getByTestId("fog-enable"));

    // 开关写的是**文档**：只有它跟着场景存盘下发，前端才知道该不该生成那一层雾
    expect(mapFogEnabled()).toBe(true);
    expect(screen.getByTestId("fog-region-1")).toBeDefined();
    expect(screen.getByTestId("fog-mask-open")).toBeDefined();

    act(() => useEditorStore.getState().setFogRegions("map-1", [CellMask.Fog1]));
    fireEvent.click(screen.getByTestId("fog-enable"));
    expect(screen.queryByTestId("fog-region-1")).toBeNull();
    // 「关掉」= 现在没有雾，不是把雾区删了：绑定还在，再打开就回来
    expect(mapFog()).toEqual([CellMask.Fog1]);
    expect(mapFogEnabled()).toBe(false);

    // 它不是编辑器偏好：浏览器本地那份记录里没有这一项（旧版本写下的 showFog 也不再被读）
    expect(window.localStorage.getItem("dts.editor.gridPaint") ?? "").not.toContain("showFog");

    // 开关也是一次文档编辑：撤销就回到「开着」
    useEditorStore.getState().undo();
    expect(mapFogEnabled()).toBe(true);
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

    // 再点一下取消：绑定回到空——但**开关还开着**，字段留着（「开着但还没指定雾区」），
    // 面板那一组不会因为取消最后一个雾区就整个塌掉
    fireEvent.click(screen.getByTestId(`fog-region-${CellMask.Fog1}`));
    expect(mapFog()).toEqual([]);
    const object = useEditorStore.getState().scenes[0]?.objects[0];
    expect(object === undefined ? undefined : mapDataOf(object)?.fog).toEqual({
      enabled: true,
      regions: [],
    });
    expect(screen.getByTestId("fog-mask-open").hasAttribute("disabled")).toBe(true);

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

describe("战争雾：揭示记账（运行态才下发给前端）", () => {
  const logs = (): string[] => useEditorStore.getState().runtime.logs.map((entry) => entry.message);
  const ops = (): readonly { kind: string }[] =>
    useEditorStore.getState().fogReveal.objects["map-1"]?.ops ?? [];

  it("编辑态擦一笔：只是这一窗口里的预览——不记账、不动文档、不进撤销栈", () => {
    seedScene([fogMap()], ["map-1"]);

    act(() => useEditorStore.getState().eraseFogMask("map-1", [{ x: 0.1, y: 0.1 }], true));

    expect(useEditorStore.getState().fogReveal.objects).toEqual({});
    expect(logs()).toEqual([]);
    expect(useEditorStore.getState().canUndo).toBe(false);
    expect(mapFog()).toEqual([CellMask.Fog1]);
  });

  it("运行态、前端没连：记账 + 写明「连上后自动补发」；拖动中的分批并成一条轨迹", () => {
    seedScene([fogMap()], ["map-1"]);
    act(() => useEditorStore.setState({ mode: "run" }));

    // 拖动中两批 + 收笔那批：记账里是**一条**完整轨迹（补发时要的是整笔）
    act(() => useEditorStore.getState().eraseFogMask("map-1", [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }], false));
    act(() => useEditorStore.getState().eraseFogMask("map-1", [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }], true));

    const recorded = useEditorStore.getState().fogReveal.objects["map-1"];
    expect(recorded?.ops).toHaveLength(1);
    expect(recorded?.ops[0]).toMatchObject({
      kind: "stroke",
      stroke: { radius: 0.05, softness: 1 },
    });
    expect(
      recorded?.ops[0]?.kind === "stroke" ? recorded.ops[0].stroke.points : [],
    ).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.2 },
      { x: 0.2, y: 0.2 },
      { x: 0.3, y: 0.3 },
    ]);

    // 只有**收笔**那批写日志：拖动中每批都写会把运行日志刷屏。
    // 这条用例里编辑器自己也没连上服务端（jsdom 里没有 WS），所以写的是那一档原因
    const eraseLogs = logs().filter((line) => line.includes("擦除"));
    expect(eraseLogs).toHaveLength(1);
    expect(eraseLogs[0]).toMatch(/已记录擦除：「网格地图」第 1 笔（4 个落点）/);
    expect(eraseLogs[0]).toMatch(/连上后自动补发/);
    expect(useEditorStore.getState().canUndo).toBe(false);
  });

  it("整区开关：记账；只认这张地图已指定的雾区", () => {
    seedScene([fogMap()], ["map-1"]);
    act(() => useEditorStore.setState({ mode: "run" }));

    act(() => useEditorStore.getState().setFogRegionRevealed("map-1", CellMask.Fog1, true));
    expect(ops().at(-1)).toEqual({ kind: "region", region: CellMask.Fog1, revealed: true });
    expect(logs().at(-1)).toMatch(/已记录揭示：区域4整片揭示/);

    // 没指定成雾区的区域位：明确说明，不记账
    act(() => useEditorStore.getState().setFogRegionRevealed("map-1", CellMask.Obstacle, true));
    expect(ops()).toHaveLength(1);
    expect(logs().at(-1)).toMatch(/没把 区域1 指定为雾区/);
  });

  it("目标不对时给明确原因、不记账（对象不存在 / 不是地图 / 开关关着 / 还没指定雾区）", () => {
    seedScene(
      [mapObject(), enabledMapWithoutRegions(), createSceneObject({ id: "sprite", name: "精灵" })],
      ["map-1"],
    );
    act(() => useEditorStore.setState({ mode: "run" }));

    for (const [objectId, expected] of [
      ["不存在", /找不到这个对象/],
      ["sprite", /不是地图/],
      // 开关关着与「开着但还没指定雾区」是两回事，日志要说清是哪一种
      ["map-1", /战争雾开关关着/],
      ["map-2", /还没指定雾区/],
    ] as const) {
      act(() => useEditorStore.getState().eraseFogMask(objectId, [{ x: 0.1, y: 0.1 }], true));
      expect(logs().at(-1)).toMatch(expected);
    }

    expect(useEditorStore.getState().fogReveal.objects).toEqual({});
  });

  it("前端不在时补发什么都不做（返回 0）", () => {
    seedScene([fogMap()], ["map-1"]);
    act(() => useEditorStore.setState({ mode: "run" }));
    act(() => useEditorStore.getState().eraseFogMask("map-1", [{ x: 0.1, y: 0.1 }], true));

    expect(useEditorStore.getState().flushFogReveal()).toBe(0);
  });
});
