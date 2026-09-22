import type {
  ClientToServerMessage,
  EditorToServerMessage,
  ServerToClientMessage,
  ServerToEditorMessage,
} from "@dts/protocol";
import type { WebSocket } from "ws";
import type { HubContext } from "../hub-context";

/**
 * **一条消息一个函数**：处理器的参数按 `type` 精确收窄，
 * 所以 `message.protocolVersion` 这种东西在 `editor_hello` 之外根本写不出来。
 */
export type EditorHandler<K extends EditorToServerMessage["type"]> = (
  ctx: HubContext,
  ws: WebSocket,
  message: Extract<EditorToServerMessage, { type: K }>,
) => void;

export type ClientHandler<K extends ClientToServerMessage["type"]> = (
  ctx: HubContext,
  ws: WebSocket,
  message: Extract<ClientToServerMessage, { type: K }>,
) => void;

/** 「可以用一条联合类型的消息调用」的处理器表。 */
export type EditorHandlerTable = Record<
  EditorToServerMessage["type"],
  (ctx: HubContext, ws: WebSocket, message: EditorToServerMessage) => void
>;

export type ClientHandlerTable = Record<
  ClientToServerMessage["type"],
  (ctx: HubContext, ws: WebSocket, message: ClientToServerMessage) => void
>;

/**
 * 把「按 type 精确定型的一张处理器表」放宽成「可以用联合类型调用的一张表」。
 *
 * 里面这一次断言是**全项目唯一**的一处，而且只影响「怎么调用」、不影响「怎么实现」：
 * TS 无法在保持每个处理器参数精确的同时让 `table[message.type](ctx, ws, message)` 通过
 * ——用联合去索引映射类型会退化成「联合的函数类型」，那个联合以任一成员调用都不成立。
 * `Record<Kind, Handler>` 的**键完整性由类型保证**：漏一条消息编译不过，这正是我们要的。
 */
export function defineEditorHandlers(
  handlers: { readonly [K in EditorToServerMessage["type"]]: EditorHandler<K> },
): EditorHandlerTable {
  return handlers as EditorHandlerTable;
}

export function defineClientHandlers(
  handlers: { readonly [K in ClientToServerMessage["type"]]: ClientHandler<K> },
): ClientHandlerTable {
  return handlers as ClientHandlerTable;
}

/** 处理器可能用到的出站消息类型（转发给前端时用）。 */
export type { ServerToClientMessage, ServerToEditorMessage };
