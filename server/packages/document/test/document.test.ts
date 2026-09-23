import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import { CellMask, decodeRle, encodeRle } from "@dts/grid";
import {
  DEFAULT_OBJECT_SCALE,
  MAX_OBJECT_SCALE,
  MIN_OBJECT_SCALE,
  addObject,
  clearMapCells,
  clearMapFog,
  createGameObject,
  findMapObject,
  findObject,
  isMapFogEnabled,
  listMapObjects,
  mapFogMask,
  objectsInDrawOrder,
  paintMapCells,
  removeObject,
  setMapCells,
  setMapFogEnabled,
  setMapFogRegions,
  setMapGrid,
  setObjectActive,
  setObjectImage,
  setObjectLocked,
  setObjectPosition,
  setObjectRotation,
  setObjectScale,
  setObjectSortingOrder,
} from "../src/commands";
import { componentOf, imageOf, mapDataOf, objectImage, writeFeature } from "../src/access";
import { defaultComponentData, isKnownComponentType } from "../src/components";
import { DEFAULT_SLOT_COMPONENT } from "../src/presets";
import {
  createEmptyProject,
  createEmptyScene,
  createEmptySceneFile,
  createMapObject,
} from "../src/factory";
import { parseProjectDoc, parseProjectFile, parseSceneFile, upgradeRawDocument } from "../src/schema";
import { DEFAULT_HISTORY_LIMIT } from "../src/history";
import { formatIssues, hasErrors, validateProject, validateScene } from "../src/validation";
import { DOCUMENT_FORMAT_VERSION, type MapDataDoc, type ProjectDoc, type SceneDoc, type GameObjectDoc } from "../src/types";

const IMAGE = { id: "project:C/Assets/images/Map001.png", width: 1920, height: 1080 };
const GRID = { width: 8, height: 6 };

function makeScene(name = "Map001"): SceneDoc {
  return createEmptyScene(name);
}

function withMapObject(scene: SceneDoc, name = "Map001"): SceneDoc {
  return produce(scene, (draft) => {
    addObject(draft, createMapObject({ name: `${name} 地图`, image: IMAGE, grid: GRID, id: "map-1" }));
  });
}

/** 旧的 v2 工程文件：格式仍是 v2，且场景内联在里面（迁移用例用）。 */
function v2ProjectWith(...scenes: SceneDoc[]): Record<string, unknown> {
  const { items } = createEmptyProject("测试项目");
  return {
    formatVersion: 2,
    name: "测试项目",
    scenes: scenes.map((scene) => ({
      id: scene.name,
      name: scene.name,
      objects: scene.objects,
    })),
    items,
  };
}

function makeProject(): ProjectDoc {
  return createEmptyProject("测试项目");
}

function mutate<T>(value: T, recipe: (draft: Draft<T>) => void): T {
  return produce(value, recipe);
}

/**
 * 场景里一个普通对象的完整形状（`active` / `sortingOrder` 是 v7 起的显式字段）。
 *
 * 用例里只关心其中一两个字段，缺的字段用这里的默认值补上——手写整个对象会在
 * 每次加字段时把所有用例都拖下水。
 */
function plainObject(id: string, patch: Partial<GameObjectDoc> = {}): GameObjectDoc {
  return {
    id,
    name: id,
    kind: "Sprite",
    active: true,
    sortingOrder: 0,
    position: null,
    rotation: 0,
    scale: 1,
    locked: false,
    components: [],
    ...patch,
  };
}

/**
 * 把内存场景里的对象转成**磁盘上的原始 JSON 形状**（v19：特性住在 `components` 里）。
 *
 * 「文件里的形状」这类用例要喂给 `parseSceneFile` 的是 JSON，而场景里那些 `GridMap`
 * 组件带着 `undefined` 的 `fog` 之类非 JSON 值，所以先过一遍 `JSON.parse(JSON.stringify(...))`——
 * 与真实读写路径完全一致，也免得手写整份对象（每次加字段都要改一遍）。
 */
function rawObjects(objects: readonly GameObjectDoc[]): unknown[] {
  return JSON.parse(JSON.stringify(objects)) as unknown[];
}

/** 往场景里加一个普通对象。 */
function withObject(scene: SceneDoc, objectId = "door"): SceneDoc {
  return produce(scene, (draft) => {
    addObject(draft, plainObject(objectId));
  });
}

describe("文档工厂：场景是容器，对象挂在场景上", () => {
  it("新建场景是**空场景**（不需要地图也能建对象）", () => {
    const scene = makeScene();
    expect(scene.name).toBe("Map001");
    expect(scene.objects).toEqual([]);
    expect(Object.keys(scene).sort()).toEqual(["name", "objects"]);
  });

  it("地图是一个普通对象，数据挂在自己身上", () => {
    const mapObject = createMapObject({ name: "背景地图", image: IMAGE, grid: GRID, id: "m1" });
    expect(mapObject.kind).toBe("Map");
    // v19 起地图数据住在 `GridMap` 组件里，读一律走 `mapDataOf`
    expect(mapDataOf(mapObject)?.image).toEqual(IMAGE);
    // 显式写出「整张图都是空格子」，否则校验会判为数据不完整
    expect(mapDataOf(mapObject)?.cells).toEqual({
      encoding: "rle",
      runs: [[0, GRID.width * GRID.height]],
    });
  });

  it("新建项目只带项目级数据（没有 scenes）与空道具库", () => {
    const project = createEmptyProject("我的模组");
    expect(project.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect("scenes" in project).toBe(false);
    expect(project.items.count).toBe(0);
  });

  it("新建场景文件：当前版本、空对象", () => {
    const file = createEmptySceneFile();
    expect(file.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(file.objects).toEqual([]);
  });

  it("场景文件里**不存名字**（场景名就是文件名）", () => {
    const file = createEmptySceneFile();
    expect("name" in file).toBe(false);
    expect(Object.keys(file).sort()).toEqual(["formatVersion", "objects"]);
  });

  it("内存场景也不带 id（身份就是名字）", () => {
    const scene = createEmptyScene("酒馆");
    expect("id" in scene).toBe(false);
  });

  it("默认历史上限是 200", () => {
    expect(DEFAULT_HISTORY_LIMIT).toBe(200);
  });
});

describe("组件注册表", () => {
  it("覆盖全部 6 个对象能力组件类型", () => {
    for (const type of [
      "GridMap",
      "ImageLayer",
      "SpriteLayer",
      "PlaySound",
      "Teleport",
      "VideoOverlay",
    ]) {
      expect(isKnownComponentType(type)).toBe(true);
    }

    expect(isKnownComponentType("NotAComponent")).toBe(false);
  });

  it("默认数据按字段类型生成", () => {
    // 6 种对象能力组件都不声明面板字段（fields: []），默认数据是空记录；未知类型同样落空
    expect(defaultComponentData("GridMap")).toEqual({});
    expect(defaultComponentData("Unknown")).toEqual({});
  });
});

describe("对象命令（都在场景上操作）", () => {
  it("没有地图对象也能加对象", () => {
    const scene = mutate(makeScene(), (draft) => {
      addObject(
        draft,
        plainObject("door_01", { name: "木门", position: { x: -340, y: 121 } }),
      );
    });

    expect(scene.objects).toHaveLength(1);
    expect(findMapObject(scene)).toBeUndefined();
  });

  it("增删对象", () => {
    const scene = mutate(makeScene(), (draft) => {
      addObject(draft, plainObject("door_01", { name: "木门" }));
    });

    expect(scene.objects).toHaveLength(1);
    const removed = mutate(scene, (draft) => {
      removeObject(draft, "door_01");
    });
    expect(removed.objects).toHaveLength(0);
  });

  it("激活开关：只有真的变了才产生变更", () => {
    const scene = withObject(makeScene(), "door");

    expect(scene.objects[0]?.active).toBe(true);
    const hidden = mutate(scene, (draft) => {
      expect(setObjectActive(draft, "door", false)).toBe(true);
    });
    expect(hidden.objects[0]?.active).toBe(false);

    // 已经是 false 了，再设一次不算变更（否则撤销栈里会多一条空记录）
    mutate(hidden, (draft) => {
      expect(setObjectActive(draft, "door", false)).toBe(false);
    });

    // 不存在的对象不报错、也不产生变更
    mutate(scene, (draft) => {
      expect(setObjectActive(draft, "nope", false)).toBe(false);
    });
  });

  it("显示顺序：大的画在前面，取整并夹在范围内", () => {
    const scene = withObject(makeScene(), "door");

    const sorted = mutate(scene, (draft) => {
      expect(setObjectSortingOrder(draft, "door", 12.6)).toBe(true);
    });
    expect(sorted.objects[0]?.sortingOrder).toBe(13);

    // 夹取：顺序只是个层号，不接受失控的大数
    const clamped = mutate(scene, (draft) => {
      setObjectSortingOrder(draft, "door", 1e9);
    });
    expect(clamped.objects[0]?.sortingOrder).toBe(9999);

    // NaN / Infinity 直接拒绝，绝不写进文档
    mutate(scene, (draft) => {
      expect(setObjectSortingOrder(draft, "door", Number.NaN)).toBe(false);
      expect(setObjectSortingOrder(draft, "door", Number.POSITIVE_INFINITY)).toBe(false);
    });
    expect(scene.objects[0]?.sortingOrder).toBe(0);
  });

  it("绘制顺序：按 sortingOrder 排，相同的保持文件里的先后，且不改动原数组", () => {
    const scene = mutate(makeScene(), (draft) => {
      addObject(draft, plainObject("a", { sortingOrder: 5 }));
      addObject(draft, plainObject("b", { sortingOrder: -1 }));
      addObject(draft, plainObject("c", { sortingOrder: 5 }));
    });

    expect(objectsInDrawOrder(scene).map((object) => object.id)).toEqual(["b", "a", "c"]);
    // 文件里的顺序是数据，不是渲染排序的结果
    expect(scene.objects.map((object) => object.id)).toEqual(["a", "b", "c"]);
  });

  it("地图对象数据可写：setMapCells", () => {
    const scene = withMapObject(makeScene());
    const cells = new Uint8Array(GRID.width * GRID.height);
    cells[0] = CellMask.Obstacle;

    const next = mutate(scene, (draft) => {
      setMapCells(draft, "map-1", encodeRle(cells));
    });

    expect(mapDataOf(next.objects[0]!)?.cells.runs[0]?.[0]).toBe(CellMask.Obstacle);
  });

  it("清空格子：clearMapCells 把整张网格恢复成空", () => {
    const scene = mutate(withMapObject(makeScene()), (draft) => {
      const cells = new Uint8Array(GRID.width * GRID.height);
      cells[3] = CellMask.Obstacle;
      setMapCells(draft, "map-1", encodeRle(cells));
    });

    const cleared = mutate(scene, (draft) => {
      expect(clearMapCells(draft, "map-1")).toBe(true);
    });

    const map = mapDataOf(cleared.objects[0]!);
    // 写回的是**一个空游程**（铺满整张网格），不是空数组：留空会被判成数据不完整
    expect(map?.cells.runs).toEqual([[CellMask.Empty, GRID.width * GRID.height]]);
    expect(decodeRle(map?.cells.runs ?? [], GRID.width * GRID.height)).toEqual(
      new Uint8Array(GRID.width * GRID.height),
    );
    expect(hasErrors(validateScene(cleared))).toBe(false);

    // 已经是空的：不再产生变更
    let clearedAgain = true;
    const untouched = mutate(cleared, (draft) => {
      clearedAgain = clearMapCells(draft, "map-1");
    });
    expect(clearedAgain).toBe(false);
    expect(untouched).toBe(cleared);

    // 清空之后仍然可以改网格尺寸（空游程展开格数与网格一致）
    const resized = mutate(cleared, (draft) => {
      expect(setMapGrid(draft, "map-1", { width: 4, height: 3 })).toBe(true);
    });
    expect(mapDataOf(resized.objects[0]!)?.grid).toEqual({ width: 4, height: 3 });
  });

  it("标注一笔：直线经过的格子都被刷到，落盘仍是合法 RLE", () => {
    const scene = withMapObject(makeScene());
    const painted = mutate(scene, (draft) => {
      expect(paintMapCells(draft, "map-1", { x: 1, y: 2 }, { x: 4, y: 2 }, {
        mask: CellMask.Obstacle,
        brushSize: 1,
      })).toBe(true);
    });

    const cells = decodeRle(mapDataOf(painted.objects[0]!)?.cells.runs ?? [], GRID.width * GRID.height);
    for (let x = 1; x <= 4; x += 1) {
      expect(cells[2 * GRID.width + x]).toBe(CellMask.Obstacle);
    }

    expect([...cells].filter((mask) => mask !== 0)).toHaveLength(4);
    expect(hasErrors(validateScene(painted))).toBe(false);
  });

  it("标注是**按位叠加**：同一格先画区域1 再画区域4，两个位都在", () => {
    const painted = mutate(withMapObject(makeScene()), (draft) => {
      paintMapCells(draft, "map-1", { x: 2, y: 2 }, { x: 2, y: 2 }, {
        mask: CellMask.Obstacle,
        brushSize: 1,
      });
      paintMapCells(draft, "map-1", { x: 2, y: 2 }, { x: 2, y: 2 }, {
        mask: CellMask.Fog1,
        brushSize: 1,
      });
    });

    const cells = decodeRle(mapDataOf(painted.objects[0]!)?.cells.runs ?? [], GRID.width * GRID.height);
    expect(cells[2 * GRID.width + 2]).toBe(CellMask.Obstacle | CellMask.Fog1);
  });

  it("橡皮擦（掩码 0）整格清零", () => {
    const painted = mutate(withMapObject(makeScene()), (draft) => {
      paintMapCells(draft, "map-1", { x: 2, y: 2 }, { x: 2, y: 2 }, {
        mask: CellMask.Obstacle | CellMask.Fog1,
        brushSize: 1,
      });
    });

    const erased = mutate(painted, (draft) => {
      expect(paintMapCells(draft, "map-1", { x: 2, y: 2 }, { x: 2, y: 2 }, {
        mask: CellMask.Empty,
        brushSize: 1,
      })).toBe(true);
    });

    expect(
      [...decodeRle(mapDataOf(erased.objects[0]!)?.cells.runs ?? [], GRID.width * GRID.height)].every(
        (mask) => mask === 0,
      ),
    ).toBe(true);
  });

  it("画笔大小按 Unity 的整除语义覆盖：3 号画笔是 3×3", () => {
    const painted = mutate(withMapObject(makeScene()), (draft) => {
      paintMapCells(draft, "map-1", { x: 3, y: 3 }, { x: 3, y: 3 }, {
        mask: CellMask.Water,
        brushSize: 3,
      });
    });

    const cells = decodeRle(mapDataOf(painted.objects[0]!)?.cells.runs ?? [], GRID.width * GRID.height);
    expect([...cells].filter((mask) => mask !== 0)).toHaveLength(9);
  });

  it("落笔点在网格外时什么都不做（不夹到边缘格）", () => {
    const scene = withMapObject(makeScene());
    let changed = true;

    const next = mutate(scene, (draft) => {
      changed = paintMapCells(draft, "map-1", { x: 99, y: 99 }, { x: 99, y: 99 }, {
        mask: CellMask.Obstacle,
        brushSize: 5,
      });
    });

    expect(changed).toBe(false);
    expect(next).toBe(scene);
  });

  it("重复涂抹同一位不产生变更（不进撤销栈）", () => {
    const painted = mutate(withMapObject(makeScene()), (draft) => {
      paintMapCells(draft, "map-1", { x: 1, y: 1 }, { x: 1, y: 1 }, {
        mask: CellMask.Obstacle,
        brushSize: 1,
      });
    });

    let changed = true;
    const again = mutate(painted, (draft) => {
      changed = paintMapCells(draft, "map-1", { x: 1, y: 1 }, { x: 1, y: 1 }, {
        mask: CellMask.Obstacle,
        brushSize: 1,
      });
    });

    expect(changed).toBe(false);
    expect(again).toBe(painted);
  });

  it("格子数据本来就坏时拒绝标注，不把坏数据「修」成正常网格", () => {
    const scene = mutate(withMapObject(makeScene()), (draft) => {
      setMapCells(draft, "map-1", [[CellMask.Obstacle, 3]]);
    });

    let changed = true;
    const next = mutate(scene, (draft) => {
      changed = paintMapCells(draft, "map-1", { x: 0, y: 0 }, { x: 0, y: 0 }, {
        mask: CellMask.Water,
        brushSize: 1,
      });
    });

    expect(changed).toBe(false);
    expect(mapDataOf(next.objects[0]!)?.cells.runs).toEqual([[CellMask.Obstacle, 3]]);
  });

  it("改网格尺寸：格子按新规格重建，重叠部分保留、多出来的格子是空", () => {
    // (0,0) 放区域1、(1,1) 放区域3
    const scene = mutate(withMapObject(makeScene()), (draft) => {
      const cells = new Uint8Array(GRID.width * GRID.height);
      cells[0] = CellMask.Obstacle;
      cells[GRID.width + 1] = CellMask.Water;
      setMapCells(draft, "map-1", encodeRle(cells));
    });

    const grown = mutate(scene, (draft) => {
      expect(setMapGrid(draft, "map-1", { width: 10, height: 8 })).toBe(true);
    });

    const map = mapDataOf(grown.objects[0]!);
    expect(map?.grid).toEqual({ width: 10, height: 8 });

    // 行主序铺满新网格：格数 = 列 × 行（校验就是这么要求的）
    const cells = decodeRle(map?.cells.runs ?? [], 10 * 8);
    expect(cells[0]).toBe(CellMask.Obstacle);
    expect(cells[10 + 1]).toBe(CellMask.Water);
    expect([...cells].filter((mask) => mask !== 0).length).toBe(2);

    // 缩回去：还在范围内的格子保留
    const shrunk = mutate(grown, (draft) => {
      expect(setMapGrid(draft, "map-1", { width: 8, height: 6 })).toBe(true);
    });
    const back = decodeRle(mapDataOf(shrunk.objects[0]!)?.cells.runs ?? [], 8 * 6);
    expect(back[0]).toBe(CellMask.Obstacle);
    expect(back[8 + 1]).toBe(CellMask.Water);
  });

  it("改网格尺寸：没变就不产生变更，0 / 负数被挡回 1 格", () => {
    const scene = withMapObject(makeScene());
    let changed = true;

    const same = mutate(scene, (draft) => {
      changed = setMapGrid(draft, "map-1", GRID);
    });
    expect(changed).toBe(false);
    expect(mapDataOf(same.objects[0]!)?.grid).toEqual(GRID);

    const tiny = mutate(scene, (draft) => {
      setMapGrid(draft, "map-1", { width: 0, height: -3 });
    });
    expect(mapDataOf(tiny.objects[0]!)?.grid).toEqual({ width: 1, height: 1 });
    expect(decodeRle(mapDataOf(tiny.objects[0]!)?.cells.runs ?? [], 1)).toEqual(new Uint8Array([0]));
  });

  it("改过尺寸的网格仍然通过校验（格数与网格一致）", () => {
    const scene = mutate(withMapObject(makeScene()), (draft) => {
      setMapGrid(draft, "map-1", { width: 10, height: 8 });
    });

    expect(hasErrors(validateScene(scene))).toBe(false);
  });

  it("格子数据本来就坏（展开格数对不上）时拒绝改尺寸，不把坏数据「修」成空网格", () => {
    const scene = mutate(withMapObject(makeScene()), (draft) => {
      setMapCells(draft, "map-1", [[CellMask.Obstacle, 3]]);
    });

    let changed = true;
    const next = mutate(scene, (draft) => {
      changed = setMapGrid(draft, "map-1", { width: 10, height: 8 });
    });

    expect(changed).toBe(false);
    expect(mapDataOf(next.objects[0]!)?.grid).toEqual(GRID);
  });

  it("findMapObject / listMapObjects 只挑地图对象", () => {
    const scene = withObject(withMapObject(makeScene()), "door");
    expect(findMapObject(scene)?.id).toBe("map-1");
    expect(listMapObjects(scene).map((object) => object.id)).toEqual(["map-1"]);
  });

  it("缩放：每个对象都有，新建是 1；可以改，且不动位置", () => {
    const scene = withObject(makeScene(), "door");
    expect(scene.objects[0]?.scale).toBe(DEFAULT_OBJECT_SCALE);

    const scaled = mutate(scene, (draft) => {
      expect(setObjectScale(draft, "door", 2.5)).toBe(true);
    });

    expect(scaled.objects[0]?.scale).toBe(2.5);
    // 缩放改的是「占多大」，矩形中心（位置）不动
    expect(scaled.objects[0]?.position).toEqual(scene.objects[0]?.position);
  });

  it("角度：新建是 0；存弧度，可以改，且不动位置与缩放", () => {
    const scene = withObject(makeScene(), "door");
    expect(scene.objects[0]?.rotation).toBe(0);

    const rotated = mutate(scene, (draft) => {
      // 30° = π/6
      expect(setObjectRotation(draft, "door", Math.PI / 6)).toBe(true);
    });

    expect(rotated.objects[0]?.rotation).toBeCloseTo(Math.PI / 6, 10);
    expect(rotated.objects[0]?.position).toEqual(scene.objects[0]?.position);
    expect(rotated.objects[0]?.scale).toBe(scene.objects[0]?.scale);
  });

  it("角度归一化到 (-180°, 180°]：转 370° 与转 10° 是同一个姿态", () => {
    const scene = withObject(makeScene(), "door");

    // 370° 应存成 10°
    const wrapped = mutate(scene, (draft) => {
      setObjectRotation(draft, "door", (370 * Math.PI) / 180);
    });
    expect((wrapped.objects[0]!.rotation * 180) / Math.PI).toBeCloseTo(10, 6);

    // -180° 应存成 180°（正半圈，不变成负的）
    const half = mutate(scene, (draft) => {
      setObjectRotation(draft, "door", -Math.PI);
    });
    expect((half.objects[0]!.rotation * 180) / Math.PI).toBeCloseTo(180, 6);

    // 负角度保留负号（符号与 Unity 一致，不能被吃掉）
    const negative = mutate(scene, (draft) => {
      setObjectRotation(draft, "door", (-45 * Math.PI) / 180);
    });
    expect((negative.objects[0]!.rotation * 180) / Math.PI).toBeCloseTo(-45, 6);
  });

  it("角度：NaN / Infinity 直接拒绝，不写进文档", () => {
    const scene = withObject(makeScene(), "door");

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      let changed = true;
      const next = mutate(scene, (draft) => {
        changed = setObjectRotation(draft, "door", bad);
      });

      expect(changed).toBe(false);
      expect(next.objects[0]?.rotation).toBe(0);
    }
  });

  it("角度：同值不产生改动（撤销栈里不留空记录）", () => {
    const scene = withObject(makeScene(), "door");
    let changed = true;
    const next = mutate(scene, (draft) => {
      changed = setObjectRotation(draft, "door", 0);
    });

    expect(changed).toBe(false);
    expect(next.objects[0]?.rotation).toBe(0);
  });

  it("缩放夹在 0.01 ~ 100：0 / 负数 / 超大值都不会原样写进文档", () => {
    const scene = withObject(makeScene(), "door");

    const tiny = mutate(scene, (draft) => {
      setObjectScale(draft, "door", 0);
    });
    expect(tiny.objects[0]?.scale).toBe(MIN_OBJECT_SCALE);

    const negative = mutate(scene, (draft) => {
      setObjectScale(draft, "door", -3);
    });
    expect(negative.objects[0]?.scale).toBe(MIN_OBJECT_SCALE);

    const huge = mutate(scene, (draft) => {
      setObjectScale(draft, "door", 1e9);
    });
    expect(huge.objects[0]?.scale).toBe(MAX_OBJECT_SCALE);
  });

  it("缩放：NaN 直接拒绝，相同值也不产生变更", () => {
    const scene = withObject(makeScene(), "door");
    let changed = true;

    const nan = mutate(scene, (draft) => {
      changed = setObjectScale(draft, "door", Number.NaN);
    });
    expect(changed).toBe(false);
    expect(nan).toBe(scene);

    const same = mutate(scene, (draft) => {
      changed = setObjectScale(draft, "door", DEFAULT_OBJECT_SCALE);
    });
    expect(changed).toBe(false);
    expect(same).toBe(scene);
  });

  it("地图对象同样有缩放（贴图与网格一起缩放）", () => {
    const scene = withMapObject(makeScene());
    expect(scene.objects[0]?.scale).toBe(DEFAULT_OBJECT_SCALE);

    const scaled = mutate(scene, (draft) => {
      expect(setObjectScale(draft, "map-1", 0.5)).toBe(true);
    });
    expect(scaled.objects[0]?.scale).toBe(0.5);
  });

  it("缩放不是正数时报错（坏数据不许悄悄留在文件里）", () => {
    const scene = mutate(withObject(makeScene(), "door"), (draft) => {
      // 命令夹得住，这里直接写坏值：只有手写文件才会这样
      if (draft.objects[0] !== undefined) {
        draft.objects[0].scale = 0;
      }
    });

    expect(formatIssues(validateScene(scene))).toMatch(/缩放必须是正数/);
  });

  it("锁定：新建默认不锁；setObjectLocked 只改这一个标记", () => {
    const scene = withObject(makeScene(), "door");
    expect(scene.objects[0]?.locked).toBe(false);

    const locked = mutate(scene, (draft) => {
      expect(setObjectLocked(draft, "door", true)).toBe(true);
    });

    expect(locked.objects[0]?.locked).toBe(true);
    // 锁只改标记：位置 / 缩放 / 激活都不动（「不能移动」的拦截在编辑器的 moveObject 里）
    expect(locked.objects[0]?.position).toEqual(scene.objects[0]?.position);
    expect(locked.objects[0]?.scale).toBe(scene.objects[0]?.scale);
    expect(locked.objects[0]?.active).toBe(true);

    // 相同值不产生变更
    let changed = true;
    const same = mutate(locked, (draft) => {
      changed = setObjectLocked(draft, "door", true);
    });
    expect(changed).toBe(false);
    expect(same).toBe(locked);

    const unlocked = mutate(locked, (draft) => {
      expect(setObjectLocked(draft, "door", false)).toBe(true);
    });
    expect(unlocked.objects[0]?.locked).toBe(false);
  });

  it("锁定：地图对象同样有（底图最容易被误拖）", () => {
    const scene = withMapObject(makeScene());
    expect(scene.objects[0]?.locked).toBe(false);

    const locked = mutate(scene, (draft) => {
      expect(setObjectLocked(draft, "map-1", true)).toBe(true);
    });
    expect(locked.objects[0]?.locked).toBe(true);
  });

  it("地图也参与摆放：setObjectPosition 对它生效（贴图中心跟着走）", () => {    const scene = withMapObject(makeScene());

    const next = mutate(scene, (draft) => {
      expect(setObjectPosition(draft, "map-1", { x: 100, y: 50 })).toBe(true);
    });

    expect(next.objects[0]?.position).toEqual({ x: 100, y: 50 });
  });

  it("普通对象照常落位（位置可以清回 null）", () => {
    const scene = withObject(makeScene(), "door");

    const moved = mutate(scene, (draft) => {
      setObjectPosition(draft, "door", { x: -320, y: 270 });
    });
    expect(moved.objects[0]?.position).toEqual({ x: -320, y: 270 });

    const cleared = mutate(moved, (draft) => {
      setObjectPosition(draft, "door", null);
    });
    expect(cleared.objects[0]?.position).toBeNull();
  });

  it("isPositionableObject 早就不在了；对象图片：地图在 map.image，精灵在 image", () => {
    const sprite = createGameObject({
      name: "精灵",
      kind: "Sprite",
      position: { x: 0, y: 0 },
    });
    expect(objectImage(sprite)).toBeUndefined();
    expect(objectImage(createMapObject({ name: "地图", image: IMAGE, grid: GRID }))).toEqual(IMAGE);
  });

  it("setObjectImage：地图写进 map.image，精灵写进 image", () => {
    const next = { id: "project:C/Assets/images/sprite.png", width: 200, height: 150 };

    const withMap = mutate(withMapObject(makeScene()), (draft) => {
      expect(setObjectImage(draft, "map-1", next)).toBe(true);
    });
    expect(mapDataOf(withMap.objects[0]!)?.image).toEqual(next);
    // 地图的贴图住在 GridMap 里，没有单独的图片层组件
    expect(imageOf(withMap.objects[0]!)).toBeUndefined();

    const withSprite = mutate(withObject(makeScene(), "sprite"), (draft) => {
      expect(setObjectImage(draft, "sprite", next)).toBe(true);
    });
    expect(imageOf(withSprite.objects[0]!)).toEqual(next);
    expect(mapDataOf(withSprite.objects[0]!)).toBeUndefined();

    // 同一张图再设一次：没有变更（recipe 不返回值，否则 immer 会拿返回值当新状态）
    expect(
      mutate(withSprite, (draft) => {
        setObjectImage(draft, "sprite", next);
      }),
    ).toBe(withSprite);
  });

  it("新建地图对象带着世界坐标（默认原点）——它就是贴图中心", () => {
    const map = createMapObject({ name: "地图", image: IMAGE, grid: GRID, position: { x: 30, y: -40 } });
    expect(map.position).toEqual({ x: 30, y: -40 });
    expect(createMapObject({ name: "地图", image: IMAGE, grid: GRID }).position).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("战争雾：手动指定雾区", () => {
  /** 场景里那张地图的 cells（断言用）。 */
  function mapCells(scene: SceneDoc): Uint8Array {
    const map = mapDataOf(scene.objects[0]!);
    if (map === undefined) {
      throw new Error("场景里没有地图对象");
    }

    return decodeRle(map.cells.runs, map.grid.width * map.grid.height);
  }

  /** 场景里那张地图的地图数据（断言用；没有就抛，免得断言在 `undefined` 上空转）。 */
  function firstMap(file: { readonly objects: readonly GameObjectDoc[] }): MapDataDoc {
    const map = mapDataOf(file.objects[0]!);
    if (map === undefined) {
      throw new Error("场景里没有地图对象");
    }

    return map;
  }

  it("指定雾区：写进 map.fog.regions，规范化后落盘", () => {
    let scene = withMapObject(makeScene());

    // 16 / 重复的 16 / 0（橡皮擦位，不是区域）/ 3（不是单个位）/ 256（越界）都该被丢掉
    scene = mutate(scene, (draft) => {
      setMapFogRegions(draft, "map-1", [16, 8, 16, 0, 3, 256]);
    });
    expect(mapDataOf(scene.objects[0]!)?.fog?.regions).toEqual([8, 16]);

    // 同一个选择再写一次 = 没变更（不进撤销栈）
    expect(
      mutate(scene, (draft) => {
        setMapFogRegions(draft, "map-1", [8, 16]);
      }),
    ).toBe(scene);
    // 顺序不同但集合相同也算没变
    expect(
      mutate(scene, (draft) => {
        setMapFogRegions(draft, "map-1", [16, 8]);
      }),
    ).toBe(scene);
  });

  it("解除绑定：雾区清空、格子数据不动；开关关着时才把字段整个摘掉", () => {
    let scene = withMapObject(makeScene());
    scene = mutate(scene, (draft) => {
      setMapFogRegions(draft, "map-1", [8]);
      paintMapCells(draft, "map-1", { x: 1, y: 1 }, { x: 1, y: 1 }, { mask: CellMask.Fog1, brushSize: 1 });
    });
    expect(mapDataOf(scene.objects[0]!)?.fog).toEqual({ enabled: true, regions: [8] });

    scene = mutate(scene, (draft) => {
      setMapFogRegions(draft, "map-1", []);
    });
    // 开关还开着：字段留着（「开着但还没指定雾区」）——属性面板那一组不会整个塌掉
    expect(mapDataOf(scene.objects[0]!)?.fog).toEqual({ enabled: true, regions: [] });
    // 解除绑定 ≠ 清数据：画好的雾格子还在，重新绑定就回来
    expect(mapCells(scene)[1 * GRID.width + 1]).toBe(CellMask.Fog1);

    // 关掉开关：没有内容要记了，字段整个摘掉（与「从没开过」同义）
    scene = mutate(scene, (draft) => {
      setMapFogEnabled(draft, "map-1", false);
    });
    expect(mapDataOf(scene.objects[0]!)?.fog).toBeUndefined();
    expect(mapCells(scene)[1 * GRID.width + 1]).toBe(CellMask.Fog1);
  });

  it("mapFogMask：没指定是 0，指定后是各位置的并集", () => {
    const scene = withMapObject(makeScene());
    const map = mapDataOf(scene.objects[0]!);
    if (map === undefined) {
      throw new Error("场景里没有地图对象");
    }

    expect(mapFogMask(map)).toBe(0);
    expect(mapFogMask({ ...map, fog: { enabled: true, regions: [8, 32] } })).toBe(40);
  });

  it("清空战争雾：只清绑定位，其它区域位保留", () => {
    let scene = withMapObject(makeScene());
    scene = mutate(scene, (draft) => {
      setMapFogRegions(draft, "map-1", [CellMask.Fog1]);
      // 一格「区域1 + 区域4」、另一格只有区域1
      paintMapCells(draft, "map-1", { x: 0, y: 0 }, { x: 0, y: 0 }, { mask: CellMask.Obstacle, brushSize: 1 });
      paintMapCells(draft, "map-1", { x: 0, y: 0 }, { x: 0, y: 0 }, { mask: CellMask.Fog1, brushSize: 1 });
      paintMapCells(draft, "map-1", { x: 1, y: 0 }, { x: 1, y: 0 }, { mask: CellMask.Obstacle, brushSize: 1 });
    });

    scene = mutate(scene, (draft) => {
      expect(clearMapFog(draft, "map-1")).toBe(true);
    });

    expect(mapCells(scene)[0]).toBe(CellMask.Obstacle);
    expect(mapCells(scene)[1]).toBe(CellMask.Obstacle);
  });

  it("清空战争雾：没指定雾区、或本来就没有雾格时都不产生变更", () => {
    const scene = withMapObject(makeScene());
    expect(
      mutate(scene, (draft) => {
        clearMapFog(draft, "map-1");
      }),
    ).toBe(scene);

    const bound = mutate(scene, (draft) => {
      setMapFogRegions(draft, "map-1", [CellMask.Fog1]);
    });
    // 指定了雾区，但一个雾格都没画
    expect(
      mutate(bound, (draft) => {
        clearMapFog(draft, "map-1");
      }),
    ).toBe(bound);
  });

  it("橡皮擦只清指定位（eraseMask），不传时仍是整格清零", () => {
    const painted = mutate(withMapObject(makeScene()), (draft) => {
      paintMapCells(draft, "map-1", { x: 2, y: 2 }, { x: 2, y: 2 }, { mask: CellMask.Obstacle, brushSize: 1 });
      paintMapCells(draft, "map-1", { x: 2, y: 2 }, { x: 2, y: 2 }, { mask: CellMask.Fog1, brushSize: 1 });
    });

    // 只擦区域4（位 8）：区域1（位 1）保住
    const partial = mutate(painted, (draft) => {
      paintMapCells(draft, "map-1", { x: 2, y: 2 }, { x: 2, y: 2 }, {
        mask: CellMask.Empty,
        brushSize: 1,
        eraseMask: CellMask.Fog1,
      });
    });
    expect(mapCells(partial)[2 * GRID.width + 2]).toBe(CellMask.Obstacle);

    // 不传 eraseMask = 整格清零（标注调色板的橡皮，行为不变）
    const whole = mutate(painted, (draft) => {
      paintMapCells(draft, "map-1", { x: 2, y: 2 }, { x: 2, y: 2 }, {
        mask: CellMask.Empty,
        brushSize: 1,
      });
    });
    expect(mapCells(whole)[2 * GRID.width + 2]).toBe(0);
  });

  it("总开关：打开写下一份空绑定，关掉时雾区留着——一个都没指定才把字段摘掉", () => {
    let scene = withMapObject(makeScene());
    expect(isMapFogEnabled(firstMap(scene))).toBe(false);
    expect(mapFogMask(firstMap(scene))).toBe(0);

    // 打开：**开关状态本身也是要存的数据**，不然下次打开项目它又变回关着
    scene = mutate(scene, (draft) => {
      expect(setMapFogEnabled(draft, "map-1", true)).toBe(true);
    });
    expect(mapDataOf(scene.objects[0]!)?.fog).toEqual({ enabled: true, regions: [] });
    expect(isMapFogEnabled(firstMap(scene))).toBe(true);

    // 同一个状态再写一次 = 没变更（不进撤销栈）
    expect(
      mutate(scene, (draft) => {
        setMapFogEnabled(draft, "map-1", true);
      }),
    ).toBe(scene);

    // 指定雾区：开关原样不动（绑定与开关是两件事）
    scene = mutate(scene, (draft) => {
      setMapFogRegions(draft, "map-1", [CellMask.Fog1]);
    });
    expect(mapDataOf(scene.objects[0]!)?.fog).toEqual({ enabled: true, regions: [CellMask.Fog1] });

    // 关掉：**雾区绑定留着**（先关掉看看效果、再打开不该逼人重新指定一遍）
    scene = mutate(scene, (draft) => {
      expect(setMapFogEnabled(draft, "map-1", false)).toBe(true);
    });
    expect(mapDataOf(scene.objects[0]!)?.fog).toEqual({ enabled: false, regions: [CellMask.Fog1] });
    expect(isMapFogEnabled(firstMap(scene))).toBe(false);

    // 关着的时候照样能改绑定
    scene = mutate(scene, (draft) => {
      setMapFogRegions(draft, "map-1", [CellMask.Fog1, CellMask.Fog2]);
    });
    expect(mapDataOf(scene.objects[0]!)?.fog).toEqual({
      enabled: false,
      regions: [CellMask.Fog1, CellMask.Fog2],
    });

    // 关掉且一个雾区都没指定：`fog` 整个摘掉（与「从没开过」同义，文件里不留空壳）
    const off = mutate(withMapObject(makeScene()), (draft) => {
      setMapFogEnabled(draft, "map-1", true);
      setMapFogEnabled(draft, "map-1", false);
    });
    expect(mapDataOf(off.objects[0]!)?.fog).toBeUndefined();

    // 关掉一个本来就没开的 = 没变更
    const fresh = withMapObject(makeScene());
    expect(
      mutate(fresh, (draft) => {
        setMapFogEnabled(draft, "map-1", false);
      }),
    ).toBe(fresh);
  });

  it("v13 之前的老文件：`fog` 里没有 enabled，读出来算**开着**并补进内存", () => {
    const object = withMapObject(makeScene()).objects[0];
    const map = object === undefined ? undefined : mapDataOf(object);
    if (object === undefined || map === undefined) {
      throw new Error("场景里没有地图对象");
    }

    // v12 的文件：那时写下 fog 就等于「这张地图有雾」（补成 false 会把老场景的雾全关掉）。
    // `fog` 住在 GridMap 组件的 data 里，`enabled` 缺省由 schema 补成 `true`。
    const load = parseSceneFile({
      formatVersion: 12,
      objects: [
        {
          ...object,
          components: [
            {
              id: "map-1__GridMap",
              type: "GridMap",
              data: { ...map, fog: { regions: [CellMask.Fog1] } },
              actions: [],
            },
          ],
        },
      ],
    });

    expect(load.file.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(mapDataOf(load.file.objects[0]!)?.fog).toEqual({ enabled: true, regions: [CellMask.Fog1] });
    expect(isMapFogEnabled(firstMap(load.file))).toBe(true);
    // 版本号从 12 涨到 13 → 要求回写一次，磁盘上的文件从此自描述（带 enabled）
    expect(load.needsRewrite).toBe(true);
  });
});

describe("文档校验", () => {
  it("干净的项目没有错误", () => {
    expect(hasErrors(validateProject(makeProject()))).toBe(false);
  });

  it("没有地图对象的场景也是合法的（对象挂在场景上，不依赖地图）", () => {
    const scene = withObject(makeScene(), "door");
    expect(hasErrors(validateScene(scene))).toBe(false);
  });

  it("战争雾指定的不是可绘制区域位时给警告（会被编辑器丢掉）", () => {
    const scene = mutate(withMapObject(makeScene()), (draft) => {
      // 手写文件里才会出现的坏值：`mapDataOf` 是只读入口，这里直接改组件 data
      const component = draft.objects[0]?.components.find(
        (item) => item.type === DEFAULT_SLOT_COMPONENT.map,
      );
      if (component !== undefined) {
        // 3 = 两位之和、256 = 越界：编辑器读取时会被 normalizeRegions 丢掉
        component.data.fog = { enabled: true, regions: [8, 3, 256] };
      }
    });

    // 只是警告：读得开、画得出，别把文件判成读不了
    expect(hasErrors(validateScene(scene))).toBe(false);
    expect(formatIssues(validateScene(scene))).toMatch(/战争雾指定的 3, 256 不是可绘制的区域位/);
  });

  it("战争雾开着却没指定雾区、或关着却指定了雾区：都只是警告（都不会有雾）", () => {
    // 开着但一个雾区都没指定：前端不会建雾层，画面上什么都不会发生
    const on = mutate(withMapObject(makeScene()), (draft) => {
      setMapFogEnabled(draft, "map-1", true);
    });
    expect(hasErrors(validateScene(on))).toBe(false);
    expect(formatIssues(validateScene(on))).toMatch(/战争雾开着但没指定雾区（不会有雾）/);

    // 关着但绑定留着：「明明指定了却不生效」得说出来
    const off = mutate(withMapObject(makeScene()), (draft) => {
      setMapFogRegions(draft, "map-1", [CellMask.Fog1]);
      setMapFogEnabled(draft, "map-1", false);
    });
    expect(hasErrors(validateScene(off))).toBe(false);
    expect(formatIssues(validateScene(off))).toMatch(/战争雾关着：指定的雾区不会生成雾/);

    // 开着 + 指定了：一句警告都没有
    const ready = mutate(withMapObject(makeScene()), (draft) => {
      setMapFogRegions(draft, "map-1", [CellMask.Fog1]);
    });
    expect(formatIssues(validateScene(ready))).not.toMatch(/战争雾/);
  });

  it("地图对象缺少地图数据时报错", () => {
    const scene = mutate(makeScene(), (draft) => {
      addObject(draft, plainObject("broken-map", { name: "坏地图", kind: "Map" }));
    });

    expect(formatIssues(validateScene(scene))).toMatch(/缺少地图数据/);
  });

  it("非地图对象带地图数据时给警告", () => {
    // v19 起「带地图数据」= 挂着 GridMap 组件（`kind` 不是 Map 时校验会提醒）
    const scene = mutate(makeScene(), (draft) => {
      addObject(draft, plainObject("odd", { name: "怪对象" }));
      const object = findObject(draft, "odd");
      if (object !== undefined) {
        writeFeature(object, DEFAULT_SLOT_COMPONENT.map, {
          image: IMAGE,
          grid: GRID,
          rowOrder: "bottom-up",
          cells: { encoding: "rle", runs: [[0, GRID.width * GRID.height]] },
        });
      }
    });

    const issues = validateScene(scene);
    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).toMatch(/不应携带地图数据/);
  });

  it("地图对象带多余的 object.image 时给警告（贴图只认 map.image）", () => {
    const scene = mutate(withMapObject(makeScene()), (draft) => {
      // 地图不该有 ImageLayer：贴图只认 GridMap 里的那一份（手写文件里可能挂着）
      const object = findObject(draft, "map-1");
      if (object !== undefined) {
        writeFeature(object, DEFAULT_SLOT_COMPONENT.image, {});
      }
    });

    const issues = validateScene(scene);
    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).toMatch(/写在 map.image/);
  });

  it("地图网格格数与网格尺寸不符时报错", () => {
    const scene = mutate(withMapObject(makeScene()), (draft) => {
      const component = draft.objects[0]?.components.find(
        (item) => item.type === DEFAULT_SLOT_COMPONENT.map,
      );
      if (component !== undefined) {
        component.data.cells = { encoding: "rle", runs: [[1, 3]] };
      }
    });

    expect(formatIssues(validateScene(scene))).toMatch(/不匹配/);
  });

  it("未知组件类型只给警告（数据原样保留）", () => {
    const scene = mutate(withObject(makeScene(), "o"), (draft) => {
      draft.objects[0]?.components.push({
        id: "c",
        type: "FutureComponent",
        data: {},
      });
    });

    const issues = validateScene(scene);
    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).toMatch(/未知组件类型/);
  });

  it("位置不是有限数值时报错", () => {
    const scene = mutate(withObject(makeScene(), "o"), (draft) => {
      const object = draft.objects[0];
      if (object !== undefined) {
        object.position = { x: Number.NaN, y: 0 };
      }
    });

    expect(formatIssues(validateScene(scene))).toMatch(/位置不是有限数值/);
  });

  it("世界坐标不受 [0,1] 限制（场景可以很大，位置可以是负数）", () => {
    const scene = mutate(withObject(makeScene(), "o"), (draft) => {
      const object = draft.objects[0];
      if (object !== undefined) {
        object.position = { x: -1200, y: 800 };
      }
    });

    expect(hasErrors(validateScene(scene))).toBe(false);
  });

  it("道具库 count 与实际条目不一致时给警告", () => {
    const project: ProjectDoc = {
      ...makeProject(),
      items: { source: "x", updatedAt: "2026-01-01", count: 5, items: [] },
    };

    const issues = validateProject(project);
    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).toMatch(/不一致/);
  });
});

describe("工程文件 schema 与版本迁移", () => {
  it("合法工程文件可解析", () => {
    const project = makeProject();
    expect(parseProjectDoc(JSON.parse(JSON.stringify(project))).name).toBe("测试项目");
  });

  it("缺少必填字段时抛出带路径的错误", () => {
    expect(() => parseProjectDoc({ formatVersion: 3, name: "x" })).toThrow(/项目文档校验失败/);
  });

  it("拒绝高于支持版本的文件（不静默丢字段）", () => {
    const project = { ...makeProject(), formatVersion: 99 };
    expect(() => parseProjectDoc(project)).toThrow(/高于本编辑器支持/);
  });

  it("当前版本工程文件：无需迁移也无需回写", () => {
    const loaded = parseProjectFile(JSON.parse(JSON.stringify(makeProject())));
    expect(loaded.doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(loaded.doc.name).toBe("测试项目");
    expect(loaded.migratedScenes).toEqual([]);
    expect(loaded.needsRewrite).toBe(false);
  });

  it("v3 工程文件：需要回写成当前版本", () => {
    const v3 = {
      formatVersion: 3,
      name: "旧工程",
      scenes: [
        {
          id: "Map001",
          name: "Map001",
          objects: [],
        },
      ],
      items: { source: "item.xlsx", updatedAt: "2026-01-01", count: 0, items: [] },
    };

    const loaded = parseProjectFile(v3);
    expect(loaded.needsRewrite).toBe(true);
    expect(loaded.doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(loaded.migratedScenes.map((scene) => scene.name)).toEqual(["Map001"]);
  });

  it("v2 工程文件：内联场景被拆出来交给调用方落盘，并要求回写", () => {
    const mapScene = withMapObject(makeScene("Map001"));
    const loaded = parseProjectFile(JSON.parse(JSON.stringify(v2ProjectWith(mapScene, makeScene("酒馆")))));

    expect(loaded.needsRewrite).toBe(true);
    expect(loaded.migratedScenes.map((scene) => scene.name)).toEqual(["Map001", "酒馆"]);
    // 地图数据原样搬进场景（对象仍是场景上的对象），且内存场景没有 id
    expect(loaded.migratedScenes[0]?.objects.map((object) => object.kind)).toEqual(["Map"]);
    expect(mapDataOf(loaded.migratedScenes[0]!.objects[0]!)?.image).toEqual(IMAGE);
    expect("id" in (loaded.migratedScenes[0] ?? {})).toBe(false);
    // 工程文件本身只留项目级数据
    expect("scenes" in loaded.doc).toBe(false);
    expect(loaded.doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
  });

  it("v1（地图即场景）先升级为 v2 再拆成场景文件", () => {
    const v1 = {
      formatVersion: 1,
      name: "老工程",
      maps: [
        {
          id: "map-1",
          name: "Map001",
          image: IMAGE,
          grid: GRID,
          rowOrder: "bottom-up",
          cells: { encoding: "rle", runs: [[0, GRID.width * GRID.height]] },
          objects: [
            {
              id: "door",
              name: "木门",
              // 那时「普通场景对象」写的就是基类这个名字（v22 起改成 `Sprite`，见下面那条断言）
              kind: "SceneObject",
              position: null,
              rotation: 0,
              components: [],
            },
          ],
        },
      ],
      items: { source: "item.xlsx", updatedAt: "2026-01-01", count: 0, items: [] },
    };

    const loaded = parseProjectFile(v1);
    expect(loaded.doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(loaded.needsRewrite).toBe(true);
    expect(loaded.migratedScenes).toHaveLength(1);

    const scene = loaded.migratedScenes[0];
    expect(scene?.name).toBe("Map001");
    // 原来的地图数据被搬到一个 Map 对象上，原有对象保持不动（只有 kind 被 v22 改成具体类型）
    expect(scene?.objects.map((object) => object.kind)).toEqual(["Map", "Sprite"]);
    expect(mapDataOf(scene!.objects[0]!)?.image).toEqual(IMAGE);
    expect(scene?.objects[1]?.id).toBe("door");

    // 旧名字仍可用：只取项目级数据
    expect(parseProjectDoc(v1).name).toBe("老工程");
    // upgradeRawDocument 仍是公开入口（有调用方/测试依赖）
    expect((upgradeRawDocument(v1) as { formatVersion: number }).formatVersion).toBe(2);
  });

  it("v2 但场景为空：仍需回写（把版本号升到当前版本）", () => {
    const loaded = parseProjectFile(JSON.parse(JSON.stringify(v2ProjectWith())));
    expect(loaded.migratedScenes).toEqual([]);
    expect(loaded.needsRewrite).toBe(true);
    expect(loaded.doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
  });

  it("非 bottom-up 行序在场景文件里被拒绝（避免坐标约定被悄悄改掉）", () => {
    const scene = JSON.parse(
      JSON.stringify({
        formatVersion: 5,
        objects: rawObjects(withMapObject(makeScene()).objects),
      }),
    ) as { objects: Array<{ components: Array<{ type: string; data: { rowOrder: string } }> }> };
    const mapObject = scene.objects[0];
    const mapComponent = mapObject?.components.find((item) => item.type === DEFAULT_SLOT_COMPONENT.map);
    if (mapComponent !== undefined) {
      mapComponent.data.rowOrder = "top-down";
    }

    expect(() => parseSceneFile(scene)).toThrow(/场景文件校验失败/);
  });
});

describe("场景文件 schema", () => {
  it("拒绝高于支持版本的文件（不静默丢字段）", () => {
    expect(() =>
      parseSceneFile({ formatVersion: DOCUMENT_FORMAT_VERSION + 1, objects: [] }),
    ).toThrow(/高于本编辑器支持/);
  });

  it("合法场景文件可解析（场景名不在文件里）", () => {
    const scene = withMapObject(createEmptyScene("Map001"));
    const raw = {
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: scene.objects,
    };

    const parsed = parseSceneFile(JSON.parse(JSON.stringify(raw)));
    expect(parsed.needsRewrite).toBe(false);
    expect(parsed.file.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(parsed.file.objects.map((object) => object.kind)).toEqual(["Map"]);
    expect("name" in parsed.file).toBe(false);
  });

  it("v3 场景文件：需要回写一次", () => {
    const scene = withMapObject(createEmptyScene("Map001"));
    const raw = {
      formatVersion: 3,
      objects: scene.objects,
    };

    const parsed = parseSceneFile(JSON.parse(JSON.stringify(raw)));
    expect(parsed.needsRewrite).toBe(true);
    expect(parsed.file.objects.map((object) => object.kind)).toEqual(["Map"]);
  });

  it("v4 场景文件：归一化位置按场景尺寸换算成世界坐标（y 翻转）", () => {
    const raw = {
      formatVersion: 4,
      objects: [
        {
          id: "door",
          name: "木门",
          kind: "Sprite",
          // 旧格式：左上为原点、y 向下
          position: { x: 0.25, y: 0.25 },
          rotation: 0,
          components: [],
        },
      ],
    };

    const parsed = parseSceneFile(raw);
    expect(parsed.needsRewrite).toBe(true);
    // 1920×1080：x = 0.25*1920-960 = -480；y = 540-0.25*1080 = 270
    expect(parsed.file.objects[0]?.position).toEqual({ x: -480, y: 270 });
  });

  it("v4 场景文件：地图的归一化位置照常换算（地图也是摆在世界里的对象）", () => {
    const raw = {
      formatVersion: 4,
      objects: [
        {
          id: "map-1",
          name: "地图",
          kind: "Map",
          position: { x: 0.5, y: 0.5 },
          rotation: 0,
          components: [
            {
              id: "map-1__GridMap",
              type: "GridMap",
              data: {
                image: IMAGE,
                grid: GRID,
                rowOrder: "bottom-up",
                cells: { encoding: "rle", runs: [[0, GRID.width * GRID.height]] },
              },
              actions: [],
            },
          ],
        },
      ],
    };

    const parsed = parseSceneFile(raw);
    expect(parsed.needsRewrite).toBe(true);
    // 归一化的 (0.5, 0.5) 就是贴图中心 → 世界原点
    expect(parsed.file.objects[0]?.position).toEqual({ x: 0, y: 0 });
  });

  it("v6 场景文件：补上 active / sortingOrder 的默认值，并要求回写一次", () => {
    // v6 的文件里没有这两个字段（它们是 v7 新增的），语义只能是「显示、顺序 0」
    const raw = {
      formatVersion: 6,
      objects: [
        {
          id: "door",
          name: "木门",
          kind: "Sprite",
          position: { x: 10, y: 20 },
          rotation: 0,
          components: [],
        },
      ],
    };

    const parsed = parseSceneFile(raw);
    expect(parsed.needsRewrite).toBe(true);
    expect(parsed.file.objects[0]?.active).toBe(true);
    expect(parsed.file.objects[0]?.sortingOrder).toBe(0);
    // 缩放也是后来才有的字段，同样补成 1
    expect(parsed.file.objects[0]?.scale).toBe(1);
    // 别的字段一个都不能动
    expect(parsed.file.objects[0]?.position).toEqual({ x: 10, y: 20 });
  });

  it("v7 场景文件：补上 scale 默认值 1，并要求回写一次", () => {
    // v7 的文件里没有 scale（它是 v8 新增的），语义只能是 1 = 原始尺寸
    const raw = {
      formatVersion: 7,
      objects: [
        {
          id: "door",
          name: "木门",
          kind: "Sprite",
          active: true,
          sortingOrder: 0,
          position: { x: 10, y: 20 },
          rotation: 0,
          components: [],
        },
      ],
    };

    const parsed = parseSceneFile(raw);
    expect(parsed.needsRewrite).toBe(true);
    expect(parsed.file.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(parsed.file.objects[0]?.scale).toBe(1);
    // 位置不做二次换算（v5 那条线只管归一化坐标）
    expect(parsed.file.objects[0]?.position).toEqual({ x: 10, y: 20 });
  });

  it("v8 场景文件：补上 locked 默认值 false，并要求回写一次", () => {
    // v8 的文件里没有 locked（它是 v9 新增的），语义只能是「不锁」
    const raw = {
      formatVersion: 8,
      objects: [
        {
          id: "door",
          name: "木门",
          kind: "Sprite",
          active: true,
          sortingOrder: 0,
          position: { x: 10, y: 20 },
          rotation: 0,
          scale: 1,
          components: [],
        },
      ],
    };

    const parsed = parseSceneFile(raw);
    expect(parsed.needsRewrite).toBe(true);
    expect(parsed.file.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(parsed.file.objects[0]?.locked).toBe(false);
    // 已经有的字段一个都不能动
    expect(parsed.file.objects[0]?.scale).toBe(1);
    expect(parsed.file.objects[0]?.position).toEqual({ x: 10, y: 20 });
  });

  it("v9 场景文件：升到当前版本并回写一次，地图的 fog 缺省 = 没指定雾区", () => {
    // v9 的文件里没有 map.fog（它是 v10 新增的），语义只能是「一个雾区都没指定」
    const raw = {
      formatVersion: 9,
      objects: [
        {
          id: "map-1",
          name: "地图",
          kind: "Map",
          active: true,
          sortingOrder: -10,
          locked: false,
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: 1,
          components: [
            {
              id: "map-1__GridMap",
              type: "GridMap",
              data: {
                image: IMAGE,
                grid: GRID,
                rowOrder: "bottom-up",
                cells: { encoding: "rle", runs: [[0, GRID.width * GRID.height]] },
              },
              actions: [],
            },
          ],
        },
      ],
    };

    const parsed = parseSceneFile(raw);
    expect(parsed.needsRewrite).toBe(true);
    expect(parsed.file.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    // 不补一个 `fog: { regions: [] }` 出来：没指定就是没有这个字段
    expect(mapDataOf(parsed.file.objects[0]!)?.fog).toBeUndefined();
    // 格子数据原样保留
    expect(mapDataOf(parsed.file.objects[0]!)?.cells.runs).toEqual([[0, GRID.width * GRID.height]]);
  });

  it("当前版本：显式的 fog.regions 原样读出来，不要求回写", () => {
    const parsed = parseSceneFile({
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: [
        {
          id: "map-1",
          name: "地图",
          kind: "Map",
          active: true,
          sortingOrder: -10,
          locked: false,
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: 1,
          components: [
            {
              id: "map-1__GridMap",
              type: "GridMap",
              data: {
                image: IMAGE,
                grid: GRID,
                rowOrder: "bottom-up",
                cells: { encoding: "rle", runs: [[0, GRID.width * GRID.height]] },
                fog: { regions: [8, 32] },
              },
              actions: [],
            },
          ],
        },
      ],
    });

    expect(parsed.needsRewrite).toBe(false);
    expect(mapDataOf(parsed.file.objects[0]!)?.fog?.regions).toEqual([8, 32]);
  });

  it("当前版本：显式的 scale / locked 原样读出来，不要求回写", () => {
    const scene = withObject(makeScene(), "door");
    const raw = {
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: [{ ...scene.objects[0], scale: 3.5, locked: true }],
    };

    const parsed = parseSceneFile(raw);
    expect(parsed.needsRewrite).toBe(false);
    expect(parsed.file.objects[0]?.scale).toBe(3.5);
    expect(parsed.file.objects[0]?.locked).toBe(true);
  });

  it("当前版本：显式的 active / sortingOrder 原样读出来，不要求回写", () => {
    const scene = withMapObject(createEmptyScene("Map001"));
    const raw = {
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: [{ ...scene.objects[0], active: false, sortingOrder: 42, position: { x: 0, y: 0 } }],
    };

    const parsed = parseSceneFile(raw);
    expect(parsed.needsRewrite).toBe(false);
    expect(parsed.file.objects[0]?.active).toBe(false);
    expect(parsed.file.objects[0]?.sortingOrder).toBe(42);
  });

  it("当前版本：没有位置的地图补成世界原点，并要求回写一次", () => {
    const scene = withMapObject(createEmptyScene("Map001"));
    const raw = {
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: [{ ...scene.objects[0], position: null }],
    };

    const parsed = parseSceneFile(raw);
    expect(parsed.needsRewrite).toBe(true);
    expect(parsed.file.objects[0]?.position).toEqual({ x: 0, y: 0 });
  });

  it("当前版本：地图本来就有位置时不动它，也不要求回写", () => {
    const scene = withMapObject(createEmptyScene("Map001"));
    const raw = {
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: [{ ...scene.objects[0], position: { x: 300, y: -200 } }],
    };

    const parsed = parseSceneFile(raw);
    expect(parsed.needsRewrite).toBe(false);
    expect(parsed.file.objects[0]?.position).toEqual({ x: 300, y: -200 });
  });

  it("v5 场景文件：世界坐标不被二次换算，只把网格里那个 cellSize 丢掉", () => {
    const scene = withMapObject(createEmptyScene("Map001"));
    const raw = {
      formatVersion: 5,
      objects: [
        {
          ...scene.objects[0],
          position: { x: 300, y: -200 },
          // v5 的网格里还留着一个没人读的 `cellSize`，schema 会顺手丢掉它
          components: [
            {
              ...componentOf(scene.objects[0]!, DEFAULT_SLOT_COMPONENT.map),
              data: {
                ...mapDataOf(scene.objects[0]!),
                grid: { width: 64, height: 36, cellSize: 1 },
              },
            },
          ],
        },
      ],
    };

    const parsed = parseSceneFile(raw);
    // 版本升到 v6：要回写一次（把没人读的 cellSize 从磁盘上清掉）
    expect(parsed.needsRewrite).toBe(true);
    expect(parsed.file.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    // 世界坐标原样保留——位置换算只认 v5 这条线，不能拿「< 当前版本」当条件
    expect(parsed.file.objects[0]?.position).toEqual({ x: 300, y: -200 });
    expect(mapDataOf(parsed.file.objects[0]!)?.grid).toEqual({ width: 64, height: 36 });
  });

  it("v4 场景文件：调用方给了贴图尺寸就按它换算", () => {
    const raw = {
      formatVersion: 4,
      objects: [
        {
          id: "door",
          name: "木门",
          kind: "Sprite",
          position: { x: 1, y: 1 },
          rotation: 0,
          components: [],
        },
      ],
    };

    const parsed = parseSceneFile(raw, { width: 800, height: 600 });
    // x = 800 - 400 = 400；y = 300 - 600 = -300
    expect(parsed.file.objects[0]?.position).toEqual({ x: 400, y: -300 });
  });

  it("v4 场景文件：越界的旧值原样保留（不静默夹到边界）", () => {
    const raw = {
      formatVersion: 4,
      objects: [
        {
          id: "door",
          name: "木门",
          kind: "Sprite",
          position: { x: 1.5, y: -0.2 },
          rotation: 0,
          components: [],
        },
      ],
    };

    expect(parseSceneFile(raw).file.objects[0]?.position).toEqual({ x: 1.5, y: -0.2 });
  });

  it("缺 objects 时抛出带路径的错误", () => {
    expect(() => parseSceneFile({ formatVersion: 5 })).toThrow(/场景文件校验失败/);
    expect(() => parseSceneFile({ formatVersion: 5 })).toThrow(/objects/);
  });

  it("拒绝非 bottom-up 行序（避免坐标约定被悄悄改掉）", () => {
    // 行序住在 GridMap 组件的 data 里（v19）：写错值时必须直接读不开
    const map = createMapObject({ id: "m1", name: "地图", image: IMAGE, grid: GRID });
    const raw = {
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: [
        {
          ...map,
          position: null,
          components: [
            {
              ...componentOf(map, DEFAULT_SLOT_COMPONENT.map),
              data: { ...mapDataOf(map), rowOrder: "top-down" },
            },
          ],
        },
      ],
    };

    expect(() => parseSceneFile(raw)).toThrow(/场景文件校验失败/);
  });
});
