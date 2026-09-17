import type { ComponentDoc, ConditionDoc } from "@dts/document";

/**
 * 条件求值。
 *
 * 语义与前端 `ComponentCondition.Compare` **逐条对齐**（含字符串忽略大小写、
 * 类型不符返回 false、Bool/String 只支持 Equal/NotEqual）。
 * 将来若把条件求值搬到服务端权威，必须继续以这里为唯一语义来源，并加对照测试。
 */

export type ConditionValue = boolean | string | number;

/** 条件缺省（未配置）视为恒满足——对齐前端 `condition == null` 的语义。 */
export function conditionAlwaysMet(condition?: ConditionDoc): boolean {
  return condition === undefined || condition === null;
}

function compareBool(op: ConditionDoc["op"], actual: boolean, target: boolean): boolean {
  switch (op) {
    case "Equal":
      return actual === target;
    case "NotEqual":
      return actual !== target;
    default:
      return false; // Bool 只支持等于/不等于
  }
}

function compareString(op: ConditionDoc["op"], actual: string, target: string): boolean {
  // 对齐前端 StringComparison.OrdinalIgnoreCase：仅忽略大小写，不做区域化折叠
  const equal = actual.toLowerCase() === target.toLowerCase();
  switch (op) {
    case "Equal":
      return equal;
    case "NotEqual":
      return !equal;
    default:
      return false; // String 只支持等于/不等于
  }
}

function compareNumber(op: ConditionDoc["op"], actual: number, target: number): boolean {
  switch (op) {
    case "Equal":
      return actual === target;
    case "NotEqual":
      return actual !== target;
    case "AtLeast":
      return actual >= target;
    case "AtMost":
      return actual <= target;
    default:
      return false;
  }
}

/**
 * 单一比较入口：`actual` 的类型与条件声明的 `valueType` 不符时返回 false（视为配置错误）。
 */
export function compareCondition(condition: ConditionDoc, actual: unknown): boolean {
  switch (condition.valueType) {
    case "Bool":
      return typeof actual === "boolean" && typeof condition.target === "boolean"
        ? compareBool(condition.op, actual, condition.target)
        : false;

    case "String":
      return typeof actual === "string" && typeof condition.target === "string"
        ? compareString(condition.op, actual, condition.target)
        : false;

    case "Number":
      return typeof actual === "number" && typeof condition.target === "number"
        ? compareNumber(condition.op, actual, condition.target)
        : false;

    case "Integer":
      return typeof actual === "number" &&
        Number.isInteger(actual) &&
        typeof condition.target === "number"
        ? compareNumber(condition.op, actual, condition.target)
        : false;

    default:
      return false;
  }
}

/**
 * 从组件数据取出「该条件要比较的实际值」，对齐前端各组件的 `Satisfies` 覆写：
 * - `BoolValue` → Bool = value
 * - `IntValue` → Integer = value
 * - `FloatValue` → Number = value
 * - `OptionValue` → String = 当前选项名；Integer = 当前选项索引
 * 其余组件/形态返回 undefined（前端默认 `Satisfies` 返回 false）。
 */
export function actualValueFor(
  component: ComponentDoc,
  valueType: ConditionDoc["valueType"],
): ConditionValue | undefined {
  switch (component.type) {
    case "BoolValue":
      return valueType === "Bool" && typeof component.data.value === "boolean"
        ? component.data.value
        : undefined;

    case "IntValue":
      return valueType === "Integer" && typeof component.data.value === "number"
        ? component.data.value
        : undefined;

    case "FloatValue":
      return valueType === "Number" && typeof component.data.value === "number"
        ? component.data.value
        : undefined;

    case "OptionValue": {
      const options = Array.isArray(component.data.options)
        ? component.data.options.filter((item): item is string => typeof item === "string")
        : [];
      const current = typeof component.data.current === "string" ? component.data.current : undefined;
      if (valueType === "String") {
        return current;
      }

      if (valueType === "Integer") {
        return current === undefined ? undefined : options.indexOf(current);
      }

      return undefined;
    }

    default:
      return undefined;
  }
}

/**
 * 完整求值：条件缺省 → 满足；否则取组件实际值并按条件语义比较。
 */
export function evaluateCondition(
  component: ComponentDoc,
  condition?: ConditionDoc,
): boolean {
  if (conditionAlwaysMet(condition) || condition === undefined) {
    return true;
  }

  const actual = actualValueFor(component, condition.valueType);
  if (actual === undefined) {
    return false;
  }

  return compareCondition(condition, actual);
}

/** 条件的人类可读描述（属性面板与运行态日志用）。 */
export function describeCondition(condition?: ConditionDoc): string {
  if (conditionAlwaysMet(condition) || condition === undefined) {
    return "无条件（总是执行）";
  }

  const symbols: Record<ConditionDoc["op"], string> = {
    Equal: "=",
    NotEqual: "≠",
    AtLeast: "≥",
    AtMost: "≤",
  };

  return `${condition.valueType} ${symbols[condition.op]} ${JSON.stringify(condition.target)}`;
}
