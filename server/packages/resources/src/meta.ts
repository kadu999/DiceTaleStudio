import { assetMetaPathOf, normalizePath, parseResourceId, type ResourceKind } from "./ids";

export function ownsAssetMeta(kind: ResourceKind, path: string): boolean {
  if (kind !== "project") {
    return false;
  }

  const normalized = normalizePath(path);
  return assetRelativePath(normalized) !== undefined && !normalized.endsWith(".meta");
}

export function assetMetaPathFor(kind: ResourceKind, path: string): string | undefined {
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

export function assetImporterForPath(path: string): AssetImporter | undefined {
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
