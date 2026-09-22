/**
 * 对象类型（`ObjectKind`）**与它们之间的层级**。
 *
 * 一个场景对象总是「某一种场景对象」：`SceneObject` 是**基类**（抽象、不落进文档），
 * `Sprite`（精灵）与 `Image`（贴图）是它的两个子类型——两者都靠基类那条
 * 「对象自己显示的图」显示一张图，差别只在**取不取图集里的一格**（组件名把这条差别写死：
 * 精灵 `SpriteLayer`、贴图 `ImageLayer`，见 `features.ts`）。
 *
 * 这张表是「谁是谁的子类型」的**唯一归属地**：特性携带（`carriesKind`）、组件路由
 * （`componentForKind`）、校验都走这里的 `kindIsA` / `kindLineage`，**别在调用处写
 * `kind === "Sprite"` 这种判断**——再加一个子类型（例如会动的精灵）时只改这张表。
 *
 * 其余类型（`Map` / `Player` / `Item` / `Event` / `PlaySound` / `Teleport`）目前都是根类型：
 * 它们与「场景对象」这条线没有共同行为，硬认一个共同基类只会多一层空壳。
 */

/**
 * 全部对象类型。**顺序就是规范顺序**（文档枚举、编辑器类型表都按它排）。
 *
 * 基类排在自己的子类型前面（`SceneObject` → `Sprite` / `Image`），其余保持既有顺序：
 * 前四个是前端 `BackendObjectKind` 就有的实体（`SceneObject` / `Player` / `Item` / `Event`），
 * 后面的是编辑器侧新增的（`Map` 是「带网格的图」、`Image` 是「只显示整张图的贴图」，
 * `PlaySound` / `Teleport` 是动作对象）。
 */
export const OBJECT_KINDS = [
  "SceneObject",
  "Sprite",
  "Image",
  "Map",
  "Player",
  "Item",
  "Event",
  "PlaySound",
  "Teleport",
] as const;

/**
 * 对象类型。
 *
 * - `SceneObject`：**场景对象的基类**（抽象，见 `OBJECT_KIND_DEFS` 的 `abstract`）——
 *   它**不会出现在文档里**：老文件里写这个值的对象（那时「精灵」就是它）由 v22 迁移
 *   改成 `Sprite`。留着它是为了让「凡是场景对象都有的东西」（现在只有一张显示图）
 *   只声明一次，`Sprite` / `Image` 继承下去；
 * - `Sprite`：**精灵**——显示的一张图可以取图集里的一格（子图）；
 * - `Image`：**贴图**（v21 起，v22 前叫 `Texture`）——只把一张图整张铺出来，不引用格子；
 * - `Map`：地图就是场景里的一个对象，携带贴图与网格数据；
 * - `Player` / `Item` / `Event`：玩家 / 道具 / 事件（前端 `BackendObjectKind` 就有的实体）；
 * - `PlaySound`：**动作对象**（「播放声音」）——基础属性与实体一样，另带「播什么 + 哪个层级」，
 *   画布上画一枚**固定的内置音频图标**（不给换贴图），编辑器**不播放**（出声是前端的事）；
 * - `Teleport`：**动作对象**里的「传送阵」——另带「传送到哪一张场景」，画布上同样是
 *   **固定的内置徽标**（不给换贴图）。触发它 = **切换当前场景**（对 DM 就是「换台」），
 *   所以它**不需要新协议命令**：切场景本来就是编辑器的事，整份 `scene_push` 下去前端就换了。
 *
 * 贴图与精灵的数据形状相同（都是一份 `ImageRef`），只是**分开用两个组件**——
 * 编辑器里贴图入口的选择图片弹框也不给右侧切分面板（见 `ImagePickerDialog` 的 `allowSprite`）；
 * 反过来，**视频这一组只有地图与贴图有**（`OBJECT_FEATURES` 里 `video` 的 kinds）：
 * 视频是「盖在这个对象自己的矩形上的一条片」，给贴图正是它的用法。
 */
export type ObjectKind = (typeof OBJECT_KINDS)[number];

/** 一个对象类型在层级里的位置。 */
export interface ObjectKindDef {
  readonly kind: ObjectKind;
  /** 基类；没有 = 根类型。 */
  readonly parent?: ObjectKind;
  /**
   * 抽象类型：**只作基类，不落进文档**。
   *
   * 现在只有 `SceneObject` 一个——它能被 `carriesKind` / `kindIsA` 命中（子类型继承它的特性），
   * 但不会被算成「能挂某个组件的具体类型」（`kindsCarrying` 把它剔掉），
   * 编辑器也不为新对象写这个值。
   */
  readonly abstract?: boolean;
}

/** 全部类型定义（顺序同 `OBJECT_KINDS`）。 */
export const OBJECT_KIND_DEFS: readonly ObjectKindDef[] = [
  { kind: "SceneObject", abstract: true },
  { kind: "Sprite", parent: "SceneObject" },
  { kind: "Image", parent: "SceneObject" },
  { kind: "Map" },
  { kind: "Player" },
  { kind: "Item" },
  { kind: "Event" },
  { kind: "PlaySound" },
  { kind: "Teleport" },
];

const BY_KIND = new Map(OBJECT_KIND_DEFS.map((def) => [def.kind, def]));

/** 一个类型的定义；表里没有的（手写文件里的怪值）返回 undefined。 */
export function objectKindDef(kind: string): ObjectKindDef | undefined {
  return BY_KIND.get(kind as ObjectKind);
}

/**
 * **祖先链**：从直接基类往上（不含自身）。
 *
 * 表里万一写出环，这里走一圈就会停下（`includes` 兜底）——文档读不开比多走两圈更糟。
 */
export function kindAncestors(kind: ObjectKind): readonly ObjectKind[] {
  const ancestors: ObjectKind[] = [];
  let parent = BY_KIND.get(kind)?.parent;

  while (parent !== undefined && !ancestors.includes(parent)) {
    ancestors.push(parent);
    parent = BY_KIND.get(parent)?.parent;
  }

  return ancestors;
}

/**
 * **自身 + 全部祖先**，从自己往上排。
 *
 * 顺序有含义：查「这个特性用哪个组件」时先看自己那一份、再往基类退
 * （见 `features.ts` 的 `componentForKind`）。
 */
export function kindLineage(kind: ObjectKind): readonly ObjectKind[] {
  return [kind, ...kindAncestors(kind)];
}

/**
 * `kind` 是 `base` **本身或它的子类型**吗。
 *
 * 「这个类型能不能带某个特性」一律走它——`kind === base` 会把子类型漏掉。
 * 认不出来的值（手写文件里的怪值）只可能等于它自己。
 */
export function kindIsA(kind: ObjectKind, base: ObjectKind): boolean {
  return kind === base || kindAncestors(kind).includes(base);
}

/** 抽象类型吗（只作基类、不落进文档）。 */
export function isAbstractKind(kind: ObjectKind): boolean {
  return BY_KIND.get(kind)?.abstract === true;
}

/** 会**落进文档**的类型（抽象基类不在内）——「能挂某个组件的对象类型」要按它筛。 */
export const CONCRETE_KINDS: readonly ObjectKind[] = OBJECT_KINDS.filter(
  (kind) => !isAbstractKind(kind),
);

/** `base` 的**全部子类型**（不含它自己；多级也一次拿全）。 */
export function kindDescendants(base: ObjectKind): readonly ObjectKind[] {
  return OBJECT_KINDS.filter((kind) => kind !== base && kindIsA(kind, base));
}
