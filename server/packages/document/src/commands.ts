import type { Draft } from "immer";
import {
  CellMask,
  applyBrushStroke,
  decodeRle,
  encodeRle,
  isInsideGrid,
  normalizeRegions,
  regionsToMask,
  removeMask,
  type GridPoint,
  type RleRun,
} from "@dts/grid";
import { defaultComponentData } from "./components";
import { DEFAULT_OBJECT_SCALE, clampObjectScale, collapseScale } from "./scale";
import type {
  ActionInstanceDoc,
  ComponentDoc,
  ImageRef,
  MapDataDoc,
  SoundDataDoc,
  SoundLayer,
  WorldPosition,
  ObjectKind,
  SceneDoc,
  SceneObjectDoc,
  TeleportDataDoc,
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

/**
 * 新建对象的默认显示顺序。
 *
 * 普通对象（精灵 / 玩家 / 道具 / 事件）是 `0`；地图当底图，默认排在下面（`-10`）。
 * 谁盖住谁是**画布上的事**，这两个默认值只是让「新场景一建出来就是对的」。
 */
export const DEFAULT_SORTING_ORDER = 0;
export const MAP_DEFAULT_SORTING_ORDER = -10;

/**
 * 声音对象的默认层级：**音效**（最常见的一档）。
 *
 * 层级是「声道分组」：同层同时只响一条，后来的顶掉先前的；想要两件事同时响就得
 * 分到两层。四档的取值与中文名见 `types.ts` 的 `SOUND_LAYERS` / `SOUND_LAYER_LABELS`。
 */
export const DEFAULT_SOUND_LAYER: SoundLayer = "sfx";

/** `sortingOrder` 的取值范围：足够表达「垫底 / 顶层」，又不至于让界面上的数字失控。 */
const SORTING_ORDER_LIMIT = 9999;

/**
 * 缩放的取值范围与默认值**住在 `scale.ts`**（那里还管着等比与单轴的换算关系），
 * 这里原样再导出一次：`DEFAULT_OBJECT_SCALE` 等一直是 `@dts/document` 的公开名字，
 * 老调用方不该因为一次内部搬家而改 import。
 */
export { DEFAULT_OBJECT_SCALE, MAX_OBJECT_SCALE, MIN_OBJECT_SCALE } from "./scale";

/**
 * 角度的归一化区间：`(-180, 180]`（**度**）。
 *
 * 文档里存的是**弧度**（`SceneObjectDoc.rotation`），面板上按**度**编辑——
 * Unity 的 Inspector 也是度数，策划对着两边看才不会算错。
 * 转 370° 和转 10° 是同一个姿态，归一化后数字才不会失控。
 */
export const MIN_OBJECT_ROTATION_DEGREES = -180;
export const MAX_OBJECT_ROTATION_DEGREES = 180;

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

/**
 * 新建普通对象（地图对象请用工厂的 `createMapObject`，它要带地图数据）。
 */
export function createSceneObject(input: CreateObjectInput): SceneObjectDoc {
  return {
    id: input.id ?? createId("obj"),
    name: input.name,
    kind: input.kind ?? "SceneObject",
    active: true,
    sortingOrder: DEFAULT_SORTING_ORDER,
    position: input.position ?? null,
    rotation: 0,
    scale: DEFAULT_OBJECT_SCALE,
    locked: false,
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

/**
 * 锁定 / 解锁对象。
 *
 * 锁上的对象**不能被移动**（画布上拖不动、世界坐标输入框也禁用），别的照常可改。
 * 命令层只负责改这个标记；「不能移动」的拦截在编辑器的 `moveObject` 里（唯一的移动入口）。
 */
export function setObjectLocked(
  scene: Draft<SceneDoc>,
  objectId: string,
  locked: boolean,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined || object.locked === locked) {
    return false;
  }

  object.locked = locked;
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

/** 是否显示该对象（对齐 Unity 的激活勾选框）：不激活就不画，但对象仍在场景里。 */
export function setObjectActive(
  scene: Draft<SceneDoc>,
  objectId: string,
  active: boolean,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined || object.active === active) {
    return false;
  }

  object.active = active;
  return true;
}

/**
 * 对象的显示顺序：**大的画在前面**。
 *
 * 取整并夹在 `±SORTING_ORDER_LIMIT` 内：顺序只是个层号，允许输入框里敲出小数 /
 * 极大值，但落到文档里必须是规规矩矩的整数，否则外部工具与画布对「谁在前」的理解会不一致。
 */
export function setObjectSortingOrder(
  scene: Draft<SceneDoc>,
  objectId: string,
  sortingOrder: number,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined || !Number.isFinite(sortingOrder)) {
    return false;
  }

  const next = Math.min(SORTING_ORDER_LIMIT, Math.max(-SORTING_ORDER_LIMIT, Math.round(sortingOrder)));
  if (object.sortingOrder === next) {
    return false;
  }

  object.sortingOrder = next;
  return true;
}

/**
 * 对象的**等比缩放**（`1` = 原始尺寸）。
 *
 * 与显示顺序一样「夹而不拒」：输入框里敲出 0 / 负数 / 超大值都夹到 `0.01 ~ 100`，
 * 但落进文档的必须是有限正数——`NaN`（留空或敲了字母）直接拒绝，不写进文档。
 * 缩放改的是「对象占多大」，位置（矩形中心）不动。
 *
 * 这是 `setObjectScaleAxes` 的等比特例：**单轴字段会被摘掉**（`collapseScale`），
 * 于是「把它改回等比」只需要调这一个命令，不用再单独去清 `scaleX` / `scaleY`。
 */
export function setObjectScale(
  scene: Draft<SceneDoc>,
  objectId: string,
  scale: number,
): boolean {
  return setObjectScaleAxes(scene, objectId, { x: scale, y: scale });
}

/**
 * 对象的**两轴缩放**（v11 起：X / Y 各自独立；相等时自动折叠回等比 `scale`）。
 *
 * 两个轴分别「夹而不拒」（`0.01 ~ 100`），但**任一轴**是非有限数就整体拒绝、不写文档——
 * 宁可这次拖拽白做，也不要把 `NaN` 半途写进去（那会让矩形算不出来）。
 *
 * 画布上的等比拖角、单轴拖边都走这里；`collapseScale` 保证写出来的形状是规范的
 * （两轴相等只留 `scale`），所以反复拖手柄不会把对象钉死在非等比形态上。
 *
 * 位置（矩形中心）不动——`SceneObjectDoc.position` 的语义就是「缩放之后那块矩形的中心」。
 */
export function setObjectScaleAxes(
  scene: Draft<SceneDoc>,
  objectId: string,
  axes: { readonly x: number; readonly y: number },
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const x = clampObjectScale(axes.x);
  const y = clampObjectScale(axes.y);
  if (x === undefined || y === undefined) {
    return false;
  }

  const next = collapseScale({ ...object, scale: object.scale, scaleX: x, scaleY: y });
  const unchanged =
    next.scale === object.scale && next.scaleX === object.scaleX && next.scaleY === object.scaleY;
  if (unchanged) {
    return false;
  }

  object.scale = next.scale;
  object.scaleX = next.scaleX;
  object.scaleY = next.scaleY;
  return true;
}

/**
 * 对象的**绕竖轴旋转**（文档里存**弧度**，与 Unity 的 `Transform.rotation.y` 同一套）。
 *
 * 与缩放一样「夹而不拒」：输入框敲出 NaN / Infinity 直接拒绝（不写文档），
 * 其余先归一化到 `(-180°, 180°]` 再转成弧度落盘——转 370° 与转 10° 是同一个姿态，
 * 存 370° 只会让数字失控。
 *
 * 符号约定：**文档里的正角度 = Unity 里正的 Y 轴旋转**，
 * 所以 Unity 侧直接用 `Quaternion.Euler(0, 角度, 0)`（不要再取反）。
 */
export function setObjectRotation(
  scene: Draft<SceneDoc>,
  objectId: string,
  rotationRadians: number,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined || !Number.isFinite(rotationRadians)) {
    return false;
  }

  const degrees = (rotationRadians * 180) / Math.PI;
  const normalized = normalizeDegrees(degrees);
  const next = (normalized * Math.PI) / 180;
  if (object.rotation === next) {
    return false;
  }

  object.rotation = next;
  return true;
}

/** 把度数归一化到 `(-180, 180]`；`180` 保留为 `180`（不变成 `-180`）。 */
export function normalizeDegrees(degrees: number): number {
  const wrapped = degrees % 360;
  if (wrapped > 180) {
    return wrapped - 360;
  }

  if (wrapped <= -180) {
    return wrapped + 360;
  }

  return wrapped;
}

/**
 * 按**显示顺序**排好序的对象（先画的在前，后画的盖在上面）。
 *
 * 画布与命中测试共用它：命中测试反过来从后往前找，于是「点到的」永远是**看得见的最上面那个**。
 * 只比较 `sortingOrder`，相同的保持场景文件里的先后（`Array.prototype.sort` 自 ES2019 起稳定）；
 * **不改动 `scene.objects` 本身**——文件里的顺序是数据，不是渲染排序的结果。
 */
export function objectsInDrawOrder(scene: SceneDoc): SceneObjectDoc[] {
  return [...scene.objects].sort((a, b) => a.sortingOrder - b.sortingOrder);
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

/**
 * 清空地图对象的全部格子。
 *
 * 写回的是**一个空游程**（`[[Empty, 列×行]]`）而不是空数组：格子数据必须铺满整张网格
 * （校验与 `setMapGrid` 都按「展开格数 = 列 × 行」读），留空数组会被判成数据不完整。
 * 这也与新建地图对象时的写法一致——比较与元组重建交给 `setMapCells`，只有一处实现。
 */
export function clearMapCells(scene: Draft<SceneDoc>, mapObjectId: string): boolean {
  const map = findObject(scene, mapObjectId)?.map;
  if (map === undefined) {
    return false;
  }

  return setMapCells(scene, mapObjectId, [[CellMask.Empty, map.grid.width * map.grid.height]]);
}

// ---------------------------------------------------------------- 战争雾（地图）

/**
 * 地图指定的雾区 → 掩码（`0` = 一个雾区都没指定）。
 *
 * 「这一格算不算雾」只有这一个判断入口：绘制预览、数雾格、擦除范围全走它，
 * 免得每处各写一遍「遍历 regions 再看有没有这一位」。
 */
export function mapFogMask(map: MapDataDoc): number {
  return regionsToMask(map.fog?.regions ?? []);
}

/**
 * 指定哪些区域算战争雾。
 *
 * 格子上的类型位是**中性区域**，所以「哪个区域是雾」是地图自己的配置，不是类型自带的语义。
 * 写入前先规范化（只留可绘制位、去重、升序），保证同一份选择永远写出同一个文件内容；
 * 规范化后为空就把 `fog` 字段整个删掉——文件里不留 `{ regions: [] }` 这种空壳
 * （读出来与「没有这个字段」同义）。
 *
 * **只改绑定，不动格子数据**：解除绑定不会连带清掉已经画好的雾格子，改回来还在。
 *
 * 返回 `false` 表示没有变更（不是地图对象、或绑定没变）。
 */
export function setMapFogRegions(
  scene: Draft<SceneDoc>,
  mapObjectId: string,
  regions: readonly number[],
): boolean {
  const map = findObject(scene, mapObjectId)?.map;
  if (map === undefined) {
    return false;
  }

  const next = normalizeRegions(regions);
  const current = normalizeRegions(map.fog?.regions ?? []);
  if (next.length === current.length && next.every((bit, index) => bit === current[index])) {
    return false;
  }

  if (next.length === 0) {
    delete map.fog;
    return true;
  }

  map.fog = { regions: next };
  return true;
}

/**
 * 清空战争雾：只清掉**已指定的雾区位**，其它区域位原样保留。
 *
 * 与 `clearMapCells` 的区别就是「只清绑定位」：一格若是「区域1 + 区域4」而只指定了区域4，
 * 清雾之后它仍是区域1 的格子。没指定任何雾区时什么都不做（返回 `false`）。
 */
export function clearMapFog(scene: Draft<SceneDoc>, mapObjectId: string): boolean {
  const map = findObject(scene, mapObjectId)?.map;
  if (map === undefined) {
    return false;
  }

  const fogMask = mapFogMask(map);
  if (fogMask === 0) {
    return false;
  }

  let cells: Uint8Array;
  try {
    cells = decodeRle(map.cells.runs, map.grid.width * map.grid.height);
  } catch {
    // 与 paintMapCells 同一条规矩：坏数据不拿来当基底，也不顺手「修」成正常网格
    return false;
  }

  const next = cells.slice();
  let changed = false;
  for (let index = 0; index < next.length; index += 1) {
    const existing = next[index] ?? CellMask.Empty;
    const cleared = removeMask(existing, fogMask);
    if (cleared !== existing) {
      next[index] = cleared;
      changed = true;
    }
  }

  return changed && setMapCells(scene, mapObjectId, encodeRle(next));
}

// ---------------------------------------------------------------- 声音对象（动作对象）

/**
 * 声音对象的「声音数据」；**缺字段就补一份默认的**。
 *
 * 手写文件里可能整个 `sound` 都没有（schema 里它是可选的）：那种对象语义上就是
 * 「还没挑音频、音效层」，所以在第一次编辑时把字段补出来，而不是让编辑静默失败
 * （`validateScene` 会先把「声音对象缺声音数据」报出来，这里只是兜底修复）。
 */
function soundDataOf(object: Draft<SceneObjectDoc>): Draft<SoundDataDoc> | undefined {
  if (object.kind !== "PlaySound") {
    return undefined;
  }

  if (object.sound === undefined) {
    object.sound = { clips: [], layer: DEFAULT_SOUND_LAYER };
  }

  return object.sound;
}

/**
 * 替换声音对象的音频列表（资源逻辑 ID）。
 *
 * 这是「**加进来 / 移出去**」那件事（界面上在「编辑声音」窗口里做）：只保证内容是去空、
 * 去重后的逻辑 ID，不排序——顺序是用户加进来的顺序，没有语义。
 *
 * 列表一变，**挂在具体文件上的东西跟着走**（见 `syncSoundSideData`）。
 */
export function setSoundClips(
  scene: Draft<SceneDoc>,
  objectId: string,
  clips: readonly string[],
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const sound = soundDataOf(object);
  if (sound === undefined) {
    return false;
  }

  const next: string[] = [];
  for (const clip of clips) {
    const trimmed = clip.trim();
    if (trimmed.length > 0 && !next.includes(trimmed)) {
      next.push(trimmed);
    }
  }

  if (next.length === sound.clips.length && next.every((id, index) => id === sound.clips[index])) {
    return false;
  }

  sound.clips = next;
  syncSoundSideData(sound);
  return true;
}

/**
 * 列表变更后收拾「按文件记」的副作用：移出去的名字不留（不然文件里攒下一堆看不见的孤儿
 * 名字），选中的那条还在列表里就行。
 *
 * 兜底「没选就默认选第一条」是**故意的**：加进来一条音频却没被选上时，面板上看着有东西、
 * 「播放」却是灰的，很容易以为是坏的。
 */
function syncSoundSideData(sound: Draft<SoundDataDoc>): void {
  if (sound.names !== undefined) {
    for (const clipId of Object.keys(sound.names)) {
      if (!sound.clips.includes(clipId)) {
        delete sound.names[clipId];
      }
    }

    if (Object.keys(sound.names).length === 0) {
      // 一条名字都不剩：字段整个删掉，不留空壳
      delete sound.names;
    }
  }

  const fallback = sound.clips[0];
  if (sound.picked === undefined) {
    if (fallback !== undefined) {
      sound.picked = fallback;
    }

    return;
  }

  if (!sound.clips.includes(sound.picked)) {
    // 移出去的正好是选中的那条：顺到剩下的第一条；一条不剩就不留这个字段
    if (fallback === undefined) {
      delete sound.picked;
    } else {
      sound.picked = fallback;
    }
  }
}

/**
 * 选中 / 取消选中「加进来的音频里播哪一条」（`null` = 取消选中）。
 *
 * 只能选 `clips` 里的（不在列表里 = 数据对不上，直接拒掉，不悄悄把它加进去）；
 * 值没变返回 false，于是连点同一条不会往撤销栈里塞空记录。
 */
export function setSoundPicked(
  scene: Draft<SceneDoc>,
  objectId: string,
  clipId: string | null,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const sound = soundDataOf(object);
  if (sound === undefined) {
    return false;
  }

  if (clipId === null) {
    if (sound.picked === undefined) {
      return false;
    }

    delete sound.picked;
    return true;
  }

  if (!sound.clips.includes(clipId) || sound.picked === clipId) {
    return false;
  }

  sound.picked = clipId;
  return true;
}

/** 改声音层级（同层同时只响一条的那「一层」）。 */
export function setSoundLayer(
  scene: Draft<SceneDoc>,
  objectId: string,
  layer: SoundLayer,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const sound = soundDataOf(object);
  if (sound === undefined || sound.layer === layer) {
    return false;
  }

  sound.layer = layer;
  return true;
}

/**
 * 给**某一个音频文件**起显示名（空 = 删掉这个名字，退回素材文件名）。
 *
 * 名字按文件记（`names[clipId]`），所以加进来的哪条都能起名、选不选中都一样；它只是编辑器里
 * 给人看的标签：不参与播放、不进协议。`sound` 字段缺失时先补出来（与其它声音命令同一个兜底）。
 */
export function setSoundClipName(
  scene: Draft<SceneDoc>,
  objectId: string,
  clipId: string,
  name: string,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const sound = soundDataOf(object);
  if (sound === undefined) {
    return false;
  }

  const trimmed = name.trim();
  if (!sound.clips.includes(clipId)) {
    // 名字挂在**加进来的音频**上：不在列表里就是数据对不上（列表变更时这类名字也会被清掉）
    return false;
  }

  const current = sound.names?.[clipId] ?? "";
  if (trimmed === current) {
    return false;
  }

  if (trimmed.length === 0) {
    // 留空 = 不要这个自定义名（文件里不留空字符串）
    if (sound.names !== undefined) {
      delete sound.names[clipId];
      if (Object.keys(sound.names).length === 0) {
        // 一条名字都没有了：字段整个删掉，不留空壳
        delete sound.names;
      }
    }
  } else {
    sound.names = { ...(sound.names ?? {}), [clipId]: trimmed };
  }

  return true;
}

export interface PaintCellsOptions {
  /** 要叠加的类型位；`0` 表示橡皮擦（整格清零，对齐 Unity 的「橡皮擦 (0)」）。 */
  readonly mask: number;
  readonly brushSize: number;
  /**
   * 橡皮**只清哪些位**；缺省（不传）= 整格清零（标注调色板的橡皮就是这一档）。
   *
   * 战争雾的橡皮必须传「已指定的雾区位」：一格可能同时是「区域1 + 区域4」，
   * 擦雾只该擦掉区域4，不能顺手把区域1 也抹了。
   *
   * 注意与 `erase` 的取值约定配套：只有 `mask === 0` 时才会走到它，
   * 且传 `undefined` 与传 `0` 含义不同（后者 = 一位都不清），所以别用 `?? 0` 兜底。
   */
  readonly eraseMask?: number;
}

/**
 * 标注一笔：把 `from → to`（含两端）经过的格子按画笔刷一遍。
 *
 * 与 Unity `GridMapEditorState.ApplyBrush` 同一套语义：类型位**按位叠加**，
 * 橡皮（`mask === 0`）**整格清零**（给了 `eraseMask` 时只清指定位）；越界的格子由画笔自己裁掉。
 * 两条约束是刻意的：
 * - **落笔点必须在网格内**才动手（Unity 的 `HandleInput` 也是先判在不在网格里）——
 *   否则「在地图外面点一下」会被量化到边缘格，凭空画上一笔；
 * - 整笔**只解码 / 编码一次 RLE**：一笔有几十个格心，逐点改写会把整张网格来回搬几十遍。
 *
 * 返回 `false` 表示没有产生变更（画笔没改到任何格、落笔点越界、数据坏了）。
 */
export function paintMapCells(
  scene: Draft<SceneDoc>,
  mapObjectId: string,
  from: GridPoint,
  to: GridPoint,
  options: PaintCellsOptions,
): boolean {
  const map = findObject(scene, mapObjectId)?.map;
  if (map === undefined || !isInsideGrid(to, map.grid)) {
    return false;
  }

  const count = map.grid.width * map.grid.height;
  let cells: Uint8Array;
  try {
    cells = decodeRle(map.cells.runs, count);
  } catch {
    // 格子数据本来就与网格尺寸对不上（坏数据）：不拿它当基底——照常理「修」一下，
    // 等于把损坏的数据悄悄换成一张看起来正常的网格
    return false;
  }

  const erase = options.mask === CellMask.Empty;
  const next = applyBrushStroke(cells, map.grid, from, to, {
    mask: options.mask,
    brushSize: options.brushSize,
    erase,
    // 只在擦除时带上「只清这些位」；`undefined` = 整格清零
    ...(erase && options.eraseMask !== undefined ? { eraseMask: options.eraseMask } : {}),
  });

  // 相同的掩码写回去时 setMapCells 会判为「无变更」并返回 false，所以重复涂抹不进撤销栈
  return setMapCells(scene, mapObjectId, encodeRle(next));
}

/**
 * 改地图网格的列数 / 行数。
 *
 * 格子数据是**按行主序铺满整张网格**的（校验要求展开格数 = 列 × 行），所以改尺寸必须把
 * 格子一起重建：左上对齐的重叠部分原样保留，多出来的格子是空（`CellMask.Empty`），
 * 被缩掉的格子丢弃。每格的像素尺寸不用记——它是 `贴图宽 ÷ 列数` 算出来的。
 */
export function setMapGrid(
  scene: Draft<SceneDoc>,
  mapObjectId: string,
  grid: { readonly width: number; readonly height: number },
): boolean {
  const map = findObject(scene, mapObjectId)?.map;
  if (map === undefined) {
    return false;
  }

  const width = Math.max(1, Math.round(grid.width));
  const height = Math.max(1, Math.round(grid.height));
  if (width === map.grid.width && height === map.grid.height) {
    return false;
  }

  let cells: Uint8Array;
  try {
    cells = decodeRle(map.cells.runs, map.grid.width * map.grid.height);
  } catch {
    // 格子数据本来就是坏的（展开格数对不上）：不拿它当基底，否则会把坏数据
    // 「修」成一张看起来正常的空网格，等于把错误悄悄抹掉
    return false;
  }

  const next = new Uint8Array(width * height);
  const keepColumns = Math.min(width, map.grid.width);
  const keepRows = Math.min(height, map.grid.height);
  for (let y = 0; y < keepRows; y += 1) {
    for (let x = 0; x < keepColumns; x += 1) {
      next[y * width + x] = cells[y * map.grid.width + x] ?? CellMask.Empty;
    }
  }

  map.grid = { width, height };
  map.cells = {
    encoding: "rle",
    runs: encodeRle(next).map((run) => [run[0], run[1]] as [number, number]),
  };
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
 * 对象要显示的图片：地图在 `map.image` 里，其它对象（精灵等）在 `image` 里。
 *
 * 两处形状一致（都是 `ImageRef`），所以显示、换图、改名同步都走这一个入口，
 * 不必到处判 `kind`。
 */
export function objectImage(object: SceneObjectDoc): ImageRef | undefined {
  return object.kind === "Map" ? object.map?.image : object.image;
}

/**
 * 给对象换贴图（地图写进 `map.image`，其它对象写进 `image`）。
 *
 * **只动贴图引用**：地图的网格尺寸不变（网格是**导入时**按贴图算好的，换图不该悄悄改动
 * 格子数——那会让已经画好的格子全部错位）；精灵没有别的尺寸可动，它在世界里的尺寸
 * 就是引用里声明的宽高。宽高由调用方从素材本身读出来，保证与真实像素一致。
 */
export function setObjectImage(
  scene: Draft<SceneDoc>,
  objectId: string,
  image: ImageRef,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const current = objectImage(object);
  if (
    current !== undefined &&
    current.id === image.id &&
    current.width === image.width &&
    current.height === image.height
  ) {
    return false;
  }

  const next = { id: image.id, width: image.width, height: image.height };
  if (object.kind === "Map") {
    if (object.map === undefined) {
      return false;
    }

    object.map.image = next;
  } else {
    object.image = next;
  }

  return true;
}

// ---------------------------------------------------------------- 传送阵（动作对象）

/**
 * 传送阵的「传送数据」；**缺字段就补一份默认的**。
 *
 * 手写文件里可能整个 `teleport` 都没有（schema 里它是可选的）：那种对象语义上就是
 * 「还没加任何目标」，所以在第一次编辑时把字段补出来，而不是让编辑静默失败
 * （`validateScene` 会先把「传送阵缺少传送数据」报出来，这里只是兜底修复）。
 */
function teleportDataOf(object: Draft<SceneObjectDoc>): Draft<TeleportDataDoc> | undefined {
  if (object.kind !== "Teleport") {
    return undefined;
  }

  if (object.teleport === undefined) {
    object.teleport = { targets: [] };
  }

  return object.teleport;
}

/**
 * 替换传送阵的**候选目标场景**（「传送目标」窗口里勾 / 取消勾就是这件事）。
 *
 * 只保证内容是**去空、去重**后的场景名，不排序——顺序是用户勾进来的顺序，没有别的语义
 * （与 `setSoundClips` 同一个口径）。
 *
 * 列表一变，**选中的那一个跟着走**（见 `syncTeleportSideData`）：移出去的正好是选中的，
 * 就顺到剩下的第一条；一条不剩就把 `picked` 整个删掉。
 */
export function setTeleportTargets(
  scene: Draft<SceneDoc>,
  objectId: string,
  targets: readonly string[],
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const teleport = teleportDataOf(object);
  if (teleport === undefined) {
    return false;
  }

  const next: string[] = [];
  for (const target of targets) {
    const trimmed = target.trim();
    if (trimmed.length > 0 && !next.includes(trimmed)) {
      next.push(trimmed);
    }
  }

  if (
    next.length === teleport.targets.length &&
    next.every((name, index) => name === teleport.targets[index])
  ) {
    return false;
  }

  teleport.targets = next;
  syncTeleportSideData(teleport);
  return true;
}

/**
 * 列表变更后收拾「选中的那一个」：还在列表里就别动；被移出去了就顺到第一条；
 * 一条不剩就把 `picked` 删掉（不留空壳）。
 *
 * 兜底「没选就默认选第一条」是**故意的**（与 `syncSoundSideData` 同一条理由）：
 * 勾进来一个场景却没被选上时，面板上看着有东西、「传送」却是灰的，很容易以为是坏的。
 */
function syncTeleportSideData(teleport: Draft<TeleportDataDoc>): void {
  const fallback = teleport.targets[0];
  if (teleport.picked === undefined) {
    if (fallback !== undefined) {
      teleport.picked = fallback;
    }

    return;
  }

  if (!teleport.targets.includes(teleport.picked)) {
    if (fallback === undefined) {
      delete teleport.picked;
    } else {
      teleport.picked = fallback;
    }
  }
}

/**
 * 选中 / 取消选中「候选里传送到哪一个」（`null` = 取消选中）。
 *
 * 只能选 `targets` 里的（不在列表里 = 数据对不上，直接拒掉，不悄悄把它加进去）；
 * 值没变返回 false，于是连点同一个小方块不会往撤销栈里塞空记录。
 */
export function setTeleportPicked(
  scene: Draft<SceneDoc>,
  objectId: string,
  target: string | null,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const teleport = teleportDataOf(object);
  if (teleport === undefined) {
    return false;
  }

  if (target === null) {
    if (teleport.picked === undefined) {
      return false;
    }

    delete teleport.picked;
    return true;
  }

  if (!teleport.targets.includes(target) || teleport.picked === target) {
    return false;
  }

  teleport.picked = target;
  return true;
}
