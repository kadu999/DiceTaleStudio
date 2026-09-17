import { describe, expect, it } from "vitest";
import { createEmptyProject, createMapDoc, type ComponentDoc, type ProjectDoc } from "@dts/document";
import {
  actualValueFor,
  compareCondition,
  conditionAlwaysMet,
  describeCondition,
  evaluateCondition,
} from "../src/condition";
import { ACTION_TYPES, findActionType, isActionImplemented } from "../src/registry";
import { validateActionGraph } from "../src/validation";

function boolComponent(value: boolean): ComponentDoc {
  return { id: "c", type: "BoolValue", data: { value }, actions: [] };
}

function optionComponent(options: string[], current: string): ComponentDoc {
  return { id: "c", type: "OptionValue", data: { options, current }, actions: [] };
}

describe("动作注册表", () => {
  it("覆盖前端全部动作类型（含未实现的空壳）", () => {
    expect(ACTION_TYPES.map((def) => def.type).sort()).toEqual(
      ["PlayAudio", "PlayVideo", "ShowHide", "Teleport", "TeleportZone"].sort(),
    );
  });

  it("字段名与前端序列化字段一致", () => {
    expect(findActionType("Teleport")?.fields.map((field) => field.key)).toEqual([
      "range",
      "teleportAllPlayers",
      "targetMapName",
      "targetMarkerId",
    ]);
    expect(findActionType("PlayVideo")?.fields.map((field) => field.key)).toEqual([
      "targetObjectId",
      "index",
      "isLooping",
      "speed",
    ]);
    expect(findActionType("ShowHide")?.fields.map((field) => field.key)).toEqual(["targetObjectId"]);
  });

  it("PlayAudio 标记为未实现（前端是空壳）", () => {
    expect(isActionImplemented("PlayAudio")).toBe(false);
    expect(isActionImplemented("ShowHide")).toBe(true);
  });

  it("所有动作都带条件（继承 ConditionalBackendChangeAction）", () => {
    expect(ACTION_TYPES.every((def) => def.conditional)).toBe(true);
  });

  it("摘要可读", () => {
    expect(
      findActionType("Teleport")?.summary({ range: 2, teleportAllPlayers: false, targetMapName: "Map002", targetMarkerId: "North" }),
    ).toContain("Map002#North");
  });
});

describe("条件求值（与前端 ComponentCondition 语义一致）", () => {
  it("条件缺省恒满足", () => {
    expect(conditionAlwaysMet(undefined)).toBe(true);
    expect(evaluateCondition(boolComponent(true), undefined)).toBe(true);
  });

  it("Bool：只支持等于/不等于", () => {
    expect(compareCondition({ valueType: "Bool", op: "Equal", target: true }, true)).toBe(true);
    expect(compareCondition({ valueType: "Bool", op: "Equal", target: true }, false)).toBe(false);
    expect(compareCondition({ valueType: "Bool", op: "NotEqual", target: true }, false)).toBe(true);
    expect(compareCondition({ valueType: "Bool", op: "AtLeast", target: true }, true)).toBe(false);
  });

  it("String：忽略大小写，只支持等于/不等于", () => {
    expect(compareCondition({ valueType: "String", op: "Equal", target: "打开" }, "打开")).toBe(true);
    expect(compareCondition({ valueType: "String", op: "Equal", target: "Open" }, "open")).toBe(true);
    expect(compareCondition({ valueType: "String", op: "NotEqual", target: "open" }, "关闭")).toBe(true);
    expect(compareCondition({ valueType: "String", op: "AtLeast", target: "a" }, "a")).toBe(false);
  });

  it("Number / Integer：支持四种比较", () => {
    expect(compareCondition({ valueType: "Number", op: "AtLeast", target: 2 }, 2)).toBe(true);
    expect(compareCondition({ valueType: "Number", op: "AtMost", target: 2 }, 2.5)).toBe(false);
    expect(compareCondition({ valueType: "Integer", op: "NotEqual", target: 3 }, 4)).toBe(true);
    expect(compareCondition({ valueType: "Integer", op: "Equal", target: 3 }, 3)).toBe(true);
  });

  it("实际值类型与声明不符时返回 false（配置错误不静默通过）", () => {
    expect(compareCondition({ valueType: "Bool", op: "Equal", target: true }, "true")).toBe(false);
    expect(compareCondition({ valueType: "Number", op: "Equal", target: 1 }, "1")).toBe(false);
    expect(compareCondition({ valueType: "Integer", op: "Equal", target: 1 }, 1.5)).toBe(false);
  });

  it("OptionValue：String 比当前选项名，Integer 比选项索引", () => {
    const component = optionComponent(["关闭", "打开"], "打开");
    expect(actualValueFor(component, "String")).toBe("打开");
    expect(actualValueFor(component, "Integer")).toBe(1);
    expect(actualValueFor(component, "Bool")).toBeUndefined();

    expect(evaluateCondition(component, { valueType: "String", op: "Equal", target: "打开" })).toBe(true);
    expect(evaluateCondition(component, { valueType: "Integer", op: "Equal", target: 0 })).toBe(false);
  });

  it("BoolValue / IntValue / FloatValue 各自提供对应形态", () => {
    expect(actualValueFor(boolComponent(true), "Bool")).toBe(true);
    expect(actualValueFor({ id: "c", type: "IntValue", data: { value: 3 }, actions: [] }, "Integer")).toBe(3);
    expect(actualValueFor({ id: "c", type: "FloatValue", data: { value: 1.5 }, actions: [] }, "Number")).toBe(1.5);
  });

  it("组件不提供该形态时条件不满足（对齐前端默认 Satisfies）", () => {
    expect(evaluateCondition(boolComponent(true), { valueType: "String", op: "Equal", target: "x" })).toBe(false);
  });

  it("条件可读描述", () => {
    expect(describeCondition(undefined)).toBe("无条件（总是执行）");
    expect(describeCondition({ valueType: "Integer", op: "AtLeast", target: 2 })).toBe("Integer ≥ 2");
  });
});

describe("动作图校验", () => {
  function projectWith(action: { id: string; type: string; params: Record<string, unknown> }): ProjectDoc {
    const base = createEmptyProject("t");
    const map = createMapDoc({
      name: "Map001",
      image: { id: "image:maps/Map001.png", width: 1920, height: 1080 },
      grid: { width: 64, height: 36, cellSize: 1 },
      id: "m1",
    });

    const withObject = {
      ...map,
      objects: [
        {
          id: "door",
          name: "门",
          kind: "SceneObject" as const,
          position: { x: 0.3, y: 0.3 },
          rotation: 0,
          components: [
            {
              id: "cmp",
              type: "OptionValue",
              data: { options: ["关闭", "打开"], current: "关闭" },
              actions: [{ id: action.id, type: action.type, enabled: true, params: action.params }],
            },
          ],
        },
      ],
    };

    return { ...base, maps: [withObject, secondMap()] };
  }

  function secondMap() {
    return createMapDoc({
      name: "Map002",
      image: { id: "image:maps/Map002.png", width: 1920, height: 1080 },
      grid: { width: 64, height: 36, cellSize: 1 },
      id: "m2",
    });
  }

  it("合法动作图没有问题", () => {
    const project = projectWith({
      id: "a1",
      type: "Teleport",
      params: { range: 1, teleportAllPlayers: false, targetMapName: "Map002", targetMarkerId: "Default" },
    });
    expect(validateActionGraph(project)).toEqual([]);
  });

  it("未知动作类型报错", () => {
    const issues = validateActionGraph(projectWith({ id: "a1", type: "NotAnAction", params: {} }));
    expect(issues.some((issue) => issue.level === "error" && /未知动作类型/.test(issue.message))).toBe(true);
  });

  it("未实现的动作只给警告", () => {
    const issues = validateActionGraph(projectWith({ id: "a1", type: "PlayAudio", params: {} }));
    expect(issues.every((issue) => issue.level === "warning")).toBe(true);
    expect(issues[0]?.message).toMatch(/尚未实现/);
  });

  it("缺少必填参数报错", () => {
    const issues = validateActionGraph(
      projectWith({ id: "a1", type: "TeleportZone", params: { targetMapName: "", targetMarkerId: "" } }),
    );
    expect(issues.filter((issue) => /缺少必填参数/.test(issue.message)).length).toBe(2);
  });

  it("目标地图或标记点不存在时报错（否则运行态会静默失败）", () => {
    const badMap = validateActionGraph(
      projectWith({
        id: "a1",
        type: "Teleport",
        params: { range: 1, teleportAllPlayers: true, targetMapName: "Map999", targetMarkerId: "Default" },
      }),
    );
    expect(badMap.some((issue) => /目标地图不存在/.test(issue.message))).toBe(true);

    const badMarker = validateActionGraph(
      projectWith({
        id: "a1",
        type: "Teleport",
        params: { range: 1, teleportAllPlayers: true, targetMapName: "Map002", targetMarkerId: "Nope" },
      }),
    );
    expect(badMarker.some((issue) => /不存在标记点/.test(issue.message))).toBe(true);
  });

  it("目标对象不存在时报错", () => {
    const issues = validateActionGraph(
      projectWith({ id: "a1", type: "PlayVideo", params: { targetObjectId: "ghost", index: 0 } }),
    );
    expect(issues.some((issue) => /目标对象不存在/.test(issue.message))).toBe(true);
  });

  it("条件形态与组件不匹配时报错（例如 OptionValue 用 Bool 条件）", () => {
    const project = projectWith({ id: "a1", type: "ShowHide", params: { targetObjectId: "" } });
    const broken: ProjectDoc = {
      ...project,
      maps: project.maps.map((map, index) =>
        index !== 0
          ? map
          : {
              ...map,
              objects: map.objects.map((object) => ({
                ...object,
                components: object.components.map((component) => ({
                  ...component,
                  actions: component.actions.map((action) => ({
                    ...action,
                    condition: { valueType: "Bool" as const, op: "Equal" as const, target: true },
                  })),
                })),
              })),
            },
      ),
    };

    const issues = validateActionGraph(broken);
    expect(issues.some((issue) => /不支持 Bool 条件/.test(issue.message))).toBe(true);
  });
});
