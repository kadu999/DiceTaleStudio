/**
 * 资源逻辑 ID 规则。
 *
 * 代码里**不允许出现资源路径字面量**：一律用 `kind:path` 形式的逻辑 ID 寻址，
 * 由 `ResourceProvider` 实现把 ID 解析成真实位置。
 * `kind` 决定资源根下的哪个子目录，`path` 是该子目录内的相对路径（含扩展名）。
 *
 * 地图相关的「同名约定」也集中在这里（地图数据 `Map001.json` / 网格 `Map001.bytes` /
 * 贴图 `images/maps/Map001.png` 同名关联），避免在别处散落字符串拼接。
 */

/** 资源类别。每个类别对应资源根下的一个子目录。 */
export type ResourceKind =
  | "config"
  | "map"
  | "image"
  | "audio"
  | "video"
  | "item-lib"
  | "project";

export const RESOURCE_KINDS: readonly ResourceKind[] = [
  "config",
  "map",
  "image",
  "audio",
  "video",
  "item-lib",
  "project",
];

/** 解析后的资源 ID。 */
export interface ResourceId {
  readonly kind: ResourceKind;
  /** 类别目录内的相对路径（含扩展名，使用 `/` 分隔）。 */
  readonly path: string;
}

function isResourceKind(value: string): value is ResourceKind {
  return (RESOURCE_KINDS as readonly string[]).includes(value);
}

/** 由类别与相对路径拼出逻辑 ID。 */
export function formatResourceId(kind: ResourceKind, path: string): string {
  return `${kind}:${normalizePath(path)}`;
}

/**
 * 解析逻辑 ID。格式非法或类别未知时抛错（不猜测，避免把错误 ID 静默映射到错误文件）。
 */
export function parseResourceId(id: string): ResourceId {
  const separator = id.indexOf(":");
  if (separator <= 0) {
    throw new Error(`资源 ID 缺少类别前缀: ${id}`);
  }

  const kind = id.slice(0, separator);
  const path = id.slice(separator + 1);
  if (!isResourceKind(kind)) {
    throw new Error(`未知资源类别: ${kind}（合法值：${RESOURCE_KINDS.join(", ")}）`);
  }

  if (path.length === 0) {
    throw new Error(`资源 ID 缺少路径: ${id}`);
  }

  const normalized = normalizePath(path);
  if (normalized.startsWith("../") || normalized.includes("/../") || normalized.startsWith("/")) {
    throw new Error(`资源路径不允许越出资源根: ${id}`);
  }

  return { kind, path: normalized };
}

/** 统一分隔符并去掉前导 `./`。 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 地图文档 ID（`maps/<name>.json`）。 */
export function mapDocumentId(name: string): string {
  return formatResourceId("map", `${name}.json`);
}

/** 地图网格二进制 ID（`maps/<name>.bytes`，与 Unity 位精确兼容）。 */
export function mapBytesId(name: string): string {
  return formatResourceId("map", `${name}.bytes`);
}

/** 地图贴图 ID（`images/maps/<name>.png`）——与地图数据同名，这是唯一的关联约定。 */
export function mapImageId(name: string, extension = "png"): string {
  return formatResourceId("image", `maps/${name}.${extension}`);
}

/** 道具库 ID（`items/items.json`）。 */
export function itemLibraryId(fileName = "items.json"): string {
  return formatResourceId("item-lib", fileName);
}

/** 应用配置 ID（`config/<name>.json`）。 */
export function configId(name: string): string {
  return formatResourceId("config", `${name}.json`);
}

/** 项目文件 ID（`projects/<name>.dtproj.json`）。 */
export function projectId(name: string): string {
  return formatResourceId("project", `${name}.dtproj.json`);
}

/** 从地图文档 ID 反推地图名（`map:Map001.json` → `Map001`）。 */
export function mapNameFromDocumentId(id: string): string {
  const { kind, path } = parseResourceId(id);
  if (kind !== "map" || !path.endsWith(".json")) {
    throw new Error(`不是地图文档 ID: ${id}`);
  }

  return path.slice(0, -".json".length);
}
