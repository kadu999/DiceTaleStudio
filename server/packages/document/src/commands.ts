import type { Draft } from "immer";
import {
  CellMask,
  applyBrushStroke,
  decodeRle,
  encodeRle,
  isInsideGrid,
  type GridPoint,
  type RleRun,
} from "@dts/grid";
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

/**
 * 新建对象的默认显示顺序。
 *
 * 普通对象（精灵 / 玩家 / 道具 / 事件）是 `0`；地图当底图，默认排在下面（`-10`）。
 * 谁盖住谁是**画布上的事**，这两个默认值只是让「新场景一建出来就是对的」。
 */
export const DEFAULT_SORTING_ORDER = 0;
export const MAP_DEFAULT_SORTING_ORDER = -10;

/** `sortingOrder` 的取值范围：足够表达「垫底 / 顶层」，又不至于让界面上的数字失控。 */
const SORTING_ORDER_LIMIT = 9999;

/**
 * 缩放的取值范围与默认值。
 *
 * `1` = 原始尺寸（新建对象就是这个值）。上下限是给**输入框**兜底的：0 会让对象
 * 变成不可见 / 不可点的零面积矩形，极大值则会把贴图与网格算成天文数字；
 * 夹在 `0.01 ~ 100`（1% ~ 100 倍）足够表达实际需求，也不至于把画布算坏。
 */
export const DEFAULT_OBJECT_SCALE = 1;
export const MIN_OBJECT_SCALE = 0.01;
export const MAX_OBJECT_SCALE = 100;

/** 把一个缩放值夹到合法范围；非法数字（NaN / Infinity）返回 `undefined`。 */
function clampScale(scale: number): number | undefined {
  if (!Number.isFinite(scale)) {
    return undefined;
  }

  return Math.min(MAX_OBJECT_SCALE, Math.max(MIN_OBJECT_SCALE, scale));
}

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
 * 对象的**统一缩放**（`1` = 原始尺寸）。
 *
 * 与显示顺序一样「夹而不拒」：输入框里敲出 0 / 负数 / 超大值都夹到 `0.01 ~ 100`，
 * 但落进文档的必须是有限正数——`NaN`（留空或敲了字母）直接拒绝，不写进文档。
 * 缩放改的是「对象占多大」，位置（矩形中心）不动。
 */
export function setObjectScale(
  scene: Draft<SceneDoc>,
  objectId: string,
  scale: number,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const next = clampScale(scale);
  if (next === undefined || object.scale === next) {
    return false;
  }

  object.scale = next;
  return true;
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

export interface PaintCellsOptions {
  /** 要叠加的类型位；`0` 表示橡皮擦（整格清零，对齐 Unity 的「橡皮擦 (0)」）。 */
  readonly mask: number;
  readonly brushSize: number;
}

/**
 * 标注一笔：把 `from → to`（含两端）经过的格子按画笔刷一遍。
 *
 * 与 Unity `GridMapEditorState.ApplyBrush` 同一套语义：类型位**按位叠加**，
 * 橡皮（`mask === 0`）**整格清零**；越界的格子由画笔自己裁掉。
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

  const next = applyBrushStroke(cells, map.grid, from, to, {
    mask: options.mask,
    brushSize: options.brushSize,
    erase: options.mask === CellMask.Empty,
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
