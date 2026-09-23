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
  /**
   * 数据里的键名。
   *
   * 这里**刻意保持 `string`**、不写成 `keyof TData`：`FieldDef<T>` 会让 `keyof T` 落在 T 的
   * 逆变位置、把整个接口变成不变的，于是「规格里的字段」赋给「泛型字段列表」会失败。
   * 「键必须真的在这份数据上」那条约束改由**同文件的 `TypedFieldDef<TData>`** 在
   * `defineComponent` / `defineObjectSpec` 的**入参**上把住——编译期一样报错，
   * 接口本身保持简单可变。
   */
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

  // ---------------------------------------------------------------- 组件规格用的补充说明
  //
  // 下面这几个是「一个组件一个规格文件」那套机制的输入：默认值、面板行序与 testid、
  // 撤销合并。全部可选，于是既有的 `FieldDef` 用法（`COMPONENT_TYPES[].fields`）不受影响。

  /** 默认值（新建组件 / 手写文件缺这一项时的兜底）。 */
  readonly default?: unknown;
  /** `true` = 缺省时字段整个不写（对应 zod 的 `.optional()`，与「有默认值」互斥）。 */
  readonly optional?: boolean;
  /**
   * 面板控件的 `data-testid`。
   *
   * **显式给出**而不是按 `key` 拼：既有的 testid 是测试与 e2e 的契约
   * （`video-loop` / `video-audio` / `video-auto-play` …），拼字符串会让重构变成「改一堆断言」。
   */
  readonly testId?: string;
  /** 面板上的行序（与组件自己的自定义行一起排序；留空 = 0，排在最前面）。 */
  readonly order?: number;
  /** 连续输入合并成一条撤销记录（数值 / 文本输入框用）。 */
  readonly coalesce?: boolean;
}

/**
 * 有类型约束的字段描述符：`key` 必须**真的是**这份数据上的键。
 *
 * 「键名写错要编译报错」这条约束只能落在**入参**上（`defineComponent` / `defineObjectSpec`），
 * 不能写进 `FieldDef` 本身：`keyof TData` 一旦进类型参数，`keyof` 就落在逆变位置、
 * 把整个接口变成不变的，于是「规格里的字段」赋不进「泛型字段列表」。约束入参既拿到检查，
 * 又让规格保持一个普通可变的形状、能按 `string` 索引。
 */
export type TypedFieldDef<TData> = FieldDef & { readonly key: keyof TData & string };

/**
 * 字段描述符 → 默认值。
 *
 * 组件规格里写了 `default` 就以它为准（那是最贴近这块数据的说法）；没写才按 `kind` 兜底。
 */
export function defaultValueFor(field: FieldDef): unknown {
  if (field.default !== undefined) {
    return field.default;
  }

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

/**
 * 按字段列表生成一份默认数据。
 *
 * **`optional: true` 的字段一个都不写**：可选字段的「没写」本身有语义（例如「还没选哪一条」），
 * 补一个空壳反而会把它变成「选了一个空值」——与 `schema.ts` 里 `.optional()` 那些字段同一个口径。
 */
export function defaultDataFromFields(fields: readonly FieldDef[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.optional === true) {
      continue;
    }

    data[field.key] = defaultValueFor(field);
  }

  return data;
}
