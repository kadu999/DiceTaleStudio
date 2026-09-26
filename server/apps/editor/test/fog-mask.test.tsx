import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { CellMask } from "@dts/grid";
import {
  DEFAULT_SLOT_COMPONENT,
  createGridMapObject,
  createGameObject,
  createFogObject,
  fogOf,
  isFogEnabled,
  withFeature,
  type GameObjectDoc,
} from "@dts/document";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";
import { emptyFogReveal } from "../src/services/fog-reveal";

/**
 * 战争雾：**属性面板的开关 / 指定雾区**（两者都是文档数据，跟着场景存盘下发）。
 *
 * v27 起雾是**独立的 `Fog` 对象**：属性面板那一组挂在**雾对象**上（引用哪张地图 + 开关 +
 * 雾区），命令与记账都按**雾对象 id** 走。Mask 窗口本身不在这里驱动：它是**像素级**的
 * （真 canvas + ImageData），jsdom 里 `getContext("2d")` 返回 null，与场景画布一样由 e2e 覆盖；
 * 它用到的那几个纯函数在 `mask-math.test.ts` 里钉。
 *
 * 这里钉住：
 * 1. 「战争雾」开关是整组的闸门（关着时雾区设置与编辑入口都不显示），并且写进**文档**；
 * 2. 关掉开关**不清雾区绑定**（再打开就回来）；
 * 3. 「指定雾区」把哪几个区域写进文档（规范化、可撤销、解除绑定不删数据）；
 * 4. 揭示记账只认**引用了有效地图、开关开着、指定了雾区**的雾对象。
 */

const IMAGE = { id: "project:测试/Assets/images/Map001.png", width: 400, height: 300 };
const GRID = { width: 8, height: 6 };

function mapObject(id = "map-1"): GameObjectDoc {
  return createGridMapObject({ id, name: id === "map-1" ? "网格地图" : id, image: IMAGE, grid: GRID });
}

/** 一个战争雾对象（默认引用 `map-1`、开着、绑了「区域4」）。 */
function fogObject(
  input: {
    readonly id?: string;
    readonly mapId?: string;
    readonly enabled?: boolean;
    readonly regions?: readonly number[];
  } = {},
): GameObjectDoc {
  const id = input.id ?? "fog-1";
  const mapId = input.mapId ?? "map-1";
  return withFeature(
    createFogObject({ id, name: "战争雾", mapId, position: { x: 0, y: 0 } }),
    DEFAULT_SLOT_COMPONENT.fog,
    {
      mapId,
      enabled: input.enabled ?? true,
      regions: [...(input.regions ?? [CellMask.Fog1])],
    },
  );
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

const fogObjectInStore = (id = "fog-1"): GameObjectDoc | undefined =>
  useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === id);

/** 雾对象的 regions。 */
const fogRegions = (id = "fog-1"): readonly number[] => {
  const object = fogObjectInStore(id);
  return (object === undefined ? undefined : fogOf(object))?.regions ?? [];
};

/** 雾对象的开关（缺省 = 没对象 / 没开）。 */
const fogEnabled = (id = "fog-1"): boolean => {
  const object = fogObjectInStore(id);
  return object !== undefined && isFogEnabled(object);
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
  it("「战争雾」的开关在雾对象上，地图与精灵都没有", () => {
    seedScene([mapObject(), fogObject(), createGameObject({ id: "sprite", name: "精灵" })], ["fog-1"]);
    const { unmount } = render(<InspectorPanel />);

    // 雾对象：引用地图选择器 + 开关（开着时露出雾区设置）
    expect(screen.getByTestId("fog-map")).toBeDefined();
    expect(screen.getByTestId("fog-enable")).toBeDefined();
    expect(screen.getByTestId("fog-region-1")).toBeDefined();

    act(() => useEditorStore.getState().setSelection(["map-1"]));
    // 地图上没有这一组（v27 起雾是独立对象）
    expect(screen.queryByTestId("fog-enable")).toBeNull();
    expect(screen.queryByTestId("fog-map")).toBeNull();

    unmount();
    seedScene([mapObject(), fogObject(), createGameObject({ id: "sprite", name: "精灵" })], ["sprite"]);
    render(<InspectorPanel />);
    expect(screen.queryByTestId("fog-enable")).toBeNull();
  });

  it("关掉开关就收起雾区设置，但雾区绑定留着（开关是文档数据、可撤销）", () => {
    seedScene([mapObject(), fogObject()], ["fog-1"]);
    render(<InspectorPanel />);

    expect(fogEnabled()).toBe(true);
    expect(screen.getByTestId("fog-region-1")).toBeDefined();
    expect(screen.getByTestId("fog-mask-open")).toBeDefined();

    fireEvent.click(screen.getByTestId("fog-enable"));

    // 开关写的是**文档**：只有它跟着场景存盘下发，前端才知道该不该生成那一层雾
    expect(fogEnabled()).toBe(false);
    expect(screen.queryByTestId("fog-region-1")).toBeNull();
    // 「关掉」= 现在没有雾，不是把雾区删了：绑定还在，再打开就回来
    expect(fogRegions()).toEqual([CellMask.Fog1]);

    // 它不是编辑器偏好：浏览器本地那份记录里没有这一项
    expect(window.localStorage.getItem("dts.editor.gridPaint") ?? "").not.toContain("showFog");

    // 开关也是一次文档编辑：撤销就回到「开着」
    act(() => useEditorStore.getState().undo());
    expect(fogEnabled()).toBe(true);
  });

  it("点区域按钮指定 / 取消雾区，并写进文档（可撤销）", () => {
    seedScene([mapObject(), fogObject({ regions: [] })], ["fog-1"]);
    render(<InspectorPanel />);

    // 一开始一个都没指定：窗口打不开
    expect(fogRegions()).toEqual([]);
    expect(screen.getByTestId("fog-mask-open").hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByTestId(`fog-region-${CellMask.Fog1}`));
    expect(fogRegions()).toEqual([CellMask.Fog1]);
    expect(screen.getByTestId(`fog-region-${CellMask.Fog1}`).getAttribute("data-bound")).toBe("true");
    expect(screen.getByTestId("fog-mask-open").hasAttribute("disabled")).toBe(false);

    // 再点一下取消：绑定回到空——但**开关还开着**，组件留着（「开着但还没指定雾区」）
    fireEvent.click(screen.getByTestId(`fog-region-${CellMask.Fog1}`));
    expect(fogRegions()).toEqual([]);
    const object = fogObjectInStore();
    expect(object === undefined ? undefined : fogOf(object)).toEqual({
      mapId: "map-1",
      enabled: true,
      regions: [],
    });
    expect(screen.getByTestId("fog-mask-open").hasAttribute("disabled")).toBe(true);

    // 指定是一次文档编辑：撤销就回到「没指定」
    fireEvent.click(screen.getByTestId(`fog-region-${CellMask.Obstacle}`));
    expect(fogRegions()).toEqual([CellMask.Obstacle]);
    useEditorStore.getState().undo();
    expect(fogRegions()).toEqual([]);
  });

  it("可以在面板上切换引用哪张地图", () => {
    seedScene([mapObject("map-1"), mapObject("map-2"), fogObject({ mapId: "" })], ["fog-1"]);
    render(<InspectorPanel />);

    fireEvent.change(screen.getByTestId("fog-map"), { target: { value: "map-2" } });
    expect(fogOf(fogObjectInStore()!)?.mapId).toBe("map-2");
  });

  it("「编辑」把目标雾对象写进 store（Mask 窗口）", () => {
    seedScene([mapObject(), fogObject()], ["fog-1"]);
    render(<InspectorPanel />);

    fireEvent.click(screen.getByTestId("fog-mask-open"));

    expect(useEditorStore.getState().fogMask).toBe(true);
    expect(useEditorStore.getState().fogMaskTarget).toBe("fog-1");

    // 关闭（对话框的 onClose 走同一个入口）
    useEditorStore.getState().openFogMask(null);
    expect(useEditorStore.getState().fogMask).toBe(false);
    expect(useEditorStore.getState().fogMaskTarget).toBeNull();
  });
});

describe("战争雾：揭示记账（运行态才下发给前端）", () => {
  const logs = (): string[] => useEditorStore.getState().runtime.logs.map((entry) => entry.message);
  const ops = (id = "fog-1"): readonly { kind: string }[] =>
    useEditorStore.getState().fogReveal.objects[id]?.ops ?? [];

  it("编辑态擦一笔：只是这一窗口里的预览——不记账、不动文档、不进撤销栈", () => {
    seedScene([mapObject(), fogObject()], ["fog-1"]);

    act(() => useEditorStore.getState().eraseFogMask("fog-1", [{ x: 0.1, y: 0.1 }], true));

    expect(useEditorStore.getState().fogReveal.objects).toEqual({});
    expect(logs()).toEqual([]);
    expect(useEditorStore.getState().canUndo).toBe(false);
    expect(fogRegions()).toEqual([CellMask.Fog1]);
  });

  it("运行态、前端没连：记账 + 写明「连上后自动补发」；拖动中的分批并成一条轨迹", () => {
    seedScene([mapObject(), fogObject()], ["fog-1"]);
    act(() => useEditorStore.setState({ mode: "run" }));

    // 拖动中两批 + 收笔那批：记账里是**一条**完整轨迹（补发时要的是整笔）
    act(() => useEditorStore.getState().eraseFogMask("fog-1", [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }], false));
    act(() => useEditorStore.getState().eraseFogMask("fog-1", [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }], true));

    const recorded = useEditorStore.getState().fogReveal.objects["fog-1"];
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
    const eraseLogs = logs().filter((line) => line.includes("擦除"));
    expect(eraseLogs).toHaveLength(1);
    expect(eraseLogs[0]).toMatch(/已记录擦除：「战争雾」第 1 笔（4 个落点）/);
    expect(eraseLogs[0]).toMatch(/连上后自动补发/);
    expect(useEditorStore.getState().canUndo).toBe(false);
  });

  it("整区开关：记账；只认这个雾对象已指定的雾区", () => {
    seedScene([mapObject(), fogObject()], ["fog-1"]);
    act(() => useEditorStore.setState({ mode: "run" }));

    act(() => useEditorStore.getState().setFogRegionRevealed("fog-1", CellMask.Fog1, true));
    expect(ops().at(-1)).toEqual({ kind: "region", region: CellMask.Fog1, revealed: true });
    expect(logs().at(-1)).toMatch(/已记录揭示：区域4整片揭示/);

    // 没指定成雾区的区域位：明确说明，不记账
    act(() => useEditorStore.getState().setFogRegionRevealed("fog-1", CellMask.Obstacle, true));
    expect(ops()).toHaveLength(1);
    expect(logs().at(-1)).toMatch(/没把 区域1 指定为雾区/);
  });

  it("目标不对时给明确原因、不记账（对象不存在 / 不是雾对象 / 没引用地图 / 开关关着 / 还没指定雾区）", () => {
    seedScene(
      [
        mapObject(),
        fogObject({ enabled: false }),
        fogObject({ id: "fog-dangling", mapId: "nope" }),
        fogObject({ id: "fog-noregions", regions: [] }),
        createGameObject({ id: "sprite", name: "精灵" }),
      ],
      ["fog-1"],
    );
    act(() => useEditorStore.setState({ mode: "run" }));

    for (const [objectId, expected] of [
      ["不存在", /找不到这个对象/],
      ["sprite", /不是战争雾对象/],
      ["fog-dangling", /引用的地图不存在或不是地图/],
      ["fog-1", /战争雾开关关着/],
      ["fog-noregions", /还没指定雾区/],
    ] as const) {
      act(() => useEditorStore.getState().eraseFogMask(objectId, [{ x: 0.1, y: 0.1 }], true));
      expect(logs().at(-1)).toMatch(expected);
    }

    expect(useEditorStore.getState().fogReveal.objects).toEqual({});
  });

  it("前端不在时补发什么都不做（返回 0）", () => {
    seedScene([mapObject(), fogObject()], ["fog-1"]);
    act(() => useEditorStore.setState({ mode: "run" }));
    act(() => useEditorStore.getState().eraseFogMask("fog-1", [{ x: 0.1, y: 0.1 }], true));

    expect(useEditorStore.getState().flushFogReveal()).toBe(0);
  });
});
