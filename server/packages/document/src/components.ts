import type { ComponentSlot } from "./presets";
import type { ComponentDoc } from "./types";

/**
 * 组件注册表。
 *
 * **v19 起，对象身上那些「可插拔特性」是组件**：地图 / 贴图 / 声音 / 传送 / 视频
 * （见 `presets.ts` 的 `OBJECT_PRESETS`），战争雾（`FogOfWar`）是 v25 从 `GridMap`
 * 拆出来的第 7 种，视频混合（`VideoBlend`）是后加的第 8 种。这些组件多两项：
 * - `slot`：它承担对象哪种能力（**组件自报**；访问器按 slot 找对象上的组件，不看 kind）；
 * - `templateKinds`：对象创建模板中会预置/路由到该组件的 kind；
 * - `repairKinds`：组件缺失时，编辑器提供显式修复入口的 kind；
 * - `optionalKinds`：允许用户主动添加该可选组件的 kind；
 * - `legacyField`：v19 之前它住在对象的哪个扁平字段里——迁移函数靠它把老字段搬成组件实例。
 */

/** 组件类型 ID：8 种对象能力组件（6 种 v19 从对象特性提升上来，`FogOfWar` 是 v25 从 GridMap 拆出来的），逐字对齐前端组件类名。 */
export type ComponentType =
  | "GridMap"
  | "FogOfWar"
  | "ImageLayer"
  | "SpriteLayer"
  | "PlaySound"
  | "Teleport"
  | "VideoOverlay"
  | "VideoBlend";

export interface ComponentTypeDef {
  /** 组件类型 ID（= 前端组件类名）。 */
  readonly type: ComponentType;
  readonly displayName: string;
  /** 是否渲染在属性面板（对齐前端 `GmEditable`）。 */
  readonly gmEditable: boolean;
  /**
   * 这个组件承担对象哪种能力（v19 从对象特性提升上来的那 6 种才有）。
   *
   * **组件是唯一功能载体**：访问器（`access.ts`）按 slot 在对象的组件列表上查找；
   * 「哪个 kind 允许哪个槽位」住在 `presets.ts` 的 `OBJECT_PRESETS`，不在这里重复写。
   */
  readonly slot?: ComponentSlot;
  /** v19 之前这个特性住在对象的哪个扁平字段里（只有从对象特性提升上来的组件有）。 */
  readonly legacyField?: ComponentSlot;
  /** Kinds whose creation preset associates this capability slot with this component. */
  readonly templateKinds?: readonly string[];
  /** Kinds whose missing required component can be explicitly repaired in the editor. */
  readonly repairKinds?: readonly string[];
  /** Kinds allowed to add this optional component when it is not attached yet. */
  readonly optionalKinds?: readonly string[];
  readonly tooltip?: string;
}

export const COMPONENT_TYPES: readonly ComponentTypeDef[] = [
  // ---------------------------------------------------------------- v19：对象特性提升上来的组件
  //
  // 前 6 条自报 `slot`（`FogOfWar` 是 v25 加的第七条）。模板、显式修复和可选组件准入分别声明，
  // 并由 presets.test.ts 保证创建模板与 templateKinds 一致。
  // `legacyField` 记着 v19 之前它住在对象的哪个扁平字段里。
  {
    // 网格（v28 起是贴图上的**可选能力**，像「视频」）：加在贴图上 = 网格地图，可移除。
    // 纯数据 + 网格编辑窗口，没有任何渲染实体（贴图本身由 `ImageLayer` 渲染）。
    type: "GridMap",
    displayName: "网格地图",
    gmEditable: true,
    slot: "map",
    legacyField: "map",
    templateKinds: ["Image"],
    optionalKinds: ["Image"],
    tooltip: "网格数据（列 / 行 / 行序 / 格子 RLE）；加在贴图上 = 网格地图，可移除",
  },
  {
    // 战争雾（v27 起是独立场景对象 `Fog` 的数据本体）：引用一张带网格的贴图（雾区取自它的格子区域位）
    // + 总开关 + 雾区。zod schema 见 `schema.ts` 的 `mapFogSchema`。
    type: "FogOfWar",
    displayName: "战争雾",
    gmEditable: true,
    slot: "fog",
    templateKinds: ["Fog"],
    repairKinds: ["Fog"],
    tooltip: "引用哪张贴图 + 总开关 + 把哪些「区域」当成雾区；只有战争雾对象携带，一张贴图最多一个",
  },
  {
    // 贴图对象的图片组件（精灵的那一份是下面的 `SpriteLayer`，两者共用同一份 `ImageRef` 形状）
    type: "ImageLayer",
    displayName: "图片层",
    gmEditable: true,
    slot: "image",
    legacyField: "image",
    templateKinds: ["Image", "Player", "Item", "Event"],
    repairKinds: ["Image", "Player", "Item", "Event"],
    tooltip: "对象自己要显示的图片，整张铺在对象矩形上（贴图对象与带网格的贴图都用它）",
  },
  {
    // 精灵对象的图片组件：与 `ImageLayer` 同一份数据，差别是它**会取图集里的一格**
    // （`ImageRef.sprite`）——所以两者分开，界面上「给不给切子图」就由组件本身说清了。
    // v21 起取代 v20 的 `TextureRenderer`（迁移见 schema.ts 的 `renameSpriteImageComponent`）。
    type: "SpriteLayer",
    displayName: "精灵层",
    gmEditable: true,
    slot: "image",
    legacyField: "image",
    templateKinds: ["Sprite"],
    repairKinds: ["Sprite"],
    tooltip: "精灵要显示的图片：可以取图集里的一格（子图），由渲染那一组挑第几行第几列",
  },
  {
    type: "PlaySound",
    displayName: "播放声音",
    gmEditable: true,
    slot: "sound",
    legacyField: "sound",
    templateKinds: ["PlaySound"],
    repairKinds: ["PlaySound"],
    tooltip: "音频列表 + 选中的那条 + 层级：声明「告诉前端播什么」，编辑器自己不播放",
  },
  {
    type: "Teleport",
    displayName: "传送阵",
    gmEditable: true,
    slot: "teleport",
    legacyField: "teleport",
    templateKinds: ["Teleport"],
    repairKinds: ["Teleport"],
    tooltip: "候选目标场景 + 选中的那一个；触发 = 切换当前场景（不需要新协议命令）",
  },
  {
    type: "VideoOverlay",
    displayName: "视频",
    gmEditable: true,
    slot: "video",
    legacyField: "video",
    templateKinds: ["Image"],
    optionalKinds: ["Image"],
    tooltip: "视频列表 + 选中的那条 + 循环 / 声音两个开关；画面盖在对象自己的矩形上",
  },
  {
    // 视频混合（对象特性之外新加的第 8 种）：两条视频叠在**同一个矩形**上用 Mask 混合
    // （A 盖住、擦开露 B）。遮罩是**纯运行态**（新命令 `erase_video_mask` 驱动，不写文档），
    // 组件只声明「放什么」。
    // 与「视频」**互斥**（两条流同时想盖同一矩形没有意义）：准入层直接拒绝同时挂
    // （见 `access.ts` 的 `EXCLUSIVE_SLOTS`），手写文件里两个都写的由 `validateScene` 报 error。
    type: "VideoBlend",
    displayName: "视频混合",
    gmEditable: true,
    slot: "videoBlend",
    templateKinds: ["Image"],
    optionalKinds: ["Image"],
    tooltip: "两条视频通道（A 盖住 / B 擦开露出）+ 循环 + 声音来源；遮罩在 Mask 窗口里擦",
  },
];

/**
 * 带 slot 的组件（对象能力组件，原「特性组件」）：迁移按注册表顺序处理它们，
 * 也是 `presets.ts` 各预设槽位声明里允许出现的全部组件名。
 */
export const SLOT_COMPONENT_TYPES: readonly ComponentTypeDef[] = COMPONENT_TYPES.filter(
  (def) => def.slot !== undefined,
);

/** 只由对象特性提升上来、带历史扁平字段的组件（迁移按注册表顺序处理它们）。 */
export const FEATURE_COMPONENT_TYPES: readonly ComponentTypeDef[] = COMPONENT_TYPES.filter(
  (def) => def.legacyField !== undefined,
);

/** 这个对象（还没过 schema 的原始样子）上还有没有**旧的扁平特性字段**（迁移的入口判据）。 */
export function hasLegacyFeatureField(raw: Record<string, unknown>): boolean {
  return FEATURE_COMPONENT_TYPES.some((def) => {
    const field = def.legacyField as string;
    return field in raw;
  });
}

const BY_TYPE = new Map<string, ComponentTypeDef>(COMPONENT_TYPES.map((def) => [def.type, def]));

/**
 * 造一个**特性组件实例**（v19 起对象特性住在组件里）。
 *
 * `data` 在这里收窄成 `Record<string, unknown>`：文档里的组件数据就是这个类型
 * （手写文件里什么都可能写，形状由 zod 与 `validateScene` 把关），
 * 断言只此一处，调用方不必到处 `as`。
 */
export function featureComponent(
  objectId: string,
  component: string,
  data: object,
): ComponentDoc {
  return {
    id: componentId(objectId, component),
    type: component,
    data: data as Record<string, unknown>,
  };
}

/**
 * 组件实例的 id：`<对象 id>__<组件类型>`。
 *
 * **确定性**是有意的：同一次编辑重复写、迁移跑第二遍，生成的都是同一个 id，
 * 于是不会多出第二个实例、写盘 diff 也稳定（对比随机 id：每次迁移都会重写整个文件）。
 */
export function componentId(objectId: string, component: string): string {
  return `${objectId}__${component}`;
}

/** 查组件定义；未知类型返回 undefined（编辑器据此提示「未知组件类型」而不崩）。 */
export function findComponentType(type: string): ComponentTypeDef | undefined {
  return BY_TYPE.get(type);
}

export function isKnownComponentType(type: string): boolean {
  return BY_TYPE.has(type);
}

/** Whether known attached components disagree with the object's legacy kind template. */
export function componentKindMismatchOf(components: readonly ComponentDoc[], kind: string): boolean {
  return components.some((component) => {
    const definition = findComponentType(component.type);
    return definition?.slot !== undefined && definition.templateKinds?.includes(kind) !== true;
  });
}
