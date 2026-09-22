import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpContext } from "./context";
import { methodNotAllowed, notFound } from "./responses";

/** 支持的 HTTP 动词（这个后端只用这四种）。 */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** 一次请求的上下文：服务器级依赖 + 这一条请求自己的东西。 */
export interface RouteContext extends HttpContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly method: string;
}

/**
 * 一条路由 = **一个动词 + 一个路径 + 一个函数**。
 *
 * 「一条协议一个函数」是这张表的全部意义：`/api/projects` 的 GET / POST / DELETE 是三条
 * 独立的表项、三个独立的函数，而不是一个 `switch (method)` 里三段内联代码。
 */
export interface Route {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: (ctx: RouteContext) => void | Promise<void>;
}

/**
 * 把路由表编译成「一次请求 → 一个处理函数」的分派器。
 *
 * - 路径没有对应表项 → 404 `未知接口: <path>`（与拆分前逐字一致）；
 * - 路径有、动词没有 → 405 `不支持的方法: <method>`；
 * - 处理函数抛出的 `HttpError` 由 `createHttpServer` 统一翻成 `{ error }`（这里不 catch，避免两处各写一遍）。
 *
 * 附带的一个收紧：拆分前 `/api/health` / `/api/config` / `/api/state` 不检查动词（POST 也能拿 200），
 * 现在只认 GET —— 仓库里所有调用方（编辑器、Playwright 健康检查、测试）都是 GET。
 */
export function createApiDispatcher(
  routes: readonly Route[],
): (ctx: RouteContext) => Promise<void> {
  const byPath = new Map<string, Route[]>();
  for (const route of routes) {
    const list = byPath.get(route.path);
    if (list === undefined) {
      byPath.set(route.path, [route]);
    } else {
      list.push(route);
    }
  }

  return async (ctx: RouteContext): Promise<void> => {
    const candidates = byPath.get(ctx.url.pathname);
    if (candidates === undefined) {
      throw notFound(`未知接口: ${ctx.url.pathname}`);
    }

    const route = candidates.find((candidate) => candidate.method === ctx.method);
    if (route === undefined) {
      throw methodNotAllowed(ctx.method);
    }

    await route.handler(ctx);
  };
}
