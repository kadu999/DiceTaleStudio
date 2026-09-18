/**
 * 资源文件的展示辅助（资源面板与属性面板共用）。
 *
 * 只做「按扩展名判断怎么显示」这一件事：不再往 resources 包塞 UI 概念，
 * 也不在编辑器里散落扩展名判断。
 */

const IMAGE_SUFFIXES = [".png", ".jpg", ".jpeg", ".webp", ".gif"] as const;
const VIDEO_SUFFIXES = [".mp4", ".webm"] as const;
const AUDIO_SUFFIXES = [".mp3", ".wav", ".ogg"] as const;

const KIND_LABELS: Record<string, string> = {
  ".png": "PNG 图片",
  ".jpg": "JPEG 图片",
  ".jpeg": "JPEG 图片",
  ".webp": "WebP 图片",
  ".gif": "GIF 图片",
  ".mp4": "MP4 视频",
  ".webm": "WebM 视频",
  ".mp3": "MP3 音频",
  ".wav": "WAV 音频",
  ".ogg": "OGG 音频",
  ".json": "JSON",
  ".txt": "文本",
  ".md": "Markdown",
};

function suffixOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot <= 0 ? "" : fileName.slice(dot).toLowerCase();
}

/** 能不能在属性面板里预览，以及用哪种元素预览。 */
export function assetPreviewKind(fileName: string): "image" | "video" | "audio" | null {
  const suffix = suffixOf(fileName);
  if ((IMAGE_SUFFIXES as readonly string[]).includes(suffix)) {
    return "image";
  }

  if ((VIDEO_SUFFIXES as readonly string[]).includes(suffix)) {
    return "video";
  }

  if ((AUDIO_SUFFIXES as readonly string[]).includes(suffix)) {
    return "audio";
  }

  return null;
}

/** 人类可读的资源类型（认不出就给「文件」）。 */
export function assetKindLabel(fileName: string): string {
  return KIND_LABELS[suffixOf(fileName)] ?? "文件";
}

/**
 * 目录里显示的名字：**不带扩展名**（`Map001.png` → `Map001`）。
 * 完整文件名在属性面板里看得到，列表里省掉扩展名更清爽。
 */
export function assetDisplayName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot <= 0 ? fileName : fileName.slice(0, dot);
}

/** 字节数 → 可读大小。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
