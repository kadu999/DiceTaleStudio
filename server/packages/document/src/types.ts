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

/**
 * 文档格式版本。每次**结构不兼容**的改动 +1（读得回来但要换形状的，靠 `schema.ts` 的迁移）。
 *
 * v16（2026-09-22）：背景音乐与项目设置解耦——`settings.audio.bgm` 从
 * 「歌单 + 默认曲 + 名字 + 循环 + 音量」收敛成**只有音量**；曲目清单不再进文档，
 * 编辑器「音乐」弹框直接列项目 `Assets/audio/` 下的音频。v7 的协议侧同步升到 v8。
 *
 * v17（2026-09-22）：工程文件多了可选的 **`audioMeta`**（音频文件的显示名 + 标签）。
 * 它是纯编辑器的标注（不进协议、不下发 Unity），可选且**不补空壳**——
 * 与 v14 的 `video` 同一条规矩：版本号 +1 只是让老文件回写一次、从此自描述，不需要迁移函数。
 *
 * v18（2026-09-22）：标签从**字符串**改成**整数 ID + 项目级标签表**
 * （`audioTags`：下标即 tag ID，值即名字；对齐 Unity 的 TagManager）——
 * 文件里只记 `[0, 2]` 这样的 ID，改标签名只改那张表。v17 的字符串标签由
 * `migrateAudioTags` 按出现顺序建成表并换成 ID，只做一次。
 */
export const DOCUMENT_FORMAT_VERSION = 18;

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
 * 前四种对齐前端 `BackendObjectKind`；后三种是**编辑器侧新增的**：
 * - `Map`：地图就是场景里的一个对象，携带贴图与网格数据；
 * - `PlaySound`：**动作对象**（弹框里「动作」种类下的「播放声音」），基础属性与实体一样，
 *   另带「播什么 + 哪个层级」；画布上画一枚**固定的内置音频图标**（不给换贴图），
 *   编辑器**不播放**——出声是前端的事；
 * - `Teleport`：**动作对象**里的「传送阵」，另带「传送到哪一张场景」；画布上同样是
 *   **固定的内置徽标**（不给换贴图）。触发它 = **切换当前场景**（对 DM 就是「换台」），
 *   所以它**不需要新协议命令**：切场景本来就是编辑器的事，整份 `scene_push` 下去前端就换了。
 */
export type ObjectKind =
  | "Map"
  | "SceneObject"
  | "Player"
  | "Item"
  | "Event"
  | "PlaySound"
  | "Teleport";

/** 地图对象携带的数据（贴图 + 网格）。 */
export interface MapDataDoc {
  readonly image: ImageRef;
  readonly grid: GridSpec;
  readonly rowOrder: RowOrder;
  readonly cells: CellRuns;
  /**
   * 战争雾配置（v10 起；v13 起多一个总开关）。
   *
   * 格子上的 8 个类型位是**中性的「区域」**（面板上叫区域1–区域8），不与任何玩法绑定——
   * 哪个区域算雾区由这里**手动指定**。指定的区域里那些格子就是战争雾：运行时
   * （`Scripts/Presentation/FogOfWar.cs`）按「玩家进入某区域 → 揭示整片区域」处理。
   *
   * 缺省（字段不存在）= **没开战争雾**，与「开关关着、也没指定雾区」同义；没开也没指定时
   * **不写这个字段**，免得文件里留一个空壳。
   */
  readonly fog?: MapFogDoc;
}

/**
 * 战争雾：**总开关** + 把哪些「区域」当成雾区（区域位取自 `@dts/grid` 的可绘制位）。
 *
 * `enabled` 是 v13 起的**总开关**：只有开着，前端才生成那一层雾（`FogOfWar`）。
 * 关掉它 = 「这张地图现在没有战争雾」，但**雾区绑定留着**——再打开就回来，
 * 不必重新指定一遍（见 `setMapFogEnabled`）。
 */
export interface MapFogDoc {
  /**
   * 是否启用战争雾。
   *
   * schema 给默认值 `true`（与 v7 的 `active` 同理）：v10–v12 的文件里只有 `regions`——
   * 那时候**写下 `fog` 就等于「这张地图有雾」**，补成 `false` 会把老场景的雾全关掉。
   * 读出来一律带上这一项并回写一次，磁盘上的文件从此是自描述的。
   */
  readonly enabled: boolean;
  /** 指定的雾区位（如 `[8, 16]` = 区域4 + 区域5）；空数组 = 一个都没指定。 */
  readonly regions: number[];
}

/**
 * 声音层级：**固定三档**（同层同时只响一条，后来的顶掉先前的）。
 *
 * 文档里存英文 slug（与其它枚举同一个口径），中文名只在界面上出现
 * （`SOUND_LAYER_LABELS`）。分层是**声道分组**：前端按层占用声源——新的一条起了，
 * 同一层旧的那条自然停；想要两件事同时响就得分到两层。
 *
 * v15 起是**三种类型**（原「环境音 `ambient`」已删掉，老文件里的 `ambient` 在迁移时
 * 并进 `bgm`）。其中 **`bgm` 不再属于对象**：背景音乐由顶栏「音乐」弹框管
 * （点一首 → `play_bgm{clip}`），声音对象的层级只剩 `OBJECT_SOUND_LAYERS`。
 * 这一档留着是因为协议里它仍是**声道名**（前端按它选声源），
 * 也是老文件里 `layer: "bgm"` 的对象能读回来的依据。
 */
export const SOUND_LAYERS = ["bgm", "sfx", "voice"] as const;

export type SoundLayer = (typeof SOUND_LAYERS)[number];

/** 层级的中文名（面板上的下拉框；只有这里写中文）。 */
export const SOUND_LAYER_LABELS: Record<SoundLayer, string> = {
  bgm: "背景音乐",
  sfx: "音效",
  voice: "旁白",
};

/**
 * **声音对象**能选的层级（v15 起）：背景音乐已经改成全局的，对象不该再选它。
 *
 * 与 `SOUND_LAYERS` 分开是有意的：协议与迁移还要认 `bgm`（它仍是声道名），
 * 但界面上给对象的选项只有这两档（`validateScene` 会对 `layer: "bgm"` 的老对象报一条警告，
 * 让作者自己把它改成音效 / 旁白）。
 */
export const OBJECT_SOUND_LAYERS = ["sfx", "voice"] as const;

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

/**
 * 传送阵（动作对象）的数据：**加进来的候选目标场景 + 当前选中的那一个**。
 *
 * 它声明的是「**按下它就把全场换到候选里的哪一张图**」——触发一次 = 切换当前场景（编辑器 →
 * 整份 `scene_push` → 前端换镜像），所以**不需要新协议命令**。编辑器自己不「播放」任何东西。
 *
 * 分工与播放声音**完全同一套**（界面上也是两处，别混）：
 * - **候选清单**（`targets`）在「传送目标」窗口里勾 / 取消勾（场景就是项目里那些场景）；
 * - **选中哪一个**（`picked`）在属性面板上点那些小方块切——「传送」送的就是它。
 *
 * 场景名 = `Assets/scenes/<场景名>.json` 的文件名（这个仓库里场景的标识就是文件名）。
 * 代价是**场景改名不会自动跟随**：那时候选里那一条成了「不存在的场景」，界面上会写明，
 * 勾掉重选一次即可。
 */
export interface TeleportDataDoc {
  /**
   * **加进来的**候选目标场景，顺序 = 加进来的先后（没有别的语义、不排序）；空数组 = 还没加。
   *
   * 加 / 取都在「传送目标」窗口里做。一条都还没加时「传送」点不了。
   */
  readonly targets: string[];
  /**
   * 候选里**当前选中的那一个**（必须是 `targets` 里的一个）；缺省 = 还没选。
   *
   * 「传送」按钮与画布上双击徽标送的就是它。加进来一条却没被选中时，
   * 文档命令会自动选上第一条（与播放声音同一条规矩），免得面板看着有东西、按钮却是灰的。
   */
  readonly picked?: string;
}

/**
 * 视频列表（v14 起）：**地图与精灵对象**上的「放一组视频、运行时选一条播」。
 *
 * 形状与 `SoundDataDoc` 完全同一套（列表 + 选中 + 名字），另加两个**逐对象的开关**：
 * 循环与声音。区别在**归属**：声音是单独一种动作对象（`kind: "PlaySound"`），
 * 而视频挂在**对象自己身上**——因为「谁在放视频」本来就是那个地图 / 精灵的属性
 * （视频画面盖在它自己的矩形上，见 `client/.../VideoOverlay.cs`）。
 *
 * 编辑器**不播放**（没有预览、不解码）：它声明的是「告诉前端放什么」，点「播放」只是
 * 记账 + 尽力下发命令（与声音一致）。
 *
 * 分工（界面上两处，别混）：
 * - **视频列表**（`clips`）在「编辑视频」窗口里加 / 删 / 起名字；
 * - **选中哪条**（`picked`）与两个开关在属性面板上点——前端放的就是它。
 */
export interface VideoDataDoc {
  /**
   * 视频的**总开关**：只有开着前端才在放视频（关掉 = 这张地图 / 精灵现在不放视频）。
   *
   * schema 给默认值 `true`（与 `map.fog.enabled` 同一个口径）：`video` 这个字段只有
   * 「加过视频」才会写出来，所以「字段在」本来就等于「在用」——补成 `false` 会把已有的
   * 视频静默关掉。编辑器里把它呈现为「视频」那一组的**启用**开关：关着时整组只剩这一个开关，
   * 雾区 / 视频列表那些设置都收起来（与战争雾那一组的行为一致）。
   */
  readonly enabled: boolean;
  /**
   * **加进来的**视频（资源逻辑 ID，如 `project:我的项目/Assets/video/opening.mp4`）。
   *
   * 顺序 = 加进来的先后（不排序、不代表优先级）；空数组 = 这个对象还没有视频可放。
   */
  readonly clips: string[];
  /** 加进来的视频里**当前选中的那一条**（必须是 `clips` 里的一个）；缺省 = 还没选。 */
  readonly picked?: string;
  /**
   * 视频文件（资源逻辑 ID）→ **显示用的名字**；缺省 = 用素材文件名去掉扩展名。
   *
   * 与声音的 `names` 一样只是编辑器里给人看的标签：**不参与播放、也不进协议**，按文件记。
   */
  readonly names?: Record<string, string>;
  /**
   * 循环播放（v14 起）：`false`（缺省）= 播完停在最后一帧，`true` = 一直循环到按「停止」。
   *
   * 它是**这张地图 / 精灵自己的设置**（进文档、可撤销、随场景下发），不是界面偏好：
   * 背景视频要循环、过场视频只放一遍，都是场景数据的一部分。
   */
  readonly loop: boolean;
  /**
   * 是否放视频自带的声音（v14 起）：`false`（缺省）= 静音。
   *
   * 缺省静音是有意的：现场跑团时「不小心点开视频就轰一声」比听不到更糟；
   * 要出声就在面板上打开。前端对应 `VideoPlayer.audioOutputMode`。
   */
  readonly audio: boolean;
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
   * **等比缩放**：`1` = 原始尺寸（每个对象都有这个参数，新建时就是 1）。
   *
   * 它放大的是对象**自己那块矩形**（`image` / `map.image` 声明的尺寸 × scale），
   * 于是地图的贴图与**网格格子**、精灵的图片、拾取范围、选中框**一起**缩放——
   * 这四件事共用同一个矩形（见编辑器的 `displayRectOf`）。
   *
   * 位置不受影响：`position` 始终是缩放**之后**那块矩形的中心。
   *
   * 想**单轴**缩放就写 `scaleX` / `scaleY`（v11 起）：它们存在时覆盖本字段在对应轴上的值。
   * 两轴相等时一律只写 `scale`（见 `collapseScale`），所以「等比」在文件里只有这一种写法。
   */
  readonly scale: number;
  /**
   * **单轴缩放**（v11 起，可选）：存在时覆盖 `scale` 在这一轴上的值。
   *
   * 省掉它 = 用 `scale`。读的时候一律走 `effectiveScaleX` / `effectiveScaleY`，
   * **不要直接读字段**——那样会漏掉「缺省 = 用等比值」这条规则。
   *
   * 为什么不是 X / Y 两个必填字段：`scale` 从 v8 起就在文件、协议与 Unity 客户端里，
   * 保留它 + 两个可选覆盖，能让所有旧文件与旧客户端零改动继续工作。
   * 单位与值域同 `scale`（`0.01 ~ 100`，等比语义相同，只是两轴各自独立）。
   */
  readonly scaleX?: number;
  readonly scaleY?: number;
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
   * 仅 `kind === "Teleport"` 的传送阵携带：候选目标场景 + 选中的那一个。
   *
   * 与声音对象同一套口径：其余属性（位置 / 缩放 / 激活 / 锁定 / 显示顺序）跟实体完全一样，
   * 画布上是**固定的内置徽标**，所以它没有 `image`（挂了也会被忽略并警告）。
   * `teleport` 整个缺失 = 数据坏了（`validateScene` 报错），界面上按「还没加目标」显示。
   */
  readonly teleport?: TeleportDataDoc;
  /**
   * **只有地图与精灵**（`kind === "Map"` / `"SceneObject"`）携带（v14 起，可选）：
   * 视频列表 + 选中哪条 + 循环 / 声音两个开关。
   *
   * 缺省（字段不存在）= 这个对象不放视频，与「列表是空的」同义——没加视频时**不写这个字段**，
   * 免得每个对象文件里都留一个空壳。运行时前端据此决定「要不要建那一层视频」。
   */
  readonly video?: VideoDataDoc;
  /**
   * 对象要显示的图片（**精灵**就靠它显示图片；地图的贴图在 `map.image` 里）。
   *
   * 声明宽高就是它在世界里的尺寸（1 图片像素 = 1 世界像素，再乘上 `scale`），
   * 位置是它的中心——和地图贴图同一套规矩。没有图片的对象只有一块兜底矩形。
   */
  readonly image?: ImageRef;
}

/**
 * 背景音乐通道（v15 起）：**只剩音量**。
 *
 * v16 之前这里还有歌单（`clips` / `picked` / `names`）与 `loop`。那些现在都不在文档里：
 * 曲目清单**就是项目 `Assets/audio/` 下的音频文件**，由编辑器顶栏「音乐」弹框列出来给 DM 点，
 * 点一首就发一条 `play_bgm{clip}`——播放是运行动作，不需要任何声明。背景音乐恒循环。
 *
 * 于是「背景音乐与项目设置分离」这条落在这里：工程文件里关于它只剩「这条声道多大声」。
 */
export type BgmSettingsDoc = ChannelVolumeDoc;

/** 单通道音量（音效 / 旁白）：全局参数，进项目设置、不进任何对象。 */
export interface ChannelVolumeDoc {
  readonly volume: number;
}

/**
 * 项目级**全局设置**（v15 起）：目前只有音频，后面要加别的全局参数就挂在这里。
 *
 * 它整份随 `project_settings` 下发到前端：前端不解释业务，只照着调音量。
 * 前端**收到即生效**（音量不需要命令）；背景音乐「现在放哪一首」是命令，与它无关。
 */
export interface ProjectSettingsDoc {
  readonly audio: {
    /** 背景音乐通道音量（v16 起只剩这一项：歌单在编辑器弹框里，不进文档）。 */
    readonly bgm: BgmSettingsDoc;
    /** 音效通道音量。 */
    readonly sfx: ChannelVolumeDoc;
    /** 旁白通道音量。 */
    readonly voice: ChannelVolumeDoc;
  };
}

/**
 * 一个**音频文件**的标注（v17 起；v18 起标签换成整数 ID）：显示名 + 标签 ID 列表。
 *
 * 它**只是编辑器里给人看 / 找的**：不进协议、不下发给 Unity、不参与播放
 * （`play_bgm{clip}` 里仍然是资源逻辑 ID）。用途是现场快速找到那一首：
 * 「音频文件」窗口里批量起名字 / 选标签，背景音乐弹框按名字与标签搜 / 筛。
 *
 * 两条缺省语义（**都不补空壳**，与 `video` 同一个口径）：
 * - `name` 缺省 = 用素材文件名；
 * - `tags` 缺省 = 还没打标签。
 * 两项都空时这一条会被删掉（见 `commands.ts` 的 `setAudioMetaName` / `setAudioMetaTags`）。
 */
export interface AudioMetaDoc {
  /** 显示名（空 = 用素材文件名）。 */
  readonly name?: string;
  /**
   * **标签 ID 列表**——ID 就是 `ProjectDoc.audioTags` 的下标（对齐 Unity：**tag 是个整数**，
   * 名字只是它的显示文本）。规范化：去重 + 升序，改标签名不会动这里一个字节。
   */
  readonly tags?: number[];
}

/**
 * 项目级**标签表**（v18 起）：**下标就是 tag 的整数 ID**，值是这个 ID 的名字。
 *
 * 为什么这样存（Unity 的 TagManager 也是这一套）：**改名字只改这张表**，所有引用它的音频文件
 * 一个字节都不用动；反过来，如果文件里存的是字符串，改一次名字就得把每个文件都改一遍
 * （还会因为「战斗」与「战斗 」这种写法分裂成两个标签）。
 *
 * `null` = 这个 ID **被删掉了**（**留洞**）：ID 不位移，别的标签与文件上的引用都不受影响；
 * 新建标签时**优先复用第一个洞**，没有洞才往后追加。
 * 空数组 / 全 null **不写这个字段**（没标签就是「没有这一项」，不补空壳）。
 */
export type AudioTagTableDoc = (string | null)[];

/** 项目文件（project.json）：只有项目级数据；场景在 Assets/scenes/ 下各自成文件。 */
export interface ProjectDoc {
  readonly formatVersion: number;
  readonly name: string;
  readonly items: ItemLibraryDoc;
  /**
   * 项目级全局设置（v15 起）。schema **给默认值**：老 `project.json` 里没有这一项时，
   * 补一份默认的（三档音量用缺省值）并随版本升级回写一次。
   */
  readonly settings: ProjectSettingsDoc;
  /**
   * **音频文件标注**（v17 起，可选）：`资源逻辑 ID → { 显示名, 标签 ID 列表 }`。
   *
   * 缺省 = 这个项目还没整理过音频（**不补空壳**：`{}` 与「没有这一项」是两回事，
   * 后者才是事实）。它**不在 `settings` 里**——「项目设置」仍然只有三档音量；
   * 标注是**项目级数据**，与 `items`（道具库）同一档。
   */
  readonly audioMeta?: Record<string, AudioMetaDoc>;
  /**
   * **音频标签表**（v18 起，可选）：下标 = tag ID，值 = 名字（`null` = 已删除的洞）。
   *
   * 与 `audioMeta` 并列（都是项目级数据、都不进协议）。没有标签时**不写这一项**。
   */
  readonly audioTags?: AudioTagTableDoc;
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
