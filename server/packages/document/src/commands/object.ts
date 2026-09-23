// 本文件从 `commands.ts` 拆出（纯搬运，行为不变）：对象级命令。
import type { Draft } from "immer";
import { DEFAULT_SLOT_COMPONENT, componentForSlot, displayImageField } from "../presets";
// 特性的读写一律走访问器（「数据存在哪个组件里」只有 access.ts 知道）
import { mapDataOf, objectImage, writeFeature } from "../access";
import { DEFAULT_OBJECT_SCALE, clampObjectScale, collapseScale } from "../scale";
import { DEFAULT_SORTING_ORDER, createId, findObject } from "./shared";
import type { ObjectKind } from "../presets";
import type {
  ImageRef,
  ImageSpriteRef,
  SceneDoc,
  GameObjectDoc,
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
 *
 * 缺省 `kind` 是**精灵** `Sprite`：`GameObject` 是抽象基类（不落进文档），
 * 而「一个还没细看的场景对象」最接近的就是它——能挂一张图、能取图集里的一格。
 */
export function createGameObject(input: CreateObjectInput): GameObjectDoc {
  return {
    id: input.id ?? createId("obj"),
    name: input.name,
    kind: input.kind ?? "Sprite",
    active: true,
    sortingOrder: DEFAULT_SORTING_ORDER,
    position: input.position ?? null,
    rotation: 0,
    scale: DEFAULT_OBJECT_SCALE,
    locked: false,
    components: [],
  };
}

export function addObject(scene: Draft<SceneDoc>, object: GameObjectDoc): void {
  scene.objects.push(object as Draft<GameObjectDoc>);
}

/**
 * 给新对象取一个不重名的名字：`门`、`门 2`、`门 3`…
 *
 * 对象名**不要求唯一**（前端不靠名字寻址，靠 id），但列表里一堆同名行没法看，
 * 所以「连续创建」与「复制」都走这里自动去重。比较与场景名一致：trim + 大小写不敏感。
 */
export function nextObjectName(objects: readonly GameObjectDoc[], base: string): string {
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
 * 位置（矩形中心）不动——`GameObjectDoc.position` 的语义就是「缩放之后那块矩形的中心」。
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
export function objectsInDrawOrder(scene: SceneDoc): GameObjectDoc[] {
  return [...scene.objects].sort((a, b) => a.sortingOrder - b.sortingOrder);
}

/**
 * 给对象换贴图（地图写进 `map.image`，其它对象写进 `image`）。
 *
 * **只动贴图引用**：地图的网格尺寸不变（网格是**导入时**按贴图算好的，换图不该悄悄改动
 * 格子数——那会让已经画好的格子全部错位）；精灵没有别的尺寸可动，它在世界里的尺寸
 * 就是引用里声明的宽高。宽高由调用方从素材本身读出来，保证与真实像素一致。
 *
 * **换了一张图就丢掉旧的子图引用**（v20）：`sprite` 说的是「这张图集里的第几格」，
 * 换图之后那格子指的是另一张图上的位置——留着只会画出莫名其妙的一块，所以一并清掉，
 * 由调用方按需要再挑一格（同一个 id 再挑一次则原样留着）。调用方**显式给了** `image.sprite`
 * 时就用它（这一条命令于是也能一次把「图 + 格子」写进去，测试与批量脚本省一次调用）。
 *
 * **稳定身份（v23 的 `guid`）走同一个口径**：调用方给了就用它（刚挑的图带着 `.meta` 的 guid），
 * 只给 `id` 时（同一个 id 再挑一次、或还没接 guid 的调用方）沿用原引用上的 guid——
 * 「同一个 id 再挑一次」不该把身份弄丢（那正是改名之后还能找回来的东西），换图才丢掉。
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
  // 给什么用什么；没给（调用方只关心换图）就沿用同一个 id 上原有的那一格，换图则丢掉
  const sprite = image.sprite ?? (current?.id === image.id ? current.sprite : undefined);
  const guid = image.guid ?? (current?.id === image.id ? current.guid : undefined);
  if (
    current !== undefined &&
    current.id === image.id &&
    current.guid === guid &&
    current.width === image.width &&
    current.height === image.height &&
    sameSpriteRef(current.sprite, sprite)
  ) {
    return false;
  }

  const next = withSpriteRef(
    {
      id: image.id,
      ...(guid === undefined ? {} : { guid }),
      width: image.width,
      height: image.height,
    },
    sprite,
  );
  if (displayImageField(object.kind) === "map") {
    const map = mapDataOf(object);
    if (map === undefined) {
      return false;
    }

    // 地图的贴图住在它自己的地图数据里：整份写回（组件实例不变，只换 data）
    writeFeature(object, DEFAULT_SLOT_COMPONENT.map, { ...map, image: next });
  } else {
    // 精灵写进 `SpriteLayer`、贴图写进 `ImageLayer`（按 kind 取组件名，见 `componentForSlot`）
    writeFeature(object, componentForSlot("image", object.kind), next);
  }

  return true;
}

/**
 * 选这张图（图集）里的**第几格**；传 `null` = 改回整图（v20）。
 *
 * **只动那一格**：切分（几行几列）住在工程文件里，这里一个字节都不碰——所以「改切分，
 * 所有引用它的对象一起变」这条口径成立。越界的格子不在这里报错（切分可能先被改小），
 * 渲染与推送统一夹到最后一格。
 *
 * 三条拒掉的输入（都返回 `false`，不进撤销栈）：
 * - 对象不存在；
 * - 这个对象**没有图片**（还没挑图时先挑图，格子没有意义）；
 * - 这个对象是**地图**类（地图的贴图不支持子图，见 `sprites.ts`）。
 */
export function setObjectSprite(
  scene: Draft<SceneDoc>,
  objectId: string,
  sprite: ImageSpriteRef | null,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined || displayImageField(object.kind) === "map") {
    return false;
  }

  const current = objectImage(object);
  if (current === undefined) {
    return false;
  }

  const next = sprite === null ? undefined : normalizeSpriteRef(sprite);
  if (sameSpriteRef(current.sprite, next)) {
    return false;
  }

  writeFeature(object, componentForSlot("image", object.kind), withSpriteRef(current, next));
  return true;
}

/** 收干净一份格子引用：取整 + 非负（越界要不要夹由渲染那条链路统一做，这里只保证是整数）。 */
function normalizeSpriteRef(sprite: ImageSpriteRef): ImageSpriteRef {
  return {
    column: Number.isFinite(sprite.column) ? Math.max(0, Math.round(sprite.column)) : 0,
    row: Number.isFinite(sprite.row) ? Math.max(0, Math.round(sprite.row)) : 0,
  };
}

/**
 * 带 / 不带格子引用的一份新图片引用（删字段，不留 `sprite: undefined` / `guid: undefined`
 * 去污染 JSON）。身份 `guid` 原样带过去——它本来就是「这份引用指向哪个素材」的一部分。
 */
function withSpriteRef(image: ImageRef, sprite: ImageSpriteRef | undefined): ImageRef {
  const base = {
    id: image.id,
    ...(image.guid === undefined ? {} : { guid: image.guid }),
    width: image.width,
    height: image.height,
  };

  return sprite === undefined ? base : { ...base, sprite };
}

/** 两份格子引用是不是同一格（都不在也算同一格）。 */
function sameSpriteRef(
  left: ImageSpriteRef | undefined,
  right: ImageSpriteRef | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return left.column === right.column && left.row === right.row;
}
