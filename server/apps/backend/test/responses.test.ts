import { describe, expect, it } from "vitest";
import { HttpError, rethrowProviderError } from "../src/http/responses";

/**
 * provider 抛出的错误有两条归宿，别把服务端故障说成「客户端请求错了」：
 *
 * - **业务错误**（我们主动 throw 的：项目重名 / 资源不存在…）→ **400**，消息照抄；
 * - **系统错误**（`node:fs` 的 EACCES / ENOSPC / ENOENT…，带 `error.code`）→ **原样冒泡**，
 *   由 `createHttpServer` 统一兜成 `500 { error: "内部错误" }`（不把磁盘路径回显给客户端）。
 */

describe("http/responses：provider 错误分类", () => {
  it("业务错误（不带 code）→ 400，消息原样带上", () => {
    let caught: unknown;
    try {
      rethrowProviderError(new Error("项目「A」已存在"));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(400);
    expect((caught as HttpError).message).toContain("已存在");
  });

  it("系统错误（带 code）→ 原样冒泡，不翻成 400", () => {
    const system = Object.assign(new Error("ENOSPC: no space left on device, write '/srv/x'"), {
      code: "ENOSPC",
    });

    let caught: unknown;
    try {
      rethrowProviderError(system);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(system);
  });

  it("非 Error 值也按业务错误处理（400）", () => {
    let caught: unknown;
    try {
      rethrowProviderError("坏了");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(400);
  });
});
