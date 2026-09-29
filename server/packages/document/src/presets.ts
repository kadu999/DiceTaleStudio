import { findComponentType, type ComponentType } from "./components";
import {
  DEFAULT_MAGNIFIER_VIDEO_AUDIO,
  DEFAULT_MAGNIFIER_VIDEO_LOOP,
  DEFAULT_SOUND_LAYER,
  DEFAULT_VIDEO_AUDIO,
  DEFAULT_VIDEO_AUTO_PLAY,
  DEFAULT_VIDEO_BLEND_AUDIO,
  DEFAULT_VIDEO_BLEND_KIND,
  DEFAULT_VIDEO_ENABLED,
  DEFAULT_VIDEO_LOOP,
  FOG_DEFAULT_SORTING_ORDER,
} from "@dts/contract";
import type { GameObjectDoc } from "./types";

/**
 * 对象预设（原 `ObjectKind` 的落地形态）与**能力槽位**。
 *
 * **组件是唯一功能载体**：组件定义自报 `slot`（「我承担对象哪种能力」，住在
 * `components.ts` 的 `ComponentTypeDef.slot`），对象访问器（`access.ts`）按 slot 在
 * 对象的组件列表上查找。kind 只用于创建模板与历史迁移；创建后不限制组件组合。
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
export type ComponentSlot = "map" | "fog" | "image" | "sound" | "teleport" | "magnifier" | "video" | "videoBlend";

/**
 * 全部对象类型（= 预设 id 的取值）。**顺序就是规范顺序**（文档枚举、编辑器类型表都按它排）。
 *
 * 基类排在所有具体类型前面（`GameObject` → 所有可落盘对象），其余保持既有顺序。
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
  "Magnifier",
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
 * - `Magnifier`：**动作对象**里的「放大镜」——另带「状态列表 + 当前展示的那一个」
 *   （v31 起每条状态 = 标题 + 图 + 文字），画布上也是**固定的内置徽标**。触发它 = 让前端
 *   **弹一扇窗**显示选中的那个状态（开 / 关两条命令；换状态是文档数据，整份 `scene_push` 带过去）。
 *
 * 贴图与精灵的数据形状相同（都是一份 `ImageRef`），只是**分开用两个组件**——
 * 编辑器里贴图入口的选择图片弹框也不给右侧切分面板（见 `ResourcePickerDialog` 的 `allowSprite`）；
 * 视频初始模板只给贴图配置；对象创建后的能力只由实际挂载的组件决定。
 */
export type ObjectKind = (typeof OBJECT_KINDS)[number];

/**
 * 对象预设：创建对象时，一个 kind 的初始槽位 → 承载组件。
 *
 * **kind 只是预设 id，不携带对象行为**：对象身上真正有什么能力，看它实际挂了哪些组件；
 * 这张表只用于创建和迁移，不用于对象实例的写入准入。
 */
export interface GameObjectPreset {
  readonly kind: ObjectKind;
  /** 抽象基类：不落进文档；手写文件写了会被迁移规范化成 Sprite。 */
  readonly abstract?: boolean;
  /**
   * 这个预设创建时的初始组件槽位 → 承载组件。
   *
   * `image` 在精灵上是 `SpriteLayer`、在其余可贴图预设上是 `ImageLayer`
   * （原 `componentsByKind` 按 kind 路由，现在直接写在每个预设自己的槽位表里）。
   */
  readonly slots: Readonly<Partial<Record<ComponentSlot, ComponentType>>>;
}

/**
 * 缺省承载组件：预设表里没写某个槽位时的兜底（原 `FEATURE_COMPONENT`）。
 *
 * 只用于历史迁移与模板；对象实例的组件能力按实际组件读取。
 */
export const DEFAULT_SLOT_COMPONENT: Readonly<Record<ComponentSlot, ComponentType>> = {
  map: "GridMap",
  fog: "FogOfWar",
  image: "ImageLayer",
  sound: "PlaySound",
  teleport: "Teleport",
  magnifier: "Magnifier",
  video: "VideoOverlay",
  videoBlend: "VideoBlend",
};

/** 精灵对象显示的图住在它自己的组件里（与贴图的 `ImageLayer` 分开，见 `OBJECT_PRESETS.Sprite`）。 */
export const SPRITE_COMPONENT: ComponentType = "SpriteLayer";

/**
 * 全部对象创建模板（顺序同 `OBJECT_KINDS`）。
 *
 * 这些槽位描述创建时的初始组件；对象创建后可显式挂载其他组件，不再受 kind 限制。
 * `fog` 槽位在历史模板里给战争雾对象（`Fog`）：
 * 雾引用一张带网格的贴图的格子区域位（v27 起雾是独立对象）。
 *
 * **网格（`GridMap`）是可选能力**（v28 起）：「网格地图」= 贴图 + 网格组件，不是独立类型。
 */
export const OBJECT_PRESETS: Readonly<Record<ObjectKind, GameObjectPreset>> = {
  GameObject: { kind: "GameObject", abstract: true, slots: {} },
  Sprite: { kind: "Sprite", slots: { image: "SpriteLayer" } },
  Image: { kind: "Image", slots: { image: "ImageLayer", map: "GridMap", video: "VideoOverlay", videoBlend: "VideoBlend" } },
  // 战争雾（v27 起是独立的场景对象）：它自己的数据就是 `FogOfWar` 组件（引用一张带网格的贴图 +
  // 开关 + 雾区）。可摆放（对象照常有位置 / 旋转 / 缩放），但画布上只画一枚图标。
  Fog: { kind: "Fog", slots: { fog: "FogOfWar" } },
  Player: { kind: "Player", slots: { image: "ImageLayer" } },
  Item: { kind: "Item", slots: { image: "ImageLayer" } },
  Event: { kind: "Event", slots: { image: "ImageLayer" } },
  PlaySound: { kind: "PlaySound", slots: { sound: "PlaySound" } },
  Teleport: { kind: "Teleport", slots: { teleport: "Teleport" } },
  // 放大镜（动作对象，v30）：它自己的数据就是 `Magnifier` 组件（状态列表 + 当前展示的那一个）。
  // 可摆放（照常有位置 / 旋转 / 缩放），但画布上只画一枚内置徽标；那扇窗在前端弹（`MagnifierWindow`）。
  Magnifier: { kind: "Magnifier", slots: { magnifier: "Magnifier" } },
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
 * 创建模板或历史迁移中，某 kind 的槽位映射到哪个组件。
 *
 * 此映射只用于创建与迁移；对象实例行为必须通过已挂载组件判定。
 */
export function componentForSlot(slot: ComponentSlot, kind: ObjectKind): ComponentType {
  return presetOf(kind)?.slots[slot] ?? DEFAULT_SLOT_COMPONENT[slot];
}

/**
 * 创建模板或历史格式中的 kind 是否映射到该组件。
 *
 * 仅供模板与迁移查询，不用于创建后的能力判定。
 */
export function carriesComponent(component: ComponentType, kind: ObjectKind): boolean {
  return Object.values(presetOf(kind)?.slots ?? {}).includes(component);
}

/**
 * 哪些对象能带视频列表：只看实际挂载的 `VideoOverlay` 组件。
 *
 * 面板、命令和校验的组件实例判据保持一致；创建后不以 kind 作为能力准入。
 */
export function supportsVideo(object: GameObjectDoc): boolean {
  return object.components.some((component) => component.type === DEFAULT_SLOT_COMPONENT.video);
}

/**
 * 哪些对象能带视频混合（`VideoBlend`）：只看实际挂载的组件。
 *
 * 与 `supportsVideo` 同一套：混合结果盖在对象自己的矩形上。
 *
 * 与 `VideoOverlay` 的关系：二者**互斥**（两条视频流同时想盖同一个矩形没有意义）——
 * 准入层（`access.ts` 的 `EXCLUSIVE_SLOTS`）**直接拒绝同时挂**：挂了一个，另一个就加不上
 * / 补不出来。手写文件里两个都写的由 `validateScene` 报一条 error。
 */
export function supportsVideoBlend(object: GameObjectDoc): boolean {
  return object.components.some((component) => component.type === DEFAULT_SLOT_COMPONENT.videoBlend);
}

/**
 * 哪些对象能带战争雾：只看实际挂载的 `FogOfWar` 组件。
 */
export function supportsFog(object: GameObjectDoc): boolean {
  return object.components.some((component) => component.type === DEFAULT_SLOT_COMPONENT.fog);
}

/**
 * 哪些对象能带放大镜：只看实际挂载的 `Magnifier` 组件。
 */
export function supportsMagnifier(object: GameObjectDoc): boolean {
  return object.components.some((component) => component.type === DEFAULT_SLOT_COMPONENT.magnifier);
}

/**
 * 这种对象的图**能不能取图集里的一格**（子图）——即精灵 `Sprite` 与其余场景对象的分界。
 *
 * 判据只看已挂载的图片渲染组件；地图组件存在时禁止切子图，以免网格标注错位。
 */
export function supportsSpriteSheet(object: GameObjectDoc): boolean {
  if (object.components.some((component) => findComponentType(component.type)?.slot === "map")) return false;
  return object.components.some((component) => component.type === SPRITE_COMPONENT);
}

// ---------------------------------------------------------------- 特性缺省值

/**
 * 声音对象的默认层级：**音效**（最常见的一档）。
 *
 * 层级是「声道分组」：同层同时只响一条，后来的顶掉先前的；想要两件事同时响就得
 * 分到两层。三档的取值与中文名见 `types.ts` 的 `SOUND_LAYERS` / `SOUND_LAYER_LABELS`；
 * 对象界面上只给 `OBJECT_SOUND_LAYERS`（音效 / 旁白）——背景音乐是项目级全局设置。
 */
export { DEFAULT_SOUND_LAYER };

/**
 * 视频的默认开关（v14 起）：**开着、不循环、静音**。
 *
 * 开着 = 加过视频就默认会用（`video` 字段本身就是「在用」的意思）；
 * 不循环 = 过场视频放一遍停在最后一帧（要循环的背景视频在面板上打开）；
 * 静音 = 现场跑团时「不小心点开视频就轰一声」比听不到更糟。
 */
export { DEFAULT_VIDEO_ENABLED, DEFAULT_VIDEO_AUTO_PLAY, DEFAULT_VIDEO_LOOP, DEFAULT_VIDEO_AUDIO };

/**
 * 视频混合的默认声音来源：**静音**（与视频同一条口径）。
 *
 * 两条视频同时放时，声音只能出一路——默认哪条都不出，要出声才在面板上选。
 */
export { DEFAULT_VIDEO_BLEND_AUDIO };

/**
 * 视频混合每一路的默认素材种类：**视频**。
 *
 * 这组件最早就是「两条视频用 Mask 混合」，图片是后加的一档；老数据迁移过来也一律是视频。
 */
export { DEFAULT_VIDEO_BLEND_KIND };

/**
 * 放大镜一屏里视频的默认开关（v33）：**循环、静音**。
 *
 * 循环 = 线索卡上的动图通常要一直动；静音 = 与对象上的视频同一条（跑团时误响比听不到更糟）。
 */
export { DEFAULT_MAGNIFIER_VIDEO_LOOP, DEFAULT_MAGNIFIER_VIDEO_AUDIO };

/**
 * 战争雾雾层的**显示顺序默认值**（v32 起可配置）：**最前面**。
 *
 * 未探索的雾要盖住地图上的对象，所以默认取 `short.MaxValue`（与图片层「大的画在前面」
 * 同一套口径，但对象自己的 `sortingOrder` 被夹在 `±SORTING_ORDER_LIMIT`，够不着它）。
 * 想拿别的对象盖住雾时在属性面板里把这一项调小。
 */
export { FOG_DEFAULT_SORTING_ORDER };

/**
 * 战争雾雾层显示顺序的取值范围（`±FOG_SORTING_ORDER_LIMIT`）。
 *
 * 与 `SORTING_ORDER_LIMIT`（对象渲染层）分开：雾默认要落在这个范围的最顶，
 * 而对象的显示顺序够不到这里，所以「默认在最前面」是稳的。
 */
export const FOG_SORTING_ORDER_LIMIT = 32767;
