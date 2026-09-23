import { type FieldDef, type TypedFieldDef } from "./fields";

/**
 * **组件规格**：一个组件「有哪些简单字段」的声明处。
 *
 * 背景：加一个字段过去要在四个地方各写一遍（接口字段 / zod schema / 默认值常量 / 写入命令），
 * 外加属性面板的一行控件与 store 的一条 action。这里把**能被描述符表达的那部分**收成一份声明，
 * 于是「加一个布尔 / 数字 / 枚举」只需要在规格文件里加一行：
 *
 * - 默认值：`defaultDataOf` 按它拼（新建组件与兜底补壳共用一份）；
 * - 属性面板：`DescriptorRows` 按 `kind` 自动出行（testid / 行序 / tooltip 都在描述符里）；
 * - 写入：`setComponentField` 按它校验并落盘（走同一条撤销通道）。
 *
 * **三个刻意的边界**：
 * 1. 规格**只登记它接管的字段**。列表选择、播放按钮、对话框入口、以及有副作用的开关
 *    （例如 `video.enabled` 关掉时要把整个组件摘掉）**不进来**——它们继续走各自的专用命令，
 *    否则「面板给了入口、文件里留下空壳」这类不变量会被静默破坏；
 * 2. 规格**不驱动 zod**。`schema.ts` 的手写 schema 仍是解析期的唯一权威——`enabled` 那种
 *    「补成 false 会把已有视频静默关掉」的默认值语义写在长注释里，派生有静默改语义的风险；
 * 3. 规格是**纯数据、不含 React**（本包不许引 React，由 `test/architecture.test.ts` 守住）。
 *    面板侧的行序、自定义行都在编辑器里，两边按 `order` 合并排序。
 */
export interface ComponentSpec {
  /** 组件类型 ID（= 前端 C# 类名，见 `components.ts` 的 `ComponentType`）。 */
  readonly type: string;
  /** 这份规格接管的字段（自动出行 + 泛型写入）。不在这里的字段仍走各自的专用路径。 */
  readonly fields: readonly FieldDef[];
  /**
   * 新建（或补壳）这个组件时的**完整**默认数据。
   *
   * 与 `fields[].default` 的分工：描述符里的 `default` 只管「面板上缺这一项时显示什么」，
   * 这里是「文件里该写出一份什么形状」。没给就只按字段描述符拼——只接管了部分字段的组件
   * （例如视频：`clips` / `picked` 不归规格管）必须显式给出，否则补出来的组件会缺字段。
   */
  readonly defaultData?: () => Record<string, unknown>;
}

/**
 * 声明一份组件规格。
 *
 * 只做两件事：给 `TData` 一个推断位（于是 `fields[].key` 是 `keyof TData`），
 * 以及在加载期挡掉重复键——那种错在运行期表现为「改了 A 却是 B 变了」，很难查。
 */
export function defineComponent<TData>(spec: {
  readonly type: string;
  readonly fields: readonly TypedFieldDef<TData>[];
  readonly defaultData?: () => Record<string, unknown>;
}): ComponentSpec {
  const seen = new Set<string>();
  for (const field of spec.fields) {
    if (seen.has(field.key)) {
      throw new Error(`组件规格 ${spec.type} 重复声明了字段 ${field.key}`);
    }

    seen.add(field.key);
  }

  return { type: spec.type, fields: spec.fields, defaultData: spec.defaultData };
}

/** 值不被这一版泛型写入接管（未知字段 / 不在规格里的字段 / 描述符表达不了的形状）。 */
export const REJECT = Symbol("dts.reject-field-value");

/**
 * 按描述符把外部来的值收窄成**能落进文档**的值。
 *
 * 判据一律从严：类型不对、越界、不在候选里，都返回 `REJECT` 让调用方**保持文档不变**——
 * 与 `object-fields.tsx` 那批控件「非法值退回原值，不把 NaN 写进文档」是同一个口径。
 * 只在 `min` / `max` 上做夹取（那是文档自己的约束），不在类型上做「猜」。
 */
export function coerceFieldValue(field: FieldDef, value: unknown): unknown | typeof REJECT {
  switch (field.kind) {
    case "boolean":
      // 严格要 boolean：勾选框给的就是 boolean；别把字符串 "false" 当 true 收下
      return typeof value === "boolean" ? value : REJECT;

    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return REJECT;
      }

      return clamp(Math.round(value), field.min, field.max);
    }

    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return REJECT;
      }

      return clamp(value, field.min, field.max);
    }

    case "enum": {
      const options = field.options ?? [];
      return typeof value === "string" && options.some((option) => option.value === value)
        ? value
        : REJECT;
    }

    case "string":
    case "text":
      return typeof value === "string" ? value : REJECT;

    default:
      // stringList / objectRef / resourceRef / vector2 / color 各有专用命令与副作用
      // （同步 names、查资源索引…），泛型写入**不越权接管**。
      return REJECT;
  }
}

function clamp(value: number, min: number | undefined, max: number | undefined): number {
  let next = value;
  if (min !== undefined) {
    next = Math.max(min, next);
  }

  if (max !== undefined) {
    next = Math.min(max, next);
  }

  return next;
}
