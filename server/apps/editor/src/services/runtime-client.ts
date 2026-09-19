import {
  PROTOCOL_VERSION,
  createRequestId,
  parseJsonMessage,
  parseServerToEditor,
  type ClientInfo,
  type CommandRequest,
  type EditorToServerMessage,
  type SceneInfo,
  type ScenePayload,
  type ServerToEditorMessage,
} from "@dts/protocol";

/**
 * 编辑器 ↔ 服务端的运行态连接。
 *
 * 职责边界：**只负责协议与连接**，不碰文档、不改任何编辑态数据；
 * 收到的运行态交给上层（store）放进 `runtime` 切片。
 *
 * 新协议下编辑器只做三件事：声明运行态（开闸 / 关闸）、把**当前场景整份推下去**、下发命令。
 * 前端 → 服务端 → 编辑器的回执与日志按 `onCommandResult` / `onServerLog` 抛给上层。
 */

export type RuntimeStatus = "idle" | "connecting" | "open" | "closed" | "error";

export interface RuntimeLogEntry {
  readonly id: string;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly time: string;
}

/** 服务端推来的运行态快照（「前端连没连 / 镜像是哪份场景」）。 */
export interface RuntimeStateSnapshot {
  readonly runtimeActive: boolean;
  readonly client: ClientInfo | null;
  readonly scene: SceneInfo | null;
}

export interface RuntimeHandlers {
  onStatus(status: RuntimeStatus, detail?: string): void;
  onState(snapshot: RuntimeStateSnapshot): void;
  onCommandResult(message: { requestId: string; ok: boolean; reason?: string; effects?: string[] }): void;
  /** 服务端写来的日志（前端连上 / 断开 / 拒连…），直接进运行日志列表。 */
  onServerLog(entry: RuntimeLogEntry): void;
  onError(reason: string, requestId?: string): void;
  /** WS 建立（含重连）之后调用一次：上层据此补发 `runtime_start` 与当前场景。 */
  onOpen(): void;
}

/** 编辑器连接地址：与页面同源（开发期由 Vite 代理到后端）。 */
export function defaultEditorSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/editor`;
}

const MAX_RECONNECT_DELAY_MS = 10_000;

export class RuntimeClient {
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private manualClose = false;
  private url = "";

  constructor(private readonly handlers: RuntimeHandlers) {}

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  connect(url: string = defaultEditorSocketUrl()): void {
    if (
      this.socket !== null &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.url = url;
    this.manualClose = false;
    this.handlers.onStatus("connecting", url);

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.handlers.onStatus("error", error instanceof Error ? error.message : String(error));
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.handlers.onStatus("open", url);
      this.send({ type: "editor_hello", protocolVersion: PROTOCOL_VERSION });
      // 要一份当前运行态（重连时尤其重要：前端可能已经连/断过）
      this.send({ type: "editor_refresh" });
      this.handlers.onOpen();
    });

    socket.addEventListener("message", (event: MessageEvent<string>) => {
      this.onMessage(event.data);
    });

    socket.addEventListener("close", () => {
      this.socket = null;
      this.handlers.onStatus("closed");
      if (!this.manualClose) {
        this.scheduleReconnect();
      }
    });

    socket.addEventListener("error", () => {
      // 具体原因由 close 事件与后端日志给出，这里只标记状态
      this.handlers.onStatus("error", "连接出错");
    });
  }

  disconnect(): void {
    this.manualClose = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.socket?.close();
    this.socket = null;
    this.handlers.onStatus("idle");
  }

  /** 进入运行态（服务端据此开闸：前端现在才连得上）。幂等。 */
  startRuntime(): void {
    this.send({ type: "runtime_start" });
  }

  /** 退出运行态：服务端关闸并踢掉前端。 */
  stopRuntime(): void {
    this.send({ type: "runtime_stop" });
  }

  /** 把当前场景整份推下去（`null` = 没有打开的场景）。 */
  pushScene(scene: ScenePayload | null): void {
    this.send({ type: "scene_push", scene });
  }

  refresh(): void {
    this.send({ type: "editor_refresh" });
  }

  /** 下发一条命令给前端（命令只是触发器，数据在推下去的场景里）。 */
  sendCommand(command: CommandRequest): string {
    const requestId = createRequestId(command.kind === "play_sound" ? "snd" : "cmd");
    this.send({ type: "editor_command", requestId, command });
    return requestId;
  }

  private onMessage(text: string): void {
    let message: ServerToEditorMessage;
    try {
      message = parseServerToEditor(parseJsonMessage(text));
    } catch (error) {
      this.handlers.onError(error instanceof Error ? error.message : String(error));
      return;
    }

    switch (message.type) {
      case "editor_state":
        this.handlers.onState({
          runtimeActive: message.runtimeActive,
          client: message.client,
          scene: message.scene,
        });
        break;

      case "editor_command_result":
        this.handlers.onCommandResult({
          requestId: message.requestId,
          ok: message.ok,
          ...(message.reason === undefined ? {} : { reason: message.reason }),
          ...(message.effects === undefined ? {} : { effects: message.effects }),
        });
        break;

      case "editor_log":
        this.handlers.onServerLog({
          id: createRequestId("log"),
          level: message.level,
          message: message.message,
          time: message.time,
        });
        break;

      case "editor_error":
        this.handlers.onError(
          message.reason,
          message.requestId === undefined ? undefined : message.requestId,
        );
        break;

      default:
        break;
    }
  }

  private send(message: EditorToServerMessage): void {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
      this.handlers.onError("编辑器未连接到服务端");
      return;
    }

    this.socket.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }

    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.url);
    }, delay);
  }
}
