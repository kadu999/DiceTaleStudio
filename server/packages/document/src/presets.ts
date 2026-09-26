import { componentKindMismatchOf, findComponentType, type ComponentType } from "./components";
import type { GameObjectDoc } from "./types";
import type { SoundLayer } from "./types";

/**
 * 对象预设（原 `ObjectKind` 的落地形态）与**能力槽位**。
 *
 * **组件是唯一功能载体**：组件定义自报 `slot`（「我承担对象哪种能力」，住在
 * `components.ts` 的 `ComponentTypeDef.slot`），对象访问器（`access.ts`）按 slot 在
 * 对象的组件列表上查找。组件定义分别声明创建模板 kind、缺失必需组件修复 kind
 * 与可选组件准入 kind；这些职责由 `templateKinds` / `repairKinds` / `optionalKinds`
 * 分别承载。
 *
 * `kind` 因此只是**预设 id**：它不再携带行为、也没有 parent 层级（v22 及更早的层级
 * 已移除，迁移见 `schema.ts` 的 `LEGACY_KINDS`）。查「这个对象显示了哪张图」一律走
 * 访问器的 slot 查找，别在调用处写 `kind === "Sprite"` 这种判断——加一个预设只改
 * 这张表与 `components.ts` 的 `slot` 声明。
 *
 * 三处（迁移、协议、Unity 客户端解析）用的组件名**必须完全一致**，由
 * `apps/backend/test/protocol-document-contract.test.ts` 兜住。
 */

/**
 * 能力槽位：组件自报「我承担对象哪种能力」，access.ts 按它找对象上的组件。
 */
export type ComponentSlot = "map" | "fog" | "image" | "sound" | "teleport" | "video";

/**
 * 全部对象类型（= 预设 id 的取值）。**顺序就是规范顺序**（文档枚举、编辑器类型表都按它排）。
 *
 * 基类排在所有具体类型前面（`GameObject` → 所有可落盘对象），其余保持既有顺序：
 * 前四个是前端 `BackendObjectKind` 就有的实体（`GameObject` / `Player` / `Item` / `Event`），
 * 后面的是编辑器侧新增的（`Map` 是「带网格的图」、`Image` 是「只显示整张图的贴图」，
 * `PlaySound` / `Teleport` 是动作对象）。
 */
export const OBJECT_KINDS = [
  "GameObject",
  "Sprite",
  "Image",
  "Fog",
  "Player",
  "Item",
  "Event",
  "PlaySound",
  "Teleport",
] as const;

/**
 * 对象类型。
 *
 * - `GameObject`：**所有场景对象的抽象基类**（见 `OBJECT_PRESETS` 的 `abstract`），
 *   它**不会出现在文档里**；老文件里写的 `SceneObject` 由 v22 迁移改成 `Sprite`，
 *   因为当时它代表精灵原型；
 * - `Sprite`：**精灵**——显示的一张图可以取图集里的一格（子图）；
 * - `Image`：**贴图**（v21 起，v22 前叫 `Texture`）——只把一张图整张铺出来，不引用格子。
 *   v28 起**「网格地图」就是「贴图 + `GridMap` 组件」**（网格是可选能力，见 `components.ts`），
 *   不再是一种独立的对象类型；
 * - `Fog`：**战争雾**（v27 起是独立的场景对象）——引用一张带网格的贴图（雾区取自它的格子区域位），
 *   自带总开关与雾区；可摆放，但画布上只画一枚图标。一张地图最多一个雾对象；
 * - `Player` / `Item` / `Event`：玩家 / 道具 / 事件（前端 `BackendObjectKind` 就有的实体）；
 * - `PlaySound`：**动作对象**（「播放声音」）——基础属性与实体一样，另带「播什么 + 哪个层级」，
 *   画布上画一枚**固定的内置音频图标**（不给换贴图），编辑器**不播放**（出声是前端的事）；
 * - `Teleport`：**动作对象**里的「传送阵」——另带「传送到哪一张场景」，画布上同样是
 *   **固定的内置徽标**（不给换贴图）。触发它 = **切换当前场景**（对 DM 就是「换台」），
 *   所以它**不需要新协议命令**：切场景本来就是编辑器的事，整份 `scene_push` 下去前端就换了。
 *
 * 贴图与精灵的数据形状相同（都是一份 `ImageRef`），只是**分开用两个组件**——
 * 编辑器里贴图入口的选择图片弹框也不给右侧切分面板（见 `ResourcePickerDialog` 的 `allowSprite`）；
 * 反过来，**视频这一组只有地图与贴图有**（`OBJECT_PRESETS` 里 `video` 槽位的声明）：
 * 视频是「盖在这个对象自己的矩形上的一条片」，给贴图正是它的用法。
 */
export type ObjectKind = (typeof OBJECT_KINDS)[number];

/**
 * 对象预设：一个 kind 允许的能力槽位 → 承载组件。
 *
 * **kind 只是预设 id，不携带行为**：对象身上真正有什么能力，看它实际挂了哪些组件；
 * 这张表管的是「这个预设**允许**什么」——写路径的准入判据（`ensureXxxData`）、
 * 「取组件名走哪个缺省承载」（`componentForSlot`）与校验都从这里查。
 */
export interface GameObjectPreset {
  readonly kind: ObjectKind;
  /** 抽象基类：不落进文档；手写文件写了会被迁移规范化成 Sprite。 */
  readonly abstract?: boolean;
  /**
   * 这个预设允许的能力槽位 → 承载组件。
   *
   * `image` 在精灵上是 `SpriteLayer`、在其余可贴图预设上是 `ImageLayer`
   * （原 `componentsByKind` 按 kind 路由，现在直接写在每个预设自己的槽位表里）。
   */
  readonly slots: Readonly<Partial<Record<ComponentSlot, ComponentType>>>;
}

/**
 * 缺省承载组件：预设表里没写某个槽位时的兜底（原 `FEATURE_COMPONENT`）。
 *
 * 取组件名只有 `componentForSlot` 这一个入口（迁移、写盘、访问器都走它），
 * 调用处不该自己判 kind。
 */
export const DEFAULT_SLOT_COMPONENT: Readonly<Record<ComponentSlot, ComponentType>> = {
  map: "GridMap",
  fog: "FogOfWar",
  image: "ImageLayer",
  sound: "PlaySound",
  teleport: "Teleport",
  video: "VideoOverlay",
};

/** 精灵对象显示的图住在它自己的组件里（与贴图的 `ImageLayer` 分开，见 `OBJECT_PRESETS.Sprite`）。 */
export const SPRITE_COMPONENT: ComponentType = "SpriteLayer";

/**
 * 全部对象预设（顺序同 `OBJECT_KINDS`）。
 *
 * `image` 那条槽位只登记在支持贴图的具体预设上（`Sprite` / `Image` / `Player` / `Item` /
 * `Event`）；`video` 那个槽位**刻意只给贴图**（`Image`）——视频画面盖在对象自己的矩形上，
 * 精灵显示的是图集里的一格，它的渲染选项归「渲染」那一组。`fog` 槽位**只给战争雾对象**（`Fog`）：
 * 雾引用一张带网格的贴图的格子区域位（v27 起雾是独立对象）。
 *
 * **网格（`GridMap`）是贴图上的可选能力**（v28 起）：`Image` 预设声明了 `map` 槽位，
 * 但组件本身是可选的（`optionalKinds`）——「网格地图」= 贴图 + 网格组件，不是独立类型。
 */
export const OBJECT_PRESETS: Readonly<Record<ObjectKind, GameObjectPreset>> = {
  GameObject: { kind: "GameObject", abstract: true, slots: {} },
  Sprite: { kind: "Sprite", slots: { image: "SpriteLayer" } },
  Image: { kind: "Image", slots: { image: "ImageLayer", map: "GridMap", video: "VideoOverlay" } },
  // 战争雾（v27 起是独立的场景对象）：它自己的数据就是 `FogOfWar` 组件（引用一张带网格的贴图 +
  // 开关 + 雾区）。可摆放（对象照常有位置 / 旋转 / 缩放），但画布上只画一枚图标。
  Fog: { kind: "Fog", slots: { fog: "FogOfWar" } },
  Player: { kind: "Player", slots: { image: "ImageLayer" } },
  Item: { kind: "Item", slots: { image: "ImageLayer" } },
  Event: { kind: "Event", slots: { image: "ImageLayer" } },
  PlaySound: { kind: "PlaySound", slots: { sound: "PlaySound" } },
  Teleport: { kind: "Teleport", slots: { teleport: "Teleport" } },
};

/**
 * 一个对象预设的定义；表里没有的（手写文件里的怪值）返回 undefined。
 *
 * 未知 kind 的所有查询（`isAbstractKind` → false、`carriesComponent` → false、
 * `componentForSlot` → 缺省承载）都按「没有预设」兜底，与旧层级表的口径一致。
 */
export function presetOf(kind: string): GameObjectPreset | undefined {
  return (OBJECT_PRESETS as Readonly<Record<string, GameObjectPreset>>)[kind];
}

/** 抽象类型吗（只作基类、不落进文档）。未知 kind 返回 false，同旧 `isAbstractKind`。 */
export function isAbstractKind(kind: ObjectKind): boolean {
  return presetOf(kind)?.abstract === true;
}

/** 会**落进文档**的预设（抽象基类不在内）——「能挂某个组件的对象类型」要按它筛。 */
export const CONCRETE_KINDS: readonly ObjectKind[] = OBJECT_KINDS.filter(
  (kind) => !isAbstractKind(kind),
);

/**
 * 这个 kind 上，某个槽位由**哪个组件**承载。
 *
 * 先查预设自己的槽位表；预设没有写这个槽位（或 kind 认不出来）时返回
 * `DEFAULT_SLOT_COMPONENT` 的缺省承载——旧 `componentForKind` 对未知 kind 也落到
 * 缺省承载组件，行为一致。
 */
export function componentForSlot(slot: ComponentSlot, kind: ObjectKind): ComponentType {
  return presetOf(kind)?.slots[slot] ?? DEFAULT_SLOT_COMPONENT[slot];
}

/**
 * 这个对象类型能不能由**这个组件**承载（即它是该 kind 某个槽位的承载组件）。
 *
 * 旧 `carriesKind` 对未知 kind（不在层级里）返回 false——这里未知 kind 没有预设、
 * 按空槽位表算，同样 false，不替它猜。
 */
export function carriesComponent(component: ComponentType, kind: ObjectKind): boolean {
  return Object.values(presetOf(kind)?.slots ?? {}).includes(component);
}

/**
 * 哪些对象能带视频列表：已挂 `VideoOverlay` 的对象；缺组件时按组件定义的可选准入 kind 添加。
 *
 * 面板、命令和校验的组件实例判据保持一致；kind 只为缺失的旧组件提供兼容准入。
 */
export function supportsVideo(target: ObjectKind | GameObjectDoc): boolean {
  if (typeof target !== "string") {
    if (target.components.some((component) => component.type === DEFAULT_SLOT_COMPONENT.video)) return true;
    if (target.components.some((component) => findComponentType(component.type)?.slot === "video")) return false;
    if (componentKindMismatchOf(target.components, target.kind)) return false;
    return findComponentType(DEFAULT_SLOT_COMPONENT.video)?.optionalKinds?.includes(target.kind) === true;
  }

  return presetOf(target)?.slots.video !== undefined;
}

/**
 * 哪些对象能带战争雾：**只有 `Fog` 对象**（v27 起雾是独立的场景对象，自己就是它的数据本体）。
 *
 * 已挂 `FogOfWar` 组件的对象照旧算数（损坏的手写文件）；组件定义里的 `templateKinds`
 * 决定正常的创建模板。地图对象上**不再**有雾。
 */
export function supportsFog(target: ObjectKind | GameObjectDoc): boolean {
  if (typeof target !== "string") {
    if (target.components.some((component) => component.type === DEFAULT_SLOT_COMPONENT.fog)) return true;
    if (target.components.some((component) => findComponentType(component.type)?.slot === "fog")) return true;
    if (componentKindMismatchOf(target.components, target.kind)) return false;
    return findComponentType(DEFAULT_SLOT_COMPONENT.fog)?.templateKinds?.includes(target.kind) === true;
  }

  return presetOf(target)?.slots.fog !== undefined;
}

/**
 * 这种对象的图**能不能取图集里的一格**（子图）——即精灵 `Sprite` 与其余场景对象的分界。
 *
 * 判据是**图片槽位用哪个组件**（精灵 `SpriteLayer`、其余 `ImageLayer`），不是另写一份
 * kind 名单：于是「选择图片弹框给不给右侧切分面板」「渲染那一组给不给选格子」两处永远一致。
 * 基类 `GameObject` 与地图返回 `false`（地图的贴图住在 `GridMap` 里，格子按整张贴图算）。
 */
export function supportsSpriteSheet(target: ObjectKind | GameObjectDoc): boolean {
  if (typeof target !== "string") {
    if (target.components.some((component) => component.type === DEFAULT_SLOT_COMPONENT.map)) return false;
    const image = target.components.find((component) => findComponentType(component.type)?.slot === "image");
    if (image !== undefined) return image.type === SPRITE_COMPONENT;
    if (componentKindMismatchOf(target.components, target.kind)) return false;
    return findComponentType(SPRITE_COMPONENT)?.templateKinds?.includes(target.kind) === true;
  }

  return presetOf(target)?.slots.image === SPRITE_COMPONENT;
}

// ---------------------------------------------------------------- 特性缺省值

/**
 * 声音对象的默认层级：**音效**（最常见的一档）。
 *
 * 层级是「声道分组」：同层同时只响一条，后来的顶掉先前的；想要两件事同时响就得
 * 分到两层。三档的取值与中文名见 `types.ts` 的 `SOUND_LAYERS` / `SOUND_LAYER_LABELS`；
 * 对象界面上只给 `OBJECT_SOUND_LAYERS`（音效 / 旁白）——背景音乐是项目级全局设置。
 */
export const DEFAULT_SOUND_LAYER: SoundLayer = "sfx";

/**
 * 视频的默认开关（v14 起）：**开着、不循环、静音**。
 *
 * 开着 = 加过视频就默认会用（`video` 字段本身就是「在用」的意思）；
 * 不循环 = 过场视频放一遍停在最后一帧（要循环的背景视频在面板上打开）；
 * 静音 = 现场跑团时「不小心点开视频就轰一声」比听不到更糟。
 */
export const DEFAULT_VIDEO_ENABLED = true;
export const DEFAULT_VIDEO_AUTO_PLAY = false;
export const DEFAULT_VIDEO_LOOP = false;
export const DEFAULT_VIDEO_AUDIO = false;
