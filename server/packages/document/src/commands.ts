import type { Draft } from "immer";
import type { RleRun } from "@dts/grid";
import { defaultComponentData } from "./components";
import type {
  ActionInstanceDoc,
  ComponentDoc,
  MapDoc,
  NormPosition,
  ObjectKind,
  ProjectDoc,
  SceneObjectDoc,
  SpawnPointDoc,
} from "./types";

/**
 * 文档修改命令（纯函数，作用于 immer draft）。
 *
 * 所有编辑都经这里 → 由 `DocumentHistory.apply` 记录补丁 → 自动获得撤销/重做。
 * 命令返回 `false` 表示未产生变更（历史不会入栈）。
 */

let idCounter = 0;

/** 生成稳定前缀 + 递增 + 随机后缀的 id（避免同毫秒内碰撞）。 */
export function createId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function findMap(doc: Draft<ProjectDoc>, mapId: string): Draft<MapDoc> | undefined {
  return doc.maps.find((map) => map.id === mapId);
}

export function findObject(
  map: Draft<MapDoc>,
  objectId: string,
): Draft<SceneObjectDoc> | undefined {
  return map.objects.find((object) => object.id === objectId);
}

export function findComponent(
  map: Draft<MapDoc>,
  objectId: string,
  componentId: string,
): Draft<ComponentDoc> | undefined {
  return findObject(map, objectId)?.components.find((component) => component.id === componentId);
}

/** 收集某地图内全部动作 id（校验唯一性用）。 */
export function collectActionIds(map: MapDoc): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const object of map.objects) {
    for (const component of object.components) {
      for (const action of component.actions) {
        const owners = byId.get(action.id) ?? [];
        owners.push(`${object.id}/${component.id}`);
        byId.set(action.id, owners);
      }
    }
  }

  return byId;
}

// ---------------------------------------------------------------- 对象

export interface CreateObjectInput {
  readonly name: string;
  readonly kind?: ObjectKind;
  readonly position?: NormPosition | null;
  readonly id?: string;
}

export function createSceneObject(input: CreateObjectInput): SceneObjectDoc {
  return {
    id: input.id ?? createId("obj"),
    name: input.name,
    kind: input.kind ?? "SceneObject",
    position: input.position ?? null,
    rotation: 0,
    components: [],
  };
}

export function addObject(map: Draft<MapDoc>, object: SceneObjectDoc): void {
  map.objects.push(object);
}

export function removeObject(map: Draft<MapDoc>, objectId: string): boolean {
  const index = map.objects.findIndex((object) => object.id === objectId);
  if (index < 0) {
    return false;
  }

  map.objects.splice(index, 1);
  return true;
}

export function renameObject(map: Draft<MapDoc>, objectId: string, name: string): boolean {
  const object = findObject(map, objectId);
  if (object === undefined || object.name === name) {
    return false;
  }

  object.name = name;
  return true;
}

export function setObjectPosition(
  map: Draft<MapDoc>,
  objectId: string,
  position: NormPosition | null,
): boolean {
  const object = findObject(map, objectId);
  if (object === undefined) {
    return false;
  }

  if (
    object.position === position ||
    (object.position !== null &&
      position !== null &&
      object.position.x === position.x &&
      object.position.y === position.y)
  ) {
    return false;
  }

  object.position = position;
  return true;
}

export function setObjectKind(map: Draft<MapDoc>, objectId: string, kind: ObjectKind): boolean {
  const object = findObject(map, objectId);
  if (object === undefined || object.kind === kind) {
    return false;
  }

  object.kind = kind;
  return true;
}

// ---------------------------------------------------------------- 组件

export function addComponent(
  map: Draft<MapDoc>,
  objectId: string,
  type: string,
  options: { id?: string; displayName?: string; data?: Record<string, unknown> } = {},
): string | undefined {
  const object = findObject(map, objectId);
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

  object.components.push(component);
  return component.id;
}

export function removeComponent(
  map: Draft<MapDoc>,
  objectId: string,
  componentId: string,
): boolean {
  const object = findObject(map, objectId);
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
  map: Draft<MapDoc>,
  objectId: string,
  componentId: string,
  patch: Record<string, unknown>,
): boolean {
  const component = findComponent(map, objectId, componentId);
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
  map: Draft<MapDoc>,
  objectId: string,
  componentId: string,
  displayName: string,
): boolean {
  const component = findComponent(map, objectId, componentId);
  if (component === undefined || component.displayName === displayName) {
    return false;
  }

  component.displayName = displayName;
  return true;
}

// ---------------------------------------------------------------- 动作

export function addAction(
  map: Draft<MapDoc>,
  objectId: string,
  componentId: string,
  action: ActionInstanceDoc,
): boolean {
  const component = findComponent(map, objectId, componentId);
  if (component === undefined) {
    return false;
  }

  component.actions.push(action);
  return true;
}

export function removeAction(
  map: Draft<MapDoc>,
  objectId: string,
  componentId: string,
  actionId: string,
): boolean {
  const component = findComponent(map, objectId, componentId);
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
  map: Draft<MapDoc>,
  objectId: string,
  componentId: string,
  actionId: string,
  patch: Partial<Omit<ActionInstanceDoc, "id">>,
): boolean {
  const component = findComponent(map, objectId, componentId);
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
  map: Draft<MapDoc>,
  objectId: string,
  componentId: string,
  actionId: string,
  delta: number,
): boolean {
  const component = findComponent(map, objectId, componentId);
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

// ---------------------------------------------------------------- 出生点与网格

export function addSpawnPoint(map: Draft<MapDoc>, spawnPoint: SpawnPointDoc): boolean {
  if (map.spawnPoints.some((item) => item.id === spawnPoint.id)) {
    return false;
  }

  map.spawnPoints.push(spawnPoint);
  return true;
}

export function removeSpawnPoint(map: Draft<MapDoc>, spawnId: string): boolean {
  const index = map.spawnPoints.findIndex((item) => item.id === spawnId);
  if (index < 0) {
    return false;
  }

  map.spawnPoints.splice(index, 1);
  return true;
}

export function updateSpawnPoint(
  map: Draft<MapDoc>,
  spawnId: string,
  patch: Partial<Omit<SpawnPointDoc, "id">>,
): boolean {
  const spawn = map.spawnPoints.find((item) => item.id === spawnId);
  if (spawn === undefined) {
    return false;
  }

  let changed = false;
  if (patch.name !== undefined && patch.name !== spawn.name) {
    spawn.name = patch.name;
    changed = true;
  }

  if (
    patch.position !== undefined &&
    (patch.position.x !== spawn.position.x || patch.position.y !== spawn.position.y)
  ) {
    spawn.position = patch.position;
    changed = true;
  }

  return changed;
}

/** 用新的游程替换格子数据。 */
export function setCellRuns(map: Draft<MapDoc>, runs: readonly RleRun[]): boolean {
  if (JSON.stringify(runs) === JSON.stringify(map.cells.runs)) {
    return false;
  }

  // RleRun 是 readonly 元组，draft 里需要可变元组，这里显式重建
  map.cells.runs = runs.map((run) => [run[0], run[1]] as [number, number]);
  return true;
}

/** 清空全部格子。 */
export function clearCells(map: Draft<MapDoc>): boolean {
  if (map.cells.runs.length === 0) {
    return false;
  }

  map.cells.runs = [];
  return true;
}
