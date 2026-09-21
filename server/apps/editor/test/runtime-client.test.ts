import { describe, expect, it } from "vitest";
import {
  CLOSE_PROTOCOL_MISMATCH,
  describeSocketClose,
  reconnectDelayMs,
} from "../src/services/runtime-client";

/**
 * 断线重连的两件小事（纯函数部分）。
 *
 * 它们对应一次真实的现场事故：编辑器升到协议 v4、服务端进程还是 v3，
 * 服务端每次都以 `close 4002` 把编辑器踢掉；而编辑器（1）把 close reason 丢了、
 * （2）在 `open` 那一刻就把退避清零，于是运行日志里变成「已连接 / 已断开」一秒刷一次，
 * 完全看不出根因。
 */

describe("断开原因：close code / reason → 一句人话", () => {
  it("协议版本不一致：照抄服务端说的版本，并点明要重启服务端", () => {
    const message = describeSocketClose(CLOSE_PROTOCOL_MISMATCH, "协议版本不一致：编辑器 4，服务端 3");

    expect(message).toContain("协议版本不一致：编辑器 4，服务端 3");
    expect(message).toContain("服务端要重启");
  });

  it("协议版本不一致但服务端没写 reason：也给一句能照着做的", () => {
    expect(describeSocketClose(CLOSE_PROTOCOL_MISMATCH, "")).toMatch(/协议版本不同.*服务端要重启/s);
  });

  it("其它原因照抄服务端的话，并附上 close code（排查时对得上后端日志）", () => {
    expect(describeSocketClose(4003, "编辑器已退出运行态")).toBe("编辑器已退出运行态（close 4003）");
  });

  it("1006（没说明的断开）与 1005 都有兜底说法，不会是空白", () => {
    expect(describeSocketClose(1006, "")).toMatch(/服务端没在跑/);
    expect(describeSocketClose(1005, "")).toMatch(/服务端关闭了连接/);
    expect(describeSocketClose(4001, "")).toBe("连接被关闭（close 4001）");
  });

  it("close 事件缺 code / reason（假 socket、老实现）也不抛异常", () => {
    // 曾经的坑：这里对 `reason` 直接 `.trim()`，于是一条缺字段的 close 事件会把
    // 整条断线流程打断（状态没更新、重连没排上），排查时只看到一堆莫名其妙的断言失败
    expect(describeSocketClose(undefined, undefined)).toBe("连接被关闭（close 0）");
    expect(describeSocketClose(1006, undefined)).toMatch(/服务端没在跑/);
  });
});

describe("重连退避：别拿 500ms 去捶一个注定拒绝你的服务端", () => {
  it("失败的尝试越多等得越久，封顶 10s", () => {
    expect([0, 1, 2, 3].map((attempt) => reconnectDelayMs(attempt))).toEqual([500, 1000, 2000, 4000]);
    expect(reconnectDelayMs(5)).toBe(10_000);
    expect(reconnectDelayMs(50)).toBe(10_000);
  });

  it("重连也不会好的原因（协议版本不一致）：直接按上限慢慢探", () => {
    expect(reconnectDelayMs(0, true)).toBe(10_000);
  });
});
