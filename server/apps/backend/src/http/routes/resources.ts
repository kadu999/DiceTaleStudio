import { RESOURCE_KINDS, parseResourceId, type ResourceKind } from "@dts/resources";
import sharp from "sharp";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { messageOf, toArrayBuffer } from "../../values";
import {
  BundleTooLargeError,
  ProjectNotFoundError,
  readProjectManifest,
} from "../../resources/bundle";
import { contentTypeFor } from "../mime";
import { bodyTrimmed, queryRaw, queryTrimmed, readBody, readJsonBody } from "../requests";
import { HttpError, badRequest, rethrowProviderError, sendBytes, sendEmpty, sendJson, sendText } from "../responses";
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
  // 不传 / 空串 = 列全部；传了必须是已知类别（未知值明确报 400，而不是让 provider 抛 500）
  const kind = parseResourceKind(ctx.url.searchParams.get("kind"));
  const entries = await ctx.provider.list(kind);
  sendJson(ctx.response, 200, { entries });
}

/** `?kind=` → 资源类别：空（不传 / 空串）= 全部；未知值抛 400。 */
function parseResourceKind(raw: string | null): ResourceKind | undefined {
  if (raw === null || raw.length === 0) {
    return undefined;
  }

  if (!RESOURCE_KINDS.includes(raw as ResourceKind)) {
    throw badRequest(`未知资源类别: ${raw}（合法值：${RESOURCE_KINDS.join(", ")}）`);
  }

  return raw as ResourceKind;
}

/** 取 `?id=`；缺失或空串时抛 400（三个 raw/text 处理器共用的第一道校验）。 */
function requireId(ctx: RouteContext): string {
  const id = ctx.url.searchParams.get("id");
  if (id === null || id.length === 0) {
    throw badRequest("缺少 id 参数");
  }

  return id;
}

/** 校验逻辑 ID 合法（非法 → 400）：写 / 删路径不经过 `exists` 的容错，不能冒泡成 500。 */
function assertResourceId(id: string): void {
  try {
    parseResourceId(id);
  } catch (error) {
    throw badRequest(messageOf(error));
  }
}

/** 读路径的存在性校验（不存在 → 404）：三个 raw/text/thumbnail 处理器共用。 */
async function requireExisting(ctx: RouteContext, id: string): Promise<void> {
  if (!(await ctx.provider.exists(id))) {
    throw new HttpError(404, `资源不存在: ${id}`);
  }
}

/** 请求体上限（字节），来自 app 配置；读 body 之前先取好。 */
function maxBodyBytes(ctx: RouteContext): number {
  return ctx.config.app.http.maxBodyBytes;
}

/** `GET /api/resources/raw?id=`：读原始字节，Content-Type 按扩展名给。 */
export async function readResourceRoute(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx);

  await requireExisting(ctx, id);

  const data = await ctx.provider.readBinary(id);
  sendBytes(ctx.response, 200, contentTypeFor(parseResourceId(id).path), Buffer.from(data));
}

/** `GET /api/resources/thumbnail?id=`: 按需生成并缓存小型 WebP，避免资源选择器下载原图。 */
export async function readResourceThumbnailRoute(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx);
  await requireExisting(ctx, id);

  const resourcePath = parseResourceId(id).path;
  const extension = extname(resourcePath).toLowerCase();
  const isVideo = contentTypeFor(resourcePath).startsWith("video/");
  const source = Buffer.from(await ctx.provider.readBinary(id));
  if (ctx.url.searchParams.get("info") === "1") {
    // 视频：用已有的 ffmpeg 抽首帧能力探测宽高。视频混合的 Mask 窗口要给遮罩定长宽比，
    // 而编辑器又不解码视频——这是它拿到「视频像素尺寸」的正路（与缩略图同一份抽帧实现）。
    if (isVideo) {
      try {
        const frame = await extractVideoFrame(source, extension);
        const metadata = await sharp(frame, { limitInputPixels: 100_000_000 }).metadata();
        if (metadata.width === undefined || metadata.height === undefined) {
          throw new Error("Video dimensions are missing");
        }
        const dimensions = metadata.autoOrient ?? { width: metadata.width, height: metadata.height };
        sendJson(ctx.response, 200, { width: dimensions.width, height: dimensions.height });
        return;
      } catch (error) {
        // 原因只写日志（ffmpeg 的原话里带着临时目录路径），**不回显给客户端**——与审核 B25 同一条口径
        ctx.log("warn", `读取视频尺寸失败: ${id}（${messageOf(error)}）`);
        throw badRequest("无法读取视频尺寸（需要 ffmpeg 在 PATH 里，或这条视频解不出来）");
      }
    }

    try {
      const metadata = await sharp(source, { limitInputPixels: 100_000_000 }).metadata();
      if (metadata.width === undefined || metadata.height === undefined) {
        throw new Error("Image dimensions are missing");
      }
      const dimensions = metadata.autoOrient ?? { width: metadata.width, height: metadata.height };
      sendJson(ctx.response, 200, { width: dimensions.width, height: dimensions.height });
      return;
    } catch (error) {
      ctx.log("warn", `读取图片尺寸失败: ${id}（${messageOf(error)}）`);
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
      job = createThumbnail(source, md5, isVideo, extension);
      thumbnailJobs.set(jobKey, job);
    }

    try {
      thumbnail = await job;
      thumbnailCache.set(id, thumbnail);
      if (thumbnailCache.size > THUMBNAIL_CACHE_MAX_ENTRIES) {
        const oldest = thumbnailCache.keys().next().value;
        if (oldest !== undefined) thumbnailCache.delete(oldest);
      }
    } catch (error) {
      ctx.log("warn", `缩略图生成失败: ${id}（${messageOf(error)}）`);
      throw badRequest(
        isVideo ? "无法生成视频缩略图（需要 ffmpeg 在 PATH 里，或这条视频解不出来）" : "无法读取图片",
      );
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

async function createThumbnail(
  source: Buffer,
  md5: string,
  isVideo: boolean,
  extension: string,
): Promise<CachedThumbnail> {
  // 视频（mp4/webm）：先用 ffmpeg 抽首帧再走同一条 sharp 管线；缓存 / 尺寸头 / 失效逻辑与图片一致
  const frame = isVideo ? await extractVideoFrame(source, extension) : source;
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
 * 用 ffmpeg 从视频里抽首帧（PNG）。
 *
 * **必须落一个临时文件、让 ffmpeg 读文件**——不能把字节喂 `pipe:0`：
 * `moov` 在文件尾的 MP4（非 faststart，手机与剪辑软件的默认导出形态）要 demuxer **回退 seek**
 * 才读得到采样表，而管道**不可 seek**，这类视频一律抽不出首帧
 * （实测 `测试项目` 6 条里 5 条栽在这，缩略图与 `?info=1` 一起废）。
 * 小文件看不出问题：不到 ffmpeg 的 IO 缓冲（32KB）时整份都在缓冲里，管道也读得动——
 * 夹具 `clip.mp4` 只有 1.9KB，所以这个坑一直没被测试逮住。
 *
 * 临时目录用完即删（`finally`；删不掉就留给系统回收，不覆盖真正的失败原因）。
 * ffmpeg 不在 PATH / 解码失败都抛错——上层转成 400，前端行内图标降级成公用图标。
 */
async function extractVideoFrame(source: Buffer, extension: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "dts-video-"));
  // 后缀照原样带过去：ffmpeg 主要靠内容探测，但少数容器认后缀
  const file = join(dir, `input${extension.length > 0 ? extension : ".mp4"}`);
  try {
    await writeFile(file, source);
    return await runFfmpegFrame(file);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 让 ffmpeg 从**文件**里抽首帧（PNG 仍从 stdout 收）。
 *
 * 文件是可 seek 的，所以 `moov` 在尾部也能读到采样表——这正是上面那份临时文件的理由。
 * 同步收 stdout/stderr；退出码非 0 或没抽到帧都抛错（错误文本 = ffmpeg 的原话）。
 */
function runFfmpegFrame(file: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"] },
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
  });
}

/** `PUT|POST /api/resources/raw?id=`：写原始字节（请求体就是文件内容，不解析 JSON）。 */
export async function writeResourceRoute(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx);
  assertResourceId(id);

  const body = await readBody(ctx.request, maxBodyBytes(ctx));
  const payload = toArrayBuffer(body);
  await ctx.provider.writeBinary(id, payload);
  ctx.log("info", `资源已写入: ${id}（${body.byteLength} 字节）`);
  sendJson(ctx.response, 200, { ok: true, id, size: body.byteLength });
}

/** `DELETE /api/resources/raw?id=`：删资源（对目录是递归语义）。 */
export async function deleteResourceRoute(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx);
  assertResourceId(id);

  await ctx.provider.remove(id);
  ctx.log("info", `资源已删除: ${id}`);
  sendJson(ctx.response, 200, { ok: true, id });
}

/** `GET /api/resources/text?id=`：读文本（场景 / 工程文件都是它）。 */
export async function readResourceTextRoute(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx);

  await requireExisting(ctx, id);

  sendText(ctx.response, 200, await ctx.provider.readText(id));
}

/** `PUT|POST /api/resources/text?id=`：写文本（UTF-8，内容原样落盘）。 */
export async function writeResourceTextRoute(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx);
  assertResourceId(id);

  const body = await readBody(ctx.request, maxBodyBytes(ctx));
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
  const body = await readJsonBody(ctx.request, maxBodyBytes(ctx));
  const from = bodyTrimmed(body, "from");
  const to = bodyTrimmed(body, "to");
  if (from.length === 0 || to.length === 0) {
    throw badRequest("缺少 from / to 参数");
  }

  try {
    // 类别不同 / 源不存在 / 目标已存在都由 provider 抛错：业务错误转 400，系统错误冒泡成 500
    await ctx.provider.rename(from, to);
  } catch (error) {
    rethrowProviderError(error);
  }

  ctx.log("info", `资源已重命名: ${from} → ${to}`);
  sendJson(ctx.response, 200, { ok: true, id: to });
}
