import { assetMetaPathOf, normalizePath, parseResourceId, type ResourceKind } from "./ids";

function ownsAssetMeta(kind: ResourceKind, path: string): boolean {
  if (kind !== "project") {
    return false;
  }

  const normalized = normalizePath(path);
  return assetRelativePath(normalized) !== undefined && !normalized.endsWith(".meta");
}

function assetMetaPathFor(kind: ResourceKind, path: string): string | undefined {
  return ownsAssetMeta(kind, path) ? assetMetaPathOf(path) : undefined;
}

export function assetFolderPathsFor(kind: ResourceKind, path: string): string[] {
  if (kind !== "project") {
    return [];
  }

  const segments = normalizePath(path).split("/");
  const assetsIndex = segments.indexOf("Assets");
  if (assetsIndex < 0) {
    return [];
  }

  return segments.slice(assetsIndex).map((_, index) => segments.slice(0, assetsIndex + index + 1).join("/"));
}

export type AssetImporter = "texture" | "audio" | "video" | "scene" | "prefab";

function assetImporterForPath(path: string): AssetImporter | undefined {
  const normalized = assetRelativePath(path)?.toLowerCase();
  if (normalized === undefined) {
    return undefined;
  }

  if (normalized.endsWith(".meta") || normalized === "assets/project.json") {
    return undefined;
  }

  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].some((suffix) => normalized.endsWith(suffix))) {
    return "texture";
  }

  if ([".mp3", ".wav", ".ogg"].some((suffix) => normalized.endsWith(suffix))) {
    return "audio";
  }

  if ([".mp4", ".webm"].some((suffix) => normalized.endsWith(suffix))) {
    return "video";
  }

  if (normalized.endsWith(".prefab")) {
    return "prefab";
  }

  return normalized.startsWith("scenes/") && normalized.endsWith(".json") ? "scene" : undefined;
}

export function assetMetaIdFor(id: string): string | undefined {
  const parsed = parseResourceId(id);
  const path = assetMetaPathFor(parsed.kind, parsed.path);
  return path === undefined ? undefined : `${parsed.kind}:${path}`;
}

/**
 * 重命名前的四处校验（内存 / 文件系统两个 provider 逐字同一套，错误消息也一致）：
 * 类别一致 → 源存在 → 目标不存在 → 双方的 meta 目标不撞车。
 *
 * 纯逻辑：调用方各自传入「存在与否」的判定结果（内存查表、文件系统 stat），这里不碰 IO。
 * **绝不覆盖用户数据**：任何一项不满足都抛错，调用方在抛错前不做任何写动作。
 */
export function assertRenameAllowed(input: {
  readonly fromId: string;
  readonly toId: string;
  readonly fromKind: ResourceKind;
  readonly toKind: ResourceKind;
  readonly fromExists: boolean;
  readonly toExists: boolean;
  readonly fromMetaId: string | undefined;
  readonly toMetaId: string | undefined;
  readonly fromMetaExists: boolean;
  readonly toMetaExists: boolean;
}): void {
  if (input.fromKind !== input.toKind) {
    throw new Error(`重命名两端类别必须一致: ${input.fromId} → ${input.toId}`);
  }

  if (!input.fromExists) {
    throw new Error(`资源不存在: ${input.fromId}`);
  }

  if (input.toExists) {
    throw new Error(`资源已存在: ${input.toId}`);
  }

  if (
    input.fromMetaId !== undefined &&
    input.toMetaId !== undefined &&
    input.fromMetaExists &&
    input.toMetaExists
  ) {
    throw new Error(`资源已存在: ${input.toMetaId}`);
  }
}

/**
 * 「确保有一份 asset meta」的公共判定（内存 / 文件系统两个 provider 同一套口径）：
 * 该有 meta（`Assets/` 下的条目、不是 meta 自己）而还没有时，算出要写的那一份
 * （meta 的 id 与内容）；不需要写返回 `undefined`。
 *
 * 纯逻辑：调用方传入「meta 是否已存在」的判定结果与「这条 id 现在是不是目录」
 * （`folder` 为 true 时调用方已知是目录，`isDirectory` 不会被求值——文件系统那边
 * 省去一次 stat）。
 */
export async function ensureAssetMetaCore(input: {
  readonly id: string;
  readonly metaId: string | undefined;
  readonly metaExists: boolean;
  readonly folder: boolean;
  readonly isDirectory: () => boolean | Promise<boolean>;
}): Promise<{ readonly metaId: string; readonly text: string } | undefined> {
  if (input.metaId === undefined || input.metaExists) {
    return undefined;
  }

  const parsed = parseResourceId(input.id);
  if (assetMetaPathFor(parsed.kind, parsed.path) === undefined) {
    return undefined;
  }

  const text = newAssetMetaText(parsed.path, input.folder || (await input.isDirectory()));
  return text === undefined ? undefined : { metaId: input.metaId, text };
}

export function newAssetMetaText(path: string, folder = false): string | undefined {
  if (!folder && assetImporterForPath(path) === undefined) {
    return undefined;
  }

  const guid = newGuid();
  const value = folder
    ? { formatVersion: 1, guid, folderAsset: true }
    : { formatVersion: 1, guid, importer: assetImporterForPath(path) };
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Read a sidecar GUID without making malformed metadata fatal to resource queries. */
export function guidFromAssetMetaText(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }

    const guid = (value as { guid?: unknown }).guid;
    return typeof guid === "string" && /^[0-9a-f]{32}$/.test(guid) ? guid : undefined;
  } catch {
    return undefined;
  }
}

function newGuid(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assetRelativePath(path: string): string | undefined {
  const normalized = normalizePath(path);
  const segments = normalized.split("/");
  const assetsIndex = segments.indexOf("Assets");
  if (assetsIndex < 0) {
    return undefined;
  }

  return segments.slice(assetsIndex + 1).join("/");
}
