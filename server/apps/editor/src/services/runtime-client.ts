import {
  createRequestId,
  parseJsonMessage,
  parseServerToEditor,
  type EditorToServerMessage,
  type GameStateSnapshot,
  type ServerToEditorMessage,
} from "@dts/protocol";

/**
 * 编辑器 ↔ 服务端的运行态连接。
 *
 * 职责边界：**只负责协议与连接**，不碰文档、不改任何编辑态数据；
 * 收到的镜像数据交给上层（store）放进 `runtime` 切片。
 */

export type RuntimeStatus = "idle" | "connecting" | "open" | "closed" | "error";

export interface RuntimeLogEntry {
  readonly id: string;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly time: string;
}

export interface RuntimeHandlers {
  onStatus(status: RuntimeStatus, detail?: string): void;
  onSnapshot(state: GameStateSnapshot, clientConnected: boolean): void;
  onActionResult(message: Extract<ServerToEditorMessage, { type: "action_result" }>): void;
  onError(reason: string, requestId?: string): void;
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
    if (this.socket !== null && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
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
      this.send({ type: "editor_subscribe" });
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

  refresh(): void {
    this.send({ type: "editor_refresh" });
  }

  /** 触发某对象上的某个动作（核心能力）。 */
  invokeAction(objectId: string, actionId: string, args?: Record<string, unknown>): string {
    const requestId = createRequestId("act");
    this.send({
      type: "invoke_action",
      requestId,
      objectId,
      actionId,
      ...(args === undefined ? {} : { args }),
    });

    return requestId;
  }

  /** 原子命令直通（低层：改组件值，副作用由前端本地动作链产生）。 */
  sendAtomic(
    command:
      | { type: "set_option"; objectId: string; option: string }
      | { type: "set_bool"; objectId: string; value: boolean }
      | { type: "set_int"; objectId: string; value: number }
      | { type: "set_float"; objectId: string; value: number }
      | { type: "set_object_items"; objectId: string; items: string[] }
      | { type: "teleport_player"; mapName: string; spawnId: string },
  ): void {
    this.send(command);
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
      case "editor_snapshot":
        this.handlers.onSnapshot(message.state, message.clientConnected);
        break;

      case "action_result":
        this.handlers.onActionResult(message);
        break;

      case "editor_error":
        this.handlers.onError(
          message.reason,
          message.requestId === undefined ? undefined : message.requestId,
        );
        break;

      case "editor_log":
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
