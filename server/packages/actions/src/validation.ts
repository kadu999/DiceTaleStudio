import type { ComponentDoc, ProjectDoc, SceneDoc, ValidationIssue } from "@dts/document";
import { conditionValueTypesFor } from "@dts/document";
import { findActionType } from "./registry";

/**
 * 动作图校验（依赖动作注册表，因此放在 `@dts/actions`；结构性问题在 `@dts/document`）。
 *
 * 这些错误会阻止编辑器进入运行态：动作 id 无法寻址、目标场景/标记点/对象不存在，
 * 都会让「触发动作」在运行态静默失败——必须在编辑态就拦住。
 *
 * 注意：动作挂在**对象**上，对象挂在**场景**上；`Teleport` 的 `targetMapName`
 * 指的就是目标**场景名**（字段名沿用前端 wire 协议，不改）。
 */

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function validateComponentActions(
  project: ProjectDoc,
  scene: SceneDoc,
  objectId: string,
  component: ComponentDoc,
  issues: ValidationIssue[],
): void {
  const base = `scenes/${scene.name}/objects/${objectId}/components/${component.id}/actions`;
  const componentActionIds = new Set<string>();

  for (const action of component.actions) {
    const path = `${base}/${action.id || "(空 id)"}`;

    // 组件内动作 id 唯一（全场景唯一性由 document 校验）
    if (componentActionIds.has(action.id)) {
      issues.push({ level: "error", path, message: `同一组件内动作 id 重复: ${action.id}` });
    }

    componentActionIds.add(action.id);

    const def = findActionType(action.type);
    if (def === undefined) {
      issues.push({
        level: "error",
        path,
        message: `未知动作类型: ${action.type}（前端将无法执行）`,
      });
      continue;
    }

    if (!def.implemented) {
      issues.push({
        level: "warning",
        path,
        message: `动作类型 ${action.type} 在前端尚未实现（空壳），导出后不会产生效果`,
      });
    }

    // 必填字段
    for (const field of def.fields) {
      if (field.required === true && isBlank(action.params[field.key])) {
        issues.push({ level: "error", path, message: `缺少必填参数「${field.label}」` });
      }
    }

    // 条件形态必须是该组件支持的类型（对齐前端 Satisfies 覆写）
    if (action.condition !== undefined) {
      const supported = conditionValueTypesFor(component.type);
      if (!supported.includes(action.condition.valueType)) {
        issues.push({
          level: "error",
          path: `${path}/condition`,
          message: `组件 ${component.type} 不支持 ${action.condition.valueType} 条件（支持：${
            supported.length > 0 ? supported.join("/") : "无"
          }）`,
        });
      }
    }

    // 目标场景 / 标记点引用
    if (action.type === "Teleport" || action.type === "TeleportZone") {
      const targetSceneName = action.params.targetMapName;
      if (typeof targetSceneName === "string" && targetSceneName.trim().length > 0) {
        const targetScene = project.scenes.find((item) => item.name === targetSceneName);
        if (targetScene === undefined) {
          issues.push({
            level: "error",
            path: `${path}/params/targetMapName`,
            message: `目标场景不存在: ${targetSceneName}`,
          });
        } else {
          const markerId = action.params.targetMarkerId;
          if (typeof markerId === "string" && markerId.trim().length > 0) {
            if (!targetScene.spawnPoints.some((spawn) => spawn.id === markerId)) {
              issues.push({
                level: "error",
                path: `${path}/params/targetMarkerId`,
                message: `目标场景 ${targetSceneName} 上不存在标记点: ${markerId}`,
              });
            }
          }
        }
      }
    }

    // 对象引用（同场景内）
    if (action.type === "ShowHide" || action.type === "PlayVideo") {
      const targetObjectId = action.params.targetObjectId;
      if (
        typeof targetObjectId === "string" &&
        targetObjectId.trim().length > 0 &&
        !scene.objects.some((object) => object.id === targetObjectId)
      ) {
        issues.push({
          level: "error",
          path: `${path}/params/targetObjectId`,
          message: `目标对象不存在于当前场景: ${targetObjectId}`,
        });
      }
    }
  }
}

/** 校验整个项目的动作图。 */
export function validateActionGraph(project: ProjectDoc): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const scene of project.scenes) {
    for (const object of scene.objects) {
      for (const component of object.components) {
        validateComponentActions(project, scene, object.id, component, issues);
      }
    }
  }

  return issues;
}
