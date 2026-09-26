import type { RleRun } from "@dts/grid";
// 对象类型（= 预设 id）住在 `presets.ts`（那张表是「哪个 kind 允许哪个能力槽位」的唯一归属地）。
// **只 import 不转出口**：barrel 里 `./presets` 已经把它导出去了，两处都 `export *`
// 会让这个同名类型变成「来源不明」，TS 会直接报重名。
import type { ObjectKind } from "./presets";

/**
 * 编辑器文档模型。
 *
 * 层级关系（**场景是容器，地图只是场景里的一个对象**；**场景各自成文件**）：
 *
 * ```
 * 项目（一个项目 = 一个文件夹 + 一个 `project.json`）
 * ├─ 项目级数据（道具库…）           ← `project.json` 里只有这些
 * └─ 场景（每个场景 = `Assets/scenes/<场景名>.json`，场景名就是文件名）
 *    └─ 对象 GameObjectDoc[]       ← 所有对象都在场景上
 *       ├─ 地图对象（kind = "Map"） ← 携带贴图 + 网格数据
 *       └─ 其它对象                 ← 携带若干能力组件
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
 * - 每个对象都带 `active`（是否显示，对齐 Unity 的激活勾选框）；`sortingOrder`
 *   （谁画在前面；大的盖住小的，相同则按场景里的先后顺序）自 v26 起住在**渲染组件**里
 *   （`GridMap` 的 data / 图片层的 data），**没有渲染层的对象没有这个参数**。
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
 *
 * v19（2026-09-22）：**对象特性搬进组件**。`map` / `image` / `sound` / `teleport` / `video`
 * 这 5 个扁平字段变成 `components[]` 里的实例（`GridMap` / `TextureRenderer` / `PlaySound` /
 * `Teleport` / `VideoOverlay`），由 `migrateFeaturesToComponents` 搬一次。
 * 于是「对象 = 实体（id / 名字 / 变换 / 可见性 / 排序）+ 组件列表」，加一个新特性
 * 只需要往组件注册表里加一条，不用再改校验、序列化、协议与客户端解析各一处。
 *
 * v20（2026-09-22）：**精灵（子图）**——图片引用多了可选的 `sprite`（引用工程里那张图的
 * 切分表第几格），工程文件多了可选的 `spriteSheets`（`图片逻辑 ID → 行×列`，**切分只有这一份**）。
 * 两项都是可选的新字段，没有迁移函数（照 v17 `audioMeta` 的先例：+1 只是让老文件回写一次、
 * 从此自描述）。协议侧同步升到 v10：切分要随载荷走（客户端没有工程文件），
 * 老客户端不认这一项会把整张图集铺出来——那是可见的错误，必须靠握手挡住。
 *
 * v21（2026-09-23）：**实体多一个「贴图」对象，精灵与贴图各用自己的图片组件**。
 * - 新 kind `Texture`：只把一张图渲染出来，**不引用图集里的格子**；
 * - 图片组件从一种拆成两种——精灵 `SpriteLayer`、贴图 `ImageLayer`（v20 及更早两者共用
 *   `TextureRenderer`），`renameSpriteImageComponent` 把老文件里精灵的那一份改名一次；
 * - 视频那一组从**精灵**挪到**贴图**（预设表 `OBJECT_PRESETS` 里 video 槽位只声明在这两个预设上）：
 *   旧文件里精灵身上的 `VideoOverlay` **不删**（不静默改用户数据），只由 `validateScene` 报一条警告。
 *   协议侧同步升到 v11（新增组件名 `SpriteLayer` / `ImageLayer`，老前端不认会把对象画成占位色）。
 *
 * v22（2026-09-23）：**两种实体的 kind 各归其位**——`GameObject`
 * 从此是**抽象基类**（老文件里写这个值的对象就是当时的「精灵」，由 `renameObjectKinds`
 * 改成 `Sprite`），`Sprite`（精灵）与 `Image`（贴图，v21 时叫 `Texture`）是它的子类型；
 * 「凡场景对象都有的东西」（现在只有一张显示图）因此只声明一次，子类型继承下去。
 * 数据形状一个字没动，改名与层级都不动内容。（层级后来在架构统一中移除：
 * 现在 kind 只是预设 id，能力槽位直接声明在 `presets.ts` 的 `OBJECT_PRESETS` 上。）
 * 协议侧同步升到 v12：老前端（v11）不认这两个值，占位色会退成灰（图照常显示，因为
 * 显示走组件名）——属于「不是崩，是画面错」，按同一条纪律靠握手挡住。
 *
 * v23（2026-09-23）：**图片的导入设置与切分从工程文件搬进素材自己的 `.meta`**。
 * - 工程文件里 `spriteSheets` / `spriteSettings` 两项**删除**（`migrateSpriteMetas` 把键按路径
 *   找到素材、生成各自的 `.meta` 交给调用方落盘）；
 * - `ImageRef` 多一项 `guid`：**有 guid 就以 guid 为准**，`id`（路径）留给显示、老文件兜底
 *   与下发前端的换算——前端/协议因此一个字节都不用改（推送时仍换算回路径 ID）；
 * - 为什么要改：那三份数据原来都以**文件名**为键，外部一改名就同时失联（见
 *   `docs/specs/2026-09-23-asset-meta.md` 里记的真实案例）。改完 `.meta` 与素材成对改名 = 不断链。
 *
 * v24（2026-09-23）：**素材 meta 覆盖到每一种素材，工程文件不再存任何「按文件记」的数据**。
 * - **每个素材旁边必有一份 `<素材>.meta`**（图片 / 音频 / 视频 / 场景）：编辑器打开项目、
 *   刷新资源树时，缺的那几份按素材种类现建（`importer` = `texture` / `audio` / `video` / `scene`）；
 * - 工程文件里的 `audioMeta`**删除**（`migrateAudioMetas` 把它按路径搬进各自音频文件的
 *   `.meta` 的 `audio` 段：显示名 + 标签 ID 列表）；`audioTags`（标签表）**留在工程文件里**，
 *   它是**项目级**数据，不是某一个文件的属性；
 * - 于是口径统一成一句话：**项目级数据在 `project.json`，素材级数据跟着素材走**。
 *   协议 / 前端仍然一个字节都不用改（音频引用一直是资源逻辑 ID）。
 *
 * v25（2026-09-25）：**战争雾拆成独立组件 `FogOfWar`**。原来住在 `GridMap` data 里的
 * `fog`（总开关 + 雾区）搬成 `components[]` 里的 `FogOfWar` 实例（数据形状不变：
 * `{ enabled, regions }`），由 `migrateMapFogToComponent` 搬一次。属性面板从此
 * 「一组 = 一个组件」；`FogOfWar` 从属 `GridMap`（雾区引用它的格子区域位），只挂在
 * 地图对象上。协议侧新增组件名 `FogOfWar`（v13 起），老前端不认会忽略雾层。
 *
 * v26（2026-09-26）：**显示顺序搬进渲染组件**。对象级 `sortingOrder` 删除——
 * 网格地图进 `MapDataDoc`（`GridMap` 组件的 data）、图片层（`ImageLayer` / `SpriteLayer`）
 * 进各自的 data（形状 = `ImageRef & { sortingOrder }`）；动作对象（`PlaySound` / `Teleport`）
 * 与没有渲染层的实体**不再有这个参数**。由 `migrateSortingOrderToRenderComponents` 搬一次。
 * 协议侧同步升到 v14。
 *
 * v27（2026-09-26）：**战争雾变成独立的场景对象**。`FogOfWar` 组件从地图对象搬到新的
 * `Fog` 对象上（对象照常有位置 / 旋转 / 缩放，**可摆放**），组件 data 多了 `mapId`
 * （引用哪张地图：雾区与格子取自那张地图的 `GridMap`）。一张地图最多一个雾对象，
 * 由 `migrateFogToSceneObject` 把老的「地图上的 `FogOfWar` 组件」搬过去。协议侧同步升到
 * v15：命令 `erase_mask` / `reveal_fog_region` 改按**雾对象 id** 寻址。
 *
 * v28（2026-09-26）：**取消 `Map` 对象类型，网格变成贴图上的一个可选组件**。
 * 「网格地图」不再是一种实体——它就是**一张贴图**（`Image`，走普通图片层）**加一个 `GridMap` 组件**：
 * - `MapDataDoc` 去掉 `image` 与 `sortingOrder`，只留网格数据（`grid` / `rowOrder` / `cells`）；
 *   贴图与显示顺序住贴图自己的 `ImageLayer` 里（v26 起本来就在图片层，地图只是不再特殊）；
 * - `GridMap` 组件改为**可选能力**（像「视频」一样能加在贴图上，也能移除）；
 * - 老 `Map` 对象由 `migrateMapKindToImage` 迁成「`Image` + `ImageLayer` + `GridMap`」。
 *
 * 于是「地图」这条特殊路径整个消失：`objectImage` / `sortingOrderOf` / 换图 / 画布 / 前端
 * 都不再给地图开分支，网格数据只有「数据 + 网格编辑窗口」，没有任何渲染实体。
 * 协议侧同步升到 v16：`mapDataSchema` 去掉这两项，地图对象改为下发 `ImageLayer` 组件。
 */
export const DOCUMENT_FORMAT_VERSION = 28;

/** 网格行序：`bottom-up` 表示 cells 第 0 行是图片最下面一行（与 Unity GridMap 一致）。 */
export type RowOrder = "bottom-up";

export interface ImageRef {
  /** 资源逻辑 ID，例如 `project:我的项目/Assets/images/Map001.png`（**显示与下发用**）。 */
  readonly id: string;
  /**
   * 素材的**稳定身份**（v23 起，可选）：素材旁边那份 `<素材>.meta` 里的 GUID。
   *
   * 有它就以它为准（`id` 只是"上次见到的路径"）：素材与 `.meta` 成对改名 / 移动之后，
   * 引用照样指得对——这正是 v23 要买到的东西。手写的老文件没有它，按 `id` 兜底解析，
   * 编辑器读到时顺手补上（`asset-meta.ts` 的索引）。
   */
  readonly guid?: string;
  /**
   * 在场景里占多宽（**换算前的声明尺寸**；实际尺寸还要乘对象 scale）。
   *
   * 整图 = 图片本身的宽；子图（`sprite` 在） = **那一格的宽**。它由挑图的人从素材读出来，
   * 与「网格规格不存 cellSize」那条规矩不冲突：它不是从别处算出来的，而是**声明**出来的
   * （画布与前端都按它铺矩形，与磁盘上的真实像素不一致时只报警告并拉伸）。
   */
  readonly width: number;
  readonly height: number;
  /**
   * 取这张图（图集）里的**哪一格**；缺省 = 整张图。
   *
   * 这里**只存引用**：「几行几列」住在**素材自己的 `.meta`** 里（v23 起；v22 及更早住在
   * 工程文件的 `spriteSheets`），只有那一份——所以改切分，所有引用它的对象一起变
   * （对齐 Unity：Sprite 的矩形住在资源自己的导入设置里，场景只引用它）。
   *
   * **不存像素矩形**：矩形 = 格子 ÷ 加载到的纹理尺寸，由编辑器画布与前端各算一次，
   * 于是两侧不可能各差一像素（与「`GridSpec` 不存 `cellSize`」同一条规矩）。
   * 地图贴图（`map.image`）**不支持**它：地图的格子是按整张贴图算好的，取一块会让已有
   * 格子标注的含义静默改变——带上它也会被忽略（见 `sprites.ts` 的 `displaySpriteOf`）。
   */
  readonly sprite?: ImageSpriteRef;
}

/**
 * 「图集里的第几格」。
 *
 * `row` **从最上面数**（`row: 0` = 第一行、`column: 0` = 最左边一列），对齐 Unity 的
 * Sprite Editor 的格子编号；它与 `GridMap` 的 `rowOrder: "bottom-up"` **无关**——
 * 那是「网格坐标系锚在哪」，这里是「第几个格子」，序数只有从左上数这一种读法。
 *
 * 越界的值（切分改小之后 `column >= columns`）不写回、不报错：渲染与推送两处统一
 * **夹到最后一格**（`sprites.ts` 的 `clampSpriteCell`），属性面板会提示出来让人自己改。
 */
export interface ImageSpriteRef {
  readonly column: number;
  readonly row: number;
}

/**
 * 一张图片的**切分**（素材级，v23 起住在 `<素材>.meta` 的 `sprite.sheet` 里）：按列 × 行切成网格。
 *
 * `1×1` = 整图（等同于没开精灵），所以**不写这种值**（不留空壳，与 `video` / `audioMeta`
 * 同一个口径）。上限 `SPRITE_SHEET_MAX`（64）：再密就没有「一格」可言了。
 */
export interface SpriteSheetDoc {
  readonly columns: number;
  readonly rows: number;
}

/** 一张图的**导入设置**（v23 起是 `<素材>.meta` 里 `sprite` 那一份的反向翻译）。 */
export interface SpriteImportSettingsDoc {
  readonly type: "Default" | "Sprite";
  readonly mode?: "Single" | "Multiple";
}

/**
 * 解析后的子图：**几行几列 + 第几格**（格评夹取之后）。
 *
 * 这是「引用 + 素材 meta」算出来的形状，有两个消费者：
 * 编辑器画布（算像素矩形）与协议载荷（`sprite` + `spriteGrid` 一起下发，见 `messages.ts`）。
 */
export interface ResolvedSprite {
  readonly columns: number;
  readonly rows: number;
  readonly column: number;
  readonly row: number;
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

export interface ComponentDoc {
  readonly id: string;
  /** 组件类型 ID，与前端组件类名一致（`GridMap` / `FogOfWar` / `ImageLayer` / `SpriteLayer` / `PlaySound` / `Teleport` / `VideoOverlay` / `VideoBlend`）。 */
  readonly type: string;
  readonly displayName?: string;
  readonly data: Record<string, unknown>;
}

// 对象类型（`ObjectKind` = 预设 id）与能力槽位住在 `presets.ts`：那张表是
// 「哪个 kind 允许哪个槽位」的唯一归属地，本文件只在 `GameObjectDoc.kind` 上用到它。

/** `GridMap` 组件携带的**网格数据**（v28 起贴图与显示顺序住图片层，这里只剩网格）。战争雾自 v25 起是独立的 `FogOfWar` 组件。 */
export interface MapDataDoc {
  readonly grid: GridSpec;
  readonly rowOrder: RowOrder;
  readonly cells: CellRuns;
}

/**
 * 图片层组件的数据（`ImageLayer` / `SpriteLayer` 共用，v26 起）：一份图片引用 + 显示顺序。
 *
 * 显示顺序**不塞进 `ImageRef`**：那个形状是「只存引用」的共享形状，污染不得。这里用交叉
 * 类型多挂一项，两类图片组件的 data 都长这样。
 *
 * v28 起**带网格的贴图也用它承载贴图与显示顺序**（以前这两项在 `MapDataDoc` 里）。
 */
export type ImageLayerDataDoc = ImageRef & { readonly sortingOrder: number };

/**
 * 战争雾组件的数据（v27 起住在独立的 `Fog` 对象上；v25–v26 住在地图对象上；更早是
 * `MapDataDoc.fog`）：**引用哪张地图** + **总开关** + 把哪些「区域」当成雾区
 * （区域位取自 `@dts/grid` 的可绘制位）。
 *
 * `mapId` 指向**被引用的地图对象**（雾区引用它的格子区域位，`cells` 与网格尺寸也从它取）。
 * 用对象 id 而不是名字：改名不会断链。一张地图最多一个雾对象（`validateScene` 报重复）。
 *
 * `enabled` 是**总开关**：只有开着，前端才生成那一层雾（`FogOfWar`）。
 * 关掉它 = 「这个雾对象现在不生成雾」，但**雾区绑定留着**——再打开就回来，
 * 不必重新指定一遍（见 `setFogEnabled`）。
 *
 * 与 v26 及更早不同：组件现在**总在**（它就是雾对象的数据本体），关掉只是 `enabled=false`，
 * 不再「关且空就摘组件」——摘了雾对象就成空壳了。
 */
export interface FogOfWarDataDoc {
  /**
   * 引用哪张地图（对象 id）。空字符串 = 还没选（损坏 / 刚修复的数据，校验报 error）。
   */
  readonly mapId: string;
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
  /** Automatically play the selected clip when the scene activates; defaults to off. */
  readonly autoPlay?: boolean;
  /**
   * **加进来的**视频（资源逻辑 ID，如 `project:我的项目/Assets/video/opening.mp4`）。
   *
   * 顺序 = 加进来的先后（不排序、不代表优先级）；空数组 = 这个对象还没有视频可放。
   */
  readonly clips: string[];
  /** 加进来的视频里**当前选中的那一条**（必须是 `clips` 里的一个）；缺省 = 还没选。 */
  readonly picked?: string;
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

/**
 * 视频混合里**一条通道**的数据：加进来的视频列表 + 当前选中的那条。
 *
 * 形状与「声音 / 视频」的 `{ clips, picked? }` 逐字一致——所以列表命令的公共骨架
 * （`commands/shared.ts` 的 `setMediaList` / `setMediaPicked`）原样复用，不必再抄一份。
 */
export interface VideoBlendChannelDoc {
  /** 加进来的视频（资源逻辑 ID）；顺序 = 加进来的先后。 */
  readonly clips: string[];
  /** 加进来的里当前选中的那条（必须是 `clips` 里的一个）；缺省 = 还没选。 */
  readonly picked?: string;
}

/**
 * 视频混合的声音来源：`none`（缺省，静音）/ `a`（出通道 A 的声音）/ `b`（出通道 B 的声音）。
 *
 * 两条同时放、声音至多出一路：现场同时轰两条比听不到更糟——与视频的「缺省静音」同一口径。
 */
export const VIDEO_BLEND_AUDIO = ["none", "a", "b"] as const;

export type VideoBlendAudio = (typeof VIDEO_BLEND_AUDIO)[number];

/**
 * 视频混合组件（`VideoBlend`）的数据：**两条视频通道 + 循环 + 声音来源**。
 *
 * A 是**盖在上面**的那条、B 是**被盖住**的那条：运行时遮罩整张不透明（只看见 A），
 * 在 Mask 窗口里擦开的地方露出底下的 B——揭示形状与战争雾完全同构（纯运行态、不写文档）。
 *
 * **没有 `enabled`**：与 `GridMap` 一样走「组件在 = 在用」（可选组件由属性面板底部的
 * Add Component 添加、组头移除），不像 `VideoDataDoc.enabled` 那样是 v19 迁移留下的兼容字段。
 * **遮罩也不在这里**：它是运行态（新命令 `erase_video_mask` 驱动），组件只声明「放什么」。
 */
export interface VideoBlendDataDoc {
  /** 通道 A（盖在上面）：视频列表 + 选中的那条。 */
  readonly a: VideoBlendChannelDoc;
  /** 通道 B（擦开露出）：视频列表 + 选中的那条。 */
  readonly b: VideoBlendChannelDoc;
  /** 两条一起循环。 */
  readonly loop: boolean;
  /**
   * **场景激活时自动播放**（与 `VideoDataDoc.autoPlay` 同义）：切到这个场景 / 前端刚连上时，
   * 不用 GM 点「播放」，前端自己把两条起起来。缺省关（现场别一进场景就轰）。
   */
  readonly autoPlay?: boolean;
  /** 出哪条的声音。 */
  readonly audio: VideoBlendAudio;
}

export interface GameObjectDoc {
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
  /**
   * **实体身上挂的组件**（v19 起，对象特性也在这里）。
   *
   * 「对象是什么、画成什么样、运行时能做什么」全由这里声明：8 种对象能力组件
   * （`GridMap` / `FogOfWar` / `ImageLayer` / `SpriteLayer` / `PlaySound` / `Teleport` / `VideoOverlay` / `VideoBlend`）——
   * v18 及更早它们住在对象的扁平字段里（`map` / `image` / `sound` / `teleport` / `video`），
   * 由 `migrateFeaturesToComponents` 搬进来。
   *
   * **读它们一律走 `access.ts` 的访问器**（`mapDataOf` / `soundDataOf` / …），
   * 不要在调用处 `components.find(...)`：那样「哪个类型带什么数据」又会散开。
   * 同一类型在一个对象上**最多一个实例**；顺序 = 注册表顺序（新建与迁移都按它 append）。
   */
  readonly components: ComponentDoc[];
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

/*
 * v24 起这里**没有** `AudioMetaDoc` 了：音频文件的标注（显示名 + 标签 ID 列表）住在
 * **那个音频文件自己的 `.meta`** 里（`asset-meta.ts` 的 `AssetMetaAudioDoc`）——
 * 它和图片的切分 / 导入设置同一档：**素材级数据跟着素材走**，键不再是路径。
 */

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
   * **音频标签表**（v18 起，可选）：下标 = tag ID，值 = 名字（`null` = 已删除的洞）。
   *
   * 它是**项目级**数据（一张表管全项目），所以**留在工程文件里**；文件那一侧只记
   * `[0, 2]` 这样的整数 ID，而那些 ID 住在**那个文件自己的 `.meta`** 里（v24 起，
   * 见 `asset-meta.ts` 的 `AssetMetaAudioDoc`）。没有标签时**不写这一项**。
   */
  readonly audioTags?: AudioTagTableDoc;
  /*
   * v23 起这里**没有** `spriteSheets` / `spriteSettings` 了：图片的导入设置与切分搬到
   * **素材自己的 `.meta`** 里（`Assets/images/A.png.meta`，见 `asset-meta.ts`）——
   * 名字即键那套会让「外部改个文件名」把图、切分、格子引用三份一起打断（实测踩过）。
   * v24 起 `audioMeta` 也走了同一条路（搬进 `Assets/audio/x.mp3.meta` 的 `audio` 段）。
   * 工程文件里只剩**项目级**数据；素材级数据跟着素材走。
   */
}

/** 场景文件（Assets/scenes/<场景名>.json）的内容：场景名就是文件名，文件里不存名字。 */
export interface SceneFileDoc {
  readonly formatVersion: number;
  readonly objects: GameObjectDoc[];
}

/** 内存里的场景 = 场景名（= 文件名）+ 文件内容。 */
export interface SceneDoc {
  readonly name: string;
  /** ★ 所有对象都在场景上 */
  readonly objects: GameObjectDoc[];
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
