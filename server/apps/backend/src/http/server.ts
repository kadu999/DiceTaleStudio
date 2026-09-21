import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmptyProject } from "@dts/document";
import {
  buildResourceTree,
  createProject,
  deleteProject,
  listProjects,
  normalizePath,
  parseResourceId,
  projectFileId,
  projectFolderId,
  projectPath,
  readProjectEntries,
  validateProjectName,
  validateProjectRelativePath,
  type ResourceProvider,
} from "@dts/resources";
import {
  openFolder as openFolderInFileManager,
  revealFile as revealFileInFileManager,
} from "../open-folder";
import {
  BundleTooLargeError,
  ProjectNotFoundError,
  buildBundle,
  readProjectManifest,
} from "../resources/bundle";
import type { LogLevel } from "../ws/hub";
import type { RuntimeHub } from "../ws/hub";
import type { LoadedConfig } from "../config";

/** 编辑器构建产物目录（`apps/editor/dist`）。 */
const EDITOR_DIST = fileURLToPath(new URL("../../../editor/dist", import.meta.url));

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".bytes": "application/octet-stream",
};

export interface HttpServerOptions {
  readonly config: LoadedConfig;
  readonly provider: ResourceProvider;
  readonly hub: RuntimeHub;
  readonly log: (level: LogLevel, message: string) => void;
  /**
   * 「在文件管理器里打开目录 / 定位文件」的实现（`/api/projects/reveal` 用）。
   *
   * 参数是**要打开的目录路径**，以及（可选）**要选中的文件路径**——两者都是服务端自己拼出来的
   * 绝对路径。测试注入假的：真的去调系统命令会在跑测试的机器上弹出一堆窗口。
   */
  readonly openFolder?: (path: string, selectFile?: string) => Promise<void>;
}

function contentTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

/** 读取并解析 JSON 请求体；空体视为 `{}`，非法 JSON 抛错（由外层转成 500，调用方一般自行校验）。 */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBody(request)).toString("utf8").trim();
  if (raw.length === 0) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

export function createHttpServer(options: HttpServerOptions): Server {
  const { config, provider, hub, log } = options;
  // 给了 `selectFile` 就走「定位文件」，否则就是普通地打开目录
  const openFolder =
    options.openFolder ??
    ((path: string, selectFile?: string) =>
      selectFile === undefined
        ? openFolderInFileManager(path)
        : revealFileInFileManager(selectFile));

  /**
   * 资源包缓存：**每个项目只留最近一份**（key = 项目名）。
   *
   * 打一次包要把整个 `Assets/` 读进内存再拼 zip，37 MB 量级每次都重打太浪费；
   * 但素材是**外部工具随时可能改**的，所以进缓存前先重算一次指纹（成本 = 一次 `list`），
   * 内容变了就重打——不需要文件监听，也不会发出发霉的包。
   */
  const bundleCache = new Map<string, { fingerprint: string; zip: Buffer; headers: Record<string, string> }>();

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      log("error", `请求处理失败: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) {
        sendJson(response, 500, { error: "内部错误" });
      } else {
        response.end();
      }
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    await serveStatic(response, path);
  }

  async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    switch (url.pathname) {
      case "/api/health":
        sendJson(response, 200, {
          ok: true,
          runtimeActive: hub.runtimeActive,
          clientConnected: hub.clientConnected,
          editorConnections: hub.editorCount,
        });
        return;

      case "/api/config":
        sendJson(response, 200, {
          resourceRoot: config.resourceRoot,
          dirs: config.dirs,
          projectFolders: config.app.projectFolders,
          defaultCellPixels: config.app.defaultCellPixels,
          usingDefaults: config.usingDefaults,
        });
        return;

      // ---------------------------------------------------------- 项目
      case "/api/projects": {
        if (request.method === "GET") {
          sendJson(response, 200, { projects: await listProjects(provider) });
          return;
        }

        if (request.method === "POST") {
          const body = await readJsonBody(request);
          const name = typeof body.name === "string" ? body.name.trim() : "";
          try {
            await createProject(provider, name, {
              folders: config.app.projectFolders,
              project: createEmptyProject(name),
            });
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }

          log("info", `已创建项目: ${name}`);
          sendJson(response, 201, { ok: true, name });
          return;
        }

        if (request.method === "DELETE") {
          const name = url.searchParams.get("name") ?? "";
          try {
            const result = await deleteProject(provider, name);
            log("info", `已删除项目: ${name}（清理 ${result.removed} 个文件）`);
            sendJson(response, 200, { ok: true, name, removed: result.removed });
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            });
          }

          return;
        }

        sendJson(response, 405, { error: `不支持的方法: ${request.method}` });
        return;
      }

      case "/api/projects/tree": {
        const name = url.searchParams.get("name") ?? "";
        if (name.length === 0) {
          sendJson(response, 400, { error: "缺少 name 参数" });
          return;
        }

        const entries = await readProjectEntries(provider, name);
        // 不存在的项目返回空树：否则会把「标准子目录」凭空画出来，让人以为项目还在
        sendJson(response, 200, {
          name,
          exists: entries.length > 0,
          tree: entries.length === 0 ? [] : buildResourceTree(name, entries, config.app.projectFolders),
        });
        return;
      }

      case "/api/projects/folder": {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: `不支持的方法: ${request.method}` });
          return;
        }

        const body = await readJsonBody(request);
        const project = typeof body.project === "string" ? body.project : "";
        const folderPath = typeof body.path === "string" ? body.path : "";
        const reason = validateProjectRelativePath(folderPath);
        if (project.length === 0 || reason !== undefined) {
          sendJson(response, 400, { error: reason ?? "缺少 project 参数" });
          return;
        }

        const id = projectFolderId(project, folderPath);
        await provider.ensureFolder(id);
        log("info", `已创建目录: ${id}`);
        sendJson(response, 201, { ok: true, id });
        return;
      }

      /**
       * 用文件管理器打开项目里的某一层（资源面板的「打开目录」按钮）。
       *
       * 打开的是**服务端这台机器**上的目录：浏览器不能替用户开文件夹，所以只能后端做。
       * 绝对路径由服务端自己拼（`资源根 / projects / 项目名 / 项目内相对路径`），
       * 客户端只能给**项目内的相对路径**，而且必须过 `validateProjectRelativePath`
       * （逐段拒绝 `..`），拼好后还要**再确认落在项目目录里**才 spawn——这是这个接口的安全边界。
       *
       * 请求体：
       * - `name`：项目名（必填）；
       * - `path`：项目内相对路径（可选，空 = 项目根）；
       * - `selectFile`：为真且 `path` 指向一个**存在的文件**时，打开它所在的目录并选中它
       *   （Linux 没有统一的「选中文件」接口，会退回打开父目录）。
       */
      case "/api/projects/reveal": {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: `不支持的方法: ${request.method}` });
          return;
        }

        const body = await readJsonBody(request);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const reason = validateProjectName(name);
        if (reason !== undefined) {
          sendJson(response, 400, { error: reason });
          return;
        }

        if (!(await provider.exists(projectFileId(name)))) {
          sendJson(response, 404, { error: `项目「${name}」不存在` });
          return;
        }

        const subPath = typeof body.path === "string" ? normalizePath(body.path).trim() : "";
        if (subPath.length > 0) {
          const pathReason = validateProjectRelativePath(subPath);
          if (pathReason !== undefined) {
            sendJson(response, 400, { error: pathReason });
            return;
          }
        }

        const projectFolder = resolve(config.resourceRoot, config.dirs.project, projectPath(name));
        const target =
          subPath.length === 0 ? projectFolder : resolve(projectFolder, ...subPath.split("/"));
        // 拼出来之后再确认一次：任何越出项目目录的路径都不许开
        if (target !== projectFolder && !target.startsWith(projectFolder + sep)) {
          sendJson(response, 400, { error: "路径不允许越出项目目录" });
          return;
        }

        const selectFile = body.selectFile === true;
        let fileToSelect: string | undefined;
        if (selectFile && subPath.length > 0) {
          // 只对**真实存在的文件**做「选中」：目录也过 `/select,` 会变成「打开它并选中它自己」，
          // 那不是用户要的；`path` 是个不存在的文件则是明确的错，不能悄悄退化成打开目录。
          const info = await stat(target).catch(() => null);
          if (info === null) {
            sendJson(response, 404, { error: `文件不存在：${subPath}` });
            return;
          }

          fileToSelect = info.isFile() ? target : undefined;
        }

        const folderToOpen = fileToSelect === undefined ? target : dirname(fileToSelect);
        try {
          await openFolder(folderToOpen, fileToSelect);
        } catch (error) {
          sendJson(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }

        log(
          "info",
          fileToSelect === undefined
            ? `已在文件管理器中打开目录: ${folderToOpen}`
            : `已在文件管理器中定位文件: ${fileToSelect}`,
        );
        sendJson(response, 200, { ok: true, path: folderToOpen });
        return;
      }

      // ---------------------------------------------------------- 通用资源
      case "/api/resources/index": {
        const kind = url.searchParams.get("kind") ?? undefined;
        const entries = await provider.list(kind as never);
        sendJson(response, 200, { entries });
        return;
      }

      case "/api/resources/raw": {
        const id = url.searchParams.get("id");
        if (id === null || id.length === 0) {
          sendJson(response, 400, { error: "缺少 id 参数" });
          return;
        }

        if (request.method === "PUT" || request.method === "POST") {
          const body = await readBody(request);
          const payload = body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
          ) as ArrayBuffer;
          await provider.writeBinary(id, payload);
          log("info", `资源已写入: ${id}（${body.byteLength} 字节）`);
          sendJson(response, 200, { ok: true, id, size: body.byteLength });
          return;
        }

        if (request.method === "DELETE") {
          await provider.remove(id);
          log("info", `资源已删除: ${id}`);
          sendJson(response, 200, { ok: true, id });
          return;
        }

        if (!(await provider.exists(id))) {
          sendJson(response, 404, { error: `资源不存在: ${id}` });
          return;
        }

        const data = await provider.readBinary(id);
        response.writeHead(200, {
          "content-type": contentTypeFor(parseResourceId(id).path),
          "content-length": String(data.byteLength),
          "cache-control": "no-store",
        });
        response.end(Buffer.from(data));
        return;
      }

      case "/api/resources/text": {
        const id = url.searchParams.get("id");
        if (id === null || id.length === 0) {
          sendJson(response, 400, { error: "缺少 id 参数" });
          return;
        }

        if (request.method === "PUT" || request.method === "POST") {
          const body = await readBody(request);
          await provider.writeText(id, body.toString("utf8"));
          sendJson(response, 200, { ok: true, id });
          return;
        }

        if (!(await provider.exists(id))) {
          sendJson(response, 404, { error: `资源不存在: ${id}` });
          return;
        }

        response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end(await provider.readText(id));
        return;
      }

      /**
       * 项目资源清单（前端先问这一份，拿指纹决定要不要真的下载）。
       *
       * 只列 `Assets/` 下的文件（项目文件与 `.gitkeep` 不算资源）。
       */
      case "/api/resources/manifest": {
        const project = (url.searchParams.get("project") ?? "").trim();
        if (project.length === 0) {
          sendJson(response, 400, { error: "缺少 project 参数" });
          return;
        }

        try {
          const manifest = await readProjectManifest(provider, project);
          sendJson(response, 200, {
            project: manifest.project,
            fingerprint: manifest.fingerprint,
            bytes: manifest.bytes,
            fileCount: manifest.entries.length,
            files: manifest.entries,
          });
        } catch (error) {
          if (error instanceof ProjectNotFoundError) {
            sendJson(response, 404, { error: error.message });
            return;
          }

          throw error;
        }

        return;
      }

      /**
       * 项目资源包（整包 zip）。
       *
       * `v=<指纹>`：客户端说「我本地已经是这一版」——指纹没变就回 **304**，
       * 省掉一次几十 MB 的传输；变了才回整包。
       */
      case "/api/resources/bundle": {
        const project = (url.searchParams.get("project") ?? "").trim();
        if (project.length === 0) {
          sendJson(response, 400, { error: "缺少 project 参数" });
          return;
        }

        const known = url.searchParams.get("v") ?? "";

        try {
          const current = await readProjectManifest(provider, project);
          if (known.length > 0 && known === current.fingerprint) {
            response.writeHead(304, {
              "cache-control": "no-store",
              "x-dts-project": encodeURIComponent(project),
              "x-dts-fingerprint": current.fingerprint,
            });
            response.end();
            return;
          }

          let cached = bundleCache.get(project);
          if (cached === undefined || cached.fingerprint !== current.fingerprint) {
            const built = await buildBundle(provider, project, {
              maxTotalBytes: config.app.bundle.maxTotalBytes,
            });
            cached = { fingerprint: built.manifest.fingerprint, zip: built.zip, headers: { ...built.headers } };
            bundleCache.set(project, cached);
            log(
              "info",
              `已打包资源「${project}」：${built.manifest.entries.length} 个文件 / ${built.manifest.bytes} 字节 / ${built.manifest.fingerprint}`,
            );
          }

          response.writeHead(200, {
            "content-type": "application/zip",
            "content-length": String(cached.zip.byteLength),
            // 指纹变了 URL 就不同，所以可以放心让客户端/代理缓存；这里交给前端自己落盘
            "cache-control": "no-store",
            ...cached.headers,
          });
          response.end(cached.zip);
        } catch (error) {
          if (error instanceof ProjectNotFoundError) {
            sendJson(response, 404, { error: error.message });
            return;
          }

          if (error instanceof BundleTooLargeError) {
            sendJson(response, 413, { error: error.message });
            return;
          }

          throw error;
        }

        return;
      }

      case "/api/resources/rename": {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: `不支持的方法: ${request.method}` });
          return;
        }

        const body = await readJsonBody(request);
        const from = typeof body.from === "string" ? body.from.trim() : "";
        const to = typeof body.to === "string" ? body.to.trim() : "";
        if (from.length === 0 || to.length === 0) {
          sendJson(response, 400, { error: "缺少 from / to 参数" });
          return;
        }

        try {
          // 类别不同 / 源不存在 / 目标已存在都由 provider 抛错，原样转成 400
          await provider.rename(from, to);
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }

        log("info", `资源已重命名: ${from} → ${to}`);
        sendJson(response, 200, { ok: true, id: to });
        return;
      }

      case "/api/state":
        // 运行态：开没开闸、前端是谁、当前镜像的是哪份场景（数据都在编辑器文档里，这里只有摘要）
        sendJson(response, 200, { ...hub.session.snapshot, serverTime: Date.now() });
        return;

      default:
        sendJson(response, 404, { error: `未知接口: ${url.pathname}` });
    }
  }

  async function serveStatic(response: ServerResponse, path: string): Promise<void> {
    const relative = path === "/" ? "index.html" : decodeURIComponent(path).replace(/^\/+/, "");
    const target = resolve(join(EDITOR_DIST, relative));
    const prefix = EDITOR_DIST.endsWith(sep) ? EDITOR_DIST : `${EDITOR_DIST}${sep}`;

    // 目录穿越防护
    if (target !== EDITOR_DIST && !target.startsWith(prefix)) {
      sendJson(response, 403, { error: "非法路径" });
      return;
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
        sendJson(response, 404, { error: `静态资源不存在: ${relative}` });
        return;
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
