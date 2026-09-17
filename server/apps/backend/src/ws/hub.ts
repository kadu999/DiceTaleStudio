import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import {
  createRequestId,
  parseClientToServer,
  parseEditorToServer,
  parseJsonMessage,
  type ServerToClientMessage,
  type ServerToEditorMessage,
} from "@dts/protocol";
import { RunState } from "./run-state";

export type LogLevel = "info" | "warn" | "error";
export type HubLogger = (level: LogLevel, message: string) => void;

/** 触发动作后等待回执的超时（超时向前端编辑器报错，避免界面一直转圈）。 */
const ACTION_RESULT_TIMEOUT_MS = 5000;

interface PendingInvocation {
  readonly timer: NodeJS.Timeout;
}

/**
 * 运行态 WebSocket 中枢。
 *
 * - `/client`：前端（Unity 客户端）连接；单客户端架构，新连接顶掉旧连接。
 * - `/editor`：编辑器连接；可订阅快照、触发动作、直通原子命令。
 *
 * 运行态是内存态：前端断开即清空（沿用 DiceTale 既有语义）。
 */
export class RuntimeHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly editors = new Set<WebSocket>();
  private client: WebSocket | undefined;
  private readonly pending = new Map<string, PendingInvocation>();
  readonly state = new RunState();

  constructor(private readonly log: HubLogger = () => {}) {}

  /** 挂到 HTTP server 上，按路径分流。 */
  attach(server: Server): void {
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path !== "/client" && path !== "/editor") {
        this.log("warn", `未知 WebSocket 路径，已拒绝: ${path}`);
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        if (path === "/client") {
          this.acceptClient(ws);
        } else {
          this.acceptEditor(ws);
        }
      });
    });
  }

  get clientConnected(): boolean {
    return this.client !== undefined && this.client.readyState === WebSocket.OPEN;
  }

  get editorCount(): number {
    return this.editors.size;
  }

  close(): void {
    for (const timer of this.pending.values()) {
      clearTimeout(timer.timer);
    }

    this.pending.clear();
    this.client?.close();
    for (const editor of this.editors) {
      editor.close();
    }

    this.wss.close();
  }

  // ------------------------------------------------------------ 前端

  private acceptClient(ws: WebSocket): void {
    // 单客户端架构：新连接顶掉旧的
    if (this.client !== undefined && this.client !== ws) {
      this.log("warn", "已有前端连接，断开旧连接");
      this.client.close();
    }

    this.client = ws;
    this.state.setClientConnected(true);
    this.log("info", "前端已连接");
    this.pushSnapshot();

    ws.on("message", (data) => {
      this.onClientMessage(ws, typeof data === "string" ? data : data.toString());
    });

    ws.on("close", () => {
      if (this.client === ws) {
        this.client = undefined;
        this.state.setClientConnected(false);
        this.log("info", "前端已断开（运行态状态清空）");
        this.pushSnapshot();
      }
    });

    ws.on("error", (error: Error) => {
      this.log("error", `前端连接异常: ${error.message}`);
    });
  }

  private onClientMessage(ws: WebSocket, text: string): void {
    let message;
    try {
      message = parseClientToServer(parseJsonMessage(text));
    } catch (error) {
      this.log("warn", error instanceof Error ? error.message : String(error));
      return;
    }

    switch (message.type) {
      case "request_join":
        this.sendTo(ws, { type: "sync_state", state: this.state.snapshot.state });
        break;

      case "register_map_objects": {
        this.state.registerObjects(message.mapName, message.objects ?? []);
        if (message.spawnPoints !== undefined) {
          this.state.registerSpawnPoints(message.mapName, message.spawnPoints);
        }

        this.log("info", `前端上报地图对象: ${message.mapName}（${message.objects?.length ?? 0} 个）`);
        this.pushSnapshot();
        break;
      }

      case "register_players":
        this.state.registerPlayers(message.players, this.state.currentMap);
        this.pushSnapshot();
        break;

      case "register_actions":
        if (this.state.registerActions(message.objectId, message.actions)) {
          this.log(
            "info",
            `前端上报动作清单: ${message.objectId} → ${message.actions.map((a) => a.actionId).join(", ")}`,
          );
        } else {
          this.log("warn", `register_actions 的对象未知: ${message.objectId}`);
        }

        this.pushSnapshot();
        break;

      case "report_player_position":
        this.state.setPlayerPosition(message.playerId, message.position, message.mapName);
        this.pushSnapshot();
        break;

      case "report_object_position":
        this.state.setObjectPosition(message.objectId, message.position, message.mapName);
        this.pushSnapshot();
        break;

      case "action_result": {
        const pending = this.pending.get(message.requestId);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          this.pending.delete(message.requestId);
        }

        this.log(
          message.ok ? "info" : "warn",
          `动作回执 ${message.objectId}/${message.actionId}: ${message.ok ? "成功" : `失败(${message.reason ?? "未知"})`}`,
        );
        this.broadcastToEditors({ ...message });
        break;
      }

      case "request_teleport":
        this.state.setMap(message.mapName);
        this.pushSnapshot();
        break;

      case "heartbeat":
        break;

      default:
        break;
    }
  }

  // ------------------------------------------------------------ 编辑器

  private acceptEditor(ws: WebSocket): void {
    this.editors.add(ws);
    this.log("info", `编辑器已连接（当前 ${this.editors.size} 个）`);
    this.sendTo(ws, this.snapshotMessage());

    ws.on("message", (data) => {
      this.onEditorMessage(ws, typeof data === "string" ? data : data.toString());
    });

    ws.on("close", () => {
      this.editors.delete(ws);
      this.log("info", "编辑器已断开");
    });

    ws.on("error", (error: Error) => {
      this.log("error", `编辑器连接异常: ${error.message}`);
    });
  }

  private onEditorMessage(ws: WebSocket, text: string): void {
    let message;
    try {
      message = parseEditorToServer(parseJsonMessage(text));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.sendTo(ws, { type: "editor_error", reason });
      return;
    }

    switch (message.type) {
      case "editor_subscribe":
      case "editor_refresh":
        this.sendTo(ws, this.snapshotMessage());
        break;

      case "invoke_action": {
        if (!this.clientConnected) {
          this.sendTo(ws, {
            type: "editor_error",
            requestId: message.requestId,
            reason: "前端未连接，无法触发动作",
          });
          return;
        }

        // 前端尚未实现 invoke_action 时，这里会在超时后向前端编辑器报错（不静默失败）
        if (!this.forwardToClient({ ...message })) {
          this.sendTo(ws, {
            type: "editor_error",
            requestId: message.requestId,
            reason: "下发失败：前端连接不可用",
          });
          return;
        }

        this.trackInvocation(message.requestId, ws);
        break;
      }

      default: {
        // 原子命令直通
        if (!this.clientConnected) {
          this.sendTo(ws, { type: "editor_error", reason: "前端未连接，无法下发命令" });
          return;
        }

        this.forwardToClient({ ...message } as ServerToClientMessage);
        break;
      }
    }
  }

  private trackInvocation(requestId: string, editor: WebSocket): void {
    const existing = this.pending.get(requestId);
    if (existing !== undefined) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      this.sendTo(editor, {
        type: "editor_error",
        requestId,
        reason: `动作回执超时（${ACTION_RESULT_TIMEOUT_MS}ms）：前端可能未实现 invoke_action`,
      });
    }, ACTION_RESULT_TIMEOUT_MS);

    this.pending.set(requestId, { timer });
  }

  /** 供测试与 Mock 前端使用：直接构造一个请求 id。 */
  newRequestId(): string {
    return createRequestId();
  }

  // ------------------------------------------------------------ 发送

  private snapshotMessage(): ServerToEditorMessage {
    const snapshot = this.state.snapshot;
    return {
      type: "editor_snapshot",
      state: snapshot.state,
      clientConnected: snapshot.clientConnected,
      editorConnected: true,
    };
  }

  private pushSnapshot(): void {
    this.broadcastToEditors(this.snapshotMessage());
  }

  broadcastToEditors(message: ServerToEditorMessage): void {
    for (const editor of this.editors) {
      this.sendTo(editor, message);
    }
  }

  private forwardToClient(message: ServerToClientMessage): boolean {
    const client = this.client;
    if (client === undefined || client.readyState !== WebSocket.OPEN) {
      return false;
    }

    client.send(JSON.stringify(message));
    return true;
  }

  private sendTo(ws: WebSocket, message: ServerToEditorMessage | ServerToClientMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}
