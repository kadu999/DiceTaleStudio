import {
  PROTOCOL_VERSION,
  createRequestId,
  parseJsonMessage,
  parseServerToEditor,
  type ClientInfo,
  type CommandRequest,
  type EditorToServerMessage,
  type ResourcesInfo,
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

/** 服务端推来的运行态快照（「前端连没连 / 镜像是哪份场景 / 本地资源包下到哪了」）。 */
export interface RuntimeStateSnapshot {
  readonly runtimeActive: boolean;
  readonly client: ClientInfo | null;
  readonly scene: SceneInfo | null;
  /** 前端本地资源包状态；null = 这次运行态还没收到过前端的回执。 */
  readonly resources: ResourcesInfo | null;
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

/**
 * 连上以后**活过这么久**才算「真的连上了」。
 *
 * 不这样判的话会出现「连上 → 立刻被踢 → 500ms 后再连」的死循环：`reconnectAttempt` 在
 * `open` 那一刻就清零了，退避永远长不起来（现场踩过一次：服务端还是旧协议、每次都回
 * `close 4002`，运行日志里一秒一次「已连接 / 已断开」刷屏）。短命的连接现在算**失败的尝试**，
 * 退避照常翻倍。
 */
const STABLE_CONNECTION_MS = 3_000;

/** 服务端因**协议版本不一致**踢掉编辑器时用的 close code（见 `@dts/protocol` 与后端 hub）。 */
export const CLOSE_PROTOCOL_MISMATCH = 4002;

/**
 * 这一次重连要等多久（毫秒）：500ms 起步、翻倍、封顶 10s。
 *
 * `jumpToMax` 给「重连也不会好」的原因用（协议版本不一致只有重启服务端才能解决）——
 * 那种情况按 10s 慢慢探，别拿 500ms 去捶一个注定拒绝你的服务端。
 */
export function reconnectDelayMs(attempt: number, jumpToMax = false): number {
  if (jumpToMax) {
    return MAX_RECONNECT_DELAY_MS;
  }

  return Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** attempt);
}

/**
 * 把一次断开翻成一句人话（写进运行日志）。
 *
 * **服务端会在 close reason 里写明为什么踢人**（例如「协议版本不一致：编辑器 4，服务端 3」），
 * 这里必须把它带出来：只写「与服务端断开」的话，现场看到的是一秒一次的重连风暴，
 * 完全看不出根因是「旧服务端在拒绝新编辑器」。
 *
 * `code` / `reason` 都按**可能缺**处理：浏览器一定给，但测试里的假 socket 未必
 * （少一个字段就抛异常会连带把整条断线流程打断——这比少一句话严重得多）。
 */
export function describeSocketClose(code: number | undefined, reason: string | undefined): string {
  const closeCode = typeof code === "number" ? code : 0;
  const detail = (reason ?? "").trim();

  if (closeCode === CLOSE_PROTOCOL_MISMATCH) {
    const what = detail.length > 0 ? detail : "服务端与本编辑器的协议版本不同";
    return `${what}——**服务端要重启**（旧进程还在跑旧协议），重启后会自动连回来`;
  }

  if (detail.length > 0) {
    return `${detail}（close ${closeCode}）`;
  }

  if (closeCode === 1006) {
    return "连接被断开且没有说明（多半是服务端没在跑）：稍后自动重连";
  }

  return closeCode === 1005 ? "服务端关闭了连接" : `连接被关闭（close ${closeCode}）`;
}

export class RuntimeClient {
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  /** 「这次连接已经稳定」的定时器：活到点才把退避清零（见 `STABLE_CONNECTION_MS`）。 */
  private stableTimer: number | null = null;
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
      this.clearStableTimer();
      // 「连上」不等于「连稳」：撑过 STABLE_CONNECTION_MS 才把退避清零
      this.stableTimer = window.setTimeout(() => {
        this.stableTimer = null;
        this.reconnectAttempt = 0;
      }, STABLE_CONNECTION_MS);

      this.handlers.onStatus("open", url);
      this.send({ type: "editor_hello", protocolVersion: PROTOCOL_VERSION });
      // 要一份当前运行态（重连时尤其重要：前端可能已经连/断过）
      this.send({ type: "editor_refresh" });
      this.handlers.onOpen();
    });

    socket.addEventListener("message", (event: MessageEvent<string>) => {
      this.onMessage(event.data);
    });

    socket.addEventListener("close", (event: CloseEvent | undefined) => {
      this.socket = null;
      this.clearStableTimer();

      // 服务端把「为什么踢你」写在 reason 里：带出去，别让它烂在这里
      const code = event?.code;
      this.handlers.onStatus("closed", describeSocketClose(code, event?.reason));

      if (!this.manualClose) {
        this.scheduleReconnect(code === CLOSE_PROTOCOL_MISMATCH);
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
    this.clearStableTimer();

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
          resources: message.resources,
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

  private scheduleReconnect(jumpToMaxDelay = false): void {
    if (this.reconnectTimer !== null) {
      return;
    }

    const wait = reconnectDelayMs(this.reconnectAttempt, jumpToMaxDelay);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.url);
    }, wait);
  }

  /** 清掉「连接已稳定」的定时器（断开 / 手动关闭 / 重连时都要清，否则会把退避悄悄清零）。 */
  private clearStableTimer(): void {
    if (this.stableTimer !== null) {
      window.clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }
}
