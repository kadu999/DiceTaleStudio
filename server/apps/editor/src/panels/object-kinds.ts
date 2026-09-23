import { FEATURE_COMPONENT, carriesKind, type ObjectKind } from "@dts/document";

/**
 * 对象类型表：**先分种类，种类下再放对象**。
 *
 * 种类是编辑器侧的归类（实体 / 动作 / 事件），落进文档的仍然是对象的 `kind`——
 * `kind` 是前端也认的字段，不能为了分类随意造新值。
 *
 * 这张表同时服务两处，所以每个类型带一个 `creatable`：
 * - 「新建对象」弹框只列 `creatable` 的（实体 → 网格地图 / 精灵 / 贴图；动作 → 播放声音）；
 * - 场景对象面板**按种类过滤**，所以每个 `kind` 都要有归属，不能留没种类的类型。
 *
 * **每个类型自带 `id` 与 `label`，不要拿 `kind` 当它们用**：
 * - 「网格地图」「精灵」「贴图」是三个**显示名不同的实体类型**，落进文档的 `kind` 是
 *   文档级的值——网格地图 `Map`、精灵 `Sprite`、贴图 `Image`（v22 起：精灵以前写的是基类
 *   `SceneObject`、贴图以前叫 `Texture`），所以同一个 kind 可以在表里出现多次（现在没有，
 *   但表的设计允许），而名字是**每个类型自己的**。
 * - 弹框的瓦片 key / 选中态一律用 `id`（用 `kind` 会让同 kind 的两个瓦片共用 key、点一个
 *   另一个跟着亮），名字用 `label`（`KIND_LABELS[kind]` 给的是 kind 的规范名，
 *   不一定等于瓦片上的名字）。
 *
 * **`SceneObject` 只作为归类项留在表里**（`creatable: false`）：它是所有场景对象的**抽象基类**
 * （层级在 `@dts/document` 的 `kinds.ts`），所有具体类型都继承它——没有对象会带着这个 kind
 * 落进文档（老文件里的由 v22 迁移改成 `Sprite`）。留在表里是为了两条既有规矩：
 * **每个 kind 都要有种类归属**（面板按种类过滤，手写文件里真出现这个值时不能凭空消失），
 * 以及 `KIND_LABELS` 是 `Record<ObjectKind, string>`（少一个键就编译不过）。
 *
 * 「播放声音」是**动作**种类下的第一个对象：`kind: "PlaySound"` 是编辑器侧新增的
 * （前端要认它，但**不为它建可见物**——动作对象只留数据，见 README 的契约一节）。
 * 基础属性与实体一模一样（位置 / 缩放 / 激活 / 锁定 / 显示顺序），画布上画一枚**固定的内置音频图标**，
 * 另带「音频列表 + 层级」——它声明的是「告诉前端播什么」，编辑器自己**不播放**。
 *
 * 「传送阵」是动作种类下的第二个：`kind: "Teleport"`，同样画一枚固定的内置徽标（也只在编辑器的
 * 画布上，前端不建可见物），另带「传送到哪一张场景」。触发它 = **切换当前场景**（编辑器 →
 * 整份 `scene_push` → 前端换镜像），所以它**不需要新协议命令**。
 *
 * 「贴图」是实体种类下的第三个：`kind: "Image"`，**只负责把一张图渲染出来**——和精灵一样挑一张图
 * 显示，唯一的区别是它**不引用图集里的格子**（选择时不显示子精灵）。数据上两者用**不同的图片组件**
 * （贴图 `ImageLayer`、精灵 `SpriteLayer`），
 * 而「视频」那一组只对地图与贴图出现（`supportsVideo`）。
 */

export interface ObjectTypeDef {
  /** 这个**类型**在表里的稳定标识（弹框瓦片 key / 选中态用它；两个类型可以共用同一个 `kind`）。 */
  readonly id: string;
  readonly kind: ObjectKind;
  /** 展示名（**只有这里与 `KIND_LABELS` 写中文**）。 */
  readonly label: string;
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
      { id: "Map", kind: "Map", label: "网格地图", creatable: true },
      // 精灵 = 场景对象这条线上的具体类型（v22 起有自己的 kind `Sprite`；以前写的是基类 `SceneObject`）
      { id: "Sprite", kind: "Sprite", label: "精灵", creatable: true },
      // 贴图 = 只显示一张图（不切子图）。kind 是编辑器侧新增的 `Image`（v21 时叫 `Texture`），前端按它给占位色
      { id: "Image", kind: "Image", label: "贴图", creatable: true },
      // 基类本身不可创建：没有「什么都不指定」的对象，落进文档的永远是具体类型。
      // 它只参与归类（手写文件里真写了这个值时，面板照样把它列在实体里）
      { id: "SceneObject", kind: "SceneObject", label: "场景对象", creatable: false },
      { id: "Player", kind: "Player", label: "玩家", creatable: false },
      { id: "Item", kind: "Item", label: "道具", creatable: false },
    ],
  },
  {
    id: "action",
    label: "动作",
    objects: [
      { id: "PlaySound", kind: "PlaySound", label: "播放声音", creatable: true },
      { id: "Teleport", kind: "Teleport", label: "传送阵", creatable: true },
    ],
  },
  { id: "event", label: "事件", objects: [{ id: "Event", kind: "Event", label: "事件", creatable: false }] },
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
  // 基类：它不落进文档，所以这个名字只可能在「手写文件写了这个值」时露出来
  SceneObject: "场景对象",
  Sprite: "精灵",
  Image: "贴图",
  Map: "网格地图",
  Player: "玩家",
  Item: "道具",
  Event: "事件",
  PlaySound: "播放声音",
  Teleport: "传送阵",
};
