import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import { CellMask, decodeRle, encodeRle } from "@dts/grid";
import {
  DEFAULT_OBJECT_SCALE,
  MAX_OBJECT_SCALE,
  MIN_OBJECT_SCALE,
  addObject,
  addObjectGridMap,
  clearMapCells,
  clearMapFog,
  createGameObject,
  findMapObject,
  findObject,
  fogMaskOf,
  listMapObjects,
  objectsInDrawOrder,
  paintMapCells,
  removeObject,
  removeObjectGridMap,
  repairImageObjectComponent,
  setMapCells,
  setFogEnabled,
  setFogMap,
  setFogRegions,
  setMapGrid,
  setObjectActive,
  setObjectImage,
  setObjectLocked,
  setObjectPosition,
  setObjectRotation,
  setObjectScale,
  setRenderSortingOrder,
} from "../src/commands";
import {
  componentOf,
  fogOf,
  imageOf,
  isFogEnabled,
  mapDataOf,
  objectImage,
  objectSupportsSpriteSheet,
  sortingOrderOf,
  supportsObjectComponent,
  videoDataOf,
  withFeature,
  writeFeature,
} from "../src/access";
import { isKnownComponentType } from "../src/components";
import { DEFAULT_SLOT_COMPONENT } from "../src/presets";
import {
  createEmptyProject,
  createEmptyScene,
  createEmptySceneFile,
  createFogObject,
  createGridMapObject,
} from "../src/factory";
import { parseProjectDoc, parseProjectFile, parseSceneFile, upgradeRawDocument } from "../src/schema";
import { DEFAULT_HISTORY_LIMIT } from "../src/history";
import { formatIssues, hasErrors, validateProject, validateScene } from "../src/validation";
import { DOCUMENT_FORMAT_VERSION, type ProjectDoc, type SceneDoc, type GameObjectDoc } from "../src/types";

const IMAGE = { id: "project:C/Assets/images/Map001.png", width: 1920, height: 1080 };
const GRID = { width: 8, height: 6 };

function makeScene(name = "Map001"): SceneDoc {
  return createEmptyScene(name);
}

function withMapObject(scene: SceneDoc, name = "Map001"): SceneDoc {
  return produce(scene, (draft) => {
    addObject(draft, createGridMapObject({ name: `${name} 地图`, image: IMAGE, grid: GRID, id: "map-1" }));
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
 * 场景里一个普通对象的完整形状（`active` 是 v7 起的显式字段；`sortingOrder` v26 起
 * 住在渲染组件里，这里没有渲染组件的对象也就没有它）。
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

/** 往场景里加一个**战争雾对象**（v27：引用一张地图；默认引用 `map-1`）。 */
function withFogObject(scene: SceneDoc, fogId = "fog-1", mapId = "map-1"): SceneDoc {
  return produce(scene, (draft) => {
    addObject(
      draft,
      createFogObject({ id: fogId, name: "战争雾", mapId, position: { x: 0, y: 0 } }),
    );
  });
}

describe("文档工厂：场景是容器，对象挂在场景上", () => {
  it("新建场景是**空场景**（不需要地图也能建对象）", () => {
    const scene = makeScene();
    expect(scene.name).toBe("Map001");
    expect(scene.objects).toEqual([]);
    expect(Object.keys(scene).sort()).toEqual(["name", "objects"]);
  });

  it("网格地图是「贴图 + 网格组件」，不是独立的对象类型（v28）", () => {
    const mapObject = createGridMapObject({ name: "背景地图", image: IMAGE, grid: GRID, id: "m1" });
    expect(mapObject.kind).toBe("Image");
    // 贴图在图片层（v28 起），网格数据在 `GridMap` 里
    expect(objectImage(mapObject)).toEqual(IMAGE);
    expect(mapDataOf(mapObject)?.grid).toEqual(GRID);
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

  it("显示顺序：大的画在前面，取整并夹在范围内（v26 起住在渲染组件里）", () => {
    const scene = withMapObject(makeScene(), "Map001");
    const start = sortingOrderOf(scene.objects[0]!);

    const sorted = mutate(scene, (draft) => {
      expect(setRenderSortingOrder(draft, "map-1", 12.6)).toBe(true);
    });
    expect(sortingOrderOf(sorted.objects[0]!)).toBe(13);

    // 夹取：顺序只是个层号，不接受失控的大数
    const clamped = mutate(scene, (draft) => {
      setRenderSortingOrder(draft, "map-1", 1e9);
    });
    expect(sortingOrderOf(clamped.objects[0]!)).toBe(9999);

    // NaN / Infinity 直接拒绝，绝不写进文档
    mutate(scene, (draft) => {
      expect(setRenderSortingOrder(draft, "map-1", Number.NaN)).toBe(false);
      expect(setRenderSortingOrder(draft, "map-1", Number.POSITIVE_INFINITY)).toBe(false);
    });
    expect(sortingOrderOf(scene.objects[0]!)).toBe(start);
  });

  it("显示顺序：没有渲染层的对象没有这个参数（写入返回 false）", () => {
    const scene = withObject(makeScene(), "door");
    const next = mutate(scene, (draft) => {
      expect(setRenderSortingOrder(draft, "door", 5)).toBe(false);
    });
    expect(sortingOrderOf(next.objects[0]!)).toBe(0);
  });

  it("绘制顺序：按显示顺序排（渲染组件里的 sortingOrder），相同的保持文件里的先后，且不改动原数组", () => {
    const imageObject = (id: string, sortingOrder: number): GameObjectDoc =>
      withFeature(plainObject(id), "SpriteLayer", {
        id: `project:C/Assets/images/${id}.png`,
        width: 10,
        height: 10,
        sortingOrder,
      });

    const scene = mutate(makeScene(), (draft) => {
      addObject(draft, imageObject("a", 5));
      addObject(draft, imageObject("b", -1));
      addObject(draft, imageObject("c", 5));
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

  it("对象图片：贴图 / 网格地图都在图片层（v28 起没有 map.image）", () => {
    const sprite = createGameObject({
      name: "精灵",
      kind: "Sprite",
      position: { x: 0, y: 0 },
    });
    expect(objectImage(sprite)).toBeUndefined();
    expect(objectImage(createGridMapObject({ name: "地图", image: IMAGE, grid: GRID }))).toEqual(IMAGE);
  });

  it("换图：写进图片层（v28 起不再有 map.image）", () => {
    const next = { id: "project:C/Assets/images/sprite.png", width: 200, height: 150 };

    const withMap = mutate(withMapObject(makeScene()), (draft) => {
      expect(setObjectImage(draft, "map-1", next)).toBe(true);
    });
    expect(objectImage(withMap.objects[0]!)).toEqual(next);
    expect(imageOf(withMap.objects[0]!)).toEqual(next);

    const withSprite = mutate(withObject(makeScene(), "sprite"), (draft) => {
      expect(repairImageObjectComponent(draft, "sprite", next)).toBe(true);
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

  it("普通 setObjectImage 不会为缺少图片组件的对象隐式添加 renderer", () => {
    const scene = withObject(makeScene(), "sprite");
    const unchanged = mutate(scene, (draft) => {
      expect(setObjectImage(draft, "sprite", IMAGE)).toBe(false);
    });

    expect(unchanged).toBe(scene);
    expect(imageOf(unchanged.objects[0]!)).toBeUndefined();
  });

  it("图片组件显式修复按 kind 选择承载类型并保留子图引用", () => {
    const scene = mutate(makeScene(), (draft) => {
      addObject(draft, plainObject("sprite", { kind: "Sprite" }));
      addObject(draft, plainObject("image", { kind: "Image" }));
      expect(repairImageObjectComponent(draft, "sprite", {
        ...IMAGE,
        sprite: { column: 2, row: 1 },
      })).toBe(true);
      expect(repairImageObjectComponent(draft, "image", IMAGE)).toBe(true);
    });

    expect(findObject(scene, "sprite")?.components).toEqual([{
      id: "sprite__SpriteLayer",
      type: "SpriteLayer",
      data: { ...IMAGE, sprite: { column: 2, row: 1 }, sortingOrder: 0 },
    }]);
    expect(findObject(scene, "image")?.components).toEqual([{
      id: "image__ImageLayer",
      type: "ImageLayer",
      data: { ...IMAGE, sortingOrder: 0 },
    }]);
  });

  it("图片组件显式修复拒绝 kind mismatch 且不影响未知组件", () => {
    const scene = mutate(makeScene(), (draft) => {
      addObject(draft, plainObject("sprite", {
        kind: "Sprite",
        components: [
          { id: "conflict", type: "Teleport", data: { targets: [] } },
          { id: "unknown", type: "FutureComponent", data: { keep: true } },
        ],
      }));
      expect(repairImageObjectComponent(draft, "sprite", IMAGE)).toBe(false);
    });
    expect(findObject(scene, "sprite")?.components.map((component) => component.type)).toEqual([
      "Teleport",
      "FutureComponent",
    ]);
  });

  it("网格地图的贴图在图片层：已经有图片层时不会重复添加", () => {
    const scene = mutate(withMapObject(makeScene()), (draft) => {
      expect(repairImageObjectComponent(draft, "map-1", IMAGE)).toBe(false);
    });
    expect(scene.objects[0]?.components.map((component) => component.type)).toEqual([
      "ImageLayer",
      "GridMap",
    ]);
  });

  it("setObjectImage：网格地图的贴图也写进图片层", () => {
    const next = { id: "project:C/Assets/images/custom.png", width: 320, height: 180 };
    const scene = mutate(withMapObject(makeScene()), (draft) => {
      expect(setObjectImage(draft, "map-1", next)).toBe(true);
    });

    expect(objectImage(scene.objects[0]!)).toEqual(next);
    expect(imageOf(scene.objects[0]!)).toEqual(next);
  });

  it("已有组件的行为校验按组件数据，不按 kind 否决", () => {
    const object = withFeature(
      createGameObject({ id: "custom", name: "组合对象", kind: "Sprite" }),
      DEFAULT_SLOT_COMPONENT.video,
      {
        enabled: true,
        autoPlay: false,
        clips: ["project:C/Assets/video/opening.mp4"],
        picked: "project:C/Assets/video/opening.mp4",
        loop: false,
        audio: false,
      },
    );
    const scene = { ...makeScene(), objects: [object] };

    expect(videoDataOf(scene.objects[0]!)).toBeDefined();
    expect(formatIssues(validateScene(scene))).toMatch(/VideoOverlay.*旧模板不一致.*仍保留并按组件生效/);
  });

  it("新建地图对象带着世界坐标（默认原点）——它就是贴图中心", () => {
    const map = createGridMapObject({ name: "地图", image: IMAGE, grid: GRID, position: { x: 30, y: -40 } });
    expect(map.position).toEqual({ x: 30, y: -40 });
    expect(createGridMapObject({ name: "地图", image: IMAGE, grid: GRID }).position).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("战争雾：独立对象（Fog）", () => {
  /** 一张地图 + 一个引用它的雾对象（v27 的模型）。 */
  function withFog(scene: SceneDoc, fogId = "fog-1", mapId = "map-1"): SceneDoc {
    return produce(scene, (draft) => {
      addObject(draft, createFogObject({ id: fogId, name: "战争雾", mapId, position: { x: 0, y: 0 } }));
    });
  }

  function fogObjectOf(scene: SceneDoc, id = "fog-1"): GameObjectDoc {
    const object = scene.objects.find((item) => item.id === id);
    if (object === undefined) {
      throw new Error("场景里没有这个雾对象");
    }

    return object;
  }

  /** 场景里某张地图的 cells（断言用）。 */
  function mapCells(scene: SceneDoc, mapId = "map-1"): Uint8Array {
    const object = scene.objects.find((item) => item.id === mapId);
    const map = object === undefined ? undefined : mapDataOf(object);
    if (map === undefined) {
      throw new Error("场景里没有地图对象");
    }

    return decodeRle(map.cells.runs, map.grid.width * map.grid.height);
  }

  it("指定雾区：写进 FogOfWar 组件的 regions，规范化后落盘", () => {
    let scene = withFog(withMapObject(makeScene()));

    // 16 / 重复的 16 / 0（橡皮擦位，不是区域）/ 3（不是单个位）/ 256（越界）都该被丢掉
    scene = mutate(scene, (draft) => {
      setFogRegions(draft, "fog-1", [16, 8, 16, 0, 3, 256]);
    });
    expect(fogObjectOf(scene).kind).toBe("Fog");
    expect(fogOf(fogObjectOf(scene))?.mapId).toBe("map-1");
    expect(fogOf(fogObjectOf(scene))?.regions).toEqual([8, 16]);

    // 同一个选择再写一次 = 没变更（不进撤销栈）；顺序不同但集合相同也算没变
    expect(
      mutate(scene, (draft) => {
        setFogRegions(draft, "fog-1", [8, 16]);
      }),
    ).toBe(scene);
    expect(
      mutate(scene, (draft) => {
        setFogRegions(draft, "fog-1", [16, 8]);
      }),
    ).toBe(scene);
  });

  it("解除绑定：雾区清空、格子数据不动；开关与组件都留着（v27 起不摘组件）", () => {
    let scene = withFog(withMapObject(makeScene()));
    scene = mutate(scene, (draft) => {
      setFogRegions(draft, "fog-1", [8]);
      paintMapCells(draft, "map-1", { x: 1, y: 1 }, { x: 1, y: 1 }, { mask: CellMask.Fog1, brushSize: 1 });
    });
    expect(fogOf(fogObjectOf(scene))).toEqual({ mapId: "map-1", enabled: true, regions: [8] });

    scene = mutate(scene, (draft) => {
      setFogRegions(draft, "fog-1", []);
    });
    expect(fogOf(fogObjectOf(scene))).toEqual({ mapId: "map-1", enabled: true, regions: [] });
    // 解除绑定 ≠ 清数据：画好的雾格子还在，重新绑定就回来
    expect(mapCells(scene)[1 * GRID.width + 1]).toBe(CellMask.Fog1);

    // 关掉开关：组件是雾对象的数据本体，**不摘**（只是 enabled=false）
    scene = mutate(scene, (draft) => {
      setFogEnabled(draft, "fog-1", false);
    });
    expect(fogOf(fogObjectOf(scene))).toEqual({ mapId: "map-1", enabled: false, regions: [] });
    expect(mapCells(scene)[1 * GRID.width + 1]).toBe(CellMask.Fog1);
  });

  it("fogMaskOf：没指定是 0，指定后是各位置的并集", () => {
    const scene = withFog(withMapObject(makeScene()));

    expect(fogMaskOf(fogObjectOf(scene))).toBe(0);
    const bound = withFeature(fogObjectOf(scene), "FogOfWar", {
      mapId: "map-1",
      enabled: true,
      regions: [8, 32],
    });
    expect(fogMaskOf(bound)).toBe(40);
  });

  it("setFogMap：切换引用的地图；目标不是地图时拒绝", () => {
    const scene = withFog(withMapObject(makeScene()), "fog-1", "");
    const mapped = mutate(scene, (draft) => {
      expect(setFogMap(draft, "fog-1", "map-1")).toBe(true);
    });
    expect(fogOf(fogObjectOf(mapped))?.mapId).toBe("map-1");
    // 同一个 = 没变更
    expect(
      mutate(mapped, (draft) => {
        setFogMap(draft, "fog-1", "map-1");
      }),
    ).toBe(mapped);
    // 目标不存在 / 不是地图：拒绝
    const withDoor = withObject(mapped, "door");
    expect(
      mutate(withDoor, (draft) => {
        expect(setFogMap(draft, "fog-1", "door")).toBe(false);
      }),
    ).toBe(withDoor);
    expect(
      mutate(withDoor, (draft) => {
        expect(setFogMap(draft, "fog-1", "nope")).toBe(false);
      }),
    ).toBe(withDoor);
  });

  it("清空战争雾：清的是被引用地图的格子，只清绑定位", () => {
    let scene = withFog(withMapObject(makeScene()));
    scene = mutate(scene, (draft) => {
      setFogRegions(draft, "fog-1", [CellMask.Fog1]);
      // 一格「区域1 + 区域4」、另一格只有区域1
      paintMapCells(draft, "map-1", { x: 0, y: 0 }, { x: 0, y: 0 }, { mask: CellMask.Obstacle, brushSize: 1 });
      paintMapCells(draft, "map-1", { x: 0, y: 0 }, { x: 0, y: 0 }, { mask: CellMask.Fog1, brushSize: 1 });
      paintMapCells(draft, "map-1", { x: 1, y: 0 }, { x: 1, y: 0 }, { mask: CellMask.Obstacle, brushSize: 1 });
    });

    scene = mutate(scene, (draft) => {
      expect(clearMapFog(draft, "fog-1")).toBe(true);
    });

    expect(mapCells(scene)[0]).toBe(CellMask.Obstacle);
    expect(mapCells(scene)[1]).toBe(CellMask.Obstacle);
  });

  it("清空战争雾：没指定雾区 / 没引用地图 / 没有雾格时都不产生变更", () => {
    const scene = withFog(withMapObject(makeScene()));
    expect(
      mutate(scene, (draft) => {
        clearMapFog(draft, "fog-1");
      }),
    ).toBe(scene);

    const bound = mutate(scene, (draft) => {
      setFogRegions(draft, "fog-1", [CellMask.Fog1]);
    });
    // 指定了雾区，但一个雾格都没画
    expect(
      mutate(bound, (draft) => {
        clearMapFog(draft, "fog-1");
      }),
    ).toBe(bound);

    // 没引用地图：清不了
    const orphan = withFog(withMapObject(makeScene()), "fog-2", "");
    const boundOrphan = mutate(orphan, (draft) => {
      setFogRegions(draft, "fog-2", [CellMask.Fog1]);
    });
    expect(
      mutate(boundOrphan, (draft) => {
        clearMapFog(draft, "fog-2");
      }),
    ).toBe(boundOrphan);
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

  it("总开关：打开 / 关闭，组件总在、雾区留着", () => {
    let scene = withFog(withMapObject(makeScene()));
    // 新建的雾对象默认开着（`createFogObject` 建出来就是 enabled: true）
    expect(isFogEnabled(fogObjectOf(scene))).toBe(true);
    expect(fogMaskOf(fogObjectOf(scene))).toBe(0);

    // 关掉：**雾区绑定留着**，组件也留着（它是雾对象的数据本体）
    scene = mutate(scene, (draft) => {
      expect(setFogEnabled(draft, "fog-1", false)).toBe(true);
    });
    expect(isFogEnabled(fogObjectOf(scene))).toBe(false);
    expect(fogOf(fogObjectOf(scene))).toEqual({ mapId: "map-1", enabled: false, regions: [] });

    // 同一个状态再写一次 = 没变更（不进撤销栈）
    expect(
      mutate(scene, (draft) => {
        setFogEnabled(draft, "fog-1", false);
      }),
    ).toBe(scene);

    // 关着的时候照样能改绑定（绑定与开关是两件事）
    scene = mutate(scene, (draft) => {
      setFogRegions(draft, "fog-1", [CellMask.Fog1]);
    });
    expect(fogOf(fogObjectOf(scene))).toEqual({ mapId: "map-1", enabled: false, regions: [CellMask.Fog1] });

    // 再打开：绑定原样留着
    scene = mutate(scene, (draft) => {
      expect(setFogEnabled(draft, "fog-1", true)).toBe(true);
    });
    expect(isFogEnabled(fogObjectOf(scene))).toBe(true);
    expect(fogOf(fogObjectOf(scene))?.regions).toEqual([CellMask.Fog1]);
  });

  it("v13 之前的老文件：`fog` 里没有 enabled，读出来算**开着**并补进内存", () => {
    const object = withMapObject(makeScene()).objects[0];
    const map = object === undefined ? undefined : mapDataOf(object);
    if (object === undefined || map === undefined) {
      throw new Error("场景里没有地图对象");
    }

    // v12 的文件：那时写下 fog 就等于「这张地图有雾」（补成 false 会把老场景的雾全关掉）。
    // `fog` 住在 GridMap 组件的 data 里，`enabled` 缺省由 schema 补成 `true`；
    // v25 迁到 `FogOfWar` 组件、v27 再搬成独立的 `Fog` 对象。
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
    expect(load.file.objects.map((item) => item.kind)).toEqual(["Image", "Fog"]);
    expect(fogOf(load.file.objects[1]!)).toEqual({
      mapId: "map-1",
      enabled: true,
      regions: [CellMask.Fog1],
    });
    expect(mapDataOf(load.file.objects[0]!)).not.toHaveProperty("fog");
    expect(isFogEnabled(load.file.objects[1]!)).toBe(true);
    // 版本号从 12 一路涨上来 → 要求回写一次，磁盘上的文件从此自描述（雾是独立对象）
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
    const scene = mutate(withFogObject(withMapObject(makeScene())), (draft) => {
      // 手写文件里才会出现的坏值：`fogOf` 是只读入口，这里直接写组件 data
      writeFeature(draft.objects[1]!, "FogOfWar", { mapId: "map-1", enabled: true, regions: [8, 3, 256] });
    });

    // 只是警告：读得开、画得出，别把文件判成读不了
    expect(hasErrors(validateScene(scene))).toBe(false);
    expect(formatIssues(validateScene(scene))).toMatch(/战争雾指定的 3, 256 不是可绘制的区域位/);
  });

  it("战争雾开着却没指定雾区、或关着却指定了雾区：都只是警告（都不会有雾）", () => {
    // 开着但一个雾区都没指定：前端不会建雾层，画面上什么都不会发生
    const on = mutate(withFogObject(withMapObject(makeScene())), (draft) => {
      setFogEnabled(draft, "fog-1", true);
    });
    expect(hasErrors(validateScene(on))).toBe(false);
    expect(formatIssues(validateScene(on))).toMatch(/战争雾开着但没指定雾区（不会有雾）/);

    // 关着但绑定留着：「明明指定了却不生效」得说出来
    const off = mutate(withFogObject(withMapObject(makeScene())), (draft) => {
      setFogRegions(draft, "fog-1", [CellMask.Fog1]);
      setFogEnabled(draft, "fog-1", false);
    });
    expect(hasErrors(validateScene(off))).toBe(false);
    expect(formatIssues(validateScene(off))).toMatch(/战争雾关着：指定的雾区不会生成雾/);

    // 开着 + 指定了：一句警告都没有
    const ready = mutate(withFogObject(withMapObject(makeScene())), (draft) => {
      setFogRegions(draft, "fog-1", [CellMask.Fog1]);
    });
    expect(formatIssues(validateScene(ready))).not.toMatch(/战争雾/);
  });

  it("战争雾引用的地图不存在 / 不是地图 / 一张地图两个雾：都是 error", () => {
    // 引用的 id 不存在
    const dangling = withFogObject(withMapObject(makeScene()), "fog-1", "nope");
    expect(hasErrors(validateScene(dangling))).toBe(true);
    expect(formatIssues(validateScene(dangling))).toMatch(/引用的对象不存在或没有网格/);

    // 引用一个不是网格对象的对象
    const notMap = withFogObject(withObject(withMapObject(makeScene()), "door"), "fog-1", "door");
    expect(hasErrors(validateScene(notMap))).toBe(true);
    expect(formatIssues(validateScene(notMap))).toMatch(/引用的对象不存在或没有网格/);

    // 一个网格两个雾
    const duplicate = withFogObject(withFogObject(withMapObject(makeScene()), "fog-1"), "fog-2");
    expect(hasErrors(validateScene(duplicate))).toBe(true);
    expect(formatIssues(validateScene(duplicate))).toMatch(/这个网格已经有战争雾了/);
  });

  it("网格是可选能力：普通贴图没有网格不报错；加了网格才有网格数据", () => {
    const scene = mutate(makeScene(), (draft) => {
      addObject(draft, plainObject("plain-image", { name: "贴图", kind: "Image" }));
    });

    expect(hasErrors(validateScene(scene))).toBe(false);
    expect(mapDataOf(scene.objects[0]!)).toBeUndefined();

    const withGrid = mutate(scene, (draft) => {
      expect(addObjectGridMap(draft, "plain-image")).toBe(true);
    });
    expect(mapDataOf(withGrid.objects[0]!)).toEqual({
      grid: { width: 8, height: 6 },
      rowOrder: "bottom-up",
      cells: { encoding: "rle", runs: [[0, 48]] },
    });

    // 再摘掉：回到普通贴图（没有网格数据）
    const removed = mutate(withGrid, (draft) => {
      expect(removeObjectGridMap(draft, "plain-image")).toBe(true);
    });
    expect(mapDataOf(removed.objects[0]!)).toBeUndefined();
  });

  it("addObjectGridMap：按图片尺寸建空网格并保留未知组件", () => {
    const scene = mutate(makeScene(), (draft) => {
      addObject(draft, plainObject("grid-image", {
        name: "网格地图",
        kind: "Image",
        components: [
          {
            id: "grid-image__ImageLayer",
            type: "ImageLayer",
            data: {
              id: "project:C/Assets/images/repaired.png",
              guid: "a".repeat(32),
              width: 420,
              height: 300,
              sortingOrder: -10,
            },
          },
          { id: "legacy-unknown", type: "FutureComponent", data: { keep: true } },
        ],
      }));
    });
    const withGrid = mutate(scene, (draft) => {
      expect(addObjectGridMap(draft, "grid-image")).toBe(true);
    });

    const object = findObject(withGrid, "grid-image");
    expect(mapDataOf(object!)).toEqual({
      grid: { width: 14, height: 10 },
      rowOrder: "bottom-up",
      cells: { encoding: "rle", runs: [[0, 140]] },
    });
    expect(object?.components.find((item) => item.type === "FutureComponent")).toEqual({
      id: "legacy-unknown",
      type: "FutureComponent",
      data: { keep: true },
    });
  });

  it("setObjectImage 不会隐式添加图片层；组件冲突时 addObjectGridMap 也拒绝", () => {
    const scene = mutate(makeScene(), (draft) => {
      addObject(draft, plainObject("broken-image", { name: "没图片层", kind: "Image" }));
      addObject(draft, plainObject("mismatched", {
        name: "组件冲突",
        kind: "Image",
        components: [{ id: "mismatched__Teleport", type: "Teleport", data: { targets: [] } }],
      }));
    });
    mutate(scene, (draft) => {
      expect(setObjectImage(draft, "broken-image", IMAGE)).toBe(false);
      expect(addObjectGridMap(draft, "mismatched")).toBe(false);
    });

    expect(imageOf(findObject(scene, "broken-image")!)).toBeUndefined();
    expect(mapDataOf(findObject(scene, "mismatched")!)).toBeUndefined();
  });

  it("网格只允许加在贴图上：挂在精灵上按 kind 不一致提示", () => {
    const onSprite = mutate(makeScene(), (draft) => {
      addObject(draft, plainObject("odd", { name: "精灵", kind: "Sprite" }));
      const object = findObject(draft, "odd");
      if (object !== undefined) {
        writeFeature(object, DEFAULT_SLOT_COMPONENT.map, {
          grid: GRID,
          rowOrder: "bottom-up",
          cells: { encoding: "rle", runs: [[0, GRID.width * GRID.height]] },
        });
      }
    });

    // 只是警告（组件仍在、仍按组件生效），不是错误
    expect(hasErrors(validateScene(onSprite))).toBe(false);
    expect(formatIssues(validateScene(onSprite))).toMatch(/旧模板不一致/);

    // 贴在贴图上就完全合法
    const onImage = mutate(makeScene(), (draft) => {
      addObject(draft, plainObject("grid-image", {
        name: "网格地图",
        kind: "Image",
        components: [
          {
            id: "grid-image__ImageLayer",
            type: "ImageLayer",
            data: { id: IMAGE.id, width: IMAGE.width, height: IMAGE.height, sortingOrder: -10 },
          },
        ],
      }));
      addObjectGridMap(draft, "grid-image");
    });
    expect(hasErrors(validateScene(onImage))).toBe(false);
    expect(formatIssues(validateScene(onImage))).not.toMatch(/旧模板不一致/);
  });

  it("kind 与显式组件不一致时只提示迁移，不拒绝组件数据", () => {
    const scene = mutate(withObject(makeScene(), "odd"), (draft) => {
      const object = findObject(draft, "odd");
      if (object !== undefined) {
        writeFeature(object, DEFAULT_SLOT_COMPONENT.teleport, { targets: [], picked: undefined });
      }
    });

    const issues = validateScene(scene);
    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).toMatch(/Teleport.*旧模板不一致.*仍保留并按组件生效/);
    expect(componentOf(scene.objects[0]!, DEFAULT_SLOT_COMPONENT.teleport)?.data).toEqual({
      targets: [],
      picked: undefined,
    });
    expect(supportsObjectComponent(scene.objects[0]!, DEFAULT_SLOT_COMPONENT.teleport)).toBe(true);
    expect(supportsObjectComponent(scene.objects[0]!, DEFAULT_SLOT_COMPONENT.image)).toBe(false);
    expect(objectSupportsSpriteSheet(scene.objects[0]!)).toBe(false);
  });

  it("网格地图上 GridMap 与 ImageLayer 共存：按实际组件共同决定能力", () => {
    const scene = mutate(withMapObject(makeScene()), (draft) => {
      const object = findObject(draft, "map-1");
      if (object !== undefined) {
        writeFeature(object, DEFAULT_SLOT_COMPONENT.image, {
          id: IMAGE.id,
          width: IMAGE.width,
          height: IMAGE.height,
          sortingOrder: -10,
        });
      }
    });

    const issues = validateScene(scene);
    expect(hasErrors(issues)).toBe(false);
    expect(objectImage(scene.objects[0]!)).toEqual(IMAGE);
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
    expect(loaded.migratedScenes[0]?.objects.map((object) => object.kind)).toEqual(["Image"]);
    expect(objectImage(loaded.migratedScenes[0]!.objects[0]!)).toEqual(IMAGE);
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
    // 原来的地图数据被搬到一个带网格的贴图上，原有对象保持不动（只有 kind 被 v22 改成具体类型）
    expect(scene?.objects.map((object) => object.kind)).toEqual(["Image", "Sprite"]);
    expect(objectImage(scene!.objects[0]!)).toEqual(IMAGE);
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
    expect(parsed.file.objects.map((object) => object.kind)).toEqual(["Image"]);
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
    expect(parsed.file.objects.map((object) => object.kind)).toEqual(["Image"]);
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

  it("v6 场景文件：补上 active 的默认值，并要求回写一次（sortingOrder 已搬进渲染组件）", () => {
    // v6 的文件里没有 `active`（它是 v7 新增的），语义只能是「显示」；
    // `sortingOrder` 也是 v7 加的，但 v26 起它住在渲染组件里——这个对象没有渲染组件，
    // 所以对象上不再有这一项
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
    expect(parsed.file.objects[0]).not.toHaveProperty("sortingOrder");
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
    // 不补一个空壳 `FogOfWar` 组件出来：没指定就是没有这个组件
    expect(fogOf(parsed.file.objects[0]!)).toBeUndefined();
    // 格子数据原样保留
    expect(mapDataOf(parsed.file.objects[0]!)?.cells.runs).toEqual([[0, GRID.width * GRID.height]]);
  });

  it("v25/v27：GridMap data 里的 fog 先拆成组件、再搬成独立的 Fog 对象，并要求回写", () => {
    const parsed = parseSceneFile({
      formatVersion: 24,
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
                fog: { enabled: false, regions: [8, 32] },
              },
              actions: [],
            },
          ],
        },
      ],
    });

    expect(parsed.needsRewrite).toBe(true);
    expect(parsed.file.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    // 地图的 GridMap data 里不再有 fog，也不再有 FogOfWar 组件
    expect(mapDataOf(parsed.file.objects[0]!)).not.toHaveProperty("fog");
    expect(parsed.file.objects[0]?.components.some((component) => component.type === "FogOfWar")).toBe(
      false,
    );
    // 雾成了独立对象（v27），引用这张地图、形状原样
    const fog = parsed.file.objects[1]!;
    expect(fog.kind).toBe("Fog");
    expect(fogOf(fog)).toEqual({ mapId: "map-1", enabled: false, regions: [8, 32] });
    // 实例 id 是确定性的：再解析一遍不会多出第二个雾对象
    const again = parseSceneFile(JSON.parse(JSON.stringify(parsed.file)) as unknown);
    expect(again.file.objects.filter((item) => item.kind === "Fog")).toHaveLength(1);
  });

  it("v26：对象级 sortingOrder 搬进渲染组件（地图进 GridMap、精灵进图片层、无渲染层丢弃）", () => {
    const parsed = parseSceneFile({
      formatVersion: 25,
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
            },
          ],
        },
        {
          id: "sprite-1",
          name: "精灵",
          kind: "Sprite",
          active: true,
          sortingOrder: 7,
          locked: false,
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: 1,
          components: [
            {
              id: "sprite-1__SpriteLayer",
              type: "SpriteLayer",
              data: { id: "project:C/Assets/images/a.png", width: 32, height: 32 },
            },
          ],
        },
        {
          id: "sound-1",
          name: "脚步",
          kind: "PlaySound",
          active: true,
          sortingOrder: 99,
          locked: false,
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: 1,
          components: [
            {
              id: "sound-1__PlaySound",
              type: "PlaySound",
              data: { clips: [], layer: "sfx" },
            },
          ],
        },
      ],
    });

    expect(parsed.needsRewrite).toBe(true);
    expect(sortingOrderOf(parsed.file.objects[0]!)).toBe(-10);
    expect(sortingOrderOf(parsed.file.objects[1]!)).toBe(7);
    // 动作对象没有渲染层：参数被丢弃
    expect(sortingOrderOf(parsed.file.objects[2]!)).toBe(0);
    for (const object of parsed.file.objects) {
      expect(object).not.toHaveProperty("sortingOrder");
    }
  });

  it("当前版本：显式的 FogOfWar 组件（在独立 Fog 对象上）原样读出来，不要求回写", () => {
    const parsed = parseSceneFile({
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: [
        {
          id: "map-1",
          name: "网格地图",
          kind: "Image",
          active: true,
          locked: false,
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: 1,
          components: [
            {
              id: "map-1__ImageLayer",
              type: "ImageLayer",
              data: { ...IMAGE, sortingOrder: -10 },
              actions: [],
            },
            {
              id: "map-1__GridMap",
              type: "GridMap",
              data: {
                grid: GRID,
                rowOrder: "bottom-up",
                cells: { encoding: "rle", runs: [[0, GRID.width * GRID.height]] },
              },
              actions: [],
            },
          ],
        },
        {
          id: "fog-1",
          name: "战争雾",
          kind: "Fog",
          active: true,
          locked: false,
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: 1,
          components: [
            {
              id: "fog-1__FogOfWar",
              type: "FogOfWar",
              data: { mapId: "map-1", enabled: true, regions: [8, 32] },
              actions: [],
            },
          ],
        },
      ],
    });

    expect(parsed.needsRewrite).toBe(false);
    expect(fogOf(parsed.file.objects[1]!)?.regions).toEqual([8, 32]);
    expect(fogOf(parsed.file.objects[1]!)?.mapId).toBe("map-1");
  });

  it("v27：地图上的 FogOfWar 组件搬成独立的 Fog 对象（引用该地图、摆放照旧）", () => {
    const parsed = parseSceneFile({
      formatVersion: 26,
      objects: [
        {
          id: "map-1",
          name: "地图",
          kind: "Map",
          active: true,
          locked: true,
          position: { x: 120, y: -80 },
          rotation: 0.5,
          scale: 2,
          components: [
            {
              id: "map-1__GridMap",
              type: "GridMap",
              data: {
                image: IMAGE,
                grid: GRID,
                rowOrder: "bottom-up",
                cells: { encoding: "rle", runs: [[0, GRID.width * GRID.height]] },
                sortingOrder: -10,
              },
            },
            {
              id: "map-1__FogOfWar",
              type: "FogOfWar",
              data: { enabled: false, regions: [8, 32] },
            },
          ],
        },
      ],
    });

    expect(parsed.needsRewrite).toBe(true);
    const [map, fog] = parsed.file.objects;
    // 地图上绿了：fog 组件与 fogOf 都没了
    expect(map?.components.some((component) => component.type === "FogOfWar")).toBe(false);
    expect(fogOf(map!)).toBeUndefined();
    // 新雾对象：引用地图、形状原样、摆放复制地图
    expect(fog?.kind).toBe("Fog");
    expect(fogOf(fog!)).toEqual({ mapId: "map-1", enabled: false, regions: [8, 32] });
    expect(fog?.position).toEqual({ x: 120, y: -80 });
    expect(fog?.rotation).toBe(0.5);
    expect(fog?.scale).toBe(2);
    expect(fog?.locked).toBe(true);
    // 幂等：再解析一遍不会再多一个雾对象
    const again = parseSceneFile(JSON.parse(JSON.stringify(parsed.file)));
    expect(again.file.objects.filter((item) => item.kind === "Fog")).toHaveLength(1);
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

  it("当前版本：显式的 active 与渲染组件里的 sortingOrder 原样读出来，不要求回写", () => {
    const scene = withMapObject(createEmptyScene("Map001"));
    const object = scene.objects[0]!;
    const raw = {
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: [
        {
          ...object,
          active: false,
          // v26 起显示顺序住在渲染组件（v28 起一律是图片层）里：改那个组件数据，而不是对象自己
          components: object.components.map((component) =>
            component.type === "ImageLayer"
              ? { ...component, data: { ...component.data, sortingOrder: 42 } }
              : component,
          ),
        },
      ],
    };

    const parsed = parseSceneFile(raw);
    expect(parsed.needsRewrite).toBe(false);
    expect(parsed.file.objects[0]?.active).toBe(false);
    expect(sortingOrderOf(parsed.file.objects[0]!)).toBe(42);
  });

  it("老地图（kind Map）没有位置时补成世界原点，并要求回写一次", () => {
    // `filled` 跑在 `renameObjectKinds` 前面：那时 kind 还是老的 `Map`，于是按「地图补原点」处理，
    // 随后才落成 `Image`（v28）
    const raw = {
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: [
        {
          id: "map-1",
          name: "地图",
          kind: "Map",
          active: true,
          locked: false,
          rotation: 0,
          scale: 1,
          components: [],
        },
      ],
    };

    const parsed = parseSceneFile(raw);
    expect(parsed.needsRewrite).toBe(true);
    expect(parsed.file.objects[0]?.position).toEqual({ x: 0, y: 0 });
    expect(parsed.file.objects[0]?.kind).toBe("Image");
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
    const map = createGridMapObject({ id: "m1", name: "地图", image: IMAGE, grid: GRID });
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
