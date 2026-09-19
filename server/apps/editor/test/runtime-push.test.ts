import { afterEach, describe, expect, it, vi } from "vitest";
import { scenePayloadText, ScenePushScheduler, shouldPushScene } from "../src/services/runtime-push";
import type { SceneDoc } from "@dts/document";

/**
 * 运行态场景推送的判定与去抖：这几条规则决定「编辑器改一下，前端多久、会不会收到」。
 */

function scene(name: string, x: number): SceneDoc {
  return {
    name,
    objects: [
      {
        id: "o1",
        name: "对象",
        kind: "SceneObject",
        active: true,
        locked: false,
        sortingOrder: 0,
        position: { x, y: 0 },
        rotation: 0,
        scale: 1,
        components: [],
      },
    ],
  };
}

describe("shouldPushScene", () => {
  it("运行态 + 连着 + 内容变了 → 推", () => {
    expect(
      shouldPushScene({ mode: "run", connected: true, lastPushed: "a", next: "b" }),
    ).toBe(true);
  });

  it("编辑态不推（前端还没连）", () => {
    expect(
      shouldPushScene({ mode: "edit", connected: true, lastPushed: "a", next: "b" }),
    ).toBe(false);
  });

  it("没连服务端不推（重连时会补一次全量）", () => {
    expect(
      shouldPushScene({ mode: "run", connected: false, lastPushed: "a", next: "b" }),
    ).toBe(false);
  });

  it("内容没变不推（撤销回到原样、重绘、切页签都不该产生流量）", () => {
    expect(
      shouldPushScene({ mode: "run", connected: true, lastPushed: "same", next: "same" }),
    ).toBe(false);
  });

  it("第一次推（lastPushed 为空）要推", () => {
    expect(
      shouldPushScene({ mode: "run", connected: true, lastPushed: null, next: "a" }),
    ).toBe(true);
  });

  it("推空场景也算一次变更（清空前端的镜像）", () => {
    expect(
      shouldPushScene({ mode: "run", connected: true, lastPushed: "a", next: null }),
    ).toBe(true);
  });
});

describe("scenePayloadText", () => {
  it("带上场景名与对象：切场景算一次变更", () => {
    const first = scenePayloadText(scene("场景1", 0));
    const sameContentOtherName = scenePayloadText(scene("场景2", 0));
    expect(first).not.toBe(sameContentOtherName);
  });

  it("同一份内容算出的文本一致（否则去重会失效）", () => {
    expect(scenePayloadText(scene("场景1", 10))).toBe(scenePayloadText(scene("场景1", 10)));
  });

  it("位置改了文本就变（拖动必须被推下去）", () => {
    expect(scenePayloadText(scene("场景1", 10))).not.toBe(scenePayloadText(scene("场景1", 11)));
  });

  it("null 表示没有打开的场景", () => {
    expect(scenePayloadText(null)).toBeNull();
  });
});

describe("ScenePushScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("连续 schedule 只推最后一次（拖动去抖）", () => {
    vi.useFakeTimers();
    const pushed: Array<string | null> = [];
    const scheduler = new ScenePushScheduler({ delayMs: 200, push: (text) => pushed.push(text) });

    scheduler.schedule("a");
    scheduler.schedule("b");
    scheduler.schedule("c");

    expect(pushed).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(pushed).toEqual(["c"]);
  });

  it("flush 立刻推，并取消还没发出去的那次", () => {
    vi.useFakeTimers();
    const pushed: Array<string | null> = [];
    const scheduler = new ScenePushScheduler({ delayMs: 200, push: (text) => pushed.push(text) });

    scheduler.schedule("later");
    scheduler.flush("now");

    expect(pushed).toEqual(["now"]);
    vi.advanceTimersByTime(500);
    expect(pushed).toEqual(["now"]);
  });

  it("cancel 之后什么都不会推（退出运行态时用）", () => {
    vi.useFakeTimers();
    const pushed: Array<string | null> = [];
    const scheduler = new ScenePushScheduler({ delayMs: 200, push: (text) => pushed.push(text) });

    scheduler.schedule("a");
    scheduler.cancel();
    vi.advanceTimersByTime(500);

    expect(pushed).toEqual([]);
  });
});
