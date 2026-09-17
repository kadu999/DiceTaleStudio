import { decodeRle } from "@dts/grid";
import { findComponentType, isKnownComponentType } from "./components";
import { collectActionIds } from "./commands";
import type { MapDoc, ProjectDoc, SceneObjectDoc } from "./types";

/**
 * 结构性校验（**不依赖动作注册表**，因此放在 document 包内）。
 * 动作类型与参数引用相关校验在 `@dts/actions` 里（依赖方向：actions → document）。
 */

export type IssueLevel = "error" | "warning";

export interface ValidationIssue {
  readonly level: IssueLevel;
  /** 定位路径，例如 `maps/Map001/objects/door_01`。 */
  readonly path: string;
  readonly message: string;
}

export function hasErrors(issues: readonly ValidationIssue[]): boolean {
  return issues.some((issue) => issue.level === "error");
}

function checkPosition(
  position: { x: number; y: number },
  path: string,
  issues: ValidationIssue[],
): void {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    issues.push({ level: "error", path, message: "位置不是有限数值" });
    return;
  }

  if (position.x < 0 || position.x > 1 || position.y < 0 || position.y > 1) {
    issues.push({
      level: "error",
      path,
      message: `归一化位置越界 [0,1]: (${position.x}, ${position.y})`,
    });
  }
}

function validateObject(object: SceneObjectDoc, path: string, issues: ValidationIssue[]): void {
  if (object.position !== null) {
    checkPosition(object.position, `${path}/position`, issues);
  }

  const componentIds = new Set<string>();
  for (const component of object.components) {
    const componentPath = `${path}/components/${component.id}`;
    if (componentIds.has(component.id)) {
      issues.push({ level: "error", path: componentPath, message: `组件 id 重复: ${component.id}` });
    }

    componentIds.add(component.id);

    if (!isKnownComponentType(component.type)) {
      issues.push({
        level: "warning",
        path: componentPath,
        message: `未知组件类型: ${component.type}（数据将原样保留）`,
      });
      continue;
    }

    // OptionValue：当前选项必须在选项列表里
    if (component.type === "OptionValue") {
      const options = component.data.options;
      const current = component.data.current;
      if (Array.isArray(options) && typeof current === "string" && current.length > 0) {
        if (!options.includes(current)) {
          issues.push({
            level: "error",
            path: `${componentPath}/data/current`,
            message: `当前选项 "${current}" 不在选项列表中`,
          });
        }
      }
    }

    // 值组件的 value 类型
    const valueType = findComponentType(component.type)?.fields.find((field) => field.key === "value")
      ?.kind;
    if (valueType !== undefined) {
      const value = component.data.value;
      if (valueType === "boolean" && typeof value !== "boolean") {
        issues.push({ level: "error", path: `${componentPath}/data/value`, message: "应为布尔值" });
      }

      if (valueType === "integer" && !Number.isInteger(value)) {
        issues.push({ level: "error", path: `${componentPath}/data/value`, message: "应为整数" });
      }

      if (valueType === "number" && typeof value !== "number") {
        issues.push({ level: "error", path: `${componentPath}/data/value`, message: "应为数值" });
      }
    }

    for (const action of component.actions) {
      if (action.id.trim().length === 0) {
        issues.push({ level: "error", path: `${componentPath}/actions`, message: "动作 id 不能为空" });
      }

      if (action.condition !== undefined) {
        if (
          action.condition.valueType === "Bool" &&
          typeof action.condition.target !== "boolean"
        ) {
          issues.push({
            level: "error",
            path: `${componentPath}/actions/${action.id}/condition`,
            message: "Bool 条件的比较目标应为布尔值",
          });
        }

        if (
          action.condition.valueType === "String" &&
          typeof action.condition.target !== "string"
        ) {
          issues.push({
            level: "error",
            path: `${componentPath}/actions/${action.id}/condition`,
            message: "String 条件的比较目标应为字符串",
          });
        }

        if (
          (action.condition.valueType === "Number" || action.condition.valueType === "Integer") &&
          typeof action.condition.target !== "number"
        ) {
          issues.push({
            level: "error",
            path: `${componentPath}/actions/${action.id}/condition`,
            message: `${action.condition.valueType} 条件的比较目标应为数值`,
          });
        }
      }
    }
  }
}

/** 校验单张地图。 */
export function validateMap(map: MapDoc): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const base = `maps/${map.name}`;

  // 网格数据长度必须与尺寸一致
  try {
    decodeRle(map.cells.runs, map.grid.width * map.grid.height);
  } catch (error) {
    issues.push({
      level: "error",
      path: `${base}/cells`,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // 每格掩码合法（RLE 里已限定 0..255，这里只查总量已足够）

  // 出生点
  const spawnIds = new Set<string>();
  for (const spawn of map.spawnPoints) {
    const path = `${base}/spawnPoints/${spawn.id}`;
    if (spawnIds.has(spawn.id)) {
      issues.push({ level: "error", path, message: `出生点 id 重复: ${spawn.id}` });
    }

    spawnIds.add(spawn.id);
    if (spawn.id.trim().length === 0) {
      issues.push({ level: "error", path, message: "出生点 id 不能为空" });
    }

    checkPosition(spawn.position, `${path}/position`, issues);
  }

  // 对象
  const objectIds = new Set<string>();
  for (const object of map.objects) {
    const path = `${base}/objects/${object.id}`;
    if (objectIds.has(object.id)) {
      issues.push({ level: "error", path, message: `对象 id 重复: ${object.id}` });
    }

    objectIds.add(object.id);
    if (object.id.trim().length === 0) {
      issues.push({ level: "error", path, message: "对象 id 不能为空" });
    }

    validateObject(object, path, issues);
  }

  // 动作 id 全图唯一（运行态要靠 actionId 寻址，重名会导致触发到错误动作）
  for (const [actionId, owners] of collectActionIds(map)) {
    if (owners.length > 1) {
      issues.push({
        level: "error",
        path: `${base}/actions/${actionId}`,
        message: `动作 id 重复: ${actionId}（出现在 ${owners.join(", ")}）`,
      });
    }
  }

  return issues;
}

/** 校验整个项目。 */
export function validateProject(doc: ProjectDoc): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const mapIds = new Set<string>();
  const mapNames = new Set<string>();

  for (const map of doc.maps) {
    if (mapIds.has(map.id)) {
      issues.push({ level: "error", path: `maps/${map.id}`, message: `地图 id 重复: ${map.id}` });
    }

    mapIds.add(map.id);

    if (mapNames.has(map.name)) {
      issues.push({ level: "warning", path: `maps/${map.name}`, message: `地图名重复: ${map.name}` });
    }

    mapNames.add(map.name);
    issues.push(...validateMap(map));
  }

  if (doc.items.count !== doc.items.items.length) {
    issues.push({
      level: "warning",
      path: "items/count",
      message: `道具库 count=${doc.items.count} 与实际条目数 ${doc.items.items.length} 不一致`,
    });
  }

  return issues;
}

/** 把问题列表整理成可读多行文本（进入运行态被阻止时展示）。 */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues
    .map((issue) => `${issue.level === "error" ? "✗" : "!"} ${issue.path}: ${issue.message}`)
    .join("\n");
}
