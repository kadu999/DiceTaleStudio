import { afterEach, describe, expect, it } from "vitest";
import {
  createEmptyProject,
  createMapObject,
  createSceneObject,
  type SceneDoc,
  type SceneObjectDoc,
} from "@dts/document";
import { createViewport, fitViewport } from "@dts/renderer";
import {
  compareSceneNames,
  fitSceneViewport,
  sceneHistory,
  useEditorStore,
} from "../src/state/editor-store";

/**
 * **切场景**这件事本身：顺序、视口跟随。
 *
 * 跑团现场 DM 是「边讲边切」的：换张图要一次点击就到位，切过去必须看得见整张图
 * （不然还得先找地图、再点适配），切回来还得是刚才看的那一角。这几条不钉住，
 * 很容易在后续改动里悄悄退化成一个「换了张图但视角还留在上一张」的工具。
 *
 * 推送那一半（运行态下切场景立刻推给前端）在 `run-mode.test.ts` 里——那边有假 WebSocket。
 */

const VIEW = { width: 800, height: 600 };

/** 一张 400×300 的地图对象，摆在世界原点（激活的、已落位的才参与「适配」）。 */
function mapOf(id: string): SceneObjectDoc {
  return createMapObject({
    id,
    name: `地图 ${id}`,
    image: { id: `project:测试/Assets/images/${id}.png`, width: 400, height: 300 },
    grid: { width: 8, height: 6 },
  });
}

function sceneOf(name: string, objects: readonly SceneObjectDoc[]): SceneDoc {
  return { name, objects: [...objects] };
}

/** 两块地图大小不同的场景：适配出来的 scale 必然不同，好判断「到底跟了谁」。 */
const SCENE_A = sceneOf("Map001", [mapOf("map-a")]);
const SCENE_B = sceneOf("Map002", [mapOf("map-b"), createSceneObject({ id: "door", name: "木门" })]);

/**
 * 铺一份干净的状态。
 *
 * 先 `resetDoc`（顺带把**记着的视口**清掉），再直接放场景：视口记忆是模块级的，
 * 不隔离的话用例之间会互相继承「上次看过哪儿」。
 */
function seed(active: string, viewportSize = VIEW): void {
  useEditorStore.getState().resetDoc(createEmptyProject());
  useEditorStore.setState({
    scenes: [SCENE_A, SCENE_B],
    activeSceneName: active,
    selectedObjectIds: [],
    viewportSize,
    viewport: createViewport(),
    project: { list: [], current: null, tree: [], busy: false, error: "" },
  });
}

const viewport = (): { scale: number; tx: number; ty: number } => {
  const { scale, tx, ty } = useEditorStore.getState().viewport;
  return { scale, tx, ty };
};

afterEach(() => {
  sceneHistory.reset([]);
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    viewport: createViewport(),
    viewportSize: { width: 0, height: 0 },
  });
});

describe("切场景：视口跟着场景走", () => {
  it("切到**没去过**的场景：自动适配（整张地图铺满），不用再点一次适配", () => {
    seed("Map001");
    // 先把视角弄成一个「带过去就看不见东西」的样子（另一张图上放大 8 倍）
    useEditorStore.setState({ viewport: { scale: 8, tx: -300, ty: -200 } });

    useEditorStore.getState().openScene("Map002");

    const expected = fitSceneViewport([SCENE_A, SCENE_B], "Map002", VIEW);
    expect(viewport().scale).toBeCloseTo(expected.scale, 6);
    expect(viewport().tx).toBeCloseTo(expected.tx, 6);
    expect(viewport().ty).toBeCloseTo(expected.ty, 6);
    // 适配出来的缩放必然不同于「上一张图那一个」，否则这条用例什么也没验
    expect(viewport().scale).not.toBeCloseTo(8, 6);
  });

  it("切回**去过**的场景：回到上次的缩放与平移（而不是又适配一次）", () => {
    seed("Map001");
    const mine = { scale: 3, tx: 12, ty: -7 };
    useEditorStore.setState({ viewport: mine });

    useEditorStore.getState().openScene("Map002");
    // 在第二张图上又调了一下视角
    useEditorStore.setState({ viewport: { scale: 5, tx: 100, ty: 100 } });
    useEditorStore.getState().openScene("Map001");

    expect(viewport()).toEqual(mine);
  });

  it("画布尺寸还没量出来（0 宽）时**不动视口**（那时「适配」会把世界原点甩到角上）", () => {
    seed("Map001", { width: 0, height: 0 });
    const before = { scale: 3, tx: 5, ty: 7 };
    useEditorStore.setState({ viewport: before });

    useEditorStore.getState().openScene("Map002");

    expect(viewport()).toEqual(before);
  });

  it("点当前那一格（切到同一个场景）不重置视角", () => {
    seed("Map001");
    const mine = { scale: 2, tx: 40, ty: 40 };
    useEditorStore.setState({ viewport: mine });

    useEditorStore.getState().openScene("Map001");

    expect(viewport()).toEqual(mine);
  });

  it("切到**什么都没有**的场景：退回「世界原点居中」，不会抛", () => {
    seed("Map001");
    useEditorStore.setState({
      scenes: [SCENE_A, sceneOf("Map002", [createSceneObject({ id: "door", name: "木门" })])],
    });

    useEditorStore.getState().openScene("Map002");

    expect(viewport()).toEqual(fitViewport([], VIEW, 24));
  });

  it("适配装的是**画布上看得见的东西**：摆在地图外的对象不会被切掉", () => {
    // 地图 400×300 摆在原点，另有一个 64×64 的精灵落在很远的 (900, 0)
    const outside = createSceneObject({
      id: "far",
      name: "远处的东西",
      position: { x: 900, y: 0 },
    });
    const scene = sceneOf("Map002", [mapOf("map-b"), outside]);
    seed("Map001");
    useEditorStore.setState({ scenes: [SCENE_A, scene] });

    useEditorStore.getState().openScene("Map002");

    expect(viewport()).toEqual(fitSceneViewport([SCENE_A, scene], "Map002", VIEW));
    // 只看地图的话 1:1 就装得下；带上那个远处的对象必须缩下去（否则它就在屏幕外）
    expect(viewport().scale).toBeLessThan(1);
  });

  it("转过角度的对象按**四角包围盒**装：斜着摆的地图不会被切掉两个角", () => {
    const tilted = { ...mapOf("map-b"), rotation: Math.PI / 4 };
    const scene = sceneOf("Map002", [tilted]);
    // 用一块**装不下 1:1** 的画布，才看得到「按包围盒缩得更多」
    const small = { width: 400, height: 300 };
    seed("Map001", small);
    useEditorStore.setState({ scenes: [SCENE_A, scene] });

    useEditorStore.getState().openScene("Map002");

    expect(viewport()).toEqual(fitSceneViewport([SCENE_A, scene], "Map002", small));
    const upright = fitSceneViewport([SCENE_A, sceneOf("x", [mapOf("map-b")])], "Map002", small);
    expect(viewport().scale).toBeLessThan(upright.scale);
  });

  it("装得下就不放大：一张 120×120 的精灵在 1:1 下居中，而不是铺满整块画布", () => {
    const sprite = createSceneObject({
      id: "sprite",
      name: "精灵",
      position: { x: 0, y: 0 },
    });
    const scene = sceneOf("Map002", [sprite]);
    seed("Map001");
    useEditorStore.setState({ scenes: [SCENE_A, scene] });

    useEditorStore.getState().openScene("Map002");

    expect(viewport().scale).toBe(1);
    expect(viewport()).toEqual(fitSceneViewport([SCENE_A, scene], "Map002", VIEW));
  });
});

describe("场景顺序：中文拼音序 + **数字按数值比**", () => {
  it("第2幕 排在 第10幕 前面（逐字符比会反）", () => {
    expect([...["第10幕", "第2幕", "第1幕"]].sort(compareSceneNames)).toEqual([
      "第1幕",
      "第2幕",
      "第10幕",
    ]);
  });

  it("数字编号前缀同样按数值排（01- 与 10-）", () => {
    expect([...["10-地窖", "02-大厅", "01-门厅"]].sort(compareSceneNames)).toEqual([
      "01-门厅",
      "02-大厅",
      "10-地窖",
    ]);
  });

  it("中文名按拼音（地 di < 酒 jiu < 森 sen），并且是稳定序", () => {
    const names = ["酒馆", "森林", "地牢"];
    expect([...names].sort(compareSceneNames)).toEqual(["地牢", "酒馆", "森林"]);
    // 已经排好的再排一次不变（比较函数自洽）
    expect([...names].sort(compareSceneNames).sort(compareSceneNames)).toEqual([
      "地牢",
      "酒馆",
      "森林",
    ]);
  });
});
