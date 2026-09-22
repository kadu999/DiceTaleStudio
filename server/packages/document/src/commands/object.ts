// 本文件从 `commands.ts` 拆出（纯搬运，行为不变）：对象级命令。
import type { Draft } from "immer";
import { FEATURE_COMPONENT, displayImageField } from "../features";
// 特性的读写一律走访问器（「数据存在哪个组件里」只有 access.ts 知道）
import { mapDataOf, objectImage, writeFeature } from "../access";
import { DEFAULT_OBJECT_SCALE, clampObjectScale, collapseScale } from "../scale";
import { DEFAULT_SORTING_ORDER, createId, findObject } from "./shared";
import type {
  ImageRef,
  ObjectKind,
  SceneDoc,
  SceneObjectDoc,
  WorldPosition,
} from "../types";

/**
 * `sortingOrder` 的取值范围：足够表达「垫底 / 顶层」，又不至于让界面上的数字失控。
 *
 * 住在**本文件**（而不是 `shared.ts`）是有意的：只有 `setObjectSortingOrder` 用它，
 * 而 barrel 是 `export *`——放 shared 会让它凭空变成 `@dts/document` 的公开名字。
 */
const SORTING_ORDER_LIMIT = 9999;

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
  if (displayImageField(object.kind) === "map") {
    const map = mapDataOf(object);
    if (map === undefined) {
      return false;
    }

    // 地图的贴图住在它自己的地图数据里：整份写回（组件实例不变，只换 data）
    writeFeature(object, FEATURE_COMPONENT.map, { ...map, image: next });
  } else {
    writeFeature(object, FEATURE_COMPONENT.image, next);
  }

  return true;
}
