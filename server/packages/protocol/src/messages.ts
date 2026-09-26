import { z } from "zod";

/**
 * WebSocket 消息契约（编辑器 / 服务端 / 前端三端共用的唯一来源）。
 *
 * 通道划分：
 * - `/editor`：编辑器 ↔ 服务端
 * - `/client`：前端（Unity 客户端）↔ 服务端
 *
 * **模型：后台是唯一真源，前端是它的镜像 + 播放器。**
 * 编辑器进入运行态后把**当前场景整份推下去**（`scene_push`），服务端缓存并转发成
 * `scene_sync`；前端按对象 `id` 建 / 改 / 删自己的 GameObject。命令（`command`）只是
 * 「什么时候播」这类触发器，**数据永远在场景里**，不在命令里。
 *
 * 旧模型（前端上报对象/动作、后端按 id 寻址、`register_*` / `report_*` / `invoke_action` /
 * 原子命令 / `sync_state`）已整层删除：新方向下前端不拥有数据，也就没有东西可上报。
 *
 * 协议版本：`PROTOCOL_VERSION`。两端不一致时服务端以 close code `4002` 断开。
 */

/**
 * 协议版本：任何不兼容改动都要 +1（前端在 `client_hello` 里报自己的版本）。
 *
 * v2（2026-09-20）：`/client` 新增 `resources_prepare`（服务端主动告诉前端「当前是哪个项目」，
 * 让前端**先把资源包下完、再载入场景**）。老前端收到不认识的类型会告警并丢弃，所以是破坏性改动。
 *
 * v3（2026-09-21）：新增战争雾两条命令（`erase_mask` / `reveal_fog_region`）。
 * 对**前端**是加法（老前端回一条「前端不认识这条命令」就行），但对**服务端**不是：
 * 老的 `/editor` 入站 schema 会直接把这条命令判成非法消息丢掉，编辑器只看到一行
 * 「消息校验失败」、命令凭空消失（现场就是这么踩了一次：服务端进程没重启）。
 * 所以这里仍然 +1——版本握手（两端都要相等）会在连上的那一刻就说清「新旧不同步」，
 * 而不是等第一条新命令发出去才暴露。
 *
 * v4（2026-09-21）：战争雾多一个**总开关**（`map.fog.enabled`）。对前端**不是**无害的加法：
 * 老前端不认这个字段，会把它静默丢掉，于是「编辑器里关掉了战争雾」在前端照样生成那一层雾——
 * 这正是要修的那个 bug（两边看到的不是同一件事）。所以照旧 +1，让新旧混跑在连上时就断掉。
 *
 * v5（2026-09-21）：地图 / 精灵多了**视频**（`video` 字段 + `play_video` / `pause_video` /
 * `resume_video` / `stop_video` 四条命令）。字段本身对老前端是无害的加法（丢掉 = 这个对象不放视频），
 * 但**命令不是**：老服务端的入站 schema 会把不认识的命令判成非法消息丢掉（v3 踩过这个坑），
 * 所以按同一条纪律 +1。
 *
 * v6（2026-09-21）：声音补齐**暂停 / 继续**（`pause_sound` / `resume_sound`）——编辑器里
 * 「播放声音对象」与「地图 / 精灵的视频」两组 UI 的控件行现在完全一致（播放 / 暂停 / 停止）。
 * 同样是新增命令，所以 +1。
 *
 * v7（2026-09-21）：**全局背景音乐**（项目级设置）+ 声音层级从四档收敛成三档。
 * - 新增两条消息：编辑器推项目设置的 `settings_push`、服务端下发的 `project_settings`；
 * - 新增四条命令：`play_bgm` / `pause_bgm` / `resume_bgm` / `stop_bgm`；
 * - `layer` 枚举去掉 `ambient`（环境音并进 `bgm`）。
 * 老前端两者都接不住（不认的消息只告警、不认的命令当失败），必须一起更新，照旧 +1。
 *
 * v8（2026-09-22）：**背景音乐与项目设置解耦**——`project_settings.audio.bgm` 从
 * 「歌单 + 默认曲 + 循环 + 音量」收敛成**只有音量**（曲目清单不再进文档，编辑器弹框直接列项目音频）；
 * 命令那一组**不变**（还是四条 `*_bgm`，`play_bgm` 仍带 `clip`）。
 * 载荷形状变了、老前端读到的 `bgm` 少三项，所以照旧 +1。
 *
 * v9（2026-09-22）：**对象特性搬进组件**（与文档格式 v19 同一批）。`gameObjectSchema` 上
 * `map` / `image` / `sound` / `teleport` / `video` 这 5 个扁平字段没了，改成 `components[]` 里的
 * 组件实例（`GridMap` / `ImageLayer` / `SpriteLayer` / `PlaySound` / `Teleport` / `VideoOverlay`）。
 * 老前端按扁平字段读，迁移后的场景在它眼里会变成「一个什么都不带的空对象」（贴图、网格、
 * 声音、视频全丢），所以必须 +1，靠版本握手把它挡在连上的那一刻。
 * **命令那一组一个字节都没动**：`play_sound` 仍只带 `objectId` + `layer`，数据在镜像里。
 *
 * v10（2026-09-22）：**精灵（子图）**（与文档格式 v20 同一批）。贴图引用多了 `sprite`
 * （取这张图里的第几格）与 `spriteGrid`（这张图几列几行）两项，前端据此只画那一块矩形。
 * 两项都是可选的，老前端（v9）会**静默把整张图集铺出来**——不是崩，是画面错，所以照旧 +1：
 * 服务端与 Unity 客户端必须同批更新。
 * **命令那一组仍然一个字节都没动**（子图是数据，不是新动作）。
 *
 * v11（2026-09-23）：**图片组件改名 + 多一个「贴图」对象**（与文档格式 v21 同一批）。
 * 对象自己显示的图从一种组件（`TextureRenderer`）拆成两种——贴图 `ImageLayer`、精灵
 * `SpriteLayer`；`kind` 多了一个 `Texture`（**kind 是自由字符串，这一项不破坏兼容**）。
 * 老前端（v10）不认这两个新组件名，会把对象画成占位色（图取不到），所以必须 +1。
 * **命令那一组仍然一个字节都没动。**
 *
 * v12（2026-09-23）：**两种实体的 kind 改名**（与文档格式 v22 同一批）——贴图 `Texture` →
 * `Image`、精灵 `SceneObject` → `Sprite`（`SceneObject` 这个值不再出现）。
 * 数据形状一个字节都没动，`kind` 也只是自由字符串；但**老前端（v11）不认这两个值**，
 * `KindColor` 匹配不上会退回灰色占位色——图照常显示（显示走组件名），属于「不是崩，是画面错」，
 * 按同一条纪律 +1。**命令那一组仍然一个字节都没动。**
 *
 * v13（2026-09-25）：**战争雾拆成独立组件**（与文档格式 v25 同一批）。`FogOfWar`
 * （总开关 + 雾区，数据形状不变）从 `GridMap` 的 data 里搬出来成为 `components[]` 里的
 * 第 7 种组件实例，地图 data 上不再有 `fog` 字段。老前端（v12）按 `map.fog` 读——
 * 新场景在它眼里「雾整个没了」（不是崩，是雾层丢了），按同一条纪律 +1：
 * 服务端与 Unity 客户端必须同批更新。**命令那一组仍然一个字节都没动**
 * （`erase_mask` / `reveal_fog_region` 照旧，只是 `reveal_fog_region` 的「区域是雾区」
 * 这一判据改从 `FogOfWar` 组件读）。
 *
 * v14（2026-09-26）：**显示顺序搬进渲染组件**（与文档格式 v26 同一批）。`gameObjectSchema`
 * 上的 `sortingOrder` 删除，改挂在渲染组件的数据里——`GridMap` 的 data、以及图片层
 * （`ImageLayer` / `SpriteLayer`）的 data 各多一项 `sortingOrder`（int，缺省 0）。
 * 动作对象与没有渲染层的实体不再有这个字段。老前端（v13）按对象级读，拿到 undefined
 * 会把它当 0、所有渲染层挤在同一层（不是崩，是遮挡顺序错乱），按同一条纪律 +1：
 * 服务端与 Unity 客户端必须同批更新。**命令那一组仍然一个字节都没动。**
 *
 * v15（2026-09-26）：**战争雾变成独立的场景对象**（与文档格式 v27 同一批）。`FogOfWar`
 * 组件从地图对象搬到新的 `Fog` 对象上，组件 data 多了 `mapId`（引用哪张地图）。
 * 命令 `erase_mask` / `reveal_fog_region` 的 `objectId` 从「地图 id」改成「**雾对象 id**」。
 * 老前端（v14）按地图 id 找雾组件 → 找不到（雾搬走了），且新场景里它根本不认 `Fog` 对象——
 * 不是崩，是雾层整个不工作，按同一条纪律 +1：服务端与 Unity 客户端必须同批更新。
 *
 * v16（2026-09-26）：**取消 `Map` 对象类型，网格变成贴图上的可选组件**（与文档格式 v28 同一批）。
 * `mapDataSchema` 去掉 `image` 与 `sortingOrder`，地图对象改为下发一个 **`ImageLayer`** 组件
 * 承载贴图 + 显示顺序；`GridMap` 的 data 只剩网格。老前端（v15）按 `map.image` 取图 → 取不到，
 * 地图对象会退成占位色（不是崩，是画面错），按同一条纪律 +1：服务端与 Unity 客户端必须同批更新。
 * **命令那一组仍然一个字节都没动。**
 *
 * v17（2026-09-26）：**新增「视频混合」组件 `VideoBlend`**（两条视频叠在同一矩形上用 Mask
 * 混合：A 盖住、擦开露 B）。同时新增一条命令 `erase_video_mask`（擦运行时遮罩，与 `erase_mask`
 * 同一套轨迹口径，但寻址的是**贴图对象**上的 `VideoBlend`）。老前端（v16）不认这个组件 →
 * 混合层不建（不是崩，是那一层没有），且收到 `erase_video_mask` 会因未知命令被拒——
 * 按同一条纪律 +1：服务端与 Unity 客户端必须同批更新。**其余消息与命令一个字节都没动。**
 *
 * v18（2026-09-26）：**视频混合多了 `autoPlay`**（场景激活时自动混合播放选中的两条，
 * 与 `VideoOverlay` 的 `autoPlay` 同义）。组件的 data 里多一个布尔，命令那一组一个字节都没动。
 * 老前端（v17）不认这一项 → 不会自动播（不是崩，是行为丢），按同一条纪律 +1：
 * 服务端与 Unity 客户端必须同批更新。
 *
 * v19（2026-09-27）：**视频混合的两路从「列表 + 选中」收成单个素材**（`{ kind, id? }`），
 * 且每路多了 `kind`（`image` / `video`）——这一路可以是**图片**也可以视频。老前端（v18）
 * 按 `clips` / `picked` 读 → 两条通道都读不到（混合层放不出来），按同一条纪律 +1。
 * 命令那一组一个字节都没动（`erase_video_mask` 的载荷还是轨迹）。
 *
 * v20（2026-09-27）：视频混合多一条命令 **`fill_video_mask`**（把整张遮罩填成 1 / 0，
 * Mask 窗口那两个「整张」按钮用）。老前端（v19）不认它 → 回一条未知命令（那两个按钮点了没反应），
 * 按同一条纪律 +1。组件数据一个字节都没动。
 */
export const PROTOCOL_VERSION = 20;

/** 未进入运行态时拒绝 `/client` 升级的 HTTP 状态与原因头。 */
export const RUNTIME_INACTIVE_STATUS = 503;
export const RUNTIME_INACTIVE_REASON = "runtime-inactive";

/** 关闸（退出运行态）时踢掉前端的 close code。 */
export const RUNTIME_STOPPED_CODE = 4003;
/** 协议版本不一致时踢掉前端的 close code。 */
export const PROTOCOL_MISMATCH_CODE = 4002;

// ---------------------------------------------------------------- 场景（文档模型的只读复刻）

/**
 * 场景对象数据 = 编辑器文档模型里的 `GameObjectDoc`（`@dts/document`）。
 *
 * 这里**复刻一份只读 schema**而不是 import `@dts/document`：`protocol` 是被三端共用的
 * 最底层包，不该反过来依赖文档包。字段口径与文档严格一致，文档加字段时这里同步补。
 */
export const worldPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

/** 图片里的一格（v10 起）：`column` 从左数（0 起）、`row` **从最上数**（0 起）。 */
export const spriteRefSchema = z.object({
  column: z.number().int().nonnegative(),
  row: z.number().int().nonnegative(),
});

/**
 * 一张图的切分上限（列与行各自的上限）。
 *
 * 与 `@dts/document` 的 `SPRITE_SHEET_MAX` **同值**：`protocol` 是被三端共用的最底层包，
 * 不能反过来依赖文档包，所以这里复刻一份（与 `DEFAULT_*_VOLUME` 同一套做法），
 * 由 `apps/backend/test/protocol-document-contract.test.ts` 断言两边一致。
 */
export const SPRITE_SHEET_MAX = 64;

/** 一张图的切分（v10 起）：几列几行。`1×1` = 整图。 */
export const spriteGridSchema = z.object({
  columns: z.number().int().min(1).max(SPRITE_SHEET_MAX),
  rows: z.number().int().min(1).max(SPRITE_SHEET_MAX),
});

/**
 * 图片引用：资源逻辑 ID + 声明的宽高（世界像素；实际尺寸 = 声明尺寸 × 对象 scale）。
 *
 * v10 起多了**精灵（子图）**两项，它们是一对：
 * - `sprite`：取这张图里的第几格（缺省 = 整张图，与 v9 完全同义）；
 * - `spriteGrid`：那张图的切分（几列几行）。
 *
 * **`spriteGrid` 是协议侧多出来的一项**：切分在编辑器那边只有一份（工程文件里的
 * `spriteSheets`），而前端手上没有工程文件——所以编辑器在推送时把它解析进载荷里
 * （见 `apps/editor/src/services/runtime-push.ts` 的 `scenePayloadOf`）。
 * 前端据此算 UV，不必知道「工程文件」这个概念。
 *
 * 老前端（v9）不认这两项，会把整张图集当成一张图铺出来——那是**可见的错误**，
 * 所以 `PROTOCOL_VERSION` 跟着 +1，靠握手把它挡在连上的那一刻。
 */
export const imageRefSchema = z
  .object({
    id: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sprite: spriteRefSchema.optional(),
    spriteGrid: spriteGridSchema.optional(),
  })
  // 格子必须落在切分范围内：编辑器推送前统一夹过（`clampSpriteCell`），所以越界只可能是
  // 坏载荷——这里明确拒掉，别让前端算出画到图外的 UV
  .refine(spriteFitsSheet, { message: "子图超出切分范围" });

/**
 * 图片层组件（`ImageLayer` / `SpriteLayer`）的数据（v14 起）：`imageRefSchema` + 显示顺序。
 *
 * 与文档格式 v26 镜像：显示顺序搬进渲染组件，**不塞进 `imageRefSchema`**（那个形状
 * `GridMap.image` 也在用，多一项会污染地图贴图）。`default(0)` 让老编辑器少发这一项时
 * 前端照常读到 0，与文档侧同一个口径。
 */
export const imageLayerDataSchema = z
  .object({
    id: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sprite: spriteRefSchema.optional(),
    spriteGrid: spriteGridSchema.optional(),
    sortingOrder: z.number().int().default(0),
  })
  .refine(spriteFitsSheet, { message: "子图超出切分范围" });

/** 子图必须落在切分范围内（缺任一项都不判错，见 `imageRefSchema`）。 */
function spriteFitsSheet(image: {
  readonly sprite?: { readonly column: number; readonly row: number };
  readonly spriteGrid?: { readonly columns: number; readonly rows: number };
}): boolean {
  return (
    image.sprite === undefined ||
    image.spriteGrid === undefined ||
    (image.sprite.column < image.spriteGrid.columns && image.sprite.row < image.spriteGrid.rows)
  );
}

/** RLE 一段：`[掩码, 连续格数]`（掩码 0–255、格数非负，与 `@dts/document` 的 `cellRunsSchema` 同口径）。 */
export const rleRunSchema = z.tuple([z.number().int().min(0).max(255), z.number().int().nonnegative()]);

export const gridSpecSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const cellRunsSchema = z.object({
  encoding: z.literal("rle"),
  runs: z.array(rleRunSchema),
});

/**
 * 战争雾组件的数据（v27 起住在独立的 `Fog` 对象上）：**引用哪张地图** + **总开关** +
 * 把哪些「区域」当成雾区（区域位取自 `@dts/grid` 的可绘制位，`[1, 8]` = 区域1 + 区域4）。
 *
 * 前端据此从**被引用地图**的 `cells` 里挑出雾格子、生成一张像素遮罩（只盖雾区、其余透明）；
 * `mapId` 是地图对象 id；`enabled` 是总开关，**关着时前端一层的雾都不建**（不是建了再隐藏）。
 * **哪个格子被揭示了不在数据里**：那是运行态，由 `erase_mask` / `reveal_fog_region` 命令驱动，
 * 不写文档、也不随 `scene_sync` 走。
 */
export const mapFogSchema = z.object({
  mapId: z.string().default(""),
  enabled: z.boolean().default(true),
  // 与文档同口径：区域位只到 1–255、缺省空数组（越界的「已知位」由语义校验报 warning）
  regions: z.array(z.number().int().min(1).max(255)).default([]),
});
/** `GridMap` 组件携带的**网格数据**（`rowOrder` 固定 bottom-up）。贴图与显示顺序自 v16 起在 `ImageLayer` 组件里，战争雾在独立的 `FogOfWar` 组件里。 */
export const mapDataSchema = z.object({
  grid: gridSpecSchema,
  rowOrder: z.literal("bottom-up"),
  cells: cellRunsSchema,
});

/**
 * 声音层级：**固定三档**（同层同时只响一条）。
 *
 * v7 起去掉了 `ambient`（环境音）：那一条在文档里被并进了 `bgm`（见 `@dts/document` 的迁移），
 * 所以协议这一侧也收成三档——**两端必须一致**，否则老前端会按「四档」理解一次迁移过的数据。
 *
 * `bgm` 留在枚举里是有用的：它是**声道名**（前端按声源分组），也是老文档里
 * `layer: "bgm"` 的声音对象能被读回来的依据；但背景音乐由编辑器顶栏「音乐」弹框 +
 * `play_bgm` 那一组命令管，不再挂在对象上、也不是项目设置里的歌单。
 */
export const soundLayerSchema = z.enum(["bgm", "sfx", "voice"]);

/** 声音对象的数据：加进来的音频 + 当前选中的那条 + 层级（前端播的就是 `picked`）。 */
export const soundDataSchema = z.object({
  clips: z.array(z.string().min(1)).default([]),
  picked: z.string().min(1).optional(),
  layer: soundLayerSchema.default("sfx"),
});

/**
 * 地图 / 精灵上的**视频列表**（v14 起）：加进来的视频 + 当前选中的那条 + 循环 / 声音两个开关。
 *
 * 与文档 schema 同一口径：`clips` / `loop` / `audio` 给默认值（老编辑器不会发这一项时语义只能是
 * 「还没加视频、不循环、静音」），`picked` 可选（「没写」= 还没选）。
 *
 * 前端据此建那一层视频（盖在**这个对象自己的矩形**上，见 `Presentation/VideoOverlay.cs`）：
 * 命令里只有 `objectId`，放哪一条 / 循环 / 声音都从这里读——与 `play_sound` 同一条「命令只是触发器」。
 * `names`（显示名）**不进协议**：它只是编辑器里给人看的标签。
 */
export const videoDataSchema = z.object({
  // 总开关：关着 = 这个对象现在不放视频（前端连那一层都不建）。缺省算开——`video` 只有
  // 加过视频才写出来，「字段在」本来就等于「在用」（与 `map.fog.enabled` 同一个口径）
  enabled: z.boolean().default(true),
  autoPlay: z.boolean().default(false),
  clips: z.array(z.string().min(1)).default([]),
  picked: z.string().min(1).optional(),
  loop: z.boolean().default(false),
  audio: z.boolean().default(false),
});

/**
 * 视频混合组件（v17 起，可选，只有贴图能带）：**两路素材**（A 盖住 / B 擦开露出）
 * + 循环 + 自动播放（v18）+ 声音来源。
 *
 * 与文档 schema 同一口径：每路是**一个素材**（`{ kind: "image" | "video", id? }`，v19 起）——
 * `kind` 给默认值（老文件缺它就按视频算），`id` 不给（「没写」= 这一路空着）；
 * **没有 `enabled`**——与 `GridMap` 一样「组件在 = 在用」（编辑器 Add Component 添加 / 移除）。
 *
 * **遮罩不在数据里**：它是纯运行态，由 `erase_video_mask` 命令驱动，不随场景下发。
 * 前端据此建混合层（**视频**那一路 `VideoPlayer` → `RenderTexture`、**图片**那一路取一张贴图，
 * 用一个 Mask 混合）；命令里只有 `objectId`，放哪两路 / 循环 / 声音都从这里读。
 */
const videoBlendChannelSchema = z.object({
  // 与文档的 `VIDEO_BLEND_KINDS` 同值（protocol 不能依赖文档包，这里复刻一份）
  kind: z.enum(["image", "video"]).default("video"),
  id: z.string().min(1).optional(),
});

export const videoBlendDataSchema = z.object({
  a: videoBlendChannelSchema.default(() => ({ kind: "video" as const })),
  b: videoBlendChannelSchema.default(() => ({ kind: "video" as const })),
  loop: z.boolean().default(false),
  // 场景激活时自动混合播放（v18；与 `videoDataSchema` 的 `autoPlay` 同一口径）
  autoPlay: z.boolean().default(false),
  // 与文档的 `VIDEO_BLEND_AUDIO` 同值（protocol 不能依赖文档包，这里复刻一份）
  audio: z.enum(["none", "a", "b"]).default("none"),
});

/**
 * 传送阵（动作对象）的数据：候选目标场景 + 当前选中的那一个。
 *
 * **前端不需要它**：触发传送阵 = 编辑器切换当前场景 → 整份 `scene_push` 下来，
 * 前端只管换镜像（没有一个「teleport」命令，也不需要）。放进协议 schema 是因为它就是
 * `GameObjectDoc` 的一部分——这份 schema 是文档形状的只读复刻，少了字段等于悄悄丢数据。
 */
export const teleportDataSchema = z.object({
  targets: z.array(z.string().min(1)).default([]),
  picked: z.string().min(1).optional(),
});

/**
 * 三档音量的缺省值（与 `@dts/document` 的 `DEFAULT_*_VOLUME` 同值；`protocol` 是被三端共用的
 * 最底层包，不能反过来依赖文档包，所以这里复刻一份数字）。
 */
export const DEFAULT_BGM_VOLUME = 0.6;
export const DEFAULT_SFX_VOLUME = 0.8;
export const DEFAULT_VOICE_VOLUME = 1;

/** 一条声道（背景音乐 / 音效 / 旁白）：**只剩音量**（v8 起背景音乐的歌单不在这里）。 */
export const channelVolumeSchema = z.object({
  volume: z.number(),
});

/**
 * 项目级**全局设置**（v7 起，目前只有音频）：前端不解释业务，照着调音量。
 *
 * 它是**文档形状的只读复刻**（`@dts/document` 的 `ProjectSettingsDoc`），但**不走场景**：
 * 场景是整份推的，项目设置是另一条通道（`settings_push` → `project_settings`），
 * 因为它跨场景有效、换场景不该丢。
 *
 * 两条口径：
 * - 每一档都给默认值（老编辑器不发这一项时语义只能是「用缺省参数」）；
 * - v8 起 `bgm` **只剩音量**：曲目清单（v7 的 `clips` / `picked` / `loop`）不再进文档，
 *   也不是命令的载荷来源——编辑器弹框直接列项目 `Assets/audio/` 下的音频，点一首就发
 *   `play_bgm{clip}`。背景音乐因此与项目设置彻底分开：这里只是「这条声道多大声」。
 */
export const projectSettingsSchema = z.object({
  audio: z
    .object({
      bgm: channelVolumeSchema.default(() => ({ volume: DEFAULT_BGM_VOLUME })),
      sfx: channelVolumeSchema.default(() => ({ volume: DEFAULT_SFX_VOLUME })),
      voice: channelVolumeSchema.default(() => ({ volume: DEFAULT_VOICE_VOLUME })),
    })
    .default(() => ({
      bgm: { volume: DEFAULT_BGM_VOLUME },
      sfx: { volume: DEFAULT_SFX_VOLUME },
      voice: { volume: DEFAULT_VOICE_VOLUME },
    })),
});

/**
 * 对象特性组件的类型名（v9 起）。
 *
 * 与 `@dts/document` 的 `DEFAULT_SLOT_COMPONENT` **必须逐字一致**——两处是刻意复刻的
 * （`protocol` 不能反过来依赖文档包），由 `apps/backend/test/protocol-document-contract.test.ts`
 * 断言两边一致，改一处忘了另一处会直接测试失败。
 */
export const COMPONENT_TYPE = {
  /** 网格（v16 起是贴图上的**可选组件**，纯数据；贴图在 `ImageLayer` 里）。 */
  map: "GridMap",
  /** 战争雾（v15 起挂在独立的 `Fog` 对象上）：引用哪个带网格的贴图 + 总开关 + 雾区。 */
  fog: "FogOfWar",
  /** 对象自己显示的图（整张铺满）：**贴图对象**与**带网格的贴图**都用它。 */
  image: "ImageLayer",
  /** 对象自己显示的图：**精灵对象**用它（会取图集里的一格）。与 `image` 同一份 `imageRefSchema`。 */
  sprite: "SpriteLayer",
  sound: "PlaySound",
  teleport: "Teleport",
  video: "VideoOverlay",
  /** 视频混合（v17 起）：两条视频叠在同一矩形上用 Mask 混合（A 盖住、擦开露 B）；遮罩纯运行态。 */
  videoBlend: "VideoBlend",
} as const;

/**
 * 一个组件实例（v9）。
 *
 * 从对象特性提升上来的 8 种按各自 schema 校验（`image` 那一份有 `ImageLayer` / `SpriteLayer`
 * 两个名字，形状一样）；其余类型（将来的自定义组件）走宽松分支：
 * `data` 是任意记录。未知类型**不报错**是有意的——
 * 编辑器加一个新组件时，老前端应当照常镜像其余数据，而不是整条场景消息被判非法。
 *
 * 「宽松」那一支**必须把已知名排除掉**：否则一个 data 写坏的 `GridMap` 会掉进这里
 * 被当成「未知类型」收下，严格校验就形同虚设。
 */
const TYPED_COMPONENT_NAMES: readonly string[] = Object.values(COMPONENT_TYPE);

export const componentSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1).refine((type) => !TYPED_COMPONENT_NAMES.includes(type), {
    message: "已知特性组件的 data 不符合它的 schema",
  }),
  displayName: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});

function featureComponentSchema<T extends z.ZodTypeAny>(
  type: string,
  data: T,
): z.ZodObject<{
  id: z.ZodString;
  type: z.ZodLiteral<string>;
  displayName: z.ZodOptional<z.ZodString>;
  data: T;
}> {
  return z.object({
    id: z.string().min(1),
    type: z.literal(type),
    displayName: z.string().optional(),
    data,
  });
}

/** 场景对象上的组件：8 种特性组件按各自形状校验，其余宽松。 */
export const sceneComponentSchema = z.union([
  featureComponentSchema(COMPONENT_TYPE.map, mapDataSchema),
  // 战争雾（v13 起）从 GridMap 拆出来：形状不变，还是 `mapFogSchema`
  featureComponentSchema(COMPONENT_TYPE.fog, mapFogSchema),
  // 对象自己显示的图有两种承载（贴图 `ImageLayer` / 精灵 `SpriteLayer`），数据都是
  // `imageLayerDataSchema`（v14 起比 `imageRefSchema` 多一项显示顺序）
  featureComponentSchema(COMPONENT_TYPE.image, imageLayerDataSchema),
  featureComponentSchema(COMPONENT_TYPE.sprite, imageLayerDataSchema),
  featureComponentSchema(COMPONENT_TYPE.sound, soundDataSchema),
  featureComponentSchema(COMPONENT_TYPE.teleport, teleportDataSchema),
  featureComponentSchema(COMPONENT_TYPE.video, videoDataSchema),
  featureComponentSchema(COMPONENT_TYPE.videoBlend, videoBlendDataSchema),
  componentSchema,
]);

/**
 * 场景对象（三端同构的那一个对象）。
 *
 * `kind`：`Map` / `Sprite` / `Player` / `Item` / `Event` / `PlaySound` / `Teleport` / `Image`
 * （v22 起贴图叫 `Image`、精灵叫 `Sprite`，见 `PROTOCOL_VERSION` 的 v12 那一条）。
 * 它是**自由字符串**（不是枚举）：加一种对象类型不需要动协议，老前端照常镜像。
 * **v9 起 `kind` 只是「创建原型」标签**（列表归类、占位色），**不再决定行为**：
 * 「这个对象有什么」全看 `components`——前端据此决定建不建可见物、建哪几层。
 * `position` 为 null = 还没落位（前端不建可见物，与编辑器画布口径一致）。
 */
export const gameObjectSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.string().min(1),
  active: z.boolean(),
  locked: z.boolean().optional(),
  // 显示顺序自 v14 起搬进渲染组件（`GridMap` / 图片层的 data），对象上不再有这一项
  position: worldPositionSchema.nullable(),
  rotation: z.number(),
  scale: z.number(),
  // v11 起文档里可能带单轴缩放（可选）：`scaleX` / `scaleY` 存在时覆盖 `scale` 在对应轴上的值。
  // 这里**可选 + 不设默认**：老编辑器不会发这两个字段，老前端也不认它们（只会看到等比），
  // 所以协议不需要版本号变更——新字段对旧实现是无害的额外信息。
  scaleX: z.number().optional(),
  scaleY: z.number().optional(),
  /**
   * 对象身上挂的组件（v9 起）。
   *
   * 前端按 `type` 分派：`GridMap` → 地图面片 + 网格 + 战争雾；`ImageLayer`（贴图对象）/
   * `SpriteLayer`（精灵对象）→ 那张图的显示层；`PlaySound` / `Teleport` → **不建可见物**
   * （数据留在镜像里，命令要用）；`VideoOverlay` → 运行时建视频层；`VideoBlend` → 运行时建
   * 混合层（两条视频 → 两张 `RenderTexture` → 一个 Mask）。
   * 不认识的类型忽略即可（数据仍留在镜像里）。
   *
   * 缺省给 `[]`：一份「什么都没有的对象」是合法状态，而**缺字段**在老编辑器 / 手写载荷里
   * 也可能出现，为此判整条消息非法不值得（对比 `scale` 那几项同一套取舍）。
   */
  components: z.array(sceneComponentSchema).default([]),
});

/** 场景 = 场景名（就是文件名）+ 对象列表；整份推送 / 整份镜像。 */
export const sceneSchema = z.object({
  name: z.string(),
  objects: z.array(gameObjectSchema),
});

export type ScenePayload = z.infer<typeof sceneSchema>;
export type GameObjectPayload = z.infer<typeof gameObjectSchema>;

/** 从对象上取某个组件的数据（协议层不解释内容，只按 `type` 找）。 */
export function componentDataOf<T = Record<string, unknown>>(
  object: GameObjectPayload,
  type: string,
): T | undefined {
  return object.components.find((item) => item.type === type)?.data as T | undefined;
}

/**
 * 这个对象引用到的**全部资源逻辑 ID**（贴图 / 音频 / 视频）。
 *
 * 服务端用它从推下来的场景里反推「这是哪个项目的资源」（`RuntimeSession.resourceProject`），
 * 好让前端**先下资源包、再载入场景**。放在协议包里是因为它只依赖协议自己的字段形状；
 * 换成一个组件时只改这里，服务端与 Mock 前端都不用动。
 *
 * v16 起**带网格的贴图的图也在 `ImageLayer` 里**，所以贴图这一条扫两种组件就够，不用再单独看地图。
 */
export function resourceIdsOfObject(object: GameObjectPayload): readonly string[] {
  const ids: string[] = [];

  // 对象自己显示的图有两种承载：贴图 `ImageLayer` / 精灵 `SpriteLayer`
  // （v10 及更早统一叫 `TextureRenderer`，v21 起拆开）——**两种都要扫**，
  // 只扫一种会让装了精灵的场景不下发它引用的那张图。
  for (const type of [COMPONENT_TYPE.image, COMPONENT_TYPE.sprite]) {
    const image = componentDataOf<{ id?: string }>(object, type);
    if (image?.id !== undefined) {
      ids.push(image.id);
    }
  }

  for (const type of [COMPONENT_TYPE.sound, COMPONENT_TYPE.video]) {
    const media = componentDataOf<{ clips?: readonly string[] }>(object, type);
    ids.push(...(media?.clips ?? []));
  }

  // 视频混合：两路各是**一个素材**（v19 起；之前是「列表 + 选中」），都要进资源包
  const blend = componentDataOf<{
    a?: { id?: string };
    b?: { id?: string };
  }>(object, COMPONENT_TYPE.videoBlend);
  if (blend !== undefined) {
    if (blend.a?.id !== undefined) {
      ids.push(blend.a.id);
    }
    if (blend.b?.id !== undefined) {
      ids.push(blend.b.id);
    }
  }

  return ids;
}
export type SoundLayer = z.infer<typeof soundLayerSchema>;
/** 项目级全局设置（`settings_push` / `project_settings` 的载荷）。 */
export type ProjectSettingsPayload = z.infer<typeof projectSettingsSchema>;
/** 已推下去的全局设置摘要（`editor_state.settings`）。 */
export type ProjectSettingsInfo = z.infer<typeof projectSettingsInfoSchema>;
export type ClientInfo = z.infer<typeof clientInfoSchema>;
export type SceneInfo = z.infer<typeof sceneInfoSchema>;
export type ResourcesInfo = z.infer<typeof resourcesInfoSchema>;

// ---------------------------------------------------------------- 命令（触发器，不是数据）

/**
 * 归一化图片坐标：`[0,1]`，**y 向下**（左上原点，与编辑器画布一致）。
 *
 * 前端把它映射到纹理像素时要翻一次 y（`(1 - y) × 高`）——纹理是自下而上的。
 */
export const normalizedPointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

/**
 * 战争雾擦除的**一笔轨迹**（与参考实现 `backend_diceTale` 的 `EraseStroke` 同一套口径，
 * 逐字对齐 `apps/editor/src/services/mask-math.ts` 里前端实际执行的那套运算）。
 *
 * - `points`：鼠标拖过的**轨迹**（归一化点，y 向下）。**发的只是轨迹，不是整张遮罩**——
 *   擦除在两端各自算一遍（前端不必收几 MB 的位图）。单点也算一笔（在那一处打一个擦除圆）；
 * - `radius`：**半径 / 遮罩宽**（编辑器固定 `48/960 = 0.05`）。前端收到后乘**它自己**的
 *   遮罩宽得到纹理像素半径——两边只要都按这个比例，擦出来的范围一致；
 * - `softness`：软边带比例（`0` = 硬边、`1` = 全程衰减）。编辑器固定 `1`（战争雾）/
 *   `0.5`（视频混合——要一个**实心核**，擦到的地方才会真的到 0，见 `VIDEO_BLEND_MASK_SOFTNESS`）。
 *
 * 这里**只挡畸形结构**（空轨迹、`NaN` / `Infinity`——zod 4 的 `z.number()` 本来就不收无限值）：
 * 点坐标的具体处理由前端消化（越界点夹到 `[0,1]`），与参考实现的后端校验同一条口径。
 */
export const eraseStrokeSchema = z.object({
  points: z.array(normalizedPointSchema).min(1),
  radius: z.number().nonnegative(),
  softness: z.number().nonnegative(),
});

/**
 * 后台 → 前端的命令。
 *
 * **载荷里不带数据**：`play_sound` 只说「让这个对象在它自己声明的层上播」，
 * 前端从**镜像里的那个对象**读 `sound.picked`——数据在场景里，命令只是触发器。
 * `pause_sound` / `resume_sound` 按**层级**给（同层只响一条，所以「暂停这一层」= 暂停当前那条）。
 * 视频同理：`play_video{objectId}` 只说「现在放」，放哪一条 / 循环 / 声音在那个对象的 `video` 里。
 * 战争雾同理：`erase_mask` / `reveal_fog_region` 只给**雾对象 id**（+ 轨迹 / 区域位），
 * 雾层本身在推下去的那个**雾对象**里（`FogOfWar.regions`），格子取自它引用的地图
 * （`map.cells`）。
 */
export const commandRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("play_sound"),
    objectId: z.string().min(1),
    layer: soundLayerSchema,
  }),
  z.object({
    kind: z.literal("stop_sound"),
    layer: soundLayerSchema,
  }),
  /**
   * 声音：**暂停 / 继续**（v6 起，与视频那两条对称）。
   *
   * 按**层级**管（不是按对象）：同层同时只响一条，所以「暂停这一层」就是暂停当前那条。
   * 编辑器里「播放声音对象」与「视频」两组 UI 的控件行因此完全一致。
   */
  z.object({
    kind: z.literal("pause_sound"),
    layer: soundLayerSchema,
  }),
  z.object({
    kind: z.literal("resume_sound"),
    layer: soundLayerSchema,
  }),
  /**
   * 视频（v5 起）：在**这个对象自己的矩形**上放它 `video.picked` 那一条。
   *
   * 与 `play_sound` 同一条规矩：**命令里不带数据**（没有 clip、没有 loop/audio），
   * 前端从镜像里的那个对象读 `video.picked` / `video.loop` / `video.audio`。
   * 「放哪一条」由编辑器面板上那一排小方块决定，命令只是「现在放」这个动作。
   */
  z.object({
    kind: z.literal("play_video"),
    objectId: z.string().min(1),
  }),
  /** 视频：暂停在当前帧（再 `resume_video` 从这一帧续播）。 */
  z.object({
    kind: z.literal("pause_video"),
    objectId: z.string().min(1),
  }),
  /** 视频：从暂停处续播（对没在播的对象 = 从头放）。 */
  z.object({
    kind: z.literal("resume_video"),
    objectId: z.string().min(1),
  }),
  /** 视频：停止并**拆掉那一层**（露出对象自己原来的贴图）。 */
  z.object({
    kind: z.literal("stop_video"),
    objectId: z.string().min(1),
  }),
  /**
   * 全局背景音乐（v7 起）：放（或**切换**到）某一首。
   *
   * 与 `play_video` / `play_sound` 的差别只有一处：它**带 `clip`**。
   * 理由是曲目清单不在任何对象上、也不在项目设置里（v8 起）——它就是**项目 `Assets/audio/`
   * 下的音频文件**，由编辑器弹框列出来给 DM 点。所以命令说「现在放哪一首」，
   * 前端按 `clip` 去资源包里找音频；音量读 `project_settings`，循环恒开。
   */
  z.object({
    kind: z.literal("play_bgm"),
    clip: z.string().min(1),
  }),
  /** 背景音乐：暂停在当前帧（同一条曲子被再次 `play_bgm` = 从头重播）。 */
  z.object({
    kind: z.literal("pause_bgm"),
  }),
  /** 背景音乐：从暂停处续播。 */
  z.object({
    kind: z.literal("resume_bgm"),
  }),
  /** 背景音乐：停掉（再 `play_bgm` 从头开始）。 */
  z.object({
    kind: z.literal("stop_bgm"),
  }),
  /** 战争雾：沿这笔轨迹擦掉**雾对象**上的雾（`objectId` = 雾对象 id）。 */
  z.object({
    kind: z.literal("erase_mask"),
    objectId: z.string().min(1),
    stroke: eraseStrokeSchema,
  }),
  /**
   * 战争雾：整片揭示（`revealed: true`）或整片盖回（`false`）某个区域。
   *
   * `objectId` = **雾对象 id**；「区域」是它 `FogOfWar.regions` 里的那个区域位：
   * 含该位的**每个**格子一起变。
   * 盖回会连带盖掉这一区里手动擦掉的部分——与 Mask 窗口里那个「整区开关」同一口径。
   */
  z.object({
    kind: z.literal("reveal_fog_region"),
    objectId: z.string().min(1),
    region: z.number().int(),
    revealed: z.boolean(),
  }),
  /**
   * 视频混合：沿这笔轨迹擦掉**贴图对象**上的混合遮罩（`objectId` = 贴图对象 id）。
   *
   * 与 `erase_mask` 逐字同一套轨迹口径（`eraseStrokeSchema`：归一化点 + 归一化半径 + 软边），
   * 但寻址与宿主不同：遮罩在推下去的那个对象的 `VideoBlend` 里，**纯运行态**、不随场景回来。
   *
   * **单列一条命令而不是复用 `erase_mask`**：后者的契约写死「`objectId` = 雾对象 id、
   * 雾层在 `FogOfWar` 里」——两张遮罩的宿主、语义与前端落点都不一样，混用会让两边互相污染
   * （也躲不开「雾对象 vs 贴图对象」的寻址差异）。
   */
  z.object({
    kind: z.literal("erase_video_mask"),
    objectId: z.string().min(1),
    stroke: eraseStrokeSchema,
  }),
  /**
   * 视频混合：把**整张**混合遮罩一次填成 1 / 0。
   *
   * `covered: true` = 整张盖住（遮罩 = 1，只看见 A，连之前擦开的一起盖回去）；
   * `false` = 整张擦开（遮罩 = 0，只看见 B）。
   *
   * 与 `erase_video_mask` 分成**两条命令**（照 `erase_mask` / `reveal_fog_region` 的先例）：
   * 这个操作跟位置无关、只有一个布尔，塞进轨迹那条反而要把 `stroke` 变可选。
   * 两者在编辑器那一侧是**同一条有序的操作序列**，前端按收到的先后依次应用
   * （于是「先擦一笔、再整张盖住」= 那一笔也被盖掉）。
   */
  z.object({
    kind: z.literal("fill_video_mask"),
    objectId: z.string().min(1),
    covered: z.boolean(),
  }),
]);

export type CommandRequest = z.infer<typeof commandRequestSchema>;

/** 命令回执（前端 → 服务端 → 编辑器）。无论成功失败都必须回，不静默失败。 */
export const commandResultSchema = z.object({
  type: z.literal("command_result"),
  requestId: z.string().min(1),
  ok: z.boolean(),
  reason: z.string().optional(),
  effects: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------- 公共结构

/** 前端信息（服务端在 `client_hello` 后广播给编辑器）。 */
export const clientInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  connectedAt: z.number().int(),
});

/** 运行态里那份场景的摘要（编辑器用它显示「镜像到哪了」）。 */
export const sceneInfoSchema = z.object({
  name: z.string(),
  objectCount: z.number().int(),
  updatedAt: z.number().int(),
});

/**
 * 已推下去的**全局设置**的摘要（编辑器用它显示「全局设置已下发」）。
 *
 * 只带看得懂的一件事实：什么时候推的——足够让 DM 确认「我刚调的音量确实到了服务端」，
 * 不必把整份设置回传一遍。v8 起背景音乐的歌单不在设置里，所以摘要里也没有它。
 */
export const projectSettingsInfoSchema = z.object({
  updatedAt: z.number().int(),
});

/**
 * 前端本地资源包的摘要（编辑器用它显示「素材下到哪了」）。
 *
 * 前端连上后会把当前项目的 `Assets/` 整包拉到本地（见 `docs/specs/` 的资源包说明），
 * 拉完（或拉失败）回一条 `resources_ready`，服务端记在这里并广播给编辑器。
 * `null` = 这次运行态还没收到过前端的资源包回执。
 */
export const resourcesInfoSchema = z.object({
  project: z.string(),
  fingerprint: z.string(),
  fileCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  ok: z.boolean(),
  at: z.number().int(),
  reason: z.string().optional(),
});

// ---------------------------------------------------------------- 编辑器 → 服务端

export const editorToServerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("editor_hello"), protocolVersion: z.number().int() }),
  /** 进入运行态：服务端据此开闸（此后 `/client` 才连得上）。幂等。 */
  z.object({ type: z.literal("runtime_start") }),
  /** 退出运行态：关闸、踢前端、清场景缓存。 */
  z.object({ type: z.literal("runtime_stop") }),
  /** 推当前场景（整份）；`null` = 没有打开的场景（前端清空镜像）。 */
  z.object({ type: z.literal("scene_push"), scene: sceneSchema.nullable() }),
  /**
   * 推**项目级全局设置**（v7 起）；`null` = 没有打开的项目。
   *
   * 与 `scene_push` 并排而不是塞进场景里：它跨场景有效（换场景不该丢），
   * 服务端缓存一份，前端一连上就补发。音量是**数据**——前端收到即生效，不需要命令。
   */
  z.object({ type: z.literal("settings_push"), settings: projectSettingsSchema.nullable() }),
  /** 下发一条命令给前端。 */
  z.object({
    type: z.literal("editor_command"),
    requestId: z.string().min(1),
    command: commandRequestSchema,
  }),
  /** 要一份当前运行态（订阅也走它）。 */
  z.object({ type: z.literal("editor_refresh") }),
]);

export type EditorToServerMessage = z.infer<typeof editorToServerSchema>;

// ---------------------------------------------------------------- 服务端 → 编辑器

export const editorLogLevelSchema = z.enum(["info", "warn", "error"]);

export const serverToEditorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("editor_state"),
    runtimeActive: z.boolean(),
    client: clientInfoSchema.nullable(),
    scene: sceneInfoSchema.nullable(),
    /** 前端本地资源包状态（没收到回执时 null）。 */
    resources: resourcesInfoSchema.nullable(),
    /** 已经推下去的全局设置摘要（编辑器据此显示「全局设置已下发」；没推过时 null）。 */
    settings: projectSettingsInfoSchema.nullable(),
    serverTime: z.number().int(),
  }),
  z.object({
    type: z.literal("editor_command_result"),
    requestId: z.string().min(1),
    ok: z.boolean(),
    reason: z.string().optional(),
    effects: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("editor_log"),
    level: editorLogLevelSchema,
    message: z.string(),
    time: z.string(),
  }),
  z.object({
    type: z.literal("editor_error"),
    requestId: z.string().optional(),
    reason: z.string(),
  }),
]);

export type ServerToEditorMessage = z.infer<typeof serverToEditorSchema>;

// ---------------------------------------------------------------- 前端 → 服务端

export const clientToServerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("client_hello"),
    protocolVersion: z.number().int(),
    name: z.string(),
    version: z.string(),
  }),
  commandResultSchema,
  z.object({ type: z.literal("pong"), seq: z.number().int() }),
  /**
   * 前端把本地资源包的结果报上来（成功或失败都报）。
   *
   * 它**不影响协议版本**：老前端的入站消息里没有这一条，服务端只是收不到回执；
   * 新前端的出站多这一条，服务端 schema 认它。
   */
  z.object({
    type: z.literal("resources_ready"),
    project: z.string().min(1),
    fingerprint: z.string().min(1),
    fileCount: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    ok: z.boolean(),
    reason: z.string().optional(),
  }),
]);

export type ClientToServerMessage = z.infer<typeof clientToServerSchema>;

// ---------------------------------------------------------------- 服务端 → 前端

export const serverToClientSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("server_hello"),
    protocolVersion: z.number().int(),
    sessionId: z.string().min(1),
    serverTime: z.number().int(),
  }),
  /** 全量场景：连上立刻给一份缓存，之后每次 `scene_push` 转发一份。 */
  z.object({ type: z.literal("scene_sync"), scene: sceneSchema.nullable() }),
  /**
   * 让前端**先把当前项目的资源包拉下来**（在 `scene_sync` 之前发）。
   *
   * 为什么需要它：前端要从镜像里的逻辑 ID 才能推出项目名，而镜像是 `scene_sync` 带来的——
   * 那就成了「场景先到、资源后下」。这条消息把项目名提前告知，前端就能**先下载、再载入场景**。
   * `project` 为 null = 服务端还不知道当前项目（编辑器还没推过场景），前端照常等场景。
   */
  z.object({ type: z.literal("resources_prepare"), project: z.string().min(1).nullable() }),
  /**
   * 项目级全局设置（v7 起）：前端连上就补一份，之后每次 `settings_push` 转发一份。
   *
   * **在 `scene_sync` 之前发**：音量与歌单是「放之前就该知道的事」，先到一步，
   * 前端载入场景 / 起播时就不用等第二条消息。`null` = 服务端还没有设置（没打开项目）。
   */
  z.object({ type: z.literal("project_settings"), settings: projectSettingsSchema.nullable() }),
  z.object({
    type: z.literal("command"),
    requestId: z.string().min(1),
    command: commandRequestSchema,
  }),
  z.object({ type: z.literal("ping"), seq: z.number().int() }),
]);

export type ServerToClientMessage = z.infer<typeof serverToClientSchema>;

// ---------------------------------------------------------------- 解析助手

function parseWith<T>(schema: z.ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${channel} 消息校验失败: ${detail}`);
  }

  return result.data;
}

export function parseClientToServer(raw: unknown): ClientToServerMessage {
  return parseWith(clientToServerSchema, raw, "/client 入站");
}

export function parseServerToClient(raw: unknown): ServerToClientMessage {
  return parseWith(serverToClientSchema, raw, "/client 出站");
}

export function parseEditorToServer(raw: unknown): EditorToServerMessage {
  return parseWith(editorToServerSchema, raw, "/editor 入站");
}

export function parseServerToEditor(raw: unknown): ServerToEditorMessage {
  return parseWith(serverToEditorSchema, raw, "/editor 出站");
}

/** 从任意 JSON 文本解析（入站用），JSON 非法时抛错。 */
export function parseJsonMessage(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("消息不是合法 JSON");
  }
}

/** 生成请求 id（命令回执关联用）。 */
export function createRequestId(prefix = "req"): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}
