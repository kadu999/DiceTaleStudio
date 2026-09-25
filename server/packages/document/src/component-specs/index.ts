import { type ComponentSpec } from "../component-spec";
import { defaultDataFromFields } from "../fields";
import { videoSpec } from "./video";

// 各组件自己的规格也原样再导出：属性面板要拿某一份具体的规格去出行
export { videoSpec } from "./video";

/**
 * **组件规格注册表**：`ComponentType` → 规格。
 *
 * 只有登记进来的组件才走「描述符自动出行 + 泛型写入」那条路；没登记的组件一切照旧
 * （面板仍是各自手写的分组视图，写入仍是各自的专用命令）。所以这是**可以一个一个搬**的：
 * 每搬一个组件，它的简单字段就少碰几处，其余组件不受影响。
 *
 * 加一份规格时**不会**有编译期提醒（`Partial` 是有意的）：没登记 = 还没搬，不是错误。
 * 反过来，登记了就必须能过 `test/component-specs.test.ts` 的那几条一致性断言。
 */
export const COMPONENT_SPECS: Readonly<Partial<Record<string, ComponentSpec>>> = {
  [videoSpec.type]: videoSpec,
};

/** 查组件规格；没登记（还没搬过来）的组件返回 `undefined`。 */
export function componentSpecOf(type: string): ComponentSpec | undefined {
  return COMPONENT_SPECS[type];
}

/**
 * 某个组件类型的**默认数据**（新建 / 补壳用）。
 *
 * 规格里给了 `defaultData` 就用它（那是「文件里该写出一份什么形状」的权威说法）；
 * 没给就按字段描述符拼（`optional` 的字段不写，理由见 `fields.ts`）。没登记规格的类型落空记录。
 *
 * 放在这里而不是 `access.ts`：它是**关于规格**的问题，不是「数据存在哪」的问题。
 * 而且组件注册表那条老的 `defaultComponentData` 已经并到这一条上——放 access 会绕出
 * `components → access → components` 的环。
 */
export function defaultDataOf(type: string): Record<string, unknown> {
  const spec = componentSpecOf(type);
  if (spec === undefined) {
    return {};
  }

  return spec.defaultData === undefined ? defaultDataFromFields(spec.fields) : spec.defaultData();
}
