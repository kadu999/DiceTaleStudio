import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import {
  PROTOCOL_MISMATCH_CODE,
  PROTOCOL_VERSION,
  RUNTIME_INACTIVE_REASON,
  RUNTIME_INACTIVE_STATUS,
  RUNTIME_STOPPED_CODE,
  createRequestId,
  parseClientToServer,
  parseEditorToServer,
  parseJsonMessage,
  type ServerToClientMessage,
  type ServerToEditorMessage,
} from "@dts/protocol";
import { RuntimeSession, type RuntimeClientInfo } from "./runtime-session";

export type LogLevel = "info" | "warn" | "error";
export type HubLogger = (level: LogLevel, message: string) => void;

/** 命令下发后等回执的超时（超时向编辑器报错，避免界面一直转圈）。 */
const COMMAND_RESULT_TIMEOUT_MS = 5000;
/** 前端心跳间隔与容忍的连续丢失次数（两拍没回 = 半开连接，断开清理）。 */
const CLIENT_PING_INTERVAL_MS = 15000;
const CLIENT_MAX_MISSED_PINGS = 2;

interface EditorSession {
  running: boolean;
}

interface ClientSession {
  readonly ws: WebSocket;
  readonly address: string;
  pingTimer: ReturnType<typeof setInterval> | undefined;
  pingSeq: number;
  missedPongs: number;
}

interface PendingCommand {
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * 运行态 WebSocket 中枢（**中继 + 缓存**，不拥有数据）。
 *
 * - `/editor`：编辑器。`runtime_start` 开闸 / `runtime_stop` 关闸；`scene_push` 推当前场景（整份）；
 *   `editor_command` 下发命令给前端。开闸状态按「编辑器会话是否声明了运行态」记账。
 * - `/client`：前端（Unity）。**只有开闸后才接受升级**；连上立刻收到 `server_hello` +
 *   一份缓存的 `scene_sync`（所以「先改场景、后开前端」也能拿到全量）。
 *
 * 数据方向是单向的：编辑器 / 服务端 → 前端。前端只回 `client_hello`、`command_result`、`pong`。
 */
export class RuntimeHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly editors = new Map<WebSocket, EditorSession>();
  private client: ClientSession | undefined;
  private readonly pending = new Map<string, PendingCommand>();
  /** 「未开闸时被前端敲过门」只记一次日志，免得前端每 3 秒重试就刷屏。 */
  private rejectedWhileInactive = false;

  readonly session = new RuntimeSession();

  constructor(private readonly log: HubLogger = () => {}) {}

  /** 挂到 HTTP server 上，按路径分流。`/client` 在未开闸时直接以 HTTP 503 拒绝。 */
  attach(server: Server): void {
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;

      if (path === "/client") {
        if (!this.session.runtimeActive) {
          if (!this.rejectedWhileInactive) {
            this.rejectedWhileInactive = true;
            this.log("info", "前端尝试连接，但编辑器还没点「运行」——已拒绝（等它点运行后前端会自动连上）");
          }

          this.rejectUpgrade(socket);
          return;
        }

        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.acceptClient(ws, request);
        });
        return;
      }

      if (path === "/editor") {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.acceptEditor(ws);
        });
        return;
      }

      this.log("warn", `未知 WebSocket 路径，已拒绝: ${path}`);
      socket.destroy();
    });
  }

  get clientConnected(): boolean {
    return this.client !== undefined && this.client.ws.readyState === WebSocket.OPEN;
  }

  get runtimeActive(): boolean {
    return this.session.runtimeActive;
  }

  get editorCount(): number {
    return this.editors.size;
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
    }

    this.pending.clear();

    if (this.client !== undefined) {
      this.stopClientPing(this.client);
      this.client.ws.close();
      this.client = undefined;
    }

    for (const editor of this.editors.keys()) {
      editor.close();
    }

    this.wss.close();
  }

  // ------------------------------------------------------------ 升级拒绝

  /**
   * 未开闸时拒绝前端的 WS 升级：**握手就不成功**（前端从没「连上过」，
   * 而不是连上再被踢）。原因写在 `x-dts-reason` 头里，排查用。
   */
  private rejectUpgrade(socket: Duplex): void {
    try {
      socket.write(
        `HTTP/1.1 ${RUNTIME_INACTIVE_STATUS} Service Unavailable\r\n` +
          `x-dts-reason: ${RUNTIME_INACTIVE_REASON}\r\n` +
          `connection: close\r\n` +
          `content-length: 0\r\n` +
          `\r\n`,
      );
    } catch (error) {
      this.log("warn", `拒绝前端连接时写响应失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    socket.destroy();
  }

  // ------------------------------------------------------------ 前端

  private acceptClient(ws: WebSocket, request: IncomingMessage): void {
    // 单客户端架构：新连接顶掉旧的
    if (this.client !== undefined && this.client.ws !== ws) {
      this.log("warn", "已有前端连接，断开旧连接");
      this.kickClient("被新的前端连接顶替");
    }

    const session: ClientSession = {
      ws,
      address: request.socket.remoteAddress ?? "",
      pingTimer: undefined,
      pingSeq: 0,
      missedPongs: 0,
    };

    this.client = session;
    // 先占位（编辑器立刻能看到「已连接」），`client_hello` 到了再补名字与版本
    this.session.setClient({
      name: "未标识的前端",
      version: "",
      connectedAt: Date.now(),
      address: session.address,
    });

    this.log("info", "前端已连接（运行态已开闸）");
    this.startClientPing(session);

    this.sendTo(ws, {
      type: "server_hello",
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.session.sessionId,
      serverTime: Date.now(),
    });
    // 立刻补一份场景：前端后连上也能拿到全量镜像
    this.sendTo(ws, { type: "scene_sync", scene: this.session.scene });

    this.broadcastEditorState();
    this.logToEditors("info", "前端已连接（等待标识…）");

    ws.on("message", (data) => {
      this.onClientMessage(ws, typeof data === "string" ? data : data.toString());
    });

    ws.on("close", () => {
      if (this.client === session) {
        this.stopClientPing(session);
        this.client = undefined;
        this.session.setClient(null);
        this.log("info", "前端已断开");
        this.broadcastEditorState();
        this.logToEditors("warn", "前端已断开");
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
      case "client_hello": {
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          const reason = `协议版本不一致：前端 ${message.protocolVersion}，服务端 ${PROTOCOL_VERSION}`;
          this.log("warn", reason);
          this.logToEditors("error", reason);
          ws.close(PROTOCOL_MISMATCH_CODE, reason);
          return;
        }

        const info: RuntimeClientInfo = {
          name: message.name,
          version: message.version,
          connectedAt: this.session.client?.connectedAt ?? Date.now(),
          address: this.client?.address ?? "",
        };

        this.session.setClient(info);
        this.log("info", `前端已标识：${message.name} v${message.version}`);
        this.broadcastEditorState();
        this.logToEditors("info", `前端已标识：${message.name} v${message.version}`);
        return;
      }

      case "command_result": {
        const pending = this.pending.get(message.requestId);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          this.pending.delete(message.requestId);
        }

        this.log(
          message.ok ? "info" : "warn",
          `命令回执 ${message.requestId}: ${message.ok ? "成功" : `失败(${message.reason ?? "未知"})`}`,
        );
        this.broadcastToEditors({
          type: "editor_command_result",
          requestId: message.requestId,
          ok: message.ok,
          ...(message.reason === undefined ? {} : { reason: message.reason }),
          ...(message.effects === undefined ? {} : { effects: message.effects }),
        });
        this.logToEditors(
          message.ok ? "info" : "warn",
          `命令 ${message.ok ? "执行成功" : `执行失败：${message.reason ?? "未知原因"}`}`,
        );
        return;
      }

      case "pong": {
        if (this.client !== undefined) {
          this.client.missedPongs = 0;
        }

        return;
      }

      default:
        return;
    }
  }

  private startClientPing(session: ClientSession): void {
    session.pingTimer = setInterval(() => {
      if (session.missedPongs >= CLIENT_MAX_MISSED_PINGS) {
        this.log("warn", "前端心跳超时（连续两拍没有 pong），断开连接");
        this.logToEditors("warn", "前端心跳超时，已断开");
        this.kickClient("心跳超时");
        return;
      }

      session.pingSeq += 1;
      session.missedPongs += 1;
      this.sendTo(session.ws, { type: "ping", seq: session.pingSeq });
    }, CLIENT_PING_INTERVAL_MS);
  }

  private stopClientPing(session: ClientSession): void {
    if (session.pingTimer !== undefined) {
      clearInterval(session.pingTimer);
      session.pingTimer = undefined;
    }
  }

  /** 踢掉前端（退出运行态 / 被顶替 / 心跳超时）。 */
  private kickClient(reason: string): void {
    const session = this.client;
    if (session === undefined) {
      return;
    }

    this.client = undefined;
    this.stopClientPing(session);
    this.session.setClient(null);
    session.ws.close(RUNTIME_STOPPED_CODE, reason);
  }

  // ------------------------------------------------------------ 编辑器

  private acceptEditor(ws: WebSocket): void {
    this.editors.set(ws, { running: false });
    this.log("info", `编辑器已连接（当前 ${this.editors.size} 个）`);
    this.sendEditorState(ws);

    ws.on("message", (data) => {
      this.onEditorMessage(ws, typeof data === "string" ? data : data.toString());
    });

    ws.on("close", () => {
      const editor = this.editors.get(ws);
      this.editors.delete(ws);
      this.log("info", "编辑器已断开");

      // 编辑器断开 = 它声明的那份运行态没了；没人声明了就关闸、踢前端
      if (editor?.running === true) {
        this.recomputeRuntime();
      }
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
      case "editor_hello": {
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          const reason = `协议版本不一致：编辑器 ${message.protocolVersion}，服务端 ${PROTOCOL_VERSION}`;
          this.log("warn", reason);
          ws.close(PROTOCOL_MISMATCH_CODE, reason);
          return;
        }

        this.sendEditorState(ws);
        return;
      }

      case "runtime_start": {
        const editor = this.editors.get(ws);
        if (editor !== undefined) {
          editor.running = true;
        }

        if (!this.session.runtimeActive) {
          this.session.start();
          this.rejectedWhileInactive = false;
          this.log("info", "进入运行态：已开闸（前端现在可以连接）");
        }

        this.broadcastEditorState();
        return;
      }

      case "runtime_stop": {
        const editor = this.editors.get(ws);
        if (editor !== undefined) {
          editor.running = false;
        }

        this.recomputeRuntime();
        return;
      }

      case "editor_refresh": {
        this.sendEditorState(ws);
        return;
      }

      case "scene_push": {
        this.session.setScene(message.scene);
        if (this.client !== undefined) {
          this.sendTo(this.client.ws, { type: "scene_sync", scene: message.scene });
        }

        // 推送很频繁（编辑器去抖后每次编辑一份），所以只更新状态、不写日志
        this.broadcastEditorState();
        return;
      }

      case "editor_command": {
        if (!this.session.runtimeActive) {
          this.sendTo(ws, {
            type: "editor_error",
            requestId: message.requestId,
            reason: "未进入运行态，无法下发命令",
          });
          return;
        }

        if (!this.clientConnected) {
          this.sendTo(ws, {
            type: "editor_error",
            requestId: message.requestId,
            reason: "前端未连接，无法下发命令",
          });
          return;
        }

        const forwarded = this.forwardToClient({
          type: "command",
          requestId: message.requestId,
          command: message.command,
        });

        if (!forwarded) {
          this.sendTo(ws, {
            type: "editor_error",
            requestId: message.requestId,
            reason: "下发失败：前端连接不可用",
          });
          return;
        }

        this.trackCommand(message.requestId, ws, message.command.kind);
        return;
      }

      default:
        return;
    }
  }

  /**
   * 重新算开闸状态：任一编辑器声明了运行态就算开；都没声明就关闸并踢前端。
   *
   * 「编辑器断开 = 关闸」是刻意的：运行态跟着编辑器活着，不留一个没人管的「已连接」。
   * 编辑器刷新页面会踢一次前端，前端会自动重连（它本来就一直重试）。
   */
  private recomputeRuntime(): void {
    const anyRunning = [...this.editors.values()].some((editor) => editor.running);
    if (!anyRunning && this.session.runtimeActive) {
      this.session.stop();
      this.kickClient("编辑器已退出运行态");
      this.log("info", "退出运行态：已关闸（前端会被断开，且连不回来直到再次点运行）");
      this.logToEditors("warn", "已退出运行态：前端连接已关闭");
    }

    this.broadcastEditorState();
  }

  /**
   * 记一笔「等着前端回执」的命令。超时后向编辑器报错，**不静默失败**：
   * 前端没实现这条命令时，界面上要看得见原因（而不是点了没反应）。
   */
  private trackCommand(requestId: string, editor: WebSocket, label: string): void {
    const existing = this.pending.get(requestId);
    if (existing !== undefined) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      this.sendTo(editor, {
        type: "editor_error",
        requestId,
        reason: `命令回执超时（${COMMAND_RESULT_TIMEOUT_MS}ms）：前端可能未实现 ${label}`,
      });
    }, COMMAND_RESULT_TIMEOUT_MS);

    this.pending.set(requestId, { timer });
  }

  /** 生成一个请求 id（编辑器与测试都用它，格式统一）。 */
  newRequestId(): string {
    return createRequestId("cmd");
  }

  // ------------------------------------------------------------ 发送

  private editorStateMessage(): ServerToEditorMessage {
    const snapshot = this.session.snapshot;
    return {
      type: "editor_state",
      runtimeActive: snapshot.runtimeActive,
      client: snapshot.client,
      scene: snapshot.scene,
      serverTime: Date.now(),
    };
  }

  private sendEditorState(ws: WebSocket): void {
    this.sendTo(ws, this.editorStateMessage());
  }

  private broadcastEditorState(): void {
    this.broadcastToEditors(this.editorStateMessage());
  }

  private logToEditors(level: LogLevel, message: string): void {
    this.broadcastToEditors({
      type: "editor_log",
      level,
      message,
      time: new Date().toISOString().slice(11, 19),
    });
  }

  broadcastToEditors(message: ServerToEditorMessage): void {
    for (const editor of this.editors.keys()) {
      this.sendTo(editor, message);
    }
  }

  private forwardToClient(message: ServerToClientMessage): boolean {
    const client = this.client;
    if (client === undefined || client.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    client.ws.send(JSON.stringify(message));
    return true;
  }

  private sendTo(ws: WebSocket, message: ServerToEditorMessage | ServerToClientMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}
