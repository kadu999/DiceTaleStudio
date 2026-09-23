import { vi } from "vitest";
import { useEditorStore } from "../../src/state/editor-store";

/**
 * 编辑器测试共享的假 WebSocket 帮手。
 *
 * 让用例走真链路（`runtime_start` → `editor_state` → 命令），
 * 「推了什么、什么顺序推的」都是可断言的事实。
 */

/** 假的 WebSocket：测试决定什么时候「连上」、什么时候「收到服务端消息」。 */
export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  /** 编辑器发出去的报文（原文，断言时再解析）。 */
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type);
    if (list === undefined) {
      this.listeners.set(type, [listener]);
      return;
    }

    list.push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) {
      return;
    }

    this.readyState = FakeSocket.CLOSED;
    // 按真实形状给 close 事件（`code` / `reason` 是诊断「为什么断开」的唯一来源）
    this.emit("close", { code: 1006, reason: "" });
  }

  /** 测试用：连上了。 */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }

  /** 测试用：服务端来了一条消息。 */
  receive(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

export const lastSocket = (): FakeSocket => {
  const socket = FakeSocket.instances.at(-1);
  if (socket === undefined) {
    throw new Error("编辑器没有连服务端");
  }

  return socket;
};

/** 连上服务端（假的），返回那只 socket。 */
export function connect(): FakeSocket {
  vi.stubGlobal("WebSocket", FakeSocket);
  useEditorStore.getState().connectRuntime();
  const socket = lastSocket();
  socket.open();
  return socket;
}

/** 服务端的运行态广播（`settings` 是摘要，`null` = 还没推过设置）。 */
export const editorState = (input: {
  readonly runtimeActive: boolean;
  readonly client?: { name: string; version: string; connectedAt: number } | null;
  readonly resources?: {
    project: string;
    fingerprint: string;
    fileCount: number;
    bytes: number;
    ok: boolean;
    at: number;
  } | null;
  readonly settings?: { updatedAt: number } | null;
}): unknown => ({
  type: "editor_state",
  runtimeActive: input.runtimeActive,
  client: input.client ?? null,
  scene: null,
  resources: input.resources ?? null,
  settings: input.settings ?? null,
  serverTime: Date.now(),
});

/** 编辑器发出去的报文（按顺序），解析成对象。 */
export const parsedSent = (socket: FakeSocket): Array<Record<string, unknown>> =>
  socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);

/** 编辑器发出去的报文类型（顺序保留）。 */
export const sentTypes = (socket: FakeSocket): string[] =>
  parsedSent(socket).map((message) => String(message.type));
