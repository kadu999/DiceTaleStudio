import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import { CellMask, encodeRle } from "@dts/grid";
import {
  addAction,
  addComponent,
  addObject,
  addSpawnPoint,
  collectActionIds,
  findMapObject,
  listMapObjects,
  moveAction,
  removeAction,
  removeObject,
  setMapCells,
  updateAction,
  updateComponentData,
} from "../src/commands";
import { defaultComponentData, findComponentType, isKnownComponentType } from "../src/components";
import { createEmptyProject, createMapObject, createSceneDoc } from "../src/factory";
import { parseProjectDoc } from "../src/schema";
import { DEFAULT_HISTORY_LIMIT } from "../src/history";
import { formatIssues, hasErrors, validateProject, validateScene } from "../src/validation";
import type { ProjectDoc, SceneDoc } from "../src/types";

const IMAGE = { id: "campaign:C/images/maps/Map001.png", width: 1920, height: 1080 };
const GRID = { width: 8, height: 6, cellSize: 1 };

function makeScene(name = "Map001"): SceneDoc {
  return createSceneDoc({ name, id: "scene-1" });
}

function withMapObject(scene: SceneDoc, name = "Map001"): SceneDoc {
  return produce(scene, (draft) => {
    addObject(draft, createMapObject({ name: `${name} 地图`, image: IMAGE, grid: GRID, id: "map-1" }));
  });
}

function makeProject(...scenes: SceneDoc[]): ProjectDoc {
  return { ...createEmptyProject("测试项目"), scenes };
}

function mutate<T>(value: T, recipe: (draft: Draft<T>) => void): T {
  return produce(value, recipe);
}

/** 往场景里加一个普通对象（带一个可选组件）。 */
function withObject(scene: SceneDoc, objectId = "door", componentType?: string): SceneDoc {
  return produce(scene, (draft) => {
    addObject(draft, {
      id: objectId,
      name: objectId,
      kind: "SceneObject",
      position: null,
      rotation: 0,
      components: [],
    });

    if (componentType !== undefined) {
      addComponent(draft, objectId, componentType, { id: "cmp" });
    }
  });
}

describe("文档工厂：场景是容器，对象挂在场景上", () => {
  it("新建场景是**空场景**（不需要地图也能建对象）", () => {
    const scene = makeScene();
    expect(scene.objects).toEqual([]);
    expect(scene.spawnPoints.map((spawn) => spawn.id)).toEqual(["Default"]);
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

  it("新建项目带上空场景列表与空道具库", () => {
    const project = createEmptyProject("我的模组");
    expect(project.formatVersion).toBe(2);
    expect(project.scenes).toEqual([]);
    expect(project.items.count).toBe(0);
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
      addObject(draft, {
        id: "door_01",
        name: "木门",
        kind: "SceneObject",
        position: { x: 0.32, y: 0.61 },
        rotation: 0,
        components: [],
      });
    });

    expect(scene.objects).toHaveLength(1);
    expect(findMapObject(scene)).toBeUndefined();
  });

  it("增删对象", () => {
    const scene = mutate(makeScene(), (draft) => {
      addObject(draft, {
        id: "door_01",
        name: "木门",
        kind: "SceneObject",
        position: null,
        rotation: 0,
        components: [],
      });
    });

    expect(scene.objects).toHaveLength(1);
    const removed = mutate(scene, (draft) => {
      removeObject(draft, "door_01");
    });
    expect(removed.objects).toHaveLength(0);
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

  it("findMapObject / listMapObjects 只挑地图对象", () => {
    const scene = withObject(withMapObject(makeScene()), "door");
    expect(findMapObject(scene)?.id).toBe("map-1");
    expect(listMapObjects(scene).map((object) => object.id)).toEqual(["map-1"]);
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

  it("出生点不可重复添加", () => {
    const scene = mutate(makeScene(), (draft) => {
      addSpawnPoint(draft, { id: "Default", name: "重复", position: { x: 0, y: 0 } });
    });
    expect(scene.spawnPoints).toHaveLength(1);
  });
});

describe("文档校验", () => {
  it("干净的项目没有错误", () => {
    expect(hasErrors(validateProject(makeProject(withMapObject(makeScene()))))).toBe(false);
  });

  it("没有地图对象的场景也是合法的（对象挂在场景上，不依赖地图）", () => {
    const scene = withObject(makeScene(), "door", "BoolValue");
    expect(hasErrors(validateScene(scene))).toBe(false);
  });

  it("地图对象缺少地图数据时报错", () => {
    const scene = mutate(makeScene(), (draft) => {
      addObject(draft, {
        id: "broken-map",
        name: "坏地图",
        kind: "Map",
        position: null,
        rotation: 0,
        components: [],
      });
    });

    expect(formatIssues(validateScene(scene))).toMatch(/缺少地图数据/);
  });

  it("非地图对象带地图数据时给警告", () => {
    const scene = mutate(makeScene(), (draft) => {
      addObject(draft, {
        id: "odd",
        name: "怪对象",
        kind: "SceneObject",
        position: null,
        rotation: 0,
        components: [],
        map: {
          image: IMAGE,
          grid: GRID,
          rowOrder: "bottom-up",
          cells: { encoding: "rle", runs: [[0, GRID.width * GRID.height]] },
        },
      });
    });

    const issues = validateScene(scene);
    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).toMatch(/不应携带地图数据/);
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
      addObject(draft, {
        id: "o2",
        name: "o2",
        kind: "SceneObject",
        position: null,
        rotation: 0,
        components: [],
      });
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

  it("归一化位置越界时报错", () => {
    const scene = mutate(withObject(makeScene(), "o"), (draft) => {
      const object = draft.objects[0];
      if (object !== undefined) {
        object.position = { x: 1.5, y: -0.2 };
      }
    });

    expect(formatIssues(validateScene(scene))).toMatch(/归一化位置越界/);
  });

  it("道具库 count 与实际条目不一致时给警告", () => {
    const project: ProjectDoc = {
      ...makeProject(makeScene()),
      items: { source: "x", updatedAt: "2026-01-01", count: 5, items: [] },
    };

    const issues = validateProject(project);
    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).toMatch(/不一致/);
  });
});

describe("文档 schema 与版本迁移", () => {
  it("合法文档可解析", () => {
    const project = makeProject(withMapObject(makeScene()));
    expect(parseProjectDoc(JSON.parse(JSON.stringify(project))).name).toBe("测试项目");
  });

  it("缺少必填字段时抛出带路径的错误", () => {
    expect(() => parseProjectDoc({ formatVersion: 2, name: "x" })).toThrow(/项目文档校验失败/);
  });

  it("拒绝高于支持版本的文件（不静默丢字段）", () => {
    const project = { ...makeProject(makeScene()), formatVersion: 99 };
    expect(() => parseProjectDoc(project)).toThrow(/高于本编辑器支持/);
  });

  it("v1（地图即场景）自动升级为 v2（地图是场景里的对象）", () => {
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
          spawnPoints: [{ id: "Default", name: "默认", position: { x: 0.5, y: 0.5 } }],
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

    const doc = parseProjectDoc(v1);
    expect(doc.formatVersion).toBe(2);
    expect(doc.scenes).toHaveLength(1);

    const scene = doc.scenes[0];
    expect(scene?.name).toBe("Map001");
    // 原来的地图数据被搬到一个 Map 对象上，原有对象保持不动
    expect(scene?.objects.map((object) => object.kind)).toEqual(["Map", "SceneObject"]);
    expect(scene?.objects[0]?.map?.image).toEqual(IMAGE);
    expect(scene?.objects[1]?.id).toBe("door");
    expect(hasErrors(validateProject(doc))).toBe(false);
  });

  it("拒绝非 bottom-up 行序（避免坐标约定被悄悄改掉）", () => {
    const project = makeProject(withMapObject(makeScene()));
    const broken = JSON.parse(JSON.stringify(project)) as {
      scenes: Array<{ objects: Array<{ map?: { rowOrder: string } }> }>;
    };
    const mapObject = broken.scenes[0]?.objects[0];
    if (mapObject?.map !== undefined) {
      mapObject.map.rowOrder = "top-down";
    }

    expect(() => parseProjectDoc(broken)).toThrow(/项目文档校验失败/);
  });
});
