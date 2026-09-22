import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { contentTypeFor } from "./mime";
import { HttpError, notFound } from "./responses";

/** 编辑器构建产物目录（`apps/editor/dist`）。 */
const EDITOR_DIST = fileURLToPath(new URL("../../../editor/dist", import.meta.url));

/**
 * 托管编辑器产物 + SPA 回退。
 *
 * 与 `/api/*` 完全无关，所以它不在这套路由表里：`createHttpServer` 只按「是不是 `/api/` 前缀」
 * 二分一次，静态这边一个函数到底。
 */
export async function serveStatic(response: ServerResponse, path: string): Promise<void> {
  const relative = path === "/" ? "index.html" : decodeURIComponent(path).replace(/^\/+/, "");
  const target = resolve(join(EDITOR_DIST, relative));
  const prefix = EDITOR_DIST.endsWith(sep) ? EDITOR_DIST : `${EDITOR_DIST}${sep}`;

  // 目录穿越防护
  if (target !== EDITOR_DIST && !target.startsWith(prefix)) {
    throw new HttpError(403, "非法路径");
  }

  const file = await resolveExisting(target);
  if (file === undefined) {
    // 产物文件缺失：**必须 404，绝不能回 index.html**。
    //
    // 构建产物是**带内容哈希**的（`index-ejQGu__r.js`）：每跑一次 `pnpm build` 就换一批文件名、
    // 旧的那批立刻不存在了。而**在构建前打开着的页面**手里还攥着旧文件名，一刷新就会来要它——
    // 要是这时回一个 `text/html` 的 index.html（还带 200），浏览器会拿 HTML 当 ES 模块解析，
    // 页面直接白屏卡死（控制台报 MIME type / `Unexpected token '<'`）。
    // 返回 404 才对：浏览器知道这个文件没了，重新拿到 `no-store` 的 index.html，一切照旧。
    if (relative !== "index.html" && looksLikeFile(relative)) {
      throw notFound(`静态资源不存在: ${relative}`);
    }

    // SPA 回退：其余「像前端路由」的未知路径交给前端（编辑器自己没有路由，留着以备将来）；
    // 若编辑器尚未构建，给出可操作的提示
    const index = await resolveExisting(join(EDITOR_DIST, "index.html"));
    if (index === undefined) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><meta charset="utf-8"><title>DiceTaleStudio</title>` +
          `<body style="font-family:system-ui;background:#14161a;color:#e6e6e6;padding:2rem">` +
          `<h1>编辑器尚未构建</h1>` +
          `<p>请先在 <code>server/</code> 下运行 <code>pnpm build</code>，或用 <code>pnpm dev</code> 启动 Vite 开发服务器。</p>` +
          `<p>后端接口可用：<code>/api/health</code>、<code>/api/config</code>、<code>/api/resources/index</code>、<code>/api/state</code></p>` +
          `</body>`,
      );
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(await readFile(index));
    return;
  }

  response.writeHead(200, {
    "content-type": contentTypeFor(file),
    "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=60",
  });
  response.end(await readFile(file));
}

async function resolveExisting(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 这个请求要的是**一个产物文件**，还是**一个前端路由**？
 *
 * 判据两条：落在 `assets/` 下，或者**带扩展名**。两类都说明请求方要的是文件——
 * 缺了就该 404，回 index.html 会让浏览器把 HTML 当 JS / CSS 解析（页面白屏卡死）。
 * 没有扩展名的路径（`/settings` 这种）才当成前端路由，交给 SPA 回退。
 */
function looksLikeFile(relative: string): boolean {
  return relative.startsWith("assets/") || /\.[a-z0-9]+$/i.test(relative);
}
