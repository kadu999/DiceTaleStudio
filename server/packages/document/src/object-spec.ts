import { type FieldDef, type TypedFieldDef } from "./fields";
import type { GameObjectDoc } from "./types";

/**
 * **对象自身字段的规格**（GameObject 的「基础」那一组）。
 *
 * 与组件规格（`component-spec.ts`）是同一个机制的两种落点：组件规格管 `object.components[].data`，
 * 这份管 `object` 自己的字段（`name` / `active` / `sortingOrder` / …）。
 * 存在的理由和组件那份一样——**让「加一个简单字段」只改一处**：描述符写在这里，
 * 泛型写入（`setObjectField`）与属性面板的行（`DescriptorRows`）都从它派生。
 *
 * ## 为什么只有 `sortingOrder` 进来了
 *
 * 其余六个基础字段**各有一件描述符表达不了的语义**，所以刻意留在各自的手写路径上：
 *
 * | 字段 | 为什么不能进规格 |
 * |---|---|
 * | `name` | 改名要连带同步引用它的贴图（`withRenamedSceneImage`），且空名字要拒 |
 * | `active` / `locked` | 专用写入会往运行日志里写一条（「已显示 / 已锁定对象」），泛型写入没有这一层 |
 * | `position` | `position: null`（未放置）是合法状态，面板上要多一个「落位」按钮 |
 * | `scale` | 等比 / 单轴两态：等比锁是界面状态，且两轴改回相等要折叠回等比 |
 * | `rotation` | 文档里存弧度、面板显示度，且越界要归一化到 `(-180, 180]` |
 *
 * 「有专属语义」不是坏味道——它说明这些字段确实比一个标量复杂。规格这条路是给
 * **下一个普通的标量字段**（例如「翻转 X」这种）准备的：那时候只需要在这里加一行。
 */
export interface ObjectSpec {
  /** 这份规格接管的字段（自动出行 + 泛型写入）。不在这里的字段仍走各自的专用路径。 */
  readonly fields: readonly FieldDef[];
}

/** 声明对象字段规格（与 `defineComponent` 同一个套路：给 `TData` 一个推断位 + 挡重复键）。 */
export function defineObjectSpec<TData>(spec: {
  readonly fields: readonly TypedFieldDef<TData>[];
}): ObjectSpec {
  const seen = new Set<string>();
  for (const field of spec.fields) {
    if (seen.has(field.key)) {
      throw new Error(`对象字段规格重复声明了字段 ${field.key}`);
    }

    seen.add(field.key);
  }

  return { fields: spec.fields };
}

/**
 * `sortingOrder` 的取值范围：足够表达「垫底 / 顶层」，又不至于让界面上的数字失控。
 *
 * 与 `setObjectSortingOrder` 过去那个模块私有常量是同一个值（`±9999` + 取整）——
 * 挪到规格里是因为「范围」本来就是**这个字段的属性**，而不是某条命令的实现细节。
 */
const SORTING_ORDER_LIMIT = 9999;

/**
 * 对象自身的字段规格。
 *
 * 范围写在描述符上，于是 `coerceFieldValue` 的 `Math.round` + 夹取与过去
 * `setObjectSortingOrder` 的语义**逐字一致**（那条命令现在只是转发到这里）。
 */
export const OBJECT_SPEC = defineObjectSpec<GameObjectDoc>({
  fields: [
    {
      key: "sortingOrder",
      label: "显示顺序",
      kind: "integer",
      default: 0,
      min: -SORTING_ORDER_LIMIT,
      max: SORTING_ORDER_LIMIT,
      step: 1,
      coalesce: true,
      testId: "inspector-object-sorting",
      order: 50,
      tooltip: "大的画在前面（盖住小的）；相同则按场景对象列表里的先后",
    },
  ],
});

/** 查对象字段描述符（没登记 = 不归规格管，调用方据此返回「无变更」）。 */
export function objectFieldOf(key: string): FieldDef | undefined {
  return OBJECT_SPEC.fields.find((field) => field.key === key);
}
