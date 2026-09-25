import { assetIdOfGuid, type AssetMetas } from "@dts/document";
import type { ResourceTreeNode } from "../services/project-api";
import { assetPreviewKind } from "./asset-info";

const SPRITE_ASSET_MARKER = "::sprite:";

export interface SpriteAssetSelection {
  readonly imageId: string;
  readonly index: number;
}

/** 虚拟子精灵使用稳定 ID，底层仍然指向父图片，不会伪造资源文件。 */
export function spriteAssetId(imageId: string, index: number): string {
  return `${imageId}${SPRITE_ASSET_MARKER}${index}`;
}

export function parseSpriteAssetId(id: string): SpriteAssetSelection | undefined {
  const marker = id.lastIndexOf(SPRITE_ASSET_MARKER);
  if (marker < 0) {
    return undefined;
  }

  const imageId = id.slice(0, marker);
  const index = Number(id.slice(marker + SPRITE_ASSET_MARKER.length));
  if (imageId.length === 0 || !Number.isInteger(index) || index < 0) {
    return undefined;
  }

  return { imageId, index };
}

/**
 * 资源在界面上的**显示路径**：省掉 `project:` 类别前缀、项目名与 `Assets/`。
 *
 * 例：`project:我的项目/Assets/images/Map001.png` → `images/Map001.png`。
 * 前缀、项目名与 `Assets/` 对用户都没有信息量（项目已经打开着、所有资源都在 `Assets/` 下），
 * 只留「哪个目录下的哪个文件」。
 */
export function assetDisplayPath(id: string): string {
  const slash = id.indexOf("/");
  const withoutProject = id.startsWith("project:") && slash >= 0 ? id.slice(slash + 1) : id;
  return withoutProject.replace(/^Assets\//, "");
}

/** 资源树里有没有这个 id 的文件（属性面板据此提示「贴图不存在」）。 */
export function findAssetById(
  nodes: readonly ResourceTreeNode[],
  id: string,
): ResourceTreeNode | undefined {
  for (const node of nodes) {
    if (node.type === "file") {
      if (node.id === id) {
        return node;
      }

      continue;
    }

    const found = findAssetById(node.children ?? [], id);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

/** Resolve a resource reference by stable GUID when available, then locate its current path. */
export function findAssetByReference(
  nodes: readonly ResourceTreeNode[],
  reference: string,
  metas: AssetMetas,
): ResourceTreeNode | undefined {
  const currentId = currentResourceId(reference, metas);
  return currentId === undefined ? undefined : findAssetById(nodes, currentId);
}

/** Resolve a persisted resource identity to the current logical ID when it is a GUID. */
export function currentResourceId(reference: string, metas: AssetMetas): string | undefined {
  return /^[0-9a-f]{32}$/.test(reference) ? assetIdOfGuid(metas, reference) : reference;
}

/** Current path identity for an image reference; GUID wins over its historical path. */
export function currentImageAssetId(
  image: { readonly id: string; readonly guid?: string },
  metas: AssetMetas,
): string {
  return image.guid === undefined ? image.id : assetIdOfGuid(metas, image.guid) ?? image.id;
}

/** Resolve an image by stable identity first; legacy references fall back to their path ID. */
export function findImageAsset(
  nodes: readonly ResourceTreeNode[],
  image: { readonly id: string; readonly guid?: string },
  metas: AssetMetas,
): ResourceTreeNode | undefined {
  return findAssetById(nodes, currentImageAssetId(image, metas));
}

/** 资源面板里当前项目下的全部图片（按路径排序）。 */
export function listImageAssets(nodes: readonly ResourceTreeNode[]): ResourceTreeNode[] {
  const found: ResourceTreeNode[] = [];
  collectByKind(nodes, "image", found);
  return found.sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));
}

/** 资源面板里当前项目下的全部音频（按路径排序）。 */
export function listAudioAssets(nodes: readonly ResourceTreeNode[]): ResourceTreeNode[] {
  const found: ResourceTreeNode[] = [];
  collectByKind(nodes, "audio", found);
  return found.sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));
}

/** 资源面板里当前项目下的全部视频（按路径排序）。 */
export function listVideoAssets(nodes: readonly ResourceTreeNode[]): ResourceTreeNode[] {
  const found: ResourceTreeNode[] = [];
  collectByKind(nodes, "video", found);
  return found.sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));
}

/** 按预览类别（图片 / 音频 / 视频）收资源：判断扩展名的地方只有 `asset-info` 一处。 */
function collectByKind(
  nodes: readonly ResourceTreeNode[],
  kind: "image" | "audio" | "video",
  into: ResourceTreeNode[],
): void {
  for (const node of nodes) {
    if (node.type === "file") {
      if (assetPreviewKind(node.name) === kind) {
        into.push(node);
      }

      continue;
    }

    collectByKind(node.children ?? [], kind, into);
  }
}

/** 原始资源地址，供需要原图像素的编辑与运行时预览使用。 */
export function assetRawUrl(id: string): string {
  return `/api/resources/raw?id=${encodeURIComponent(id)}`;
}

/** 小尺寸图片预览，后端转换并按源内容缓存。 */
export function assetThumbnailUrl(id: string): string {
  return `/api/resources/thumbnail?id=${encodeURIComponent(id)}`;
}

/** 图片原始像素尺寸，不下载原始像素数据。 */
export function assetImageInfoUrl(id: string): string {
  return `/api/resources/thumbnail?id=${encodeURIComponent(id)}&info=1`;
}
