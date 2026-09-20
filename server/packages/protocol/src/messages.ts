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
 */
export const PROTOCOL_VERSION = 2;

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

export const mapFogSchema = z.object({
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

/** 声音层级：固定四档（同层同时只响一条）。 */
export const soundLayerSchema = z.enum(["bgm", "ambient", "sfx", "voice"]);

/** 声音对象的数据：加进来的音频 + 当前选中的那条 + 层级（前端播的就是 `picked`）。 */
export const soundDataSchema = z.object({
  clips: z.array(z.string()),
  picked: z.string().optional(),
  layer: soundLayerSchema,
});

/**
 * 场景对象（三端同构的那一个对象）。
 *
 * `kind`：`Map` / `SceneObject` / `Player` / `Item` / `Event` / `PlaySound`。
 * 前端按需取用字段：`components`（编辑器侧的组件与动作，前端不执行）等字段会被忽略。
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
export type ClientInfo = z.infer<typeof clientInfoSchema>;
export type SceneInfo = z.infer<typeof sceneInfoSchema>;
export type ResourcesInfo = z.infer<typeof resourcesInfoSchema>;

// ---------------------------------------------------------------- 命令（触发器，不是数据）

/**
 * 后台 → 前端的命令。
 *
 * **载荷里不带数据**：`play_sound` 只说「让这个对象在它自己声明的层上播」，
 * 前端从**镜像里的那个对象**读 `sound.picked`——数据在场景里，命令只是触发器。
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
