import type { RouteContext } from "../router";
import { sendJson } from "../responses";

/**
 * `GET /api/health`：运行态摘要。
 *
 * 给三种用途：Playwright 的 `webServer` 就绪判据、运维脚本、以及「后端起来了吗」。
 * 它是**只读**的，不碰磁盘也不碰运行态。
 */
export function getHealth(ctx: RouteContext): void {
  sendJson(ctx.response, 200, {
    ok: true,
    runtimeActive: ctx.hub.runtimeActive,
    clientConnected: ctx.hub.clientConnected,
    editorConnections: ctx.hub.editorCount,
  });
}
