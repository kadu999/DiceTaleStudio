import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import { CellMask, encodeRle } from "@dts/grid";
import {
  addAction,
  addComponent,
  addObject,
  addSpawnPoint,
  collectActionIds,
  moveAction,
  removeAction,
  removeObject,
  setCellRuns,
  updateAction,
  updateComponentData,
} from "../src/commands";
import { defaultComponentData, findComponentType, isKnownComponentType } from "../src/components";
import { createEmptyProject, createMapDoc } from "../src/factory";
import { parseProjectDoc } from "../src/schema";
import { DEFAULT_HISTORY_LIMIT } from "../src/history";
import { validateMap, validateProject, hasErrors, formatIssues } from "../src/validation";
import type { MapDoc, ProjectDoc } from "../src/types";

const IMAGE = { id: "image:maps/Map001.png", width: 1920, height: 1080 };
const GRID = { width: 8, height: 6, cellSize: 1 };

function makeMap(): MapDoc {
  return createMapDoc({ name: "Map001", image: IMAGE, grid: GRID, id: "map-1" });
}

function makeProject(map: MapDoc): ProjectDoc {
  return { ...createEmptyProject("测试项目"), maps: [map] };
}

/** 在不可变副本上执行命令（测试里用它代替完整的命令层）。 */
function mutate<T>(value: T, recipe: (draft: Draft<T>) => void): T {
  return produce(value, recipe);
}

describe("文档工厂", () => {
  it("新建地图带上默认出生点与整张空网格", () => {
    const map = makeMap();
    expect(map.rowOrder).toBe("bottom-up");
    // 显式写出「整张图都是空格子」，而不是留空数组（否则校验会判为数据不完整）
    expect(map.cells).toEqual({ encoding: "rle", runs: [[0, GRID.width * GRID.height]] });
    expect(map.spawnPoints.map((spawn) => spawn.id)).toEqual(["Default"]);
    expect(map.objects).toEqual([]);
  });

  it("新建项目带上空的道具库", () => {
    const project = createEmptyProject("我的模组");
    expect(project.formatVersion).toBe(1);
    expect(project.maps).toEqual([]);
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

describe("文档命令", () => {
  it("增删对象", () => {
    const withObject = mutate(makeMap(), (draft) => {
      addObject(draft, {
        id: "door_01",
        name: "木门",
        kind: "SceneObject",
        position: { x: 0.32, y: 0.61 },
        rotation: 0,
        components: [],
      });
    });

    expect(withObject.objects).toHaveLength(1);

    const removed = mutate(withObject, (draft) => {
      removeObject(draft, "door_01");
    });
    expect(removed.objects).toHaveLength(0);
  });

  it("添加组件时用注册表默认数据，并可浅合并修改", () => {
    const map = mutate(
      mutate(makeMap(), (draft) => {
        addObject(draft, {
          id: "chest",
          name: "宝箱",
          kind: "SceneObject",
          position: null,
          rotation: 0,
          components: [],
        });
      }),
      (draft) => {
        addComponent(draft, "chest", "OptionValue", { id: "cmp_1" });
      },
    );

    expect(map.objects[0]?.components[0]?.data).toEqual({ options: [], current: "" });

    const updated = mutate(map, (draft) => {
      updateComponentData(draft, "chest", "cmp_1", { options: ["关闭", "打开"], current: "关闭" });
    });
    expect(updated.objects[0]?.components[0]?.data.current).toBe("关闭");
  });

  it("动作的增删改与排序", () => {
    let map = makeMap();
    map = mutate(map, (draft) => {
      addObject(draft, {
        id: "door",
        name: "门",
        kind: "SceneObject",
        position: null,
        rotation: 0,
        components: [],
      });
      addComponent(draft, "door", "BoolValue", { id: "cmp" });
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

    expect(collectActionIds(map).size).toBe(2);

    map = mutate(map, (draft) => {
      updateAction(draft, "door", "cmp", "act_1", { enabled: false });
    });
    expect(map.objects[0]?.components[0]?.actions[0]?.enabled).toBe(false);

    map = mutate(map, (draft) => {
      moveAction(draft, "door", "cmp", "act_2", -1);
    });
    expect(map.objects[0]?.components[0]?.actions.map((action) => action.id)).toEqual([
      "act_2",
      "act_1",
    ]);

    map = mutate(map, (draft) => {
      removeAction(draft, "door", "cmp", "act_2");
    });
    expect(map.objects[0]?.components[0]?.actions.map((action) => action.id)).toEqual(["act_1"]);
  });

  it("动作条件可设置与清除", () => {
    let map = makeMap();
    map = mutate(map, (draft) => {
      addObject(draft, {
        id: "o",
        name: "o",
        kind: "SceneObject",
        position: null,
        rotation: 0,
        components: [],
      });
      addComponent(draft, "o", "BoolValue", { id: "c" });
      addAction(draft, "o", "c", { id: "a", type: "ShowHide", enabled: true, params: {} });
      updateAction(draft, "o", "c", "a", {
        condition: { valueType: "Bool", op: "Equal", target: true },
      });
    });

    expect(map.objects[0]?.components[0]?.actions[0]?.condition?.target).toBe(true);

    map = mutate(map, (draft) => {
      updateAction(draft, "o", "c", "a", { condition: undefined });
    });
    expect(map.objects[0]?.components[0]?.actions[0]?.condition).toBeUndefined();
  });

  it("出生点不可重复添加", () => {
    const map = mutate(makeMap(), (draft) => {
      addSpawnPoint(draft, { id: "Default", name: "重复", position: { x: 0, y: 0 } });
    });
    expect(map.spawnPoints).toHaveLength(1);
  });

  it("setCellRuns 用 RLE 写入格子", () => {
    const cells = new Uint8Array(GRID.width * GRID.height);
    cells[0] = CellMask.Obstacle;
    const runs = encodeRle(cells);

    const map = mutate(makeMap(), (draft) => {
      setCellRuns(draft, runs);
    });

    expect(map.cells.runs.length).toBeGreaterThan(0);
    expect(map.cells.runs[0]?.[0]).toBe(CellMask.Obstacle);
  });
});

describe("文档校验", () => {
  it("干净的文档没有错误", () => {
    const project = makeProject(makeMap());
    expect(hasErrors(validateProject(project))).toBe(false);
  });

  it("RLE 格数与网格尺寸不符时报错", () => {
    const map = mutate(makeMap(), (draft) => {
      draft.cells.runs = [[1, 3]];
    });

    const issues = validateMap(map);
    expect(hasErrors(issues)).toBe(true);
    expect(formatIssues(issues)).toMatch(/不匹配/);
  });

  it("动作 id 重复时报错（运行态要靠 actionId 寻址）", () => {
    const map = mutate(makeMap(), (draft) => {
      addObject(draft, {
        id: "o1",
        name: "o1",
        kind: "SceneObject",
        position: null,
        rotation: 0,
        components: [],
      });
      addComponent(draft, "o1", "BoolValue", { id: "c1" });
      addAction(draft, "o1", "c1", { id: "dup", type: "ShowHide", enabled: true, params: {} });

      addObject(draft, {
        id: "o2",
        name: "o2",
        kind: "SceneObject",
        position: null,
        rotation: 0,
        components: [],
      });
      addComponent(draft, "o2", "BoolValue", { id: "c2" });
      addAction(draft, "o2", "c2", { id: "dup", type: "ShowHide", enabled: true, params: {} });
    });

    const issues = validateMap(map);
    expect(formatIssues(issues)).toMatch(/动作 id 重复/);
  });

  it("OptionValue 当前选项不在列表里时报错", () => {
    const map = mutate(makeMap(), (draft) => {
      addObject(draft, {
        id: "o",
        name: "o",
        kind: "SceneObject",
        position: null,
        rotation: 0,
        components: [],
      });
      addComponent(draft, "o", "OptionValue", { id: "c" });
      updateComponentData(draft, "o", "c", { options: ["关闭", "打开"], current: "爆炸" });
    });

    expect(formatIssues(validateMap(map))).toMatch(/不在选项列表中/);
  });

  it("未知组件类型只给警告（数据原样保留）", () => {
    const map = mutate(makeMap(), (draft) => {
      draft.objects.push({
        id: "o",
        name: "o",
        kind: "SceneObject",
        position: null,
        rotation: 0,
        components: [{ id: "c", type: "FutureComponent", data: {}, actions: [] }],
      });
    });

    const issues = validateMap(map);
    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).toMatch(/未知组件类型/);
  });

  it("归一化位置越界时报错", () => {
    const map = mutate(makeMap(), (draft) => {
      draft.objects.push({
        id: "o",
        name: "o",
        kind: "SceneObject",
        position: { x: 1.5, y: -0.2 },
        rotation: 0,
        components: [],
      });
    });

    expect(formatIssues(validateMap(map))).toMatch(/归一化位置越界/);
  });

  it("道具库 count 与实际条目不一致时给警告", () => {
    const project: ProjectDoc = {
      ...makeProject(makeMap()),
      items: { source: "x", updatedAt: "2026-01-01", count: 5, items: [] },
    };

    const issues = validateProject(project);
    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).toMatch(/不一致/);
  });
});

describe("文档 schema", () => {
  it("合法文档可解析", () => {
    const project = makeProject(makeMap());
    expect(parseProjectDoc(JSON.parse(JSON.stringify(project))).name).toBe("测试项目");
  });

  it("缺少必填字段时抛出带路径的错误", () => {
    expect(() => parseProjectDoc({ formatVersion: 1, name: "x" })).toThrow(/项目文档校验失败/);
  });

  it("拒绝高于支持版本的文件（不静默丢字段）", () => {
    const project = { ...makeProject(makeMap()), formatVersion: 99 };
    expect(() => parseProjectDoc(project)).toThrow(/高于本编辑器支持/);
  });

  it("拒绝非 bottom-up 行序（避免坐标约定被悄悄改掉）", () => {
    const project = makeProject(makeMap());
    const broken = { ...project, maps: [{ ...project.maps[0], rowOrder: "top-down" }] };
    expect(() => parseProjectDoc(broken)).toThrow(/项目文档校验失败/);
  });
});
