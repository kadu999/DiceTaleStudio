import type { Draft } from "immer";
import type { RleRun } from "@dts/grid";
import { defaultComponentData } from "./components";
import type {
  ActionInstanceDoc,
  ComponentDoc,
  MapDataDoc,
  NormPosition,
  ObjectKind,
  ProjectDoc,
  SceneDoc,
  SceneObjectDoc,
  SpawnPointDoc,
} from "./types";

/**
 * 文档修改命令（纯函数，作用于 immer draft）。
 *
 * 层级：项目 → 场景 → 对象 → 组件 → 动作。
 * **对象一律挂在场景上**（`scene.objects`），地图也只是其中 kind = "Map" 的一个对象。
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

export function findScene(doc: Draft<ProjectDoc>, sceneId: string): Draft<SceneDoc> | undefined {
  return doc.scenes.find((scene) => scene.id === sceneId);
}

export function findObject(scene: Draft<SceneDoc>, objectId: string): Draft<SceneObjectDoc> | undefined {
  return scene.objects.find((object) => object.id === objectId);
}

export function findComponent(
  scene: Draft<SceneDoc>,
  objectId: string,
  componentId: string,
): Draft<ComponentDoc> | undefined {
  return findObject(scene, objectId)?.components.find((component) => component.id === componentId);
}

/** 场景里的地图对象（可能没有，也可能有多个；取第一个用于渲染底图）。 */
export function findMapObject(scene: SceneDoc): SceneObjectDoc | undefined {
  return scene.objects.find((object) => object.kind === "Map");
}

/** 场景里所有地图对象。 */
export function listMapObjects(scene: SceneDoc): SceneObjectDoc[] {
  return scene.objects.filter((object) => object.kind === "Map");
}

/** 收集某场景内全部动作 id（校验唯一性用）。 */
export function collectActionIds(scene: SceneDoc): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const object of scene.objects) {
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

/** 新建普通对象（地图对象请用工厂的 `createMapObject`，它要带地图数据）。 */
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

export function addObject(scene: Draft<SceneDoc>, object: SceneObjectDoc): void {
  scene.objects.push(object as Draft<SceneObjectDoc>);
}

export function removeObject(scene: Draft<SceneDoc>, objectId: string): boolean {
  const index = scene.objects.findIndex((object) => object.id === objectId);
  if (index < 0) {
    return false;
  }

  scene.objects.splice(index, 1);
  return true;
}

export function renameObject(scene: Draft<SceneDoc>, objectId: string, name: string): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined || object.name === name) {
    return false;
  }

  object.name = name;
  return true;
}

export function setObjectPosition(
  scene: Draft<SceneDoc>,
  objectId: string,
  position: NormPosition | null,
): boolean {
  const object = findObject(scene, objectId);
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

export function setObjectKind(scene: Draft<SceneDoc>, objectId: string, kind: ObjectKind): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined || object.kind === kind) {
    return false;
  }

  object.kind = kind;
  return true;
}

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

// ---------------------------------------------------------------- 场景

/** 场景名是否已被占用（大小写不敏感；场景名将来会作为文件名，必须唯一）。 */
export function isSceneNameTaken(doc: ProjectDoc, name: string, exceptId?: string): boolean {
  const normalized = name.trim().toLowerCase();
  return doc.scenes.some(
    (scene) => scene.id !== exceptId && scene.name.trim().toLowerCase() === normalized,
  );
}

/** 场景名合法性：与跑团名同样的限制（会作为文件名与传送目标名）。 */
export function validateSceneName(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "场景名不能为空";
  }

  if (trimmed.length > 64) {
    return "场景名不能超过 64 个字符";
  }

  if (/[\\/:*?"<>|]/.test(trimmed)) {
    return '场景名不能包含 \\ / : * ? " < > | 等字符';
  }

  if (trimmed === "." || trimmed === "..") {
    return "场景名不合法";
  }

  return undefined;
}

/** 追加一个场景。 */
export function addScene(doc: Draft<ProjectDoc>, scene: SceneDoc): void {
  doc.scenes.push(scene as Draft<SceneDoc>);
}

/** 删除场景，返回是否删掉了。 */
export function removeScene(doc: Draft<ProjectDoc>, sceneId: string): boolean {
  const index = doc.scenes.findIndex((scene) => scene.id === sceneId);
  if (index < 0) {
    return false;
  }

  doc.scenes.splice(index, 1);
  return true;
}

/** 重命名场景。 */
export function renameScene(doc: Draft<ProjectDoc>, sceneId: string, name: string): boolean {
  const scene = doc.scenes.find((item) => item.id === sceneId);
  if (scene === undefined || scene.name === name) {
    return false;
  }

  scene.name = name;
  return true;
}

/** 按名字找场景（传送动作按场景名引用目标）。 */
export function findSceneByName(doc: ProjectDoc, name: string): SceneDoc | undefined {
  const normalized = name.trim().toLowerCase();
  return doc.scenes.find((scene) => scene.name.trim().toLowerCase() === normalized);
}

// ---------------------------------------------------------------- 出生点

export function addSpawnPoint(scene: Draft<SceneDoc>, spawnPoint: SpawnPointDoc): boolean {
  if (scene.spawnPoints.some((item) => item.id === spawnPoint.id)) {
    return false;
  }

  scene.spawnPoints.push(spawnPoint as Draft<SpawnPointDoc>);
  return true;
}

export function removeSpawnPoint(scene: Draft<SceneDoc>, spawnId: string): boolean {
  const index = scene.spawnPoints.findIndex((item) => item.id === spawnId);
  if (index < 0) {
    return false;
  }

  scene.spawnPoints.splice(index, 1);
  return true;
}

export function updateSpawnPoint(
  scene: Draft<SceneDoc>,
  spawnId: string,
  patch: Partial<Omit<SpawnPointDoc, "id">>,
): boolean {
  const spawn = scene.spawnPoints.find((item) => item.id === spawnId);
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

// ---------------------------------------------------------------- 地图对象数据

/** 用新的网格数据替换地图对象的 cells。 */
export function setMapCells(
  scene: Draft<SceneDoc>,
  mapObjectId: string,
  runs: readonly RleRun[],
): boolean {
  const map = findObject(scene, mapObjectId)?.map;
  if (map === undefined) {
    return false;
  }

  if (JSON.stringify(runs) === JSON.stringify(map.cells.runs)) {
    return false;
  }

  // RleRun 是 readonly 元组，draft 里需要可变元组，这里显式重建
  map.cells = {
    encoding: "rle",
    runs: runs.map((run) => [run[0], run[1]] as [number, number]),
  };
  return true;
}

/** 清空地图对象的全部格子。 */
export function clearMapCells(scene: Draft<SceneDoc>, mapObjectId: string): boolean {
  const map = findObject(scene, mapObjectId)?.map;
  if (map === undefined || map.cells.runs.length === 0) {
    return false;
  }

  map.cells = { encoding: "rle", runs: [] };
  return true;
}

/** 替换地图对象的地图数据（换贴图 / 改网格尺寸时用）。 */
export function setMapData(
  scene: Draft<SceneDoc>,
  mapObjectId: string,
  map: MapDataDoc,
): boolean {
  const object = findObject(scene, mapObjectId);
  if (object === undefined || object.kind !== "Map") {
    return false;
  }

  object.map = map as Draft<MapDataDoc>;
  return true;
}
