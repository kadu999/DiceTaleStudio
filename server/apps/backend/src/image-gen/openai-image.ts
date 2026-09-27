import type { AppConfig } from "@dts/resources";
import { messageOf } from "../values";

/**
 * AI 生图客户端：**OpenAI 兼容**的 `POST {baseUrl}/images/generations`。
 *
 * 为什么是这一家：这一套是事实标准（OpenAI 官方、以及国内外大多数聚合 / 中转服务都吃它），
 * 换供应商只改配置（`imageGen.baseUrl` / `model`）——代码不认任何一家的专有字段。
 *
 * 三条刻意的取舍：
 * 1. **不发 `response_format`**：`gpt-image-1` 不认这个参数（发过去直接 400），而 Dall·E 系
 *    默认就回 `url`。所以两个形状都收：有 `b64_json` 就用它，只有 `url` 就再去下载一次。
 * 2. **密钥只在服务端**：环境变量优先、配置兜底（见 `resolveImageGenSettings`），
 *    它只出现在这一层发出去的 `authorization` 头里，**永不回显**给客户端。
 * 3. 超时用一次性的 `AbortSignal.timeout`：出图是几十秒级的事，没有超时会把连接吊死。
 */

export interface ImageGenSettings {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly size: string;
  readonly timeoutMs: number;
}

/** 一张生成好的图（字节 + MIME；尺寸由调用方按需再读）。 */
export interface GeneratedImageBytes {
  readonly data: Buffer;
  readonly mime: string;
}

/**
 * 环境变量优先、配置兜底。
 *
 * 密钥与地址**只在服务端**（浏览器那一侧拿到的是「生成好的项目素材 ID」，不是这些）。
 * `size` / `timeoutMs` 留配置一份就够：它们不是秘密，也不常改。
 */
export function resolveImageGenSettings(app: AppConfig): ImageGenSettings {
  const env = (name: string): string | undefined => {
    const value = process.env[name];
    return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
  };

  return {
    baseUrl: env("DTS_IMAGE_API_BASE") ?? app.imageGen.baseUrl,
    apiKey: env("DTS_IMAGE_API_KEY") ?? app.imageGen.apiKey,
    model: env("DTS_IMAGE_MODEL") ?? app.imageGen.model,
    size: app.imageGen.size,
    timeoutMs: app.imageGen.timeoutMs,
  };
}

/** 配好了没有（没配 = 那个接口明确回 400，而不是发一个注定 401 的请求）。 */
export function imageGenConfigured(settings: ImageGenSettings): boolean {
  return settings.apiKey.trim().length > 0;
}

/**
 * 让生图接口画一张，返回图片字节。
 *
 * 失败一律抛 `Error`（消息是**给人看的**：连不上 / 供应商回的原文截断 300 字），
 * 由路由翻成 502——调用方不需要认识 HTTP 细节。
 */
export async function generateImage(
  settings: ImageGenSettings,
  prompt: string,
  size: string,
): Promise<GeneratedImageBytes> {
  const url = `${settings.baseUrl.replace(/\/+$/, "")}/images/generations`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(settings.apiKey.length === 0 ? {} : { authorization: `Bearer ${settings.apiKey}` }),
      },
      body: JSON.stringify({ model: settings.model, prompt, size, n: 1 }),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch (error) {
    // 网络/超时：把地址写出来（不含密钥），否则「没反应」时无从查起
    throw new Error(`连不上生图接口（${url}）：${messageOf(error)}`, { cause: error });
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

  const entry = firstImageEntry(payload);
  if (entry === undefined) {
    throw new Error(`生图接口没返回图片：${shorten(text)}`);
  }

  if (entry.b64Json !== undefined) {
    return { data: Buffer.from(entry.b64Json, "base64"), mime: mimeForUrl(entry.url) };
  }

  return downloadImage(entry.url!, settings.timeoutMs);
}

/** 取 `data[0]` 里的图片：`b64_json` 优先，其次 `url`。 */
function firstImageEntry(payload: unknown): { b64Json?: string; url?: string } | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) {
    return undefined;
  }

  const first: unknown = data[0];
  if (typeof first !== "object" || first === null) {
    return undefined;
  }

  const b64Json = (first as { b64_json?: unknown }).b64_json;
  const url = (first as { url?: unknown }).url;
  const hasB64 = typeof b64Json === "string" && b64Json.length > 0;
  const hasUrl = typeof url === "string" && url.length > 0;
  if (!hasB64 && !hasUrl) {
    return undefined;
  }

  return {
    ...(hasB64 ? { b64Json: b64Json as string } : {}),
    ...(hasUrl ? { url: url as string } : {}),
  };
}

/** 只有 `url` 的供应商：再下载一次（图片地址通常是有时效的签名链接）。 */
async function downloadImage(url: string, timeoutMs: number): Promise<GeneratedImageBytes> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`下载生成的图片失败：${messageOf(error)}`, { cause: error });
  }

  if (!response.ok) {
    throw new Error(`下载生成的图片失败：${response.status} ${response.statusText}`);
  }

  return {
    data: Buffer.from(await response.arrayBuffer()),
    mime: mimeForUrl(url),
  };
}

/** MIME 按 URL 后缀猜；认不出来一律当 PNG（生图默认就是 PNG）。 */
function mimeForUrl(url: string | undefined): string {
  const lower = (url ?? "").toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

/** 供应商的原话只留开头一段：够定位问题，又不至于把几 KB 的 HTML 错误页灌进日志与界面。 */
function shorten(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 300 ? trimmed : `${trimmed.slice(0, 300)}…`;
}
