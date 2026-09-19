import type { RleRun } from "@dts/grid";

/**
 * 编辑器文档模型。
 *
 * 层级关系（**场景是容器，地图只是场景里的一个对象**；**场景各自成文件**）：
 *
 * ```
 * 项目（一个项目 = 一个文件夹 + 一个 `project.json`）
 * ├─ 项目级数据（道具库…）           ← `project.json` 里只有这些
 * └─ 场景（每个场景 = `Assets/scenes/<场景名>.json`，场景名就是文件名）
 *    └─ 对象 SceneObjectDoc[]       ← 所有对象都在场景上
 *       ├─ 地图对象（kind = "Map"） ← 携带贴图 + 网格数据
 *       └─ 其它对象                 ← 携带若干能力组件与动作
 * ```
 *
 * 关键约定：**对象挂在场景上，不挂在地图上**——所以没有地图也能建对象；
 * 地图只是众多对象之一，且可以有多个（例如分层地图）或一个都没有。
 *
 * 为什么场景要拆成独立文件：场景名即文件名，重命名/删除就是文件操作，
 * 多场景协作时也不会因为共用一个 `project.json` 而互相冲突。
 *
 * 其它约定：
 * - 坐标一律是**世界坐标**：原点 = 场景中心 `(0, 0)`，x 向右，**y 向上**，单位像素
 *   （范围 `±宽/2`、`±高/2`；换算走 `@dts/grid` 的 `world.ts`）；
 * - 网格格子以 RLE 存储，`rowOrder: 'bottom-up'` 显式声明「第 0 行 = 图片最下面一行」，
 *   也就是世界 y 最小的一行——与世界坐标同向，不需要翻转；
 * - 图片/音频/视频用**资源逻辑 ID**引用，不存路径；
 * - 每个对象都带 `active`（是否显示，对齐 Unity 的激活勾选框）与 `sortingOrder`
 *   （谁画在前面；大的盖住小的，相同则按场景里的先后顺序）。
 */

export const DOCUMENT_FORMAT_VERSION = 8;

/** 网格行序：`bottom-up` 表示 cells 第 0 行是图片最下面一行（与 Unity GridMap 一致）。 */
export type RowOrder = "bottom-up";

export interface ImageRef {
  /** 资源逻辑 ID，例如 `project:我的项目/Assets/images/Map001.png`。 */
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

/**
 * 网格规格：只有**列数 / 行数**。
 *
 * 每格的像素尺寸**不存**——它是算出来的（`贴图宽 ÷ 列数`，1920×1080 分 64×36 格就是 30×30）。
 * 存一份只会和事实不一致（v5 及更早存过一个恒为 1 的 `cellSize`，谁也没读它）。
 */
export interface GridSpec {
  readonly width: number;
  readonly height: number;
}

export interface CellRuns {
  readonly encoding: "rle";
  readonly runs: RleRun[];
}

export interface WorldPosition {
  readonly x: number;
  readonly y: number;
}

/** 动作实例（挂在组件上，与前端 `BackendComponent.actions` 一一对齐）。 */
export interface ActionInstanceDoc {
  readonly id: string;
  readonly type: string;
  readonly enabled: boolean;
  /** 触发条件；缺省表示恒满足（对齐前端 `condition == null` 语义）。 */
  readonly condition?: ConditionDoc;
  readonly params: Record<string, unknown>;
}

/** 组件条件（对齐前端 `ComponentCondition`）。 */
export interface ConditionDoc {
  readonly valueType: "Bool" | "String" | "Number" | "Integer";
  readonly op: "Equal" | "NotEqual" | "AtLeast" | "AtMost";
  readonly target: boolean | string | number;
}

export interface ComponentDoc {
  readonly id: string;
  /** 组件类型 ID，与前端组件类名一致（OptionValue / Backpack / ItemExchange / MaskImage / FloatValue / IntValue / BoolValue）。 */
  readonly type: string;
  readonly displayName?: string;
  readonly data: Record<string, unknown>;
  readonly actions: ActionInstanceDoc[];
}

/**
 * 对象类型。
 *
 * 前四种对齐前端 `BackendObjectKind`；`Map` 是**编辑器侧新增的地图对象类型**——
 * 地图就是场景里的一个对象，携带贴图与网格数据。
 */
export type ObjectKind = "Map" | "SceneObject" | "Player" | "Item" | "Event";

/** 地图对象携带的数据（贴图 + 网格）。 */
export interface MapDataDoc {
  readonly image: ImageRef;
  readonly grid: GridSpec;
  readonly rowOrder: RowOrder;
  readonly cells: CellRuns;
}

export interface SceneObjectDoc {
  readonly id: string;
  readonly name: string;
  readonly kind: ObjectKind;
  /**
   * 是否**显示**（对齐 Unity 的激活勾选框）：不激活的对象在画布上完全不画，
   * 也不参与画布上的点选与拖动——但**对象还在场景里**，属性面板照样能改。
   */
  readonly active: boolean;
  /**
   * 显示顺序：**大的画在前面**（后画 = 盖在上面），相同则按场景文件里的先后顺序。
   *
   * 与世界坐标无关，纯控制「谁挡住谁」；地图通常给一个很小的值（甚至负数）当底图。
   */
  readonly sortingOrder: number;
  /** 世界坐标位置（场景中心为原点，y 向上）；未放置时为 null。 */
  readonly position: WorldPosition | null;
  readonly rotation: number;
  /**
   * **统一缩放**：`1` = 原始尺寸（每个对象都有这个参数，新建时就是 1）。
   *
   * 它放大的是对象**自己那块矩形**（`image` / `map.image` 声明的尺寸 × scale），
   * 于是地图的贴图与**网格格子**、精灵的图片、拾取范围、选中框**一起**缩放——
   * 这四件事共用同一个矩形（见编辑器的 `displayRectOf`）。
   *
   * 位置不受影响：`position` 始终是缩放**之后**那块矩形的中心。
   * 只支持等比缩放（一个数），不做 X / Y 分开——需要非等比时再加字段。
   */
  readonly scale: number;
  readonly components: ComponentDoc[];
  /** 仅 `kind === "Map"` 的地图对象携带；其它对象没有。 */
  readonly map?: MapDataDoc;
  /**
   * 对象要显示的图片（**精灵**就靠它显示图片；地图的贴图在 `map.image` 里）。
   *
   * 声明宽高就是它在世界里的尺寸（1 图片像素 = 1 世界像素，再乘上 `scale`），
   * 位置是它的中心——和地图贴图同一套规矩。没有图片的对象只有一块兜底矩形。
   */
  readonly image?: ImageRef;
}

/** 项目文件（project.json）：只有项目级数据；场景在 Assets/scenes/ 下各自成文件。 */
export interface ProjectDoc {
  readonly formatVersion: number;
  readonly name: string;
  readonly items: ItemLibraryDoc;
}

/** 场景文件（Assets/scenes/<场景名>.json）的内容：场景名就是文件名，文件里不存名字。 */
export interface SceneFileDoc {
  readonly formatVersion: number;
  readonly objects: SceneObjectDoc[];
}

/** 内存里的场景 = 场景名（= 文件名）+ 文件内容。 */
export interface SceneDoc {
  readonly name: string;
  /** ★ 所有对象都在场景上 */
  readonly objects: SceneObjectDoc[];
}

export interface ItemDef {
  readonly name: string;
  /** 价格；null 表示价格自定。 */
  readonly price: number | null;
  readonly category: string;
  readonly identify: string;
  readonly usage: string;
}

/** 道具库（形状与 `items.json` 一致）。 */
export interface ItemLibraryDoc {
  readonly source: string;
  readonly updatedAt: string;
  readonly count: number;
  readonly items: ItemDef[];
}
