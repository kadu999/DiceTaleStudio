import { z } from "zod";

/**
 * WebSocket 消息契约（编辑器 / 服务端 / 前端三端共用的唯一来源）。
 *
 * 通道划分：
 * - `/client`：前端（Unity 客户端）↔ 服务端
 * - `/editor`：编辑器 ↔ 服务端
 *
 * 命名沿用 DiceTale 既有协议（snake_case 的 `type`、`mapName`、`objectId` 等），
 * 新增消息只在末尾追加，**不修改既有消息语义**，保证老前端仍可工作。
 */

// ---------------------------------------------------------------- 公共结构

/**
 * **世界坐标**：原点 = 场景中心 `(0, 0)`，x 向右，**y 向上**，单位像素
 * （与文档里 `SceneObjectDoc.position`、`@dts/grid` 的 `world.ts` 完全一致）。
 *
 * 协议里**不再有第二套坐标**：前端上报对象 / 玩家位置、擦除笔画、传送落点都用这一套。
 */
export const positionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

/** 组件数据段：后端/GM 按 `component` 类型解析 `data`（JSON 字符串）。 */
export const componentDataSchema = z.object({
  component: z.string(),
  displayName: z.string().optional(),
  data: z.string(),
});

/** 动作清单条目：前端上报「本对象上可被远程触发的动作」（新增能力）。 */
export const actionSummarySchema = z.object({
  actionId: z.string().min(1),
  type: z.string().min(1),
  displayName: z.string().optional(),
  paramSummary: z.string().optional(),
  conditionSummary: z.string().optional(),
});

/** 对象状态快照（与既有 ObjectStateSnapshot 对齐）。 */
export const objectStateSchema = z.object({
  name: z.string(),
  kind: z.string(),
  mapName: z.string(),
  position: positionSchema.nullable(),
  componentData: z.array(componentDataSchema).optional(),
  /** 新增：可触发的动作清单。 */
  actions: z.array(actionSummarySchema).optional(),
});

export const playerStateSchema = z.object({
  name: z.string(),
  position: positionSchema,
  mapName: z.string(),
});

export const gameStateSchema = z.object({
  currentMap: z.string(),
  players: z.record(z.string(), playerStateSchema),
  objects: z.record(z.string(), objectStateSchema),
});

// 由 schema 推导的类型（编辑器与后端共用，保证"校验通过"与"类型正确"是同一件事）
export type Position = z.infer<typeof positionSchema>;
export type ComponentData = z.infer<typeof componentDataSchema>;
export type ActionSummary = z.infer<typeof actionSummarySchema>;
export type ObjectStateSnapshot = z.infer<typeof objectStateSchema>;
export type PlayerStateSnapshot = z.infer<typeof playerStateSchema>;
export type GameStateSnapshot = z.infer<typeof gameStateSchema>;
export type InvokeActionMessage = z.infer<typeof invokeActionSchema>;
export type ActionResultMessage = z.infer<typeof actionResultSchema>;

/** 遮罩擦除笔画（既有协议）。 */
export const eraseStrokeSchema = z.object({
  points: z.array(positionSchema),
  radius: z.number(),
  softness: z.number(),
  done: z.boolean().optional(),
});

// ---------------------------------------------------------------- 动作触发（核心新增）

/** 触发某对象上的某个动作。编辑器 → 服务端 → 前端的核心语义命令。 */
export const invokeActionSchema = z.object({
  type: z.literal("invoke_action"),
  requestId: z.string().min(1),
  objectId: z.string().min(1),
  actionId: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});

/** 动作执行回执。前端 → 服务端 → 编辑器。 */
export const actionResultSchema = z.object({
  type: z.literal("action_result"),
  requestId: z.string().min(1),
  objectId: z.string().min(1),
  actionId: z.string().min(1),
  ok: z.boolean(),
  reason: z.string().optional(),
  effects: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------- 前端 → 服务端

export const registerMapObjectsSchema = z.object({
  type: z.literal("register_map_objects"),
  mapName: z.string(),
  objects: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        kind: z.string().optional(),
        mapName: z.string().optional(),
        position: positionSchema.nullable().optional(),
        componentData: z.array(componentDataSchema).optional(),
      }),
    )
    .optional(),
});

export const clientToServerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("request_join") }),
  registerMapObjectsSchema,
  z.object({
    type: z.literal("register_players"),
    players: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
  /** 新增：动作清单上报（可与 register_map_objects 合并，但独立消息便于前端分阶段实现）。 */
  z.object({
    type: z.literal("register_actions"),
    objectId: z.string().min(1),
    componentId: z.string().min(1),
    actions: z.array(actionSummarySchema),
  }),
  z.object({
    type: z.literal("request_teleport"),
    mapName: z.string(),
    spawnId: z.string(),
  }),
  z.object({
    type: z.literal("report_player_position"),
    playerId: z.string(),
    position: positionSchema,
    mapName: z.string(),
  }),
  z.object({
    type: z.literal("report_object_position"),
    objectId: z.string(),
    position: positionSchema,
    mapName: z.string(),
  }),
  actionResultSchema,
  z.object({ type: z.literal("heartbeat") }),
]);

export type ClientToServerMessage = z.infer<typeof clientToServerSchema>;

// ---------------------------------------------------------------- 服务端 → 前端

export const serverToClientSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sync_state"), state: gameStateSchema }),
  z.object({ type: z.literal("teleport_player"), mapName: z.string(), spawnId: z.string() }),
  z.object({ type: z.literal("set_option"), objectId: z.string(), option: z.string() }),
  z.object({ type: z.literal("set_object_items"), objectId: z.string(), items: z.array(z.string()) }),
  z.object({ type: z.literal("set_mask_image"), objectId: z.string(), image: z.string() }),
  z.object({ type: z.literal("erase_mask"), objectId: z.string(), stroke: eraseStrokeSchema }),
  z.object({ type: z.literal("set_float"), objectId: z.string(), value: z.number() }),
  z.object({ type: z.literal("set_int"), objectId: z.string(), value: z.number().int() }),
  z.object({ type: z.literal("set_bool"), objectId: z.string(), value: z.boolean() }),
  z.object({ type: z.literal("set_map"), mapName: z.string(), spawnId: z.string().optional() }),
  /** 核心新增。 */
  invokeActionSchema,
]);

export type ServerToClientMessage = z.infer<typeof serverToClientSchema>;

// ---------------------------------------------------------------- 编辑器 → 服务端

/** 编辑器运行态下的原子命令直通（低层，副作用由前端本地动作链产生）。 */
export const atomicCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_option"), objectId: z.string(), option: z.string() }),
  z.object({ type: z.literal("set_bool"), objectId: z.string(), value: z.boolean() }),
  z.object({ type: z.literal("set_int"), objectId: z.string(), value: z.number().int() }),
  z.object({ type: z.literal("set_float"), objectId: z.string(), value: z.number() }),
  z.object({ type: z.literal("set_object_items"), objectId: z.string(), items: z.array(z.string()) }),
  z.object({ type: z.literal("teleport_player"), mapName: z.string(), spawnId: z.string() }),
]);

export const editorToServerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("editor_subscribe") }),
  z.object({ type: z.literal("editor_refresh") }),
  invokeActionSchema,
  atomicCommandSchema,
]);

export type EditorToServerMessage = z.infer<typeof editorToServerSchema>;

// ---------------------------------------------------------------- 服务端 → 编辑器

export const editorLogLevelSchema = z.enum(["info", "warn", "error"]);

export const serverToEditorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("editor_snapshot"),
    state: gameStateSchema,
    clientConnected: z.boolean(),
    editorConnected: z.boolean().default(true),
  }),
  actionResultSchema,
  z.object({
    type: z.literal("editor_error"),
    requestId: z.string().optional(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("editor_log"),
    level: editorLogLevelSchema,
    message: z.string(),
    time: z.string(),
  }),
]);

export type ServerToEditorMessage = z.infer<typeof serverToEditorSchema>;

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

/** 生成请求 id（触发动作时用于关联回执）。 */
export function createRequestId(prefix = "req"): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}
