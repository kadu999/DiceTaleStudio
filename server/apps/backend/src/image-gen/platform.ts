import type { AppConfig } from "@dts/resources";
import sharp from "sharp";
import { messageOf } from "../values";
import { loadProviders } from "./providers";
import type { ImageInput, ImageProvider, ImageRequest } from "./providers/types";

/**
 * AI 生图**平台解析 + 出网 + 后处理**。
 *
 * 平台本身是**一个文件一个平台**（`providers/*.ts`，接口见 `providers/types.ts`），
 * 后端启动时自动发现。本文件只做三件事：
 * 1. **选平台**：`DTS_IMAGE_PLATFORM` 或 `imageGen.default` 选中 provider，再用环境变量 / 配置
 *    取它的**地址 / 模型 / 密钥**（部署参数，只在配置里）；尺寸 / 超时 / 额外字段则平台默认 + 配置覆盖；
 * 2. **出网**：调 provider 拼出的请求体，读它的响应；
 * 3. **后处理**：出图统一转 **PNG**，需要时抠掉纯色背景。
 *
 * 密钥只在服务端：环境变量优先，其次配置——它只出现在这里发出去的 `authorization` 头里，
 * **永不回显**给客户端。
 */

/** 解析好的、这一次要用的全部设置。 */
export interface ImageGenSettings {
  /** 平台名（日志与「没配密钥」提示里用得上）。 */
  readonly platform: string;
  /** 给人看的平台名（界面 / 日志）。 */
  readonly label: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly size: string;
  readonly sizes: readonly string[];
  readonly timeoutMs: number;
  readonly extraBody: Record<string, unknown>;
  /** 平台适配器（请求体 / 取图 / 尺寸形状）。 */
  readonly provider: ImageProvider;
}

/** 一张生成好的图（字节 + MIME；尺寸由调用方按需再读）。 */
export interface GeneratedImageBytes {
  readonly data: Buffer;
  readonly mime: string;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * 挑出这次要用的平台并叠加环境变量覆盖。
 *
 * 平台由 `DTS_IMAGE_PLATFORM` 或 `imageGen.default` 决定；平台不存在时回落到第一个
 * （这样配错一个名字也只是「用了别的平台」，而不是整个功能不可用）。
 */
export async function resolveImageGenSettings(app: AppConfig): Promise<ImageGenSettings> {
  const providers = await loadProviders();
  const fallback = providers[0];
  if (fallback === undefined) {
    throw new Error("没有可用的生图平台（apps/backend/src/image-gen/providers/ 为空）");
  }

  const requested = env("DTS_IMAGE_PLATFORM") ?? app.imageGen.default;
  const provider = providers.find((item) => item.id === requested) ?? fallback;
  const override = app.imageGen.platforms[provider.id];

  const keyEnv = override?.apiKeyEnv ?? provider.apiKeyEnv;
  return {
    platform: provider.id,
    label: provider.label,
    // 地址与模型是部署参数：只从配置（或环境变量）来，平台文件里不写死
    baseUrl: env("DTS_IMAGE_API_BASE") ?? override?.baseUrl ?? "",
    apiKey: env(keyEnv) ?? env("DTS_IMAGE_API_KEY") ?? override?.apiKey ?? "",
    model: env("DTS_IMAGE_MODEL") ?? override?.model ?? "",
    size: override?.size ?? provider.defaults.size,
    sizes: override?.sizes ?? provider.defaults.sizes,
    timeoutMs: override?.timeoutMs ?? provider.defaults.timeoutMs,
    // 平台的额外字段是默认值，配置里的同名字段覆盖它（合并而非替换）
    extraBody: { ...provider.defaults.extraBody, ...override?.extraBody },
    provider,
  };
}

/**
 * 还缺哪些必填项（给「还没配好」的错误提示用）：地址 / 模型 / 密钥。
 */
export function imageGenMissing(settings: ImageGenSettings): string[] {
  const missing: string[] = [];
  if (settings.baseUrl.trim().length === 0) {
    missing.push("baseUrl");
  }

  if (settings.model.trim().length === 0) {
    missing.push("model");
  }

  if (settings.apiKey.trim().length === 0) {
    missing.push(`apiKey（或设环境变量 ${settings.provider.apiKeyEnv}）`);
  }

  return missing;
}

/**
 * 配好了没有（没配 = 那个接口明确回 400，而不是发一个注定 401 的请求）。
 *
 * 三样齐了才算配好：**密钥**（`apiKey`）、**地址**（`baseUrl`）、**模型**（`model`）。
 * 地址与模型现在只在配置里给，所以「忘了填」时会在这里被挡下，而不是等到出网才 400 / 404。
 */
export function imageGenConfigured(settings: ImageGenSettings): boolean {
  return imageGenMissing(settings).length === 0;
}

/** 尺寸形状按**平台**判断（`2K` 这种档位只有部分平台认）。 */
export function isSizeAccepted(settings: ImageGenSettings, size: string): boolean {
  return settings.provider.acceptsSize(size);
}

/** 这个平台支不支持图生图 / 修图。 */
export function imageGenSupportsEdit(settings: ImageGenSettings): boolean {
  return settings.provider.supportsEdit;
}

/** 这个平台支不支持蒙版局部重绘。 */
export function imageGenSupportsMask(settings: ImageGenSettings): boolean {
  return settings.provider.supportsMask;
}

/**
 * 让生图平台画一张，返回图片字节（**PNG**）。
 *
 * - 没有 `inputImages` = **文生图**；
 * - 有 `inputImages` = **图生图 / 修图**（1 张 = 待编辑 / 多张 = 垫图参考）；
 * - 再有 `mask` = **蒙版局部重绘**（平台需声明 `supportsMask`）。
 * 失败一律抛 `Error`（消息是**给人看的**：连不上 / 供应商回的原文截断 300 字），
 * 由路由翻成 502——调用方不需要认识 HTTP 细节。
 */
export async function generateImage(
  settings: ImageGenSettings,
  prompt: string,
  size: string,
  removeBackground: boolean,
  inputImages: readonly ImageInput[] = [],
  mask?: ImageInput,
): Promise<GeneratedImageBytes> {
  const request = settings.provider.buildRequest({
    prompt,
    size,
    model: settings.model,
    extraBody: settings.extraBody,
    images: inputImages,
    ...(mask === undefined ? {} : { mask }),
  });
  const url = `${settings.baseUrl.replace(/\/+$/, "")}${request.endpoint}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        // multipart 的 content-type 要留给 fetch 自己带（含 boundary）
        ...(request.kind === "json" ? { "content-type": "application/json" } : {}),
        ...(settings.apiKey.length === 0 ? {} : { authorization: `Bearer ${settings.apiKey}` }),
      },
      body: request.kind === "json" ? JSON.stringify(request.body) : buildFormData(request),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch (error) {
    // 网络/超时：把地址写出来（不含密钥），否则「没反应」时无从查起
    throw new Error(`连不上生图接口（${settings.label} · ${url}）：${messageOf(error)}`, {
      cause: error,
    });
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`生图接口返回 ${response.status}：${shorten(text)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`生图接口返回的不是 JSON：${shorten(text)}`);
  }

  const entry = settings.provider.parseImage(payload);
  if (entry === undefined) {
    throw new Error(`生图接口没返回图片：${shorten(text)}`);
  }

  const raw =
    entry.base64 !== undefined
      ? Buffer.from(entry.base64, "base64")
      : await downloadImage(entry.url!, settings.timeoutMs);

  return normalizeToPng(raw, removeBackground);
}

/** 一个 multipart 请求 → `FormData`（文本字段在前，文件字段在后）。 */
function buildFormData(
  request: Extract<ImageRequest, { kind: "multipart" }>,
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(request.fields)) {
    form.append(key, value);
  }

  for (const file of request.files) {
    // `Buffer` 底层可能是 `SharedArrayBuffer`，用精确切片后的 ArrayBuffer 让类型与运行时都稳
    const bytes = file.data.buffer.slice(
      file.data.byteOffset,
      file.data.byteOffset + file.data.byteLength,
    ) as ArrayBuffer;
    form.append(file.field, new Blob([bytes], { type: file.mime }), file.filename);
  }

  return form;
}

/**
 * 统一成 **PNG**。
 *
 * 各家回来的格式不一（火山 Seedream 回 JPEG、有的回 WebP），而项目里生成的素材一律按
 * `.png` 落盘、贴图也按 PNG 用——所以这里用 sharp 转一次码，顺带把方向（EXIF）摆正。
 * 需要抠背景时，再走一遍 `removeBackgroundToPng`（只对**纯色**背景有效）。
 */
async function normalizeToPng(raw: Buffer, removeBackground: boolean): Promise<GeneratedImageBytes> {
  try {
    const png = await sharp(raw, { limitInputPixels: 100_000_000 }).rotate().png().toBuffer();
    if (!removeBackground) {
      return { data: png, mime: "image/png" };
    }

    return await removeBackgroundToPng(png);
  } catch (error) {
    // 转码失败也要有话说：把原字节回给上层没有意义（后缀写的是 .png）
    throw new Error(`生成的图片无法转成 PNG：${messageOf(error)}`, { cause: error });
  }
}

/**
 * 抠掉**纯色**背景，输出带 alpha 的 PNG。
 *
 * 用的是「取四角的主色 → 按容差设透明」这套通用做法（适合生成素材常见的一色背景），
 * 不做按边缘洪水填充（那会把主体内部同色的洞也挖掉）。容差默认 16（0–255）。
 * 这不是发丝级的抠图，但对「角色 / 道具贴图」这类用途够用，且**零额外依赖**。
 */
export async function removeBackgroundToPng(png: Buffer, tolerance = 16): Promise<GeneratedImageBytes> {
  const { data, info } = await sharp(png, { limitInputPixels: 100_000_000 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const background = dominantCornerColor(data, width, height, channels);

  const out = Buffer.from(data); // 拷一份再改，免得动到 sharp 的缓冲
  for (let i = 0; i < out.length; i += channels) {
    const dr = out[i]! - background.r;
    const dg = out[i + 1]! - background.g;
    const db = out[i + 2]! - background.b;
    // 与背景色的欧氏距离落在容差内 → 设为透明
    if (Math.sqrt(dr * dr + dg * dg + db * db) <= tolerance) {
      out[i + 3] = 0;
    }
  }

  const result = await sharp(out, { raw: { width, height, channels } }).png().toBuffer();
  return { data: result, mime: "image/png" };
}

/** 取四角像素的众数当背景色（生成图背景一般在角上）。 */
function dominantCornerColor(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
): { r: number; g: number; b: number } {
  const corners: Array<[number, number]> = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];

  const counts = new Map<string, { r: number; g: number; b: number; n: number }>();
  for (const [x, y] of corners) {
    const i = (y * width + x) * channels;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const key = `${String(r)},${String(g)},${String(b)}`;
    const found = counts.get(key);
    if (found === undefined) {
      counts.set(key, { r, g, b, n: 1 });
    } else {
      found.n += 1;
    }
  }

  let best = { r: 0, g: 0, b: 0, n: -1 };
  for (const value of counts.values()) {
    if (value.n > best.n) {
      best = value;
    }
  }

  return best;
}

/** 只有 `url` 的供应商：再下载一次（图片地址通常是有时效的签名链接）。 */
async function downloadImage(url: string, timeoutMs: number): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`下载生成的图片失败：${messageOf(error)}`, { cause: error });
  }

  if (!response.ok) {
    throw new Error(`下载生成的图片失败：${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/** 供应商的原话只留开头一段：够定位问题，又不至于把几 KB 的 HTML 错误页灌进日志与界面。 */
function shorten(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 300 ? trimmed : `${trimmed.slice(0, 300)}…`;
}
