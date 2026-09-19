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

export const DOCUMENT_FORMAT_VERSION = 10;

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
 * 前四种对齐前端 `BackendObjectKind`；后两种是**编辑器侧新增的**：
 * - `Map`：地图就是场景里的一个对象，携带贴图与网格数据；
 * - `PlaySound`：**动作对象**（弹框里「动作」种类下的「播放声音」），基础属性与实体一样，
 *   另带「播什么 + 哪个层级」；画布上画一枚**固定的内置音频图标**（不给换贴图），
 *   编辑器**不播放**——出声是前端的事。
 */
export type ObjectKind = "Map" | "SceneObject" | "Player" | "Item" | "Event" | "PlaySound";

/** 地图对象携带的数据（贴图 + 网格）。 */
export interface MapDataDoc {
  readonly image: ImageRef;
  readonly grid: GridSpec;
  readonly rowOrder: RowOrder;
  readonly cells: CellRuns;
  /**
   * 战争雾配置（v10 起）。
   *
   * 格子上的 8 个类型位是**中性的「区域」**（面板上叫区域1–区域8），不与任何玩法绑定——
   * 哪个区域算雾区由这里**手动指定**。指定的区域里那些格子就是战争雾：运行时
   * （`Scripts/Map/FogOfWar.cs`）按「玩家进入某区域 → 揭示整片区域」处理。
   *
   * 缺省（字段不存在）= 一个雾区都没指定，与 `{ regions: [] }` 同义；没指定时**不写这个字段**，
   * 免得文件里留一个空壳。
   */
  readonly fog?: MapFogDoc;
}

/** 战争雾：把哪些「区域」当成雾区（区域位取自 `@dts/grid` 的可绘制位）。 */
export interface MapFogDoc {
  /** 指定的雾区位（如 `[8, 16]` = 区域4 + 区域5）；空数组 = 一个都没指定。 */
  readonly regions: number[];
}

/**
 * 声音层级：**固定四档**（同层同时只响一条，后来的顶掉先前的）。
 *
 * 文档里存英文 slug（与其它枚举同一个口径），中文名只在界面上出现
 * （`SOUND_LAYER_LABELS`）。分层是**声道分组**：前端按层占用声源——「背景音乐」
 * 起了新的，旧的那条自然停；想要两件事同时响就得分到两层。
 */
export const SOUND_LAYERS = ["bgm", "ambient", "sfx", "voice"] as const;

export type SoundLayer = (typeof SOUND_LAYERS)[number];

/** 层级的中文名（面板上的下拉框；只有这里写中文）。 */
export const SOUND_LAYER_LABELS: Record<SoundLayer, string> = {
  bgm: "背景音乐",
  ambient: "环境音",
  sfx: "音效",
  voice: "语音",
};

/**
 * 播放声音（动作对象）的数据：**加进来的音频列表 + 当前选中的那条 + 层级**。
 *
 * 它声明的是「**要告诉前端播什么**」，编辑器不播放（没有试听、不解码音频），
 * 真正出声在前端。
 *
 * 分工（界面上就是两个地方，别混）：
 * - **音频列表**（`clips`）在「编辑声音」窗口里加 / 删 / 起名字；
 * - **选中哪条**（`picked`）在属性面板上点那些小方块切——前端播的就是它。
 */
export interface SoundDataDoc {
  /**
   * **加进来的**音频（资源逻辑 ID，如 `project:我的项目/Assets/audio/step1.mp3`）。
   *
   * 顺序 = 加进来的先后，没有别的语义（不排序、不代表优先级）；空数组 = 这条声音还没有
   * 任何音频可播（新建出来就是这样）。加与删都在「编辑声音」窗口里做。
   */
  readonly clips: string[];
  /**
   * 加进来的音频里**当前选中的那一条**（资源逻辑 ID，必须是 `clips` 里的一个）。
   *
   * 属性面板把它们全列出来（小方块），点一下就把 `picked` 换成它——前端播的正是这一条，
   * 所以这个选择是**场景数据**（重开项目还在，撤销能回退），不是界面偏好。
   * 缺省 = 还没选（这时「播放」按钮点不了）。
   */
  readonly picked?: string;
  /**
   * 音频文件（资源逻辑 ID）→ **显示用的名字**（例如把 `thunderstorm-30s-high` 叫成「雷雨·高」）。
   *
   * 缺省（或这一条没起名）= 用素材文件名去掉扩展名。它只是编辑器里给人看的标签：
   * **不参与播放、也不进协议**。按文件记（不是按「选中」记），所以在窗口里给哪条起名都行，
   * 换选 / 换层级都不会动它。
   */
  readonly names?: Record<string, string>;
  readonly layer: SoundLayer;
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
   * 是否**锁定**：锁住的对象**不能被移动**——画布上拖它不会动，世界坐标输入框也禁用。
   *
   * 只锁「位置」这一件事：改名 / 显示顺序 / 缩放 / 激活 / 换贴图，以及地图的网格标注
   * 都照常可改（那些都得显式操作，不会「点一下就被拖走」）。
   * 它也不阻止**选中**与**删除**——锁是为了摆场景时别误拖底图，不是为了禁用它。
   */
  readonly locked: boolean;
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
   * 仅 `kind === "PlaySound"` 的声音对象携带：音频列表 + 选中的那条 + 层级。
   *
   * 它的其余属性（位置 / 缩放 / 激活 / 锁定 / 显示顺序）与实体完全同一套；
   * 画布上的样子是**固定的内置音频图标**，所以它没有 `image`（挂了也会被忽略并警告）。
   */
  readonly sound?: SoundDataDoc;
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
