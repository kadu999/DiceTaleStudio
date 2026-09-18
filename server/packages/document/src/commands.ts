import type { Draft } from "immer";
import type { RleRun } from "@dts/grid";
import { defaultComponentData } from "./components";
import type {
  ActionInstanceDoc,
  ComponentDoc,
  ImageRef,
  MapDataDoc,
  WorldPosition,
  ObjectKind,
  SceneDoc,
  SceneObjectDoc,
} from "./types";

/**
 * 文档修改命令（纯函数，作用于 immer draft）。
 *
 * 层级：场景 → 对象 → 组件 → 动作。
 * **对象一律挂在场景上**（`scene.objects`），地图也只是其中 kind = "Map" 的一个对象；
 * 场景本身不再是工程文件里的一项，增删改名是调用方的文件操作，这里只管「按名字找」。
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
  readonly position?: WorldPosition | null;
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

/**
 * 给新对象取一个不重名的名字：`门`、`门 2`、`门 3`…
 *
 * 对象名**不要求唯一**（前端不靠名字寻址，靠 id），但列表里一堆同名行没法看，
 * 所以「连续创建」与「复制」都走这里自动去重。比较与场景名一致：trim + 大小写不敏感。
 */
export function nextObjectName(objects: readonly SceneObjectDoc[], base: string): string {
  const taken = new Set(objects.map((object) => object.name.trim().toLowerCase()));
  const trimmed = base.trim();
  if (!taken.has(trimmed.toLowerCase())) {
    return trimmed;
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${trimmed} ${index}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
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
  position: WorldPosition | null,
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

/**
 * 按名字找场景（传送动作按场景名引用目标）。
 *
 * 场景名就是文件名，所以查找要 trim + 大小写不敏感：磁盘上跨平台大小写规则不一致，
 * 用严格比较会让「Map001」和「map001」变成两个都打不开的引用。
 */
export function findScene(scenes: readonly SceneDoc[], name: string): SceneDoc | undefined {
  const normalized = name.trim().toLowerCase();
  return scenes.find((scene) => scene.name.trim().toLowerCase() === normalized);
}

/** 场景名是否已被占用（trim + 大小写不敏感；`exceptName` 用于改名时排除自身）。 */
export function isSceneNameTaken(
  scenes: readonly SceneDoc[],
  name: string,
  exceptName?: string,
): boolean {
  const found = findScene(scenes, name);
  if (found === undefined) {
    return false;
  }

  // 改名时允许「占用者就是自己」
  return exceptName === undefined || found.name.trim().toLowerCase() !== exceptName.trim().toLowerCase();
}

/** 场景名合法性：与项目名同样的限制；**场景名会直接成为文件名**，非法字符必须挡在这里。 */
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

/**
 * 换地图对象的贴图。
 *
 * 只动 `image`：网格尺寸不变（网格是**导入时**按贴图算好的，换图不该悄悄改动格子数——
 * 那会让已经画好的格子全部错位）。宽高由调用方从素材本身读出来，保证与真实像素一致。
 */
export function setMapImage(
  scene: Draft<SceneDoc>,
  mapObjectId: string,
  image: ImageRef,
): boolean {
  const map = findObject(scene, mapObjectId)?.map;
  if (map === undefined) {
    return false;
  }

  if (
    map.image.id === image.id &&
    map.image.width === image.width &&
    map.image.height === image.height
  ) {
    return false;
  }

  map.image = { id: image.id, width: image.width, height: image.height };
  return true;
}
