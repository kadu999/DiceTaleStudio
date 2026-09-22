import { extname } from "node:path";

/**
 * 扩展名 → Content-Type。
 *
 * 只列**这个项目真的会出现**的类型：编辑器产物（html/js/css/svg/woff2）、
 * 资源素材（png/jpg/webp/gif/mp3/ogg/wav/mp4/webm/ico）、数据（json/txt/bytes）。
 */
export const MIME_TYPES: Readonly<Record<string, string>> = {
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

/** 按扩展名查 Content-Type；认不出的一律当二进制流（浏览器会去下载而不是当脚本执行）。 */
export function contentTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}
