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
 */
export const PROTOCOL_VERSION = 8;

/** 未进入运行态时拒绝 `/client` 升级的 HTTP 状态与原因头。 */
export const RUNTIME_INACTIVE_STATUS = 503;
export const RUNTIME_INACTIVE_REASON = "runtime-inactive";

/** 关闸（退出运行态）时踢掉前端的 close code。 */
export const RUNTIME_STOPPED_CODE = 4003;
/** 协议版本不一致时踢掉前端的 close code。 */
export const PROTOCOL_MISMATCH_CODE = 4002;

// ---------------------------------------------------------------- 场景（文档模型的只读复刻）

/**
 * 场景对象数据 = 编辑器文档模型里的 `SceneObjectDoc`（`@dts/document`）。
 *
 * 这里**复刻一份只读 schema**而不是 import `@dts/document`：`protocol` 是被三端共用的
 * 最底层包，不该反过来依赖文档包。字段口径与文档严格一致，文档加字段时这里同步补。
 */
export const worldPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

/** 图片引用：资源逻辑 ID + 声明的宽高（世界像素；实际尺寸 = 声明尺寸 × 对象 scale）。 */
export const imageRefSchema = z.object({
  id: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/** RLE 一段：`[掩码, 连续格数]`（掩码值与 `@dts/grid` 的 `CellMask` 一致）。 */
export const rleRunSchema = z.tuple([z.number().int(), z.number().int()]);

export const gridSpecSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const cellRunsSchema = z.object({
  encoding: z.literal("rle"),
  runs: z.array(rleRunSchema),
});

/**
 * 战争雾：**总开关** + 把哪些「区域」当成雾区（区域位取自 `@dts/grid` 的可绘制位，
 * `[1, 8]` = 区域1 + 区域4）。
 *
 * 前端据此从 `cells` 里挑出**雾格子**、生成一张像素遮罩（只盖雾区、其余透明）；
 * `enabled` 是 v13 起的总开关，**关着时前端一层的雾都不建**（不是建了再隐藏）——
 * 与文档 schema 同一口径，缺省算开（v10–v12 的文件里「有 fog」就等于「开着」）。
 * **哪个格子被揭示了不在数据里**：那是运行态，由 `erase_mask` / `reveal_fog_region` 命令驱动，
 * 不写文档、也不随 `scene_sync` 走。
 */
export const mapFogSchema = z.object({
  enabled: z.boolean().default(true),
  regions: z.array(z.number().int()),
});
/** 地图对象携带的数据（贴图 + 网格；`rowOrder` 固定 bottom-up）。 */
export const mapDataSchema = z.object({
  image: imageRefSchema,
  grid: gridSpecSchema,
  rowOrder: z.literal("bottom-up"),
  cells: cellRunsSchema,
  fog: mapFogSchema.optional(),
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
  clips: z.array(z.string()),
  picked: z.string().optional(),
  layer: soundLayerSchema,
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
  clips: z.array(z.string()).default([]),
  picked: z.string().optional(),
  loop: z.boolean().default(false),
  audio: z.boolean().default(false),
});

/**
 * 传送阵（动作对象）的数据：候选目标场景 + 当前选中的那一个。
 *
 * **前端不需要它**：触发传送阵 = 编辑器切换当前场景 → 整份 `scene_push` 下来，
 * 前端只管换镜像（没有一个「teleport」命令，也不需要）。放进协议 schema 是因为它就是
 * `SceneObjectDoc` 的一部分——这份 schema 是文档形状的只读复刻，少了字段等于悄悄丢数据。
 */
export const teleportDataSchema = z.object({
  targets: z.array(z.string()),
  picked: z.string().optional(),
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
 * 场景对象（三端同构的那一个对象）。
 *
 * `kind`：`Map` / `SceneObject` / `Player` / `Item` / `Event` / `PlaySound` / `Teleport`。
 * 前端按需取用字段：`components`（编辑器侧的组件与动作，前端不执行）等字段会被忽略；
 * `teleport`（传送阵的目标场景）只有编辑器用——见 `teleportDataSchema` 的说明。
 * `position` 为 null = 还没落位（前端不建可见物，与编辑器画布口径一致）。
 */
export const sceneObjectSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.string().min(1),
  active: z.boolean(),
  locked: z.boolean().optional(),
  sortingOrder: z.number().int(),
  position: worldPositionSchema.nullable(),
  rotation: z.number(),
  scale: z.number(),
  // v11 起文档里可能带单轴缩放（可选）：`scaleX` / `scaleY` 存在时覆盖 `scale` 在对应轴上的值。
  // 这里**可选 + 不设默认**：老编辑器不会发这两个字段，老前端也不认它们（只会看到等比），
  // 所以协议不需要版本号变更——新字段对旧实现是无害的额外信息。
  scaleX: z.number().optional(),
  scaleY: z.number().optional(),
  components: z.array(z.unknown()).optional(),
  map: mapDataSchema.optional(),
  sound: soundDataSchema.optional(),
  // v12 起文档里可能带传送阵的目标场景（可选）：**前端不用它**（切场景靠整份 `scene_push`），
  // 但它是 SceneObjectDoc 的一部分，缺了就等于在这一层丢了字段。
  teleport: teleportDataSchema.optional(),
  // v14 起文档里可能带视频列表（可选，只有地图 / 精灵会带）：前端据此在**那个对象自己的矩形**上
  // 建一层视频，命令（`play_video` 等）只给 `objectId`。
  video: videoDataSchema.optional(),
  image: imageRefSchema.optional(),
});

/** 场景 = 场景名（就是文件名）+ 对象列表；整份推送 / 整份镜像。 */
export const sceneSchema = z.object({
  name: z.string(),
  objects: z.array(sceneObjectSchema),
});

export type ScenePayload = z.infer<typeof sceneSchema>;
export type SceneObjectPayload = z.infer<typeof sceneObjectSchema>;
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
 * - `softness`：软边带比例（`0` = 硬边、`1` = 全程衰减），编辑器固定 `1`。
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
 * 战争雾同理：`erase_mask` 只给**轨迹**，雾层本身在推下去的那个地图对象里
 * （`map.fog.regions` + `map.cells`）。
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
  /** 战争雾：沿这笔轨迹擦掉地图对象上的雾。 */
  z.object({
    kind: z.literal("erase_mask"),
    objectId: z.string().min(1),
    stroke: eraseStrokeSchema,
  }),
  /**
   * 战争雾：整片揭示（`revealed: true`）或整片盖回（`false`）某个区域。
   *
   * 「区域」是 `map.fog.regions` 里的那个区域位：含该位的**每个**格子一起变。
   * 盖回会连带盖掉这一区里手动擦掉的部分——与 Mask 窗口里那个「整区开关」同一口径。
   */
  z.object({
    kind: z.literal("reveal_fog_region"),
    objectId: z.string().min(1),
    region: z.number().int(),
    revealed: z.boolean(),
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
export type CommandResultMessage = z.infer<typeof commandResultSchema>;
export type EditorStateMessage = z.infer<typeof serverToEditorSchema>;

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
