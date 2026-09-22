import type { FieldDef } from "./fields";
import { defaultDataFromFields } from "./fields";
import { FEATURE_COMPONENT, kindsCarrying, type ObjectFeatureField } from "./features";
import type { ComponentDoc, ObjectKind } from "./types";

/**
 * 组件注册表。
 *
 * 组件类型 ID 与字段严格对齐前端 `Backend/Components/*` 的序列化字段与上报数据，
 * 保证编辑器保存的组件数据能被前端直接消费。
 *
 * **v19 起，对象身上那些「可插拔特性」也是组件**：地图 / 贴图 / 声音 / 传送 / 视频
 * （见 `features.ts` 的 `OBJECT_FEATURES`）。这些组件多两项：
 * - `kinds`：能挂在哪些对象类型上（**从 `OBJECT_FEATURES` 取回来**，不在这里重复写）；
 * - `legacyField`：v19 之前它住在对象的哪个扁平字段里——迁移函数靠它把老字段搬成组件实例。
 */

/** 组件类型 ID。前 7 种对齐前端组件类名；后 5 种是 v19 从对象特性提升上来的。 */
export type ComponentType =
  | "OptionValue"
  | "Backpack"
  | "ItemExchange"
  | "MaskImage"
  | "FloatValue"
  | "IntValue"
  | "BoolValue"
  | "GridMap"
  | "TextureRenderer"
  | "PlaySound"
  | "Teleport"
  | "VideoOverlay";

export interface ComponentTypeDef {
  /** 组件类型 ID（= 前端组件类名）。 */
  readonly type: ComponentType;
  readonly displayName: string;
  readonly fields: readonly FieldDef[];
  /** 是否渲染在属性面板（对齐前端 `GmEditable`）。 */
  readonly gmEditable: boolean;
  /** 条件比较时组件提供的值形态（对齐前端 `Satisfies` 覆写）。 */
  readonly conditionValueTypes: readonly ("Bool" | "String" | "Number" | "Integer")[];
  /** 前端命令类型（该组件能处理的后台命令），供运行态直接下发展示。 */
  readonly commandTypes: readonly string[];
  /** 能挂在哪些对象类型上；**空数组 = 任何类型都允许**。 */
  readonly kinds: readonly ObjectKind[];
  /** v19 之前这个特性住在对象的哪个扁平字段里（只有从对象特性提升上来的组件有）。 */
  readonly legacyField?: ObjectFeatureField;
  readonly tooltip?: string;
}

/** 「任何 kind 都能挂」的组件（前端组件体系里那 7 种）。 */
const ANY_KIND: readonly ObjectKind[] = [];

export const COMPONENT_TYPES: readonly ComponentTypeDef[] = [
  {
    type: "OptionValue",
    displayName: "选项值",
    gmEditable: true,
    kinds: ANY_KIND,
    conditionValueTypes: ["String", "Integer"],
    commandTypes: ["set_option"],
    tooltip: "选项列表 + 当前选项；String 条件比较当前选项名，Integer 条件比较选项索引",
    fields: [
      { key: "options", label: "选项列表", kind: "stringList", required: true },
      { key: "current", label: "当前选项", kind: "string", tooltip: "必须是选项列表中的一项" },
    ],
  },
  {
    type: "Backpack",
    displayName: "背包",
    gmEditable: true,
    kinds: ANY_KIND,
    conditionValueTypes: [],
    commandTypes: ["set_object_items"],
    tooltip: "玩家持有的道具列表",
    fields: [{ key: "items", label: "道具", kind: "stringList" }],
  },
  {
    type: "ItemExchange",
    displayName: "道具货源",
    gmEditable: true,
    kinds: ANY_KIND,
    conditionValueTypes: [],
    commandTypes: [],
    tooltip: "场景中的道具货源：道具名 + 固定总数（剩余由前端按玩家持有量推导）",
    fields: [
      { key: "itemName", label: "道具名", kind: "string", required: true },
      { key: "quantity", label: "总数", kind: "integer", min: 0 },
    ],
  },
  {
    type: "MaskImage",
    displayName: "遮罩图",
    gmEditable: true,
    kinds: ANY_KIND,
    conditionValueTypes: [],
    commandTypes: ["set_mask_image", "erase_mask"],
    tooltip: "可被 GM 擦除的遮罩贴图",
    fields: [
      { key: "image", label: "遮罩图", kind: "resourceRef", resourceKind: "image" },
      { key: "base64", label: "运行时遮罩数据", kind: "text", tooltip: "运行时由 GM 擦除下发，编辑态一般留空" },
    ],
  },
  {
    type: "FloatValue",
    displayName: "浮点值",
    gmEditable: true,
    kinds: ANY_KIND,
    conditionValueTypes: ["Number"],
    commandTypes: ["set_float"],
    fields: [{ key: "value", label: "值", kind: "number", step: 0.1 }],
  },
  {
    type: "IntValue",
    displayName: "整数值",
    gmEditable: true,
    kinds: ANY_KIND,
    conditionValueTypes: ["Integer"],
    commandTypes: ["set_int"],
    fields: [{ key: "value", label: "值", kind: "integer" }],
  },
  {
    type: "BoolValue",
    displayName: "布尔值",
    gmEditable: true,
    kinds: ANY_KIND,
    conditionValueTypes: ["Bool"],
    commandTypes: ["set_bool"],
    fields: [{ key: "value", label: "值", kind: "boolean" }],
  },

  // ---------------------------------------------------------------- v19：对象特性提升上来的组件
  //
  // 这 5 条的 `kinds` **不在本地重复写**：它是 `features.ts` 那张 `OBJECT_FEATURES` 表的
  // 一部分（「哪个 kind 带哪个特性」只有那一处归属地），这里按组件名取回来。
  {
    type: "GridMap",
    displayName: "网格地图",
    gmEditable: true,
    kinds: kindsCarrying(FEATURE_COMPONENT.map),
    legacyField: "map",
    conditionValueTypes: [],
    commandTypes: [],
    tooltip: "贴图 + 网格数据（列 / 行 / 行序 / 格子 RLE / 战争雾）；只有地图对象携带",
    fields: [],
  },
  {
    type: "TextureRenderer",
    displayName: "贴图",
    gmEditable: true,
    kinds: kindsCarrying(FEATURE_COMPONENT.image),
    legacyField: "image",
    conditionValueTypes: [],
    commandTypes: [],
    tooltip: "对象自己要显示的图片（精灵靠它显示；地图的贴图在 GridMap 里）",
    fields: [],
  },
  {
    type: "PlaySound",
    displayName: "播放声音",
    gmEditable: true,
    kinds: kindsCarrying(FEATURE_COMPONENT.sound),
    legacyField: "sound",
    conditionValueTypes: [],
    commandTypes: ["play_sound", "stop_sound", "pause_sound", "resume_sound"],
    tooltip: "音频列表 + 选中的那条 + 层级：声明「告诉前端播什么」，编辑器自己不播放",
    fields: [],
  },
  {
    type: "Teleport",
    displayName: "传送阵",
    gmEditable: true,
    kinds: kindsCarrying(FEATURE_COMPONENT.teleport),
    legacyField: "teleport",
    conditionValueTypes: [],
    commandTypes: [],
    tooltip: "候选目标场景 + 选中的那一个；触发 = 切换当前场景（不需要新协议命令）",
    fields: [],
  },
  {
    type: "VideoOverlay",
    displayName: "视频",
    gmEditable: true,
    kinds: kindsCarrying(FEATURE_COMPONENT.video),
    legacyField: "video",
    conditionValueTypes: [],
    commandTypes: ["play_video", "pause_video", "resume_video", "stop_video"],
    tooltip: "视频列表 + 选中的那条 + 循环 / 声音两个开关；画面盖在对象自己的矩形上",
    fields: [],
  },
];

/** 只由对象特性提升上来、带历史扁平字段的组件（迁移按注册表顺序处理它们）。 */
export const FEATURE_COMPONENT_TYPES: readonly ComponentTypeDef[] = COMPONENT_TYPES.filter(
  (def) => def.legacyField !== undefined,
);

/** 按历史扁平字段名查组件定义（迁移用）。 */
export function findComponentTypeByLegacyField(field: ObjectFeatureField): ComponentTypeDef | undefined {
  return COMPONENT_TYPES.find((def) => def.legacyField === field);
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
    actions: [],
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

/** 组件类型的默认数据。 */
export function defaultComponentData(type: string): Record<string, unknown> {
  const def = findComponentType(type);
  return def === undefined ? {} : defaultDataFromFields(def.fields);
}

export function isKnownComponentType(type: string): boolean {
  return BY_TYPE.has(type);
}

/** 条件值形态 → 候选项（属性面板下拉）。 */
export function conditionValueTypesFor(type: string): readonly string[] {
  return findComponentType(type)?.conditionValueTypes ?? [];
}
