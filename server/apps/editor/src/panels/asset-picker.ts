import type { ResourceTreeNode } from "../services/project-api";
import { assetPreviewKind } from "./asset-info";

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

/** 资源缩略图 / 预览地址（后端原始字节接口）。 */
export function assetRawUrl(id: string): string {
  return `/api/resources/raw?id=${encodeURIComponent(id)}`;
}
