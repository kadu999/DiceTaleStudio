import type { WebSocket } from "ws";
import type { ServerToEditorMessage } from "@dts/protocol";

interface PendingCommand {
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Tracks command acknowledgements and reports commands that never receive a result. */
export class PendingCommands {
  private readonly entries = new Map<string, PendingCommand>();

  constructor(
    private readonly send: (editor: WebSocket, message: ServerToEditorMessage) => void,
    private readonly timeoutMs = 15000,
  ) {}

  track(requestId: string, editor: WebSocket, label: string): void {
    this.settle(requestId);

    const timer = setTimeout(() => {
      this.entries.delete(requestId);
      this.send(editor, {
        type: "editor_error",
        requestId,
        reason: `命令回执超时（${this.timeoutMs}ms）：前端可能未实现 ${label}`,
      });
    }, this.timeoutMs);

    this.entries.set(requestId, { timer });
  }

  settle(requestId: string): void {
    const pending = this.entries.get(requestId);
    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timer);
    this.entries.delete(requestId);
  }

  clear(): void {
    for (const pending of this.entries.values()) {
      clearTimeout(pending.timer);
    }

    this.entries.clear();
  }
}
