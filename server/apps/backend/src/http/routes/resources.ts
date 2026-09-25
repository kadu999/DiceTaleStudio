import { parseResourceId, type ResourceKind } from "@dts/resources";
import sharp from "sharp";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  BundleTooLargeError,
  ProjectNotFoundError,
  readProjectManifest,
} from "../../resources/bundle";
import { contentTypeFor } from "../mime";
import { bodyTrimmed, queryRaw, queryTrimmed, readBody, readJsonBody } from "../requests";
import { HttpError, badRequest, sendBytes, sendEmpty, sendJson, sendText } from "../responses";
import type { RouteContext } from "../router";

const THUMBNAIL_MAX_EDGE = 192;
const THUMBNAIL_CACHE_MAX_ENTRIES = 96;
interface CachedThumbnail {
  readonly md5: string;
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

const thumbnailCache = new Map<string, CachedThumbnail>();
const thumbnailJobs = new Map<string, Promise<CachedThumbnail>>();

/**
 * 通用资源接口：**一条协议一个函数**。
 *
 * 资源一律用**逻辑 ID**（`config:<路径>` / `project:<项目名>/<项目内路径>`）寻址，
 * 由 `ResourceProvider` 解析成真实位置——这一层不拼路径、也不认识文件系统。
 */

/** `GET /api/resources/index?kind=`：扁平资源列表（编辑器资源面板与素材清单用）。 */
export async function listResourcesRoute(ctx: RouteContext): Promise<void> {
  // 不传 kind = 列全部；传了空串仍按「按该类别列」处理（保持与拆分前一致的行为）
  const kind = ctx.url.searchParams.get("kind") ?? undefined;
  const entries = await ctx.provider.list(kind as ResourceKind | undefined);
  sendJson(ctx.response, 200, { entries });
}

/** 取 `?id=`；缺失或空串时抛 400（三个 raw/text 处理器共用的第一道校验）。 */
function requireId(ctx: RouteContext): string {
  const id = ctx.url.searchParams.get("id");
  if (id === null || id.length === 0) {
    throw badRequest("缺少 id 参数");
  }

  return id;
}

/** `GET /api/resources/raw?id=`：读原始字节，Content-Type 按扩展名给。 */
export async function readResourceRoute(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx);

  if (!(await ctx.provider.exists(id))) {
    throw new HttpError(404, `资源不存在: ${id}`);
  }

  const data = await ctx.provider.readBinary(id);
  sendBytes(ctx.response, 200, contentTypeFor(parseResourceId(id).path), Buffer.from(data));
}

/** `GET /api/resources/thumbnail?id=`: 按需生成并缓存小型 WebP，避免资源选择器下载原图。 */
export async function readResourceThumbnailRoute(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx);
  if (!(await ctx.provider.exists(id))) {
    throw new HttpError(404, `资源不存在: ${id}`);
  }

  const isVideo = contentTypeFor(parseResourceId(id).path).startsWith("video/");
  const source = Buffer.from(await ctx.provider.readBinary(id));
  if (ctx.url.searchParams.get("info") === "1") {
    if (isVideo) {
      throw badRequest("视频不支持 info=1");
    }

    try {
      const metadata = await sharp(source, { limitInputPixels: 100_000_000 }).metadata();
      if (metadata.width === undefined || metadata.height === undefined) {
        throw new Error("Image dimensions are missing");
      }
      const dimensions = metadata.autoOrient ?? { width: metadata.width, height: metadata.height };
      sendJson(ctx.response, 200, { width: dimensions.width, height: dimensions.height });
      return;
    } catch {
      throw badRequest("无法读取图片");
    }
  }

  const md5 = createHash("md5").update(source).digest("hex");
  let thumbnail = thumbnailCache.get(id);
  if (thumbnail?.md5 === md5) {
    thumbnailCache.delete(id);
    thumbnailCache.set(id, thumbnail);
  } else {
    const jobKey = `${id}\n${md5}`;
    let job = thumbnailJobs.get(jobKey);
    if (job === undefined) {
      job = createThumbnail(source, md5, isVideo);
      thumbnailJobs.set(jobKey, job);
    }

    try {
      thumbnail = await job;
      thumbnailCache.set(id, thumbnail);
      if (thumbnailCache.size > THUMBNAIL_CACHE_MAX_ENTRIES) {
        const oldest = thumbnailCache.keys().next().value;
        if (oldest !== undefined) thumbnailCache.delete(oldest);
      }
    } catch {
      throw badRequest(isVideo ? "无法生成视频缩略图（需要 ffmpeg 在 PATH 里）" : "无法读取图片");
    } finally {
      if (thumbnailJobs.get(jobKey) === job) thumbnailJobs.delete(jobKey);
    }
  }

  const headers = {
    "x-image-width": String(thumbnail.width),
    "x-image-height": String(thumbnail.height),
    "cache-control": "private, max-age=86400",
  };
  sendBytes(ctx.response, 200, "image/webp", thumbnail.data, headers);
}

async function createThumbnail(source: Buffer, md5: string, isVideo: boolean): Promise<CachedThumbnail> {
  // 视频（mp4/webm）：先用 ffmpeg 抽首帧再走同一条 sharp 管线；缓存 / 尺寸头 / 失效逻辑与图片一致
  const frame = isVideo ? await extractVideoFrame(source) : source;
  const pipeline = sharp(frame, { limitInputPixels: 100_000_000 });
  const metadata = await pipeline.metadata();
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new Error("Image dimensions are missing");
  }
  const data = await pipeline
    .rotate()
    .resize({ width: THUMBNAIL_MAX_EDGE, height: THUMBNAIL_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 76 })
    .toBuffer();
  const dimensions = metadata.autoOrient ?? { width: metadata.width, height: metadata.height };
  return { md5, data, width: dimensions.width, height: dimensions.height };
}

/**
 * 用 ffmpeg 从视频字节里抽首帧（PNG）：源从 stdin 喂、帧从 stdout 收，不落临时文件。
 * ffmpeg 不在 PATH / 解码失败都抛错——上层转成 400，前端行内图标降级成公用图标。
 */
function extractVideoFrame(source: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(Buffer.concat(errors).toString("utf8").trim() || `ffmpeg 退出码 ${code}`));
      }
    });
    child.stdin.write(source);
    child.stdin.end();
  });
}

/** `PUT|POST /api/resources/raw?id=`：写原始字节（请求体就是文件内容，不解析 JSON）。 */
export async function writeResourceRoute(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx);

  const body = await readBody(ctx.request);
  const payload = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  await ctx.provider.writeBinary(id, payload);
  ctx.log("info", `资源已写入: ${id}（${body.byteLength} 字节）`);
  sendJson(ctx.response, 200, { ok: true, id, size: body.byteLength });
}

/** `DELETE /api/resources/raw?id=`：删资源（对目录是递归语义）。 */
export async function deleteResourceRoute(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx);

  await ctx.provider.remove(id);
  ctx.log("info", `资源已删除: ${id}`);
  sendJson(ctx.response, 200, { ok: true, id });
}

/** `GET /api/resources/text?id=`：读文本（场景 / 工程文件都是它）。 */
export async function readResourceTextRoute(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx);

  if (!(await ctx.provider.exists(id))) {
    throw new HttpError(404, `资源不存在: ${id}`);
  }

  sendText(ctx.response, 200, await ctx.provider.readText(id));
}

/** `PUT|POST /api/resources/text?id=`：写文本（UTF-8，内容原样落盘）。 */
export async function writeResourceTextRoute(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx);

  const body = await readBody(ctx.request);
  await ctx.provider.writeText(id, body.toString("utf8"));
  sendJson(ctx.response, 200, { ok: true, id });
}

/**
 * `GET /api/resources/manifest?project=`：项目资源清单（前端先问这一份，拿指纹决定要不要真的下载）。
 *
 * 只列 `Assets/` 下的文件（项目文件与 `.gitkeep` 不算资源）。
 */
export async function getManifestRoute(ctx: RouteContext): Promise<void> {
  const project = queryTrimmed(ctx.url, "project");
  if (project.length === 0) {
    throw badRequest("缺少 project 参数");
  }

  try {
    const manifest = await readProjectManifest(ctx.provider, project);
    sendJson(ctx.response, 200, {
      project: manifest.project,
      fingerprint: manifest.fingerprint,
      bytes: manifest.bytes,
      fileCount: manifest.entries.length,
      files: manifest.entries,
    });
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      throw new HttpError(404, error.message);
    }

    throw error;
  }
}

/**
 * `GET /api/resources/bundle?project=&v=<指纹>`：项目资源包（整包 zip）。
 *
 * `v` 是客户端说「我本地已经是这一版」——指纹没变就回 **304**，
 * 省掉一次几十 MB 的传输；变了才回整包（打包与缓存见 `BundleCache`）。
 */
export async function getBundleRoute(ctx: RouteContext): Promise<void> {
  const project = queryTrimmed(ctx.url, "project");
  if (project.length === 0) {
    throw badRequest("缺少 project 参数");
  }

  const known = queryRaw(ctx.url, "v");

  try {
    const current = await readProjectManifest(ctx.provider, project);
    if (known.length > 0 && known === current.fingerprint) {
      sendEmpty(ctx.response, 304, {
        "x-dts-project": encodeURIComponent(project),
        "x-dts-fingerprint": current.fingerprint,
      });
      return;
    }

    const cached = await ctx.bundles.get(
      ctx.provider,
      project,
      current,
      ctx.config.app.bundle.maxTotalBytes,
    );
    sendBytes(ctx.response, 200, "application/zip", cached.zip, cached.headers);
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      throw new HttpError(404, error.message);
    }

    if (error instanceof BundleTooLargeError) {
      throw new HttpError(413, error.message);
    }

    throw error;
  }
}

/** `POST /api/resources/rename`：重命名资源（两侧同类别；**绝不覆盖**已有目标）。 */
export async function renameResourceRoute(ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(ctx.request);
  const from = bodyTrimmed(body, "from");
  const to = bodyTrimmed(body, "to");
  if (from.length === 0 || to.length === 0) {
    throw badRequest("缺少 from / to 参数");
  }

  try {
    // 类别不同 / 源不存在 / 目标已存在都由 provider 抛错，原样转成 400
    await ctx.provider.rename(from, to);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : String(error));
  }

  ctx.log("info", `资源已重命名: ${from} → ${to}`);
  sendJson(ctx.response, 200, { ok: true, id: to });
}
