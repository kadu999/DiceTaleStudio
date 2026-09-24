import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import {
  PROTOCOL_VERSION,
  RUNTIME_INACTIVE_REASON,
  RUNTIME_INACTIVE_STATUS,
  RUNTIME_STOPPED_CODE,
  createRequestId,
  parseClientToServer,
  parseEditorToServer,
  parseJsonMessage,
  type ClientToServerMessage,
  type EditorToServerMessage,
  type ServerToClientMessage,
  type ServerToEditorMessage,
} from "@dts/protocol";
import type { HubContext } from "./hub-context";
import { CLIENT_HANDLERS, EDITOR_HANDLERS } from "./handlers";
import { PendingCommands } from "./pending-commands";
import { RuntimeSession } from "./runtime-session";
import type { HubLogger, LogLevel } from "./types";

export type { HubLogger, LogLevel } from "./types";

/** 前端心跳间隔与容忍的连续丢失次数（两拍没回 = 半开连接，断开清理）。 */
const CLIENT_PING_INTERVAL_MS = 15000;
const CLIENT_MAX_MISSED_PINGS = 2;

/**
 * 从一条**没通过校验**的入站消息里尽力取出 `requestId`。
 *
 * 校验失败有两种：JSON 本身就坏了（取不出来，只能报一条无主的错），以及 JSON 合法但字段 /
 * 判别值不认识（例如服务端进程还是旧的、不认识新增的命令种类）。后者带着 `requestId`，
 * 把它一起回给编辑器，那条命令的失败才有主、编辑器的 pending 才收得掉。
 */
function requestIdOf(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }

  const value = (raw as { requestId?: unknown }).requestId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface ClientSession {
  readonly ws: WebSocket;
  readonly address: string;
  pingTimer: ReturnType<typeof setInterval> | undefined;
  pingSeq: number;
  missedPongs: number;
}

/**
 * 运行态 WebSocket 中枢（**中继 + 缓存**，不拥有数据）。
 *
 * - `/editor`：编辑器。`runtime_start` 开闸 / `runtime_stop` 关闸；`scene_push` 推当前场景（整份）；
 *   `editor_command` 下发命令给前端。
 * - `/client`：前端（Unity）。**只有开闸后才接受升级**；连上立刻收到 `server_hello` +
 *   一份缓存的 `scene_sync`（所以「先改场景、后开前端」也能拿到全量）。
 *
 * **运行态是服务端状态**（`RuntimeSession.runtimeActive`）：只由 `runtime_start` / `runtime_stop` 改，
 * 编辑器刷新页面 / 断线 / 临时掉线都**不影响**它——否则「刷新一下就退出运行、前端被踢」，
 * 而服务端本来该记得「现在是在运行」。只有服务端重启才会清掉（那时要重新点一次「运行」）。
 *
 * 数据方向是单向的：编辑器 / 服务端 → 前端。前端只回 `client_hello`、`command_result`、`pong`。
 *
 * **这个类只管传输**：升级分流、连接表、心跳与序列化发送。
 * 「每种消息来了做什么」在 `./handlers/`（一条消息一个函数），通过 `HubContext` 反向调用这里。
 */
export class RuntimeHub implements HubContext {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly editors = new Set<WebSocket>();
  private client: ClientSession | undefined;
  private readonly pendingCommands = new PendingCommands((editor, message) => this.sendTo(editor, message));
  /** 「未开闸时被前端敲过门」只记一次日志，免得前端每 3 秒重试就刷屏。 */
  private rejectedWhileInactive = false;

  readonly session = new RuntimeSession();
  readonly log: HubLogger;

  constructor(log: HubLogger = () => {}) {
    this.log = log;
  }

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

  get clientSocket(): WebSocket | undefined {
    return this.client?.ws;
  }

  get clientAddress(): string {
    return this.client?.address ?? "";
  }

  get runtimeActive(): boolean {
    return this.session.runtimeActive;
  }

  get editorCount(): number {
    return this.editors.size;
  }

  close(): void {
    this.pendingCommands.clear();

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

  // ------------------------------------------------------------ 前端连接

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
    // 先把「当前是哪个项目」告诉前端：它据此**先下资源包、再载入场景**。
    // 必须在 scene_sync 之前发——顺序反了就成了「场景先到、资源后下」。
    this.prepareClientResources(ws);
    // 全局设置（三档音量）也走在前头：它是「出声之前就该知道的事」
    this.sendTo(ws, { type: "project_settings", settings: this.session.settings });
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

  /** 校验入站消息，然后交给 `CLIENT_HANDLERS`。校验失败只记日志（前端没有可回的错误通道）。 */
  private onClientMessage(ws: WebSocket, text: string): void {
    let message: ClientToServerMessage;
    try {
      message = parseClientToServer(parseJsonMessage(text));
    } catch (error) {
      this.log("warn", error instanceof Error ? error.message : String(error));
      return;
    }

    CLIENT_HANDLERS[message.type](this, ws, message);
  }

  // ------------------------------------------------------------ 编辑器连接

  private acceptEditor(ws: WebSocket): void {
    this.editors.add(ws);
    this.log("info", `编辑器已连接（当前 ${this.editors.size} 个）`);
    this.sendEditorState(ws);

    ws.on("message", (data) => {
      this.onEditorMessage(ws, typeof data === "string" ? data : data.toString());
    });

    ws.on("close", () => {
      this.editors.delete(ws);
      // 编辑器断开**不影响运行态**：刷新页面 / 关掉编辑器，前端照样连着、镜像也还在。
      // 要关闸只有两条路：有人点「编辑」（runtime_stop），或服务端重启。
      this.log("info", `编辑器已断开（运行态不受影响，当前 ${this.editors.size} 个编辑器）`);
    });

    ws.on("error", (error: Error) => {
      this.log("error", `编辑器连接异常: ${error.message}`);
    });
  }

  /** 校验入站消息，然后交给 `EDITOR_HANDLERS`。校验失败**尽力挂到那条命令上**（见下）。 */
  private onEditorMessage(ws: WebSocket, text: string): void {
    let raw: unknown;
    let message: EditorToServerMessage;
    try {
      raw = parseJsonMessage(text);
      message = parseEditorToServer(raw);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // **能对上号的错误要挂到那条命令上**：消息没通过校验时它同样带 `requestId`（JSON 是合法的，
      // 只是字段/判别值不认识，例如服务端进程还是旧的、不认识新增的命令种类）。
      // 只发一行无主的「消息校验失败」的话，编辑器那边那条命令就成了「发出去、永远没回音」——
      // 现场的表现就是「点了有报错、前端一动不动」。
      const requestId = requestIdOf(raw);
      this.sendTo(
        ws,
        requestId === undefined
          ? { type: "editor_error", reason }
          : { type: "editor_error", requestId, reason },
      );
      return;
    }

    EDITOR_HANDLERS[message.type](this, ws, message);
  }

  // ------------------------------------------------------------ 心跳

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

  resetMissedPongs(): void {
    if (this.client !== undefined) {
      this.client.missedPongs = 0;
    }
  }

  // ------------------------------------------------------------ HubContext（对处理器开放）

  /** 踢掉前端（退出运行态 / 被顶替 / 心跳超时）。 */
  kickClient(reason: string): void {
    const session = this.client;
    if (session === undefined) {
      return;
    }

    this.client = undefined;
    this.stopClientPing(session);
    this.session.setClient(null);
    session.ws.close(RUNTIME_STOPPED_CODE, reason);
  }

  /**
   * 记一笔「等着前端回执」的命令。超时后向编辑器报错，**不静默失败**：
   * 前端没实现这条命令时，界面上要看得见原因（而不是点了没反应）。
   */
  trackCommand(requestId: string, editor: WebSocket, label: string): void {
    this.pendingCommands.track(requestId, editor, label);
  }

  /** 清掉某条命令的等待记录（收到回执时）。没记过就当没发生。 */
  settleCommand(requestId: string): void {
    this.pendingCommands.settle(requestId);
  }

  /**
   * 告诉前端「当前是哪个项目」，让它先把资源包拉下来。
   *
   * 在 `scene_sync` **之前**发。项目还不知道（编辑器没推过场景）时发 `null`，
   * 前端就照旧等场景到了再从镜像里推项目名。
   */
  prepareClientResources(ws: WebSocket): void {
    this.sendTo(ws, { type: "resources_prepare", project: this.session.resourceProject });
  }

  resetInactiveRejectionLog(): void {
    this.rejectedWhileInactive = false;
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
      resources: snapshot.resources,
      settings: snapshot.settings,
      serverTime: Date.now(),
    };
  }

  sendEditorState(ws: WebSocket): void {
    this.sendTo(ws, this.editorStateMessage());
  }

  broadcastEditorState(): void {
    this.broadcastToEditors(this.editorStateMessage());
  }

  logToEditors(level: LogLevel, message: string): void {
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

  forwardToClient(message: ServerToClientMessage): boolean {
    const client = this.client;
    if (client === undefined || client.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    client.ws.send(JSON.stringify(message));
    return true;
  }

  sendTo(ws: WebSocket, message: ServerToEditorMessage | ServerToClientMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}
