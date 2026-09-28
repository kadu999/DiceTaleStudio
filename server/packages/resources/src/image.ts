/**
 * 输入图片的格式知识（**唯一归属地**）：图生图 / 修图要把「项目里的一份图」喂给平台，
 * 需要知道它的 MIME。放这里，编辑器 / 后端共用一套，不各写一份。
 *
 * 刻意不引 `node:path`：这个包要在浏览器侧（编辑器）也能用。
 */

/** 支持的输入图格式：扩展名 → MIME。 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** 图片路径 → MIME（按扩展名猜；认不出返回 undefined = 这个格式不支持做输入图）。 */
export function imageMimeForPath(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0) {
    return undefined;
  }

  return MIME_BY_EXTENSION[path.slice(dot + 1).toLowerCase()];
}
