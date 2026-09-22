import { FEATURE_COMPONENT, carriesKind, type ObjectKind } from "@dts/document";

/**
 * 对象类型表：**先分种类，种类下再放对象**。
 *
 * 种类是编辑器侧的归类（实体 / 动作 / 事件），落进文档的仍然是对象的 `kind`——
 * `kind` 是前端也认的字段，不能为了分类随意造新值。
 *
 * 这张表同时服务两处，所以每个类型带一个 `creatable`：
 * - 「新建对象」弹框只列 `creatable` 的（实体 → 网格地图 / 精灵；动作 → 播放声音）；
 * - 场景对象面板**按种类过滤**，所以每个 `kind` 都要有归属，不能留没种类的类型。
 *
 * 「网格地图」与「精灵」是两个**显示名不同的实体类型**，但精灵复用文档里既有的
 * `SceneObject` kind——即精灵就是场景里的普通对象，前端已经认这个值，不需要新枚举。
 * `ObjectTypeDef.kind` 因此不是一一对应的：同一个 kind 可以在表里出现多次。
 *
 * 「播放声音」是**动作**种类下的第一个对象：`kind: "PlaySound"` 是编辑器侧新增的
 * （前端要认它，但**不为它建可见物**——动作对象只留数据，见 README 的契约一节）。
 * 基础属性与实体一模一样（位置 / 缩放 / 激活 / 锁定 / 显示顺序），画布上画一枚**固定的内置音频图标**，
 * 另带「音频列表 + 层级」——它声明的是「告诉前端播什么」，编辑器自己**不播放**。
 *
 * 「传送阵」是动作种类下的第二个：`kind: "Teleport"`，同样画一枚固定的内置徽标（也只在编辑器的
 * 画布上，前端不建可见物），另带「传送到哪一张场景」。触发它 = **切换当前场景**（编辑器 →
 * 整份 `scene_push` → 前端换镜像），所以它**不需要新协议命令**。
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
  {
    id: "action",
    label: "动作",
    objects: [
      { kind: "PlaySound", creatable: true },
      { kind: "Teleport", creatable: true },
    ],
  },
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

/**
 * 这个类型画的是**固定内置徽标**吗（动作对象）？返回徽标名，普通对象返回 `undefined`。
 *
 * 抽成一个函数是因为「哪种对象不认贴图」在三个地方要用，各写一遍 `kind === "PlaySound"`
 * 迟早会漏掉新加的那一种：
 * 1. 画布上画什么（徽标还是 `image` / `map.image`；尺寸也按徽标那块固定矩形算）；
 * 2. 属性面板要不要给「渲染」那一组（固定徽标就没有换贴图的入口）；
 * 3. 列表行尾显示什么提示（层级 / 目标场景）。
 */
export function badgeIconOf(kind: ObjectKind): "audio" | "teleport" | undefined {
  if (carriesKind(FEATURE_COMPONENT.sound, kind)) {
    return "audio";
  }

  return carriesKind(FEATURE_COMPONENT.teleport, kind) ? "teleport" : undefined;
}

/** 对象类型的展示名（弹框的瓦片、面板的提示共用）。**只有这里写中文**，代码一律用英文。 */
export const KIND_LABELS: Record<ObjectKind, string> = {
  Map: "网格地图",
  SceneObject: "精灵",
  Player: "玩家",
  Item: "道具",
  Event: "事件",
  PlaySound: "播放声音",
  Teleport: "传送阵",
};
