import type { ComponentSlot } from "./presets";
import type { ComponentDoc } from "./types";

/**
 * 组件注册表。
 *
 * **v19 起，对象身上那些「可插拔特性」是组件**：地图 / 贴图 / 声音 / 传送 / 视频
 * （见 `presets.ts` 的 `OBJECT_PRESETS`）。这些组件多两项：
 * - `slot`：它承担对象哪种能力（**组件自报**；访问器按 slot 找对象上的组件，不看 kind）；
 * - `legacyField`：v19 之前它住在对象的哪个扁平字段里——迁移函数靠它把老字段搬成组件实例。
 */

/** 组件类型 ID：6 种对象能力组件（v19 从对象特性提升上来的），逐字对齐前端组件类名。 */
export type ComponentType =
  | "GridMap"
  | "ImageLayer"
  | "SpriteLayer"
  | "PlaySound"
  | "Teleport"
  | "VideoOverlay";

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
  readonly tooltip?: string;
}

export const COMPONENT_TYPES: readonly ComponentTypeDef[] = [
  // ---------------------------------------------------------------- v19：对象特性提升上来的组件
  //
  // 这 6 条自报 `slot`（「哪个 kind 允许哪个槽位」只有 `presets.ts` 的 `OBJECT_PRESETS`
  // 那一处归属地，不在这里重复写）；`legacyField` 记着 v19 之前它住在对象的哪个扁平字段里。
  {
    type: "GridMap",
    displayName: "网格地图",
    gmEditable: true,
    slot: "map",
    legacyField: "map",
    tooltip: "贴图 + 网格数据（列 / 行 / 行序 / 格子 RLE / 战争雾）；只有地图对象携带",
  },
  {
    // 贴图对象的图片组件（精灵的那一份是下面的 `SpriteLayer`，两者共用同一份 `ImageRef` 形状）
    type: "ImageLayer",
    displayName: "图片层",
    gmEditable: true,
    slot: "image",
    legacyField: "image",
    tooltip: "对象自己要显示的图片，整张铺在对象矩形上（贴图对象用它；地图的贴图在 GridMap 里）",
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
    tooltip: "精灵要显示的图片：可以取图集里的一格（子图），由渲染那一组挑第几行第几列",
  },
  {
    type: "PlaySound",
    displayName: "播放声音",
    gmEditable: true,
    slot: "sound",
    legacyField: "sound",
    tooltip: "音频列表 + 选中的那条 + 层级：声明「告诉前端播什么」，编辑器自己不播放",
  },
  {
    type: "Teleport",
    displayName: "传送阵",
    gmEditable: true,
    slot: "teleport",
    legacyField: "teleport",
    tooltip: "候选目标场景 + 选中的那一个；触发 = 切换当前场景（不需要新协议命令）",
  },
  {
    type: "VideoOverlay",
    displayName: "视频",
    gmEditable: true,
    slot: "video",
    legacyField: "video",
    tooltip: "视频列表 + 选中的那条 + 循环 / 声音两个开关；画面盖在对象自己的矩形上",
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
