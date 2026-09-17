import type { FieldDef } from "./fields";
import { defaultDataFromFields } from "./fields";

/**
 * 组件注册表。
 *
 * 组件类型 ID 与字段严格对齐前端 `Backend/Components/*` 的序列化字段与上报数据，
 * 保证编辑器保存的组件数据能被前端直接消费。
 */

export interface ComponentTypeDef {
  /** 组件类型 ID（= 前端组件类名）。 */
  readonly type: string;
  readonly displayName: string;
  readonly fields: readonly FieldDef[];
  /** 是否渲染在属性面板（对齐前端 `GmEditable`）。 */
  readonly gmEditable: boolean;
  /** 条件比较时组件提供的值形态（对齐前端 `Satisfies` 覆写）。 */
  readonly conditionValueTypes: readonly ("Bool" | "String" | "Number" | "Integer")[];
  /** 前端命令类型（该组件能处理的后台命令），供运行态直接下发展示。 */
  readonly commandTypes: readonly string[];
  readonly tooltip?: string;
}

export const COMPONENT_TYPES: readonly ComponentTypeDef[] = [
  {
    type: "OptionValue",
    displayName: "选项值",
    gmEditable: true,
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
    conditionValueTypes: [],
    commandTypes: ["set_object_items"],
    tooltip: "玩家持有的道具列表",
    fields: [{ key: "items", label: "道具", kind: "stringList" }],
  },
  {
    type: "ItemExchange",
    displayName: "道具货源",
    gmEditable: true,
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
    conditionValueTypes: ["Number"],
    commandTypes: ["set_float"],
    fields: [{ key: "value", label: "值", kind: "number", step: 0.1 }],
  },
  {
    type: "IntValue",
    displayName: "整数值",
    gmEditable: true,
    conditionValueTypes: ["Integer"],
    commandTypes: ["set_int"],
    fields: [{ key: "value", label: "值", kind: "integer" }],
  },
  {
    type: "BoolValue",
    displayName: "布尔值",
    gmEditable: true,
    conditionValueTypes: ["Bool"],
    commandTypes: ["set_bool"],
    fields: [{ key: "value", label: "值", kind: "boolean" }],
  },
];

const BY_TYPE = new Map(COMPONENT_TYPES.map((def) => [def.type, def]));

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
