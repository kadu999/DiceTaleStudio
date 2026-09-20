import type { SceneObjectDoc } from "./types";

/**
 * 对象缩放的**单一事实来源**：等比 `scale` 与单轴 `scaleX` / `scaleY` 的关系。
 *
 * 为什么不把 `scale` 换掉：`scale` 是 v8 起就在文件里、协议里、Unity 客户端里的字段，
 * 语义是「等比，两轴都用它」。**保留它**，再加两个**可选**的单轴字段来覆盖——
 * 于是老文件、老客户端、老协议解析全都照旧工作，非等比是纯增量能力。
 *
 * 规则只有两条：
 * 1. **有效值**一律经 `effectiveScaleX` / `effectiveScaleY` 取，不要直接读字段
 *    （直接读会漏掉「单轴字段缺省 = 用 `scale`」这条）。
 * 2. **写盘前**一律经 `collapseScale` 归一：两轴相等就收敛回单个 `scale`。
 *    少了这一步会出两个问题——等比对象也会写出两轴字段（没更新的 Unity 客户端
 *    拿不到那个语义），而且反复拖手柄的浮点误差会把「其实等比」的对象永远钉在非等比形态。
 */

/**
 * 缩放的取值范围。
 *
 * `1` = 原始尺寸（新建对象就是这个值）。上下限是给**输入框与手柄**兜底的：0 会让对象
 * 变成不可见 / 不可点的零面积矩形，极大值则会把贴图与网格算成天文数字；
 * 夹在 `0.01 ~ 100`（1% ~ 100 倍）足够表达实际需求，也不至于把画布算坏。
 */
export const DEFAULT_OBJECT_SCALE = 1;
export const MIN_OBJECT_SCALE = 0.01;
export const MAX_OBJECT_SCALE = 100;

/** 判断两轴是否「相等」的相对误差：小于它就算等比，折叠回单个 `scale`。 */
const UNIFORM_EPSILON = 1e-4;

/**
 * 把一个缩放值夹到合法范围（**写路径**：输入框 / 拖拽提交时用）。
 *
 * 「夹而不拒」是有意的，也是既有行为：输入框里敲出 `0` / 负数 / 超大值都夹到
 * `0.01 ~ 100`——用户敲 0 想表达「小到看不见」，给他 1% 比拒绝更符合预期。
 * 只有 `NaN` / `Infinity`（留空、敲了字母、算坏了）才返回 `undefined` 让调用方拒绝。
 *
 * **不要拿它当读路径的兜底**：读的时候把坏数据夹成 `0.01` 会把「文件写坏了」
 * 伪装成「对象特别小」，那是另一回事——读路径见 `effectiveScaleX`。
 */
export function clampObjectScale(scale: number): number | undefined {
  if (!Number.isFinite(scale)) {
    return undefined;
  }

  return Math.min(MAX_OBJECT_SCALE, Math.max(MIN_OBJECT_SCALE, scale));
}

/**
 * 一个轴上**实际生效**的缩放值（**读路径**：渲染 / 拾取 / 手柄用它）。
 *
 * 取值顺序：单轴字段 → 等比 `scale` → 兜底 `1`。
 * 坏值（非有限数 / `<= 0`）**退回下一层，而不是夹成 `0.01`**：画布上正确的做法是
 * 按原始尺寸画出来（看得见、点得到），让 `validateScene` 去报那个坏数字；
 * 夹成 0.01 会让对象变成一个几乎点不到的点，看起来像「对象没了」。
 * 所以这里的判定自己写一遍，不图省事复用写路径的夹取。
 */
function axisScale(axis: number | undefined, uniform: number): number {
  const candidate = axis !== undefined && Number.isFinite(axis) && axis > 0 ? axis : uniform;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return DEFAULT_OBJECT_SCALE;
  }

  return Math.min(candidate, MAX_OBJECT_SCALE);
}

/** 对象在 **X 轴**上实际生效的缩放值（画布宽度、拾取矩形、手柄都用它）。 */
export function effectiveScaleX(object: SceneObjectDoc): number {
  return axisScale(object.scaleX, object.scale);
}

/** 对象在 **Y 轴**上实际生效的缩放值（画布高度、拾取矩形、手柄都用它）。 */
export function effectiveScaleY(object: SceneObjectDoc): number {
  return axisScale(object.scaleY, object.scale);
}

/** 两轴是否等比（在 `UNIFORM_EPSILON` 的相对误差内）。 */
export function isUniformScale(x: number, y: number): boolean {
  const largest = Math.max(Math.abs(x), Math.abs(y));
  if (largest === 0) {
    return true;
  }

  return Math.abs(x - y) / largest <= UNIFORM_EPSILON;
}

/**
 * 把一个对象的缩放**归一化**成规范形式（写盘与推送前调用）。
 *
 * - 两轴有效值相等 → 只留 `scale`，**删掉** `scaleX` / `scaleY`；
 * - 两轴不等 → `scale` 归 `1`（它不再是这两个轴的值），`scaleX` / `scaleY` 各写各的。
 *
 * 返回新对象（不改原对象）：文档是不可变数据，且调用方常常只需要一个投影。
 */
export function collapseScale(object: SceneObjectDoc): SceneObjectDoc {
  const x = effectiveScaleX(object);
  const y = effectiveScaleY(object);
  const alreadyUniform = object.scaleX === undefined && object.scaleY === undefined;

  if (isUniformScale(x, y)) {
    // 已经是「只有 scale」的形状就不必造新对象：序列化每帧都可能跑，能省则省。
    // 折叠时把两个轴字段**整个摘掉**（而不是置 undefined）——文档是会被 JSON.stringify
    // 出去的数据，少一个键就是少一个键，别指望序列化替我们收拾。
    if (alreadyUniform && object.scale === x) {
      return object;
    }

    const { scaleX: _scaleX, scaleY: _scaleY, ...rest } = object;
    return { ...rest, scale: x };
  }

  if (object.scale === DEFAULT_OBJECT_SCALE && object.scaleX === x && object.scaleY === y) {
    return object;
  }

  return { ...object, scale: DEFAULT_OBJECT_SCALE, scaleX: x, scaleY: y };
}
