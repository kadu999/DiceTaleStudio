import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmptyProject } from "@dts/document";
import {
  buildResourceTree,
  campaignFolderId,
  createCampaign,
  deleteCampaign,
  listCampaigns,
  parseResourceId,
  readCampaignEntries,
  validateCampaignRelativePath,
  type ResourceProvider,
} from "@dts/resources";
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
          clientConnected: hub.clientConnected,
          editorConnections: hub.editorCount,
        });
        return;

      case "/api/config":
        sendJson(response, 200, {
          resourceRoot: config.resourceRoot,
          dirs: config.dirs,
          campaignFolders: config.app.campaignFolders,
          defaultCellPixels: config.app.defaultCellPixels,
          usingDefaults: config.usingDefaults,
        });
        return;

      // ---------------------------------------------------------- 跑团工程
      case "/api/campaigns": {
        if (request.method === "GET") {
          sendJson(response, 200, { campaigns: await listCampaigns(provider) });
          return;
        }

        if (request.method === "POST") {
          const body = await readJsonBody(request);
          const name = typeof body.name === "string" ? body.name.trim() : "";
          try {
            await createCampaign(provider, name, {
              folders: config.app.campaignFolders,
              project: createEmptyProject(name),
            });
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }

          log("info", `已创建跑团: ${name}`);
          sendJson(response, 201, { ok: true, name });
          return;
        }

        if (request.method === "DELETE") {
          const name = url.searchParams.get("name") ?? "";
          try {
            const result = await deleteCampaign(provider, name);
            log("info", `已删除跑团: ${name}（清理 ${result.removed} 个文件）`);
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

      case "/api/campaigns/tree": {
        const name = url.searchParams.get("name") ?? "";
        if (name.length === 0) {
          sendJson(response, 400, { error: "缺少 name 参数" });
          return;
        }

        const entries = await readCampaignEntries(provider, name);
        // 不存在的跑团返回空树：否则会把「标准子目录」凭空画出来，让人以为工程还在
        sendJson(response, 200, {
          name,
          exists: entries.length > 0,
          tree: entries.length === 0 ? [] : buildResourceTree(name, entries, config.app.campaignFolders),
        });
        return;
      }

      case "/api/campaigns/folder": {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: `不支持的方法: ${request.method}` });
          return;
        }

        const body = await readJsonBody(request);
        const campaign = typeof body.campaign === "string" ? body.campaign : "";
        const folderPath = typeof body.path === "string" ? body.path : "";
        const reason = validateCampaignRelativePath(folderPath);
        if (campaign.length === 0 || reason !== undefined) {
          sendJson(response, 400, { error: reason ?? "缺少 campaign 参数" });
          return;
        }

        const id = campaignFolderId(campaign, folderPath);
        await provider.ensureFolder(id);
        log("info", `已创建目录: ${id}`);
        sendJson(response, 201, { ok: true, id });
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

      case "/api/state":
        sendJson(response, 200, { ...hub.state.snapshot, actions: hub.state.listActions() });
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
      // SPA 回退：未知路径交给前端路由；但若编辑器尚未构建，给出可操作的提示
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

      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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
