import { type FieldDef, type TypedFieldDef } from "./fields";
import type { GameObjectDoc } from "./types";

/**
 * **对象自身字段的规格**（GameObject 的「基础」那一组）。
 *
 * 与组件规格（`component-spec.ts`）是同一个机制的两种落点：组件规格管 `object.components[].data`，
 * 这份管 `object` 自己的字段（`name` / `active` / `position` / …）。
 * 存在的理由和组件那份一样——**让「加一个简单字段」只改一处**：描述符写在这里，
 * 泛型写入（`setObjectField`）与属性面板的行（`DescriptorRows`）都从它派生。
 *
 * ## v26 起这张表是空的
 *
 * 过去这里只登记 `sortingOrder`。v26 把显示顺序搬进了**渲染组件**（网格地图 / 图片层），
 * 于是对象自己一个「无专属语义的标量字段」都不剩了——这张表随之清空，**机制保留给
 * 下一个这样的字段**（例如「翻转 X」）。
 *
 * 其余基础字段**各有一件描述符表达不了的语义**，所以从来就留在各自的手写路径上：
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
 * **下一个普通的标量字段**准备的：那时候只需要在这里加一行。
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
 * 对象自身的字段规格：**v26 起为空**。
 *
 * 显示顺序搬进了渲染组件（`GridMap` 的 data / 图片层的 data），写入走
 * `setRenderSortingOrder`（它按「先地图、后图片层」路由，泛型写入表达不了）。
 */
export const OBJECT_SPEC = defineObjectSpec<GameObjectDoc>({
  fields: [],
});

/** 查对象字段描述符（没登记 = 不归规格管，调用方据此返回「无变更」）。 */
export function objectFieldOf(key: string): FieldDef | undefined {
  return OBJECT_SPEC.fields.find((field) => field.key === key);
}
