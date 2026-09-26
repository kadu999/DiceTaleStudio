import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHttpContext, type HttpServerOptions } from "./context";
import { HttpError, sendJson } from "./responses";
import { createApiDispatcher, type RouteContext } from "./router";
import { ROUTES } from "./routes";
import { serveStatic } from "./static";

export type { HttpServerOptions } from "./context";

/**
 * 组装 HTTP 服务器。
 *
 * 这里**只剩三件事**：装配上下文、按 `/api/` 前缀二分、把失败翻成响应。
 * 具体接口在 `./routes/*`（一条协议一个函数），静态托管在 `./static.ts`。
 *
 * 失败的两种归宿（与拆分前逐字一致）：
 * - `HttpError` → 对应的状态码 + `{ error: <message> }`（400 / 403 / 404 / 405 / 413 / 500 的那几条）；
 * - 其它异常 → 记一条 `请求处理失败` 日志 + `500 { error: "内部错误" }`（不把内部细节漏给客户端）。
 */
export function createHttpServer(options: HttpServerOptions): Server {
  const context = createHttpContext(options);
  const dispatchApi = createApiDispatcher(ROUTES);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname.startsWith("/api/")) {
      const ctx: RouteContext = {
        ...context,
        request,
        response,
        url,
        // HTTP/1.1 的请求一定有动词；这里兜一个默认值只是为了让类型收窄
        method: request.method ?? "GET",
      };
      await dispatchApi(ctx);
      return;
    }

    await serveStatic(response, url.pathname);
  }

  const server = createServer((request, response) => {
    // 客户端中途断开（取消缩略图 / 视频下载、关页面）时，写响应会**异步**冒 'error'
    // （Windows 上是 UV_EOF 的 write）——没人接就把整个进程打崩，这里统一吞掉：
    // 断开了就是客户端不需要了，不是服务端错误。
    response.on("error", () => {});

    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }

      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }

      context.log("error", `请求处理失败: ${error instanceof Error ? error.message : String(error)}`);
      sendJson(response, 500, { error: "内部错误" });
    });
  });

  // keep-alive 下一个 socket 服务很多个请求，`connection` 每个连接只触发一次，
  // 所以 error 监听挂在这里天然不会累积（不需要 WeakSet 去重）。
  server.on("connection", (socket) => {
    socket.on("error", () => {});
  });

  return server;
}
