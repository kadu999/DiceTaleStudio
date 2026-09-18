import { decodeRle } from "@dts/grid";
import { findComponentType, isKnownComponentType } from "./components";
import { collectActionIds } from "./commands";
import type { ProjectDoc, SceneDoc, SceneObjectDoc } from "./types";

/**
 * 结构性校验（**不依赖动作注册表**，因此放在 document 包内）。
 * 动作类型与参数引用相关校验在 `@dts/actions` 里（依赖方向：actions → document）。
 */

export type IssueLevel = "error" | "warning";

export interface ValidationIssue {
  readonly level: IssueLevel;
  /** 定位路径，例如 `scenes/Map001/objects/door_01`。 */
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
  }

  // 世界坐标的范围就是场景范围（±宽/2、±高/2），而校验拿不到场景尺寸；
  // 这里**不**给坐标设上下限——越界的对象在画布上看得见，比静默拒绝更有用。
}

function validateObject(object: SceneObjectDoc, path: string, issues: ValidationIssue[]): void {
  if (object.position !== null) {
    checkPosition(object.position, `${path}/position`, issues);
  }

  // 地图对象：数据必须完整（没有数据的「地图对象」在场景里就是个空壳）
  if (object.kind === "Map") {
    if (object.map === undefined) {
      issues.push({ level: "error", path, message: "地图对象缺少地图数据（贴图 / 网格）" });
    } else {
      try {
        decodeRle(object.map.cells.runs, object.map.grid.width * object.map.grid.height);
      } catch (error) {
        issues.push({
          level: "error",
          path: `${path}/map/cells`,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      if (object.map.image.id.trim().length === 0) {
        issues.push({ level: "warning", path: `${path}/map/image`, message: "地图贴图未指定" });
      }
    }

    // 地图的贴图在 map.image 里：再挂一份 object.image 就是同一件事写了两遍（显示到底听谁的？）
    if (object.image !== undefined) {
      issues.push({
        level: "warning",
        path: `${path}/image`,
        message: "地图对象的贴图写在 map.image 里，多余的 image 字段会被忽略",
      });
    }
  } else if (object.map !== undefined) {
    issues.push({
      level: "warning",
      path: `${path}/map`,
      message: `非地图对象（kind=${object.kind}）不应携带地图数据`,
    });
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
        const target = action.condition.target;
        const ok =
          (action.condition.valueType === "Bool" && typeof target === "boolean") ||
          (action.condition.valueType === "String" && typeof target === "string") ||
          ((action.condition.valueType === "Number" || action.condition.valueType === "Integer") &&
            typeof target === "number");

        if (!ok) {
          issues.push({
            level: "error",
            path: `${componentPath}/actions/${action.id}/condition`,
            message: `${action.condition.valueType} 条件的比较目标类型不符`,
          });
        }
      }
    }
  }
}

/** 校验单个场景。 */
export function validateScene(scene: SceneDoc): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const base = `scenes/${scene.name}`;

  if (scene.name.trim().length === 0) {
    issues.push({ level: "error", path: base, message: "场景名不能为空" });
  }

  // 对象（地图也只是其中之一）
  const objectIds = new Set<string>();
  for (const object of scene.objects) {
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

  // 动作 id 全场景唯一（运行态靠 actionId 寻址，重名会触发到错误动作）
  for (const [actionId, owners] of collectActionIds(scene)) {
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

/**
 * 校验工程文件里的项目级数据。
 *
 * 场景已各自成文件、由 `validateScene` 逐个校验，所以这里不再遍历场景；
 * 场景名唯一性也由文件系统保证（同名即同文件）。
 */
export function validateProject(doc: ProjectDoc): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

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
