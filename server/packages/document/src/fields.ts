/**
 * 属性面板的字段描述符。
 *
 * 组件用这套字段描述符声明自己的可编辑字段，属性面板按 `kind` 选择控件。
 * 这是纯数据（不含 React），因此可被 `packages/document` 与编辑器的控件层共同复用。
 */

export type FieldKind =
  | "string"
  | "text"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "vector2"
  | "color"
  /** 对象引用：值是其他对象的 id。 */
  | "objectRef"
  /** 资源引用：值是资源逻辑 ID（贴图 / 音频 / 视频）。 */
  | "resourceRef"
  /** 字符串列表。 */
  | "stringList";

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

export interface FieldDef {
  /** 数据里的键名。 */
  readonly key: string;
  /** 面板上的标签（中文）。 */
  readonly label: string;
  readonly kind: FieldKind;
  /** 悬停提示。 */
  readonly tooltip?: string;
  /** 必填（校验用）。 */
  readonly required?: boolean;
  /** `enum` 的候选值。 */
  readonly options?: readonly FieldOption[];
  /** `number` / `integer` 的取值范围。 */
  readonly min?: number;
  readonly max?: number;
  /** `number` 的步进。 */
  readonly step?: number;
  /** `resourceRef` 限定的资源类别。 */
  readonly resourceKind?: string;
  /** `objectRef` 限定可选的 kind（不填表示任意对象）。 */
  readonly objectKinds?: readonly string[];
  /** 仅当同组件内另一字段取到指定值时显示（用于联动表单）。 */
  readonly visibleWhen?: { readonly key: string; readonly equals: unknown };
}

/** 字段描述符 → 默认值。 */
export function defaultValueFor(field: FieldDef): unknown {
  switch (field.kind) {
    case "string":
    case "text":
      return "";
    case "number":
    case "integer":
      return field.min ?? 0;
    case "boolean":
      return false;
    case "enum":
      return field.options?.[0]?.value ?? "";
    case "vector2":
      return { x: 0, y: 0 };
    case "color":
      return "#ffffff";
    case "objectRef":
    case "resourceRef":
      return "";
    case "stringList":
      return [];
    default:
      return null;
  }
}

/** 按字段列表生成一份默认数据。 */
export function defaultDataFromFields(fields: readonly FieldDef[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    data[field.key] = defaultValueFor(field);
  }

  return data;
}
