import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { readBody, readJsonBody } from "../src/http/requests";
import { HttpError } from "../src/http/responses";

/**
 * 请求体读取的两条语义：正常读取，以及**超过上限就 413**。
 *
 * 背景：整个 body 是先进内存再解析的（`readBody`），没有上限时一个超大请求就能把服务端
 * 内存吃光。上限来自 app 配置（`http.maxBodyBytes`），这里用小值直接验证拦截发生在
 * 「声明的 content-length」与「实际累计字节」两条路径上。
 */

/** 造一个只满足 `readBody` 需要的假请求：可异步迭代的流 + `headers`。 */
function fakeRequest(chunks: Buffer[], contentLength?: number): IncomingMessage {
  const stream = Readable.from(chunks) as unknown as IncomingMessage;
  stream.headers = contentLength === undefined ? {} : { "content-length": String(contentLength) };
  return stream;
}

async function statusOfBodyError(run: Promise<Buffer>): Promise<number | undefined> {
  const error = await run.catch((caught: unknown) => caught);
  return error instanceof HttpError ? error.status : undefined;
}

describe("http/requests：请求体读取", () => {
  it("读完整个 body，并交给 JSON 解析", async () => {
    await expect(readJsonBody(fakeRequest([Buffer.from('{"a":'), Buffer.from("1}")]), 1024)).resolves.toEqual({
      a: 1,
    });
  });

  it("空体视为 {}（不带 body 的 POST 不会因此报错）", async () => {
    await expect(readJsonBody(fakeRequest([]), 1024)).resolves.toEqual({});
  });

  it("声明的 content-length 超限：直接 413", async () => {
    expect(await statusOfBodyError(readBody(fakeRequest([Buffer.from("xxxx")], 2048), 16))).toBe(413);
  });

  it("没有 content-length 时按实际累计字节在流中拦截", async () => {
    expect(await statusOfBodyError(readBody(fakeRequest([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)]), 16))).toBe(
      413,
    );
  });

  it("刚好等于上限时放行", async () => {
    await expect(readBody(fakeRequest([Buffer.alloc(16)]), 16)).resolves.toHaveLength(16);
  });
});
