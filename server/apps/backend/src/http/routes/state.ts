import type { RouteContext } from "../router";
import { sendJson } from "../responses";

/**
 * `GET /api/state`：运行态摘要——开没开闸、前端是谁、当前镜像的是哪份场景。
 *
 * **数据都在编辑器文档里**，服务端只有缓存与摘要（见 `RuntimeSession.snapshot`），
 * 所以这里没有「整份场景」可给。它也用于「编辑器刷新后接回运行态」之外的人工排查。
 */
export function getState(ctx: RouteContext): void {
  sendJson(ctx.response, 200, { ...ctx.hub.session.snapshot, serverTime: Date.now() });
}
