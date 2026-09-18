import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import { CellMask, decodeRle, encodeRle } from "@dts/grid";
import {
  addAction,
  addComponent,
  addObject,
  clearMapCells,
  collectActionIds,
  createSceneObject,
  findMapObject,
  listMapObjects,
  objectImage,
  moveAction,
  objectsInDrawOrder,
  paintMapCells,
  removeAction,
  removeObject,
  setMapCells,
  setMapGrid,
  setObjectActive,
  setObjectImage,
  setObjectPosition,
  setObjectSortingOrder,
  updateAction,
  updateComponentData,
} from "../src/commands";
import { defaultComponentData, findComponentType, isKnownComponentType } from "../src/components";
import {
  createEmptyProject,
  createEmptyScene,
  createEmptySceneFile,
  createMapObject,
} from "../src/factory";
import { parseProjectDoc, parseProjectFile, parseSceneFile, upgradeRawDocument } from "../src/schema";
import { DEFAULT_HISTORY_LIMIT } from "../src/history";
import { formatIssues, hasErrors, validateProject, validateScene } from "../src/validation";
import { DOCUMENT_FORMAT_VERSION, type ProjectDoc, type SceneDoc, type SceneObjectDoc } from "../src/types";

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
function plainObject(id: string, patch: Partial<SceneObjectDoc> = {}): SceneObjectDoc {
  return {
    id,
    name: id,
    kind: "SceneObject",
    active: true,
    sortingOrder: 0,
    position: null,
    rotation: 0,
    components: [],
    ...patch,
  };
}

/** 往场景里加一个普通对象（带一个可选组件）。 */
function withObject(scene: SceneDoc, objectId = "door", componentType?: string): SceneDoc {
  return produce(scene, (draft) => {
    addObject(draft, plainObject(objectId));

    if (componentType !== undefined) {
      addComponent(draft, objectId, componentType, { id: "cmp" });
    }
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
    expect(mapObject.map?.image).toEqual(IMAGE);
    // 显式写出「整张图都是空格子」，否则校验会判为数据不完整
    expect(mapObject.map?.cells).toEqual({
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
  it("覆盖前端全部 7 个组件类型", () => {
    for (const type of [
      "OptionValue",
      "Backpack",
      "ItemExchange",
      "MaskImage",
      "FloatValue",
      "IntValue",
      "BoolValue",
    ]) {
      expect(isKnownComponentType(type)).toBe(true);
    }

    expect(isKnownComponentType("NotAComponent")).toBe(false);
  });

  it("默认数据按字段类型生成", () => {
    expect(defaultComponentData("BoolValue")).toEqual({ value: false });
    expect(defaultComponentData("IntValue")).toEqual({ value: 0 });
    expect(defaultComponentData("OptionValue")).toEqual({ options: [], current: "" });
    expect(defaultComponentData("Unknown")).toEqual({});
  });

  it("条件值形态与前端 Satisfies 覆写一致", () => {
    expect(findComponentType("OptionValue")?.conditionValueTypes).toEqual(["String", "Integer"]);
    expect(findComponentType("BoolValue")?.conditionValueTypes).toEqual(["Bool"]);
    expect(findComponentType("IntValue")?.conditionValueTypes).toEqual(["Integer"]);
    expect(findComponentType("FloatValue")?.conditionValueTypes).toEqual(["Number"]);
    expect(findComponentType("Backpack")?.conditionValueTypes).toEqual([]);
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

  it("添加组件时用注册表默认数据，并可浅合并修改", () => {
    const scene = mutate(withObject(makeScene(), "chest"), (draft) => {
      addComponent(draft, "chest", "OptionValue", { id: "cmp_1" });
    });

    expect(scene.objects[0]?.components[0]?.data).toEqual({ options: [], current: "" });

    const updated = mutate(scene, (draft) => {
      updateComponentData(draft, "chest", "cmp_1", { options: ["关闭", "打开"], current: "关闭" });
    });
    expect(updated.objects[0]?.components[0]?.data.current).toBe("关闭");
  });

  it("地图对象数据可写：setMapCells", () => {
    const scene = withMapObject(makeScene());
    const cells = new Uint8Array(GRID.width * GRID.height);
    cells[0] = CellMask.Obstacle;

    const next = mutate(scene, (draft) => {
      setMapCells(draft, "map-1", encodeRle(cells));
    });

    expect(next.objects[0]?.map?.cells.runs[0]?.[0]).toBe(CellMask.Obstacle);
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

    const map = cleared.objects[0]?.map;
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
    expect(resized.objects[0]?.map?.grid).toEqual({ width: 4, height: 3 });
  });

  it("标注一笔：直线经过的格子都被刷到，落盘仍是合法 RLE", () => {
    const scene = withMapObject(makeScene());
    const painted = mutate(scene, (draft) => {
      expect(paintMapCells(draft, "map-1", { x: 1, y: 2 }, { x: 4, y: 2 }, {
        mask: CellMask.Obstacle,
        brushSize: 1,
      })).toBe(true);
    });

    const cells = decodeRle(painted.objects[0]?.map?.cells.runs ?? [], GRID.width * GRID.height);
    for (let x = 1; x <= 4; x += 1) {
      expect(cells[2 * GRID.width + x]).toBe(CellMask.Obstacle);
    }

    expect([...cells].filter((mask) => mask !== 0)).toHaveLength(4);
    expect(hasErrors(validateScene(painted))).toBe(false);
  });

  it("标注是**按位叠加**：同一格先画障碍再画雾，两个位都在", () => {
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

    const cells = decodeRle(painted.objects[0]?.map?.cells.runs ?? [], GRID.width * GRID.height);
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
      [...decodeRle(erased.objects[0]?.map?.cells.runs ?? [], GRID.width * GRID.height)].every(
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

    const cells = decodeRle(painted.objects[0]?.map?.cells.runs ?? [], GRID.width * GRID.height);
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
    expect(next.objects[0]?.map?.cells.runs).toEqual([[CellMask.Obstacle, 3]]);
  });

  it("改网格尺寸：格子按新规格重建，重叠部分保留、多出来的格子是空", () => {
    // (0,0) 放障碍、(1,1) 放水
    const scene = mutate(withMapObject(makeScene()), (draft) => {
      const cells = new Uint8Array(GRID.width * GRID.height);
      cells[0] = CellMask.Obstacle;
      cells[GRID.width + 1] = CellMask.Water;
      setMapCells(draft, "map-1", encodeRle(cells));
    });

    const grown = mutate(scene, (draft) => {
      expect(setMapGrid(draft, "map-1", { width: 10, height: 8 })).toBe(true);
    });

    const map = grown.objects[0]?.map;
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
    const back = decodeRle(shrunk.objects[0]?.map?.cells.runs ?? [], 8 * 6);
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
    expect(same.objects[0]?.map?.grid).toEqual(GRID);

    const tiny = mutate(scene, (draft) => {
      setMapGrid(draft, "map-1", { width: 0, height: -3 });
    });
    expect(tiny.objects[0]?.map?.grid).toEqual({ width: 1, height: 1 });
    expect(decodeRle(tiny.objects[0]?.map?.cells.runs ?? [], 1)).toEqual(new Uint8Array([0]));
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
    expect(next.objects[0]?.map?.grid).toEqual(GRID);
  });

  it("findMapObject / listMapObjects 只挑地图对象", () => {
    const scene = withObject(withMapObject(makeScene()), "door");
    expect(findMapObject(scene)?.id).toBe("map-1");
    expect(listMapObjects(scene).map((object) => object.id)).toEqual(["map-1"]);
  });

  it("地图也参与摆放：setObjectPosition 对它生效（贴图中心跟着走）", () => {
    const scene = withMapObject(makeScene());

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
    const sprite = createSceneObject({
      name: "精灵",
      kind: "SceneObject",
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
    expect(withMap.objects[0]?.map?.image).toEqual(next);
    expect(withMap.objects[0]?.image).toBeUndefined();

    const withSprite = mutate(withObject(makeScene(), "sprite"), (draft) => {
      expect(setObjectImage(draft, "sprite", next)).toBe(true);
    });
    expect(withSprite.objects[0]?.image).toEqual(next);
    expect(withSprite.objects[0]?.map).toBeUndefined();

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

  it("动作的增删改与排序", () => {
    let scene = withObject(makeScene(), "door", "BoolValue");
    scene = mutate(scene, (draft) => {
      addAction(draft, "door", "cmp", {
        id: "act_1",
        type: "ShowHide",
        enabled: true,
        params: { targetObjectId: "" },
      });
      addAction(draft, "door", "cmp", {
        id: "act_2",
        type: "PlayVideo",
        enabled: true,
        params: { targetObjectId: "tv", index: 0 },
      });
    });

    expect(collectActionIds(scene).size).toBe(2);

    scene = mutate(scene, (draft) => {
      updateAction(draft, "door", "cmp", "act_1", { enabled: false });
    });
    expect(scene.objects[0]?.components[0]?.actions[0]?.enabled).toBe(false);

    scene = mutate(scene, (draft) => {
      moveAction(draft, "door", "cmp", "act_2", -1);
    });
    expect(scene.objects[0]?.components[0]?.actions.map((action) => action.id)).toEqual([
      "act_2",
      "act_1",
    ]);

    scene = mutate(scene, (draft) => {
      removeAction(draft, "door", "cmp", "act_2");
    });
    expect(scene.objects[0]?.components[0]?.actions.map((action) => action.id)).toEqual(["act_1"]);
  });

  it("动作条件可设置与清除", () => {
    let scene = withObject(makeScene(), "o", "BoolValue");
    scene = mutate(scene, (draft) => {
      addAction(draft, "o", "cmp", { id: "a", type: "ShowHide", enabled: true, params: {} });
      updateAction(draft, "o", "cmp", "a", {
        condition: { valueType: "Bool", op: "Equal", target: true },
      });
    });

    expect(scene.objects[0]?.components[0]?.actions[0]?.condition?.target).toBe(true);

    scene = mutate(scene, (draft) => {
      updateAction(draft, "o", "cmp", "a", { condition: undefined });
    });
    expect(scene.objects[0]?.components[0]?.actions[0]?.condition).toBeUndefined();
  });
});

describe("文档校验", () => {
  it("干净的项目没有错误", () => {
    expect(hasErrors(validateProject(makeProject()))).toBe(false);
  });

  it("没有地图对象的场景也是合法的（对象挂在场景上，不依赖地图）", () => {
    const scene = withObject(makeScene(), "door", "BoolValue");
    expect(hasErrors(validateScene(scene))).toBe(false);
  });

  it("地图对象缺少地图数据时报错", () => {
    const scene = mutate(makeScene(), (draft) => {
      addObject(draft, plainObject("broken-map", { name: "坏地图", kind: "Map" }));
    });

    expect(formatIssues(validateScene(scene))).toMatch(/缺少地图数据/);
  });

  it("非地图对象带地图数据时给警告", () => {
    const scene = mutate(makeScene(), (draft) => {
      addObject(
        draft,
        plainObject("odd", {
          name: "怪对象",
          map: {
            image: IMAGE,
            grid: GRID,
            rowOrder: "bottom-up",
            cells: { encoding: "rle", runs: [[0, GRID.width * GRID.height]] },
          },
        }),
      );
    });

    const issues = validateScene(scene);
    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).toMatch(/不应携带地图数据/);
  });

  it("地图对象带多余的 object.image 时给警告（贴图只认 map.image）", () => {
    const scene = mutate(withMapObject(makeScene()), (draft) => {
      const map = draft.objects[0];
      if (map !== undefined) {
        map.image = IMAGE;
      }
    });

    const issues = validateScene(scene);
    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).toMatch(/写在 map.image/);
  });

  it("地图网格格数与网格尺寸不符时报错", () => {
    const scene = mutate(withMapObject(makeScene()), (draft) => {
      const map = draft.objects[0]?.map;
      if (map !== undefined) {
        map.cells = { encoding: "rle", runs: [[1, 3]] };
      }
    });

    expect(formatIssues(validateScene(scene))).toMatch(/不匹配/);
  });

  it("动作 id 重复时报错（运行态要靠 actionId 寻址）", () => {
    let scene = withObject(makeScene(), "o1", "BoolValue");
    scene = produce(scene, (draft) => {
      addObject(draft, plainObject("o2"));
      addComponent(draft, "o2", "BoolValue", { id: "cmp2" });
      addAction(draft, "o1", "cmp", { id: "dup", type: "ShowHide", enabled: true, params: {} });
      addAction(draft, "o2", "cmp2", { id: "dup", type: "ShowHide", enabled: true, params: {} });
    });

    expect(formatIssues(validateScene(scene))).toMatch(/动作 id 重复/);
  });

  it("OptionValue 当前选项不在列表里时报错", () => {
    const scene = mutate(withObject(makeScene(), "o", "OptionValue"), (draft) => {
      updateComponentData(draft, "o", "cmp", { options: ["关闭", "打开"], current: "爆炸" });
    });

    expect(formatIssues(validateScene(scene))).toMatch(/不在选项列表中/);
  });

  it("未知组件类型只给警告（数据原样保留）", () => {
    const scene = mutate(withObject(makeScene(), "o"), (draft) => {
      draft.objects[0]?.components.push({
        id: "c",
        type: "FutureComponent",
        data: {},
        actions: [],
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
    expect(loaded.migratedScenes[0]?.objects[0]?.map?.image).toEqual(IMAGE);
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
    // 原来的地图数据被搬到一个 Map 对象上，原有对象保持不动
    expect(scene?.objects.map((object) => object.kind)).toEqual(["Map", "SceneObject"]);
    expect(scene?.objects[0]?.map?.image).toEqual(IMAGE);
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
        objects: withMapObject(makeScene()).objects,
      }),
    ) as { objects: Array<{ map?: { rowOrder: string } }> };
    const mapObject = scene.objects[0];
    if (mapObject?.map !== undefined) {
      mapObject.map.rowOrder = "top-down";
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
          kind: "SceneObject",
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
          components: [],
          map: {
            image: IMAGE,
            grid: GRID,
            rowOrder: "bottom-up",
            cells: { encoding: "rle", runs: [[0, GRID.width * GRID.height]] },
          },
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
          kind: "SceneObject",
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
    // 别的字段一个都不能动
    expect(parsed.file.objects[0]?.position).toEqual({ x: 10, y: 20 });
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
          map: { ...scene.objects[0]?.map, grid: { width: 64, height: 36, cellSize: 1 } },
        },
      ],
    };

    const parsed = parseSceneFile(raw);
    // 版本升到 v6：要回写一次（把没人读的 cellSize 从磁盘上清掉）
    expect(parsed.needsRewrite).toBe(true);
    expect(parsed.file.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    // 世界坐标原样保留——位置换算只认 v5 这条线，不能拿「< 当前版本」当条件
    expect(parsed.file.objects[0]?.position).toEqual({ x: 300, y: -200 });
    expect(parsed.file.objects[0]?.map?.grid).toEqual({ width: 64, height: 36 });
  });

  it("v4 场景文件：调用方给了贴图尺寸就按它换算", () => {
    const raw = {
      formatVersion: 4,
      objects: [
        {
          id: "door",
          name: "木门",
          kind: "SceneObject",
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
          kind: "SceneObject",
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
    const raw = {
      formatVersion: 5,
      objects: [
        {
          id: "m1",
          name: "地图",
          kind: "Map",
          position: null,
          rotation: 0,
          components: [],
          map: {
            image: IMAGE,
            grid: GRID,
            rowOrder: "top-down",
            cells: { encoding: "rle", runs: [[0, GRID.width * GRID.height]] },
          },
        },
      ],
    };

    expect(() => parseSceneFile(raw)).toThrow(/场景文件校验失败/);
  });
});
