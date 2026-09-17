import type { RleRun } from "@dts/grid";

/**
 * 编辑器文档模型。
 *
 * 设计要点：
 * - 坐标一律是**归一化图片坐标 `[0,1]`，y 向下**（与后端协议、前端上报完全一致）；
 * - 网格格子以 RLE 存储，`rowOrder: 'bottom-up'` 显式声明「第 0 行 = 图片最下面一行」；
 * - 对象结构对齐前端：对象（主体）+ 组件 + 组件上的动作列表；
 * - 图片/音频/视频用**资源逻辑 ID**引用，不存路径。
 */

export const DOCUMENT_FORMAT_VERSION = 1;

/** 网格行序：`bottom-up` 表示 cells 第 0 行是图片最下面一行（与 Unity GridMap 一致）。 */
export type RowOrder = "bottom-up";

export interface ImageRef {
  /** 资源逻辑 ID，例如 `image:maps/Map001.png`。 */
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

/** 对象类型（对齐前端 `BackendObjectKind`）。 */
export type ObjectKind = "SceneObject" | "Player" | "Item" | "Event";

export interface SceneObjectDoc {
  readonly id: string;
  readonly name: string;
  readonly kind: ObjectKind;
  /** 归一化位置，y 向下；未放置时为 null。 */
  readonly position: NormPosition | null;
  readonly rotation: number;
  readonly components: ComponentDoc[];
}

export interface MapDoc {
  readonly id: string;
  readonly name: string;
  readonly image: ImageRef;
  readonly grid: GridSpec;
  readonly rowOrder: RowOrder;
  readonly cells: CellRuns;
  readonly spawnPoints: SpawnPointDoc[];
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

/** 编辑项目文件（`*.dtproj.json`）。 */
export interface ProjectDoc {
  readonly formatVersion: number;
  readonly name: string;
  readonly maps: MapDoc[];
  readonly items: ItemLibraryDoc;
}
