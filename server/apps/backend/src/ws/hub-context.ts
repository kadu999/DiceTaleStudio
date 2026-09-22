import type { ServerToClientMessage, ServerToEditorMessage } from "@dts/protocol";
import type { WebSocket } from "ws";
import type { RuntimeSession } from "./runtime-session";
import type { HubLogger, LogLevel } from "./types";

/**
 * 消息处理器能用的全部能力。
 *
 * 这是 `RuntimeHub` 与处理器之间的唯一接口：处理器**不认识 WebSocket 服务器、也不认识
 * 心跳定时器与连接表**，只通过这里做「读运行态 / 发消息 / 记日志」。于是加一条消息
 * 不需要理解中枢的传输细节，中枢也不必知道有哪些消息。
 *
 * 实现方是 `RuntimeHub` 自己（`implements HubContext`）——它是唯一同时握着会话、
 * 编辑器集合与前端 socket 的地方。
 */
export interface HubContext {
  /** 运行态（开闸 / 前端 / 场景 / 设置 / 资源包）。处理器唯一的可变状态入口。 */
  readonly session: RuntimeSession;

  readonly log: HubLogger;

  /** 前端是否在线（已连接且 socket 处于 OPEN）。 */
  readonly clientConnected: boolean;

  /** 已连接前端的 socket；没有连接时 `undefined`。 */
  readonly clientSocket: WebSocket | undefined;

  /** 前端连接的远端地址（`client_hello` 要把它写进前端信息）。 */
  readonly clientAddress: string;

  sendTo(ws: WebSocket, message: ServerToEditorMessage | ServerToClientMessage): void;

  broadcastToEditors(message: ServerToEditorMessage): void;

  logToEditors(level: LogLevel, message: string): void;

  sendEditorState(ws: WebSocket): void;

  broadcastEditorState(): void;

  /** 踢掉前端（关闸 / 被新连接顶替 / 心跳超时）。 */
  kickClient(reason: string): void;

  /** 转发一条消息给前端；前端不在线时返回 `false`（不抛）。 */
  forwardToClient(message: ServerToClientMessage): boolean;

  /** 记一笔「等前端回执」的命令；超时后向编辑器报错，**不静默失败**。 */
  trackCommand(requestId: string, editor: WebSocket, label: string): void;

  /** 清掉某条命令的等待记录（收到 `command_result` 时）。 */
  settleCommand(requestId: string): void;

  /** 心跳：收到 `pong` 后清零丢失计数。 */
  resetMissedPongs(): void;

  /** 告诉前端「当前是哪个项目」，让它先下资源包（必须在 `scene_sync` 之前发）。 */
  prepareClientResources(ws: WebSocket): void;

  /** 开闸时复位「未开闸被前端敲过门」的日志开关。 */
  resetInactiveRejectionLog(): void;
}
