import type { AssetImporter } from "@dts/document";
import { PROJECT_FOLDERS, PROJECT_SCENE_FILE_EXTENSION } from "@dts/resources";

/**
 * 资源文件的展示辅助（资源面板与属性面板共用）。
 *
 * 只做「按扩展名判断怎么显示」这一件事：不再往 resources 包塞 UI 概念，
 * 也不在编辑器里散落扩展名判断。
 */

const IMAGE_SUFFIXES = [".png", ".jpg", ".jpeg", ".webp", ".gif"] as const;
const VIDEO_SUFFIXES = [".mp4", ".webm"] as const;
const AUDIO_SUFFIXES = [".mp3", ".wav", ".ogg"] as const;
const TEXT_SUFFIXES = new Set([".json", ".txt", ".md", ".csv"]);

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

/**
 * 文件的扩展名（小写，带点）；没有扩展名返回空串。
 *
 * 导出是因为**图标**也要按同一份后缀表判断类型——它和预览 / 类型名必须认同一套规则，
 * 否则会出现「类型写着 PNG 图片、图标却是通用文件」这种自相矛盾。
 */
export function assetSuffix(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot <= 0 ? "" : fileName.slice(dot).toLowerCase();
}

/** 资源行图标的种类（未知扩展名归入 `file`）。 */
export type AssetIconKind = "image" | "video" | "audio" | "text" | "scene" | "file";

/**
 * 图标种类：图片 / 视频 / 音频 / 文本 / 场景 / 通用文件。
 *
 * 和 `assetPreviewKind` 一样**只看文件名**（不看路径）：`.json` 就是「场景」那一格的图标，
 * 因为项目里 `.json` 目前只有场景文件（`project.json` 不进资源树，见 `PROJECT_SPECIAL_FILES`）。
 * 「这一行点下去是打开场景还是看属性」由面板按路径判定（见 `AssetsPanel` 的 `sceneNameOf`）。
 */
export function assetIconKind(fileName: string): AssetIconKind {
  const suffix = assetSuffix(fileName);

  if ((IMAGE_SUFFIXES as readonly string[]).includes(suffix)) {
    return "image";
  }

  if ((VIDEO_SUFFIXES as readonly string[]).includes(suffix)) {
    return "video";
  }

  if ((AUDIO_SUFFIXES as readonly string[]).includes(suffix)) {
    return "audio";
  }

  if (suffix === PROJECT_SCENE_FILE_EXTENSION) {
    return "scene";
  }

  if (TEXT_SUFFIXES.has(suffix)) {
    return "text";
  }

  return "file";
}

/**
 * 这个素材该配哪种 meta 导入器（`<素材>.meta` 的 `importer`）；`undefined` = **不给它生成 meta**
 * （项目里只有图片 / 音频 / 视频 / 场景这四种素材）。
 *
 * `path` 是**项目内相对路径**（`Assets/audio/x.mp3`，与资源树节点上的 `path` 同口径）。
 * 后缀那一半与 `assetIconKind` 共用同一张表：同一个文件不能这边算「图片」、那边算「文件」，
 * 否则会出现「有图标、没 meta」这种谁也说不清的状态。
 *
 * `.json` 必须落在 **`Assets/scenes/`** 里才算场景：那个目录之外的 `.json`（该项目自己的配置）
 * 是配置而不是素材，不配 meta。图标那一层按扩展名一律画成「场景」，所以这里比它严一档。
 */
export function assetImporterKind(path: string): AssetImporter | undefined {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  switch (assetIconKind(fileName)) {
    case "image":
      return "texture";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "scene":
      return path.startsWith(`${PROJECT_FOLDERS.scenes}/`) ? "scene" : undefined;
    default:
      return undefined;
  }
}

/** 能不能在属性面板里预览，以及用哪种元素预览。 */
export function assetPreviewKind(fileName: string): "image" | "video" | "audio" | null {
  const suffix = assetSuffix(fileName);
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
  return KIND_LABELS[assetSuffix(fileName)] ?? "文件";
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
