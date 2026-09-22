// 本文件从 `commands.ts` 拆出（纯搬运，行为不变）：组件与动作级命令。
import type { Draft } from "immer";
import { defaultComponentData } from "../components";
import { createId, findComponent, findObject } from "./shared";
import type { ActionInstanceDoc, ComponentDoc, SceneDoc } from "../types";

// ---------------------------------------------------------------- 组件

export function addComponent(
  scene: Draft<SceneDoc>,
  objectId: string,
  type: string,
  options: { id?: string; displayName?: string; data?: Record<string, unknown> } = {},
): string | undefined {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return undefined;
  }

  const component: ComponentDoc = {
    id: options.id ?? createId("cmp"),
    type,
    data: options.data ?? defaultComponentData(type),
    actions: [],
    ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
  };

  object.components.push(component as Draft<ComponentDoc>);
  return component.id;
}

export function removeComponent(
  scene: Draft<SceneDoc>,
  objectId: string,
  componentId: string,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const index = object.components.findIndex((component) => component.id === componentId);
  if (index < 0) {
    return false;
  }

  object.components.splice(index, 1);
  return true;
}

/** 浅合并组件数据（只覆盖 patch 里出现的键）。 */
export function updateComponentData(
  scene: Draft<SceneDoc>,
  objectId: string,
  componentId: string,
  patch: Record<string, unknown>,
): boolean {
  const component = findComponent(scene, objectId, componentId);
  if (component === undefined) {
    return false;
  }

  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (component.data[key] !== value) {
      component.data[key] = value;
      changed = true;
    }
  }

  return changed;
}

export function setComponentDisplayName(
  scene: Draft<SceneDoc>,
  objectId: string,
  componentId: string,
  displayName: string,
): boolean {
  const component = findComponent(scene, objectId, componentId);
  if (component === undefined || component.displayName === displayName) {
    return false;
  }

  component.displayName = displayName;
  return true;
}

// ---------------------------------------------------------------- 动作

export function addAction(
  scene: Draft<SceneDoc>,
  objectId: string,
  componentId: string,
  action: ActionInstanceDoc,
): boolean {
  const component = findComponent(scene, objectId, componentId);
  if (component === undefined) {
    return false;
  }

  component.actions.push(action as Draft<ActionInstanceDoc>);
  return true;
}

export function removeAction(
  scene: Draft<SceneDoc>,
  objectId: string,
  componentId: string,
  actionId: string,
): boolean {
  const component = findComponent(scene, objectId, componentId);
  if (component === undefined) {
    return false;
  }

  const index = component.actions.findIndex((action) => action.id === actionId);
  if (index < 0) {
    return false;
  }

  component.actions.splice(index, 1);
  return true;
}

export function updateAction(
  scene: Draft<SceneDoc>,
  objectId: string,
  componentId: string,
  actionId: string,
  patch: Partial<Omit<ActionInstanceDoc, "id">>,
): boolean {
  const component = findComponent(scene, objectId, componentId);
  const action = component?.actions.find((item) => item.id === actionId);
  if (action === undefined) {
    return false;
  }

  let changed = false;
  if (patch.type !== undefined && patch.type !== action.type) {
    action.type = patch.type;
    changed = true;
  }

  if (patch.enabled !== undefined && patch.enabled !== action.enabled) {
    action.enabled = patch.enabled;
    changed = true;
  }

  if (patch.params !== undefined) {
    for (const [key, value] of Object.entries(patch.params)) {
      if (action.params[key] !== value) {
        action.params[key] = value;
        changed = true;
      }
    }
  }

  if ("condition" in patch) {
    const next = patch.condition;
    if (next === undefined) {
      if (action.condition !== undefined) {
        delete action.condition;
        changed = true;
      }
    } else if (JSON.stringify(next) !== JSON.stringify(action.condition)) {
      action.condition = next;
      changed = true;
    }
  }

  return changed;
}

/** 动作在组件内的上移/下移（顺序即执行顺序）。 */
export function moveAction(
  scene: Draft<SceneDoc>,
  objectId: string,
  componentId: string,
  actionId: string,
  delta: number,
): boolean {
  const component = findComponent(scene, objectId, componentId);
  if (component === undefined) {
    return false;
  }

  const index = component.actions.findIndex((action) => action.id === actionId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= component.actions.length) {
    return false;
  }

  const [moved] = component.actions.splice(index, 1);
  if (moved === undefined) {
    return false;
  }

  component.actions.splice(target, 0, moved);
  return true;
}
