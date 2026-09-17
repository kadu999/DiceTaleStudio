/**
 * 资源逻辑 ID 规则。
 *
 * 布局：**一个跑团 = 一个工程 = 一个文件夹**（类似 UE 的 `MyGame.uproject` 放在 `MyGame/` 根下）：
 *
 * ```
 * resources/
 * ├─ config/                        编辑器全局配置（不属于任何跑团）
 * │  └─ app.json
 * └─ campaigns/                     ★ 所有跑团工程
 *    └─ 我的跑团/                     ★ 一个跑团一个唯一文件夹
 *       ├─ 我的跑团.dtproj.json       ★ 工程文件（单独的文件；打开/保存的就是它）
 *       ├─ config/                   该跑团的配置
 *       ├─ maps/                     地图数据（<地图>.json / <地图>.bytes）
 *       ├─ images/maps/              地图贴图（<地图>.png，与地图数据同名）
 *       ├─ audio/
 *       ├─ video/
 *       └─ items/                    道具库 items.json
 * ```
 *
 * 代码里**不允许出现资源路径字面量**：一律用 `kind:path` 逻辑 ID 寻址，
 * 由 `ResourceProvider` 实现解析成真实位置。
 * 类别只有两种：`config`（编辑器全局）与 `campaign`（跑团工程内容）；
 * 跑团内部再按用途分子目录，子目录名由本文件的 `CAMPAIGN_FOLDERS` 统一约定。
 */

/** 资源类别。每个类别对应资源根下的一个子目录。 */
export type ResourceKind = "config" | "campaign";

export const RESOURCE_KINDS: readonly ResourceKind[] = ["config", "campaign"];

/** 跑团文件夹内的标准子目录名（**唯一约定来源**，不要在别处再拼一遍）。 */
export const CAMPAIGN_FOLDERS = {
  /** 该跑团自己的配置 */
  config: "config",
  /** 地图数据：`<地图>.json`（编辑态）、`<地图>.bytes`（导出/导入） */
  maps: "maps",
  /** 图片资源；地图贴图放 `images/maps/`，与地图数据同名 */
  images: "images",
  /** 地图贴图相对跑团根的子路径 */
  mapImages: "images/maps",
  audio: "audio",
  video: "video",
  /** 道具库 */
  items: "items",
} as const;

/** 创建跑团时默认建立的子目录。 */
export const DEFAULT_CAMPAIGN_FOLDERS: readonly string[] = [
  CAMPAIGN_FOLDERS.config,
  CAMPAIGN_FOLDERS.maps,
  CAMPAIGN_FOLDERS.images,
  CAMPAIGN_FOLDERS.mapImages,
  CAMPAIGN_FOLDERS.audio,
  CAMPAIGN_FOLDERS.video,
  CAMPAIGN_FOLDERS.items,
];

/** 工程文件后缀（跑团工程 = 单个文件）。 */
export const PROJECT_FILE_EXTENSION = ".dtproj.json";

/** 解析后的资源 ID。 */
export interface ResourceId {
  readonly kind: ResourceKind;
  /** 类别目录内的相对路径（含扩展名，使用 `/` 分隔）。 */
  readonly path: string;
}

function isResourceKind(value: string): value is ResourceKind {
  return (RESOURCE_KINDS as readonly string[]).includes(value);
}

/** 统一分隔符并去掉前导 `./`。 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 由类别与相对路径拼出逻辑 ID。 */
export function formatResourceId(kind: ResourceKind, path: string): string {
  return `${kind}:${normalizePath(path)}`;
}

/**
 * 解析逻辑 ID。格式非法、类别未知或路径越界时抛错（不猜测，避免把错误 ID 静默映射到错误文件）。
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
  if (
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.startsWith("/") ||
    normalized === ".."
  ) {
    throw new Error(`资源路径不允许越出资源根: ${id}`);
  }

  return { kind, path: normalized };
}

// ---------------------------------------------------------------- 跑团工程

/** 跑团工程文件名：`<跑团名>.dtproj.json`。 */
export function campaignProjectFileName(campaign: string): string {
  return `${campaign}${PROJECT_FILE_EXTENSION}`;
}

/** 跑团根目录内的相对路径。 */
export function campaignPath(campaign: string, subPath = ""): string {
  const base = normalizePath(campaign);
  if (subPath.length === 0) {
    return base;
  }

  return `${base}/${normalizePath(subPath)}`;
}

/** 跑团工程文件 ID（打开/保存的就是它）。 */
export function campaignProjectId(campaign: string): string {
  return formatResourceId("campaign", campaignPath(campaign, campaignProjectFileName(campaign)));
}

/** 跑团内任意文件的 ID。 */
export function campaignFileId(campaign: string, subPath: string): string {
  return formatResourceId("campaign", campaignPath(campaign, subPath));
}

/** 跑团内的标准子目录 ID（用于列目录 / 建目录）。 */
export function campaignFolderId(campaign: string, folder: string): string {
  return formatResourceId("campaign", campaignPath(campaign, folder));
}

/** 地图数据 ID：`maps/<地图>.json`。 */
export function campaignMapId(campaign: string, mapName: string): string {
  return campaignFileId(campaign, `${CAMPAIGN_FOLDERS.maps}/${mapName}.json`);
}

/** 地图网格二进制 ID：`maps/<地图>.bytes`（与 Unity 位精确兼容）。 */
export function campaignMapBytesId(campaign: string, mapName: string): string {
  return campaignFileId(campaign, `${CAMPAIGN_FOLDERS.maps}/${mapName}.bytes`);
}

/** 地图贴图 ID：`images/maps/<地图>.png`——与地图数据同名，这是唯一的关联约定。 */
export function campaignMapImageId(campaign: string, mapName: string, extension = "png"): string {
  return campaignFileId(
    campaign,
    `${CAMPAIGN_FOLDERS.mapImages}/${mapName}.${extension}`,
  );
}

/** 道具库 ID：`items/items.json`。 */
export function campaignItemsId(campaign: string, fileName = "items.json"): string {
  return campaignFileId(campaign, `${CAMPAIGN_FOLDERS.items}/${fileName}`);
}

/** 从跑团内资源 ID 反推跑团名（`campaign:我的跑团/...` → `我的跑团`）。 */
export function campaignNameFromId(id: string): string {
  const { kind, path } = parseResourceId(id);
  if (kind !== "campaign") {
    throw new Error(`不是跑团资源 ID: ${id}`);
  }

  const separator = path.indexOf("/");
  if (separator <= 0) {
    throw new Error(`跑团资源 ID 缺少跑团名: ${id}`);
  }

  return path.slice(0, separator);
}

/** 从跑团内资源 ID 取「跑团根之后的相对路径」。 */
export function campaignRelativePathFromId(id: string): string {
  const { kind, path } = parseResourceId(id);
  if (kind !== "campaign") {
    throw new Error(`不是跑团资源 ID: ${id}`);
  }

  const separator = path.indexOf("/");
  return separator < 0 ? "" : path.slice(separator + 1);
}

/** 从工程文件 ID 反推跑团名（校验文件名确实是 `<跑团名>.dtproj.json`）。 */
export function campaignNameFromProjectId(id: string): string {
  const campaign = campaignNameFromId(id);
  const relative = campaignRelativePathFromId(id);
  if (relative !== campaignProjectFileName(campaign)) {
    throw new Error(`不是跑团工程文件 ID: ${id}`);
  }

  return campaign;
}

// ---------------------------------------------------------------- 编辑器全局配置

/** 应用配置 ID（`config/<name>.json`）。 */
export function configId(name: string): string {
  return formatResourceId("config", `${name}.json`);
}
