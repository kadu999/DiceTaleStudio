import type { ServerResponse } from "node:http";
import { messageOf } from "../values";

/**
 * 处理器「提前返回一个状态码」的唯一手段。
 *
 * 抛 `HttpError`，由 `createHttpServer` 统一翻成 `{ error }` JSON。
 * 为什么不直接在处理器里 `sendJson(400, …)` 再 `return`：那样每条失败路径都要自己写一遍
 * 「写响应 + 结束」，漏掉一条就变成「请求挂着不返回」。抛错之后分工很清楚——
 * **成功路径只管写响应（返回 `void`），失败路径只管抛**。
 *
 * 注意：这里**只**承接拆分前就返回 400 / 404 / 405 的那些路径。
 * 其它异常（provider 抛的、JSON 解析失败的）继续冒泡成 `500 { error: "内部错误" }`，
 * 与拆分前的行为逐字一致。
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, message);
}

/** 405 的文案固定成这一句（测试与前端都按它辨认）。 */
export function methodNotAllowed(method: string | undefined): HttpError {
  return new HttpError(405, `不支持的方法: ${method}`);
}

/**
 * provider 抛出的错误：**业务错误 → 400，系统错误 → 原样冒泡（500「内部错误」）**。
 *
 * 区分靠 Node 的 `error.code`：我们主动 throw 的业务错误（项目重名 / 资源不存在…）不带它，
 * 而文件系统错误（EACCES / ENOSPC / ENOENT…）带。少了这一步，磁盘故障会被说成「你请求错了」，
 * 还会把服务端的绝对路径原样回显给客户端。
 */
export function rethrowProviderError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  if (typeof code === "string") {
    throw error;
  }

  throw badRequest(messageOf(error));
}

/** JSON 响应：所有接口的成功体都是 JSON，且一律 `no-store`（接口数据没有可缓存性）。 */
export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

/** 纯文本响应（`/api/resources/text` 的读路径）。 */
export function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(text);
}

/** 二进制响应（`/api/resources/raw` 的读路径）。`headers` 用来附加 `x-dts-*` 之类的元信息。 */
export function sendBytes(
  response: ServerResponse,
  status: number,
  contentType: string,
  data: Buffer,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": String(data.byteLength),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(data);
}

/** 空响应（资源包指纹没变时的 **304**：不带 body，只带指纹头）。 */
export function sendEmpty(
  response: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { "cache-control": "no-store", ...headers });
  response.end();
}
