import type { ObjectKind } from "@dts/document";

/**
 * 对象类型表：**先分种类，种类下再放对象**。
 *
 * 种类是编辑器侧的归类（实体 / 动作 / 事件），落进文档的仍然是对象的 `kind`——
 * `kind` 是前端也认的字段，不能为了分类随意造新值。
 *
 * 这张表同时服务两处，所以每个类型带一个 `creatable`：
 * - 「新建对象」弹框只列 `creatable` 的（现在有 实体 → 网格地图 / 精灵）；
 * - 场景对象面板**按种类过滤**，所以每个 `kind` 都要有归属，不能留没种类的类型。
 *
 * 「网格地图」与「精灵」是两个**显示名不同的实体类型**，但精灵复用文档里既有的
 * `SceneObject` kind——即精灵就是场景里的普通对象，前端已经认这个值，不需要新枚举。
 * `ObjectTypeDef.kind` 因此不是一一对应的：同一个 kind 可以在表里出现多次。
 */

export interface ObjectTypeDef {
  readonly kind: ObjectKind;
  /** 现在能不能从「新建对象」弹框创建；还没做的类型先只参与归类。 */
  readonly creatable: boolean;
}

export interface ObjectCategoryDef {
  readonly id: string;
  readonly label: string;
  readonly objects: readonly ObjectTypeDef[];
}

export const OBJECT_CATEGORIES: readonly ObjectCategoryDef[] = [
  {
    id: "entity",
    label: "实体",
    objects: [
      { kind: "Map", creatable: true },
      // 精灵 = 场景里的普通对象（复用 SceneObject kind），只是显示名叫「精灵」
      { kind: "SceneObject", creatable: true },
      { kind: "Player", creatable: false },
      { kind: "Item", creatable: false },
    ],
  },
  { id: "action", label: "动作", objects: [] },
  { id: "event", label: "事件", objects: [{ kind: "Event", creatable: false }] },
];

/** 该种类下**现在能创建**的对象类型（弹框只列这些）。 */
export function creatableObjects(category: ObjectCategoryDef): readonly ObjectTypeDef[] {
  return category.objects.filter((object) => object.creatable);
}

/** 打开弹框时默认选中的种类：第一个「有可创建对象」的。 */
export const DEFAULT_CATEGORY: ObjectCategoryDef =
  OBJECT_CATEGORIES.find((category) => creatableObjects(category).length > 0) ??
  OBJECT_CATEGORIES[0]!;

/** 对象属于哪个种类（面板按种类过滤用；每个 `kind` 都有归属）。 */
export function categoryOfKind(kind: ObjectKind): ObjectCategoryDef | undefined {
  return OBJECT_CATEGORIES.find((category) =>
    category.objects.some((object) => object.kind === kind),
  );
}

/** 对象类型的展示名（弹框的瓦片、面板的提示共用）。**只有这里写中文**，代码一律用英文。 */
export const KIND_LABELS: Record<ObjectKind, string> = {
  Map: "网格地图",
  SceneObject: "精灵",
  Player: "玩家",
  Item: "道具",
  Event: "事件",
};
