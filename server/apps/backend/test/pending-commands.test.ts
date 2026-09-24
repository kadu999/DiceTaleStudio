import type { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerToEditorMessage } from "@dts/protocol";
import { PendingCommands } from "../src/ws/pending-commands";

describe("PendingCommands", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out once and reports the original request", () => {
    vi.useFakeTimers();
    const sent: ServerToEditorMessage[] = [];
    const commands = new PendingCommands((_editor, message) => sent.push(message), 25);

    commands.track("cmd-1", {} as WebSocket, "play_sound");
    vi.advanceTimersByTime(25);

    expect(sent).toEqual([
      {
        type: "editor_error",
        requestId: "cmd-1",
        reason: "命令回执超时（25ms）：前端可能未实现 play_sound",
      },
    ]);
    commands.clear();
  });

  it("settle and clear cancel timers; replacing an id only leaves the newest timer", () => {
    vi.useFakeTimers();
    const sent: ServerToEditorMessage[] = [];
    const commands = new PendingCommands((_editor, message) => sent.push(message), 25);
    const editor = {} as WebSocket;

    commands.track("settled", editor, "one");
    commands.settle("settled");
    commands.track("replaced", editor, "old");
    commands.track("replaced", editor, "new");
    vi.advanceTimersByTime(25);
    commands.track("cleared", editor, "three");
    commands.clear();
    vi.advanceTimersByTime(25);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "editor_error",
      requestId: "replaced",
      reason: expect.stringContaining("new"),
    });
  });
});
