import type { RleRun } from "@dts/grid";

/**
 * 编辑器文档模型。
 *
 * 层级关系（**场景是容器，地图只是场景里的一个对象**）：
 *
 * ```
 * 项目（一个跑团 = 一个工程文件）
 * └─ 场景 SceneDoc                 ← 所有对象都在场景上
 *    ├─ 对象 SceneObjectDoc[]      ← 地图、门、宝箱、玩家、事件…都只是这里的普通对象
 *    │  ├─ 地图对象（kind = "Map"）← 携带贴图 + 网格数据
 *    │  └─ 其它对象                 ← 携带若干能力组件与动作
 *    └─ 出生点 SpawnPointDoc[]
 * ```
 *
 * 关键约定：**对象挂在场景上，不挂在地图上**——所以没有地图也能建对象；
 * 地图只是众多对象之一，且可以有多个（例如分层地图）或一个都没有。
 *
 * 其它约定：
 * - 坐标一律是**归一化图片坐标 `[0,1]`，y 向下**（与后端协议、前端上报一致）；
 * - 网格格子以 RLE 存储，`rowOrder: 'bottom-up'` 显式声明「第 0 行 = 图片最下面一行」；
 * - 图片/音频/视频用**资源逻辑 ID**引用，不存路径。
 */

export const DOCUMENT_FORMAT_VERSION = 2;

/** 网格行序：`bottom-up` 表示 cells 第 0 行是图片最下面一行（与 Unity GridMap 一致）。 */
export type RowOrder = "bottom-up";

export interface ImageRef {
  /** 资源逻辑 ID，例如 `campaign:我的跑团/images/maps/Map001.png`。 */
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface GridSpec {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
}

export interface CellRuns {
  readonly encoding: "rle";
  readonly runs: RleRun[];
}

export interface NormPosition {
  readonly x: number;
  readonly y: number;
}

export interface SpawnPointDoc {
  readonly id: string;
  readonly name: string;
  readonly position: NormPosition;
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
  /** 归一化位置，y 向下；未放置时为 null。 */
  readonly position: NormPosition | null;
  readonly rotation: number;
  readonly components: ComponentDoc[];
  /** 仅 `kind === "Map"` 的地图对象携带；其它对象没有。 */
  readonly map?: MapDataDoc;
}

/** 场景：对象容器（地图也只是它的一个对象）。 */
export interface SceneDoc {
  readonly id: string;
  readonly name: string;
  /** ★ 所有对象都在场景上 */
  readonly objects: SceneObjectDoc[];
  readonly spawnPoints: SpawnPointDoc[];
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

/** 编辑项目文件（`*.dtproj.json`）。 */
export interface ProjectDoc {
  readonly formatVersion: number;
  readonly name: string;
  readonly scenes: SceneDoc[];
  readonly items: ItemLibraryDoc;
}
