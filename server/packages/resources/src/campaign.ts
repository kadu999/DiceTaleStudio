import {
  campaignFolderId,
  campaignPath,
  campaignProjectId,
  formatResourceId,
  normalizePath,
  parseResourceId,
} from "./ids";
import type { ResourceEntry, ResourceProvider } from "./provider";

/**
 * 跑团工程（一个跑团 = 一个文件夹）的读写操作。
 *
 * 这些是纯业务操作，只依赖 `ResourceProvider` 抽象，因此浏览器端（HTTP）、
 * 后端（文件系统）、测试（内存）三处行为一致。
 */

/** 跑团概览（编辑器「打开项目」列表用）。 */
export interface CampaignSummary {
  readonly name: string;
  /** 工程文件是否存在（缺失说明目录不完整或不是合法跑团） */
  readonly hasProject: boolean;
  readonly fileCount: number;
  readonly updatedAt?: string;
}

/** 资源树节点（编辑器 Assets 面板用）。 */
export interface ResourceTreeNode {
  /** 显示名（最后一段） */
  readonly name: string;
  /** 跑团内的相对路径（空串表示跑团根） */
  readonly path: string;
  /** 资源逻辑 ID */
  readonly id: string;
  readonly type: "folder" | "file";
  readonly size?: number;
  readonly children?: ResourceTreeNode[];
}

/** Windows 保留设备名，作为文件夹名会出各种怪问题。 */
const RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/**
 * 校验跑团名。返回错误原因；合法时返回 undefined。
 *
 * 跑团名会直接成为文件夹名，因此必须挡住路径分隔符、Windows 非法字符与保留名。
 */
export function validateCampaignName(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "跑团名不能为空";
  }

  if (trimmed !== name) {
    return "跑团名首尾不能有空白字符";
  }

  if (trimmed.length > 64) {
    return "跑团名不能超过 64 个字符";
  }

  if (/[\\/:*?"<>|]/.test(trimmed)) {
    return '跑团名不能包含 \\ / : * ? " < > | 等字符';
  }

  if (trimmed === "." || trimmed === "..") {
    return "跑团名不合法";
  }

  if (RESERVED_NAMES.has(trimmed.toLowerCase())) {
    return `"${trimmed}" 是系统保留名，请换一个`;
  }

  return undefined;
}

/** 校验跑团内的相对路径（新建文件夹 / 上传文件时用）。 */
export function validateCampaignRelativePath(path: string): string | undefined {
  const normalized = normalizePath(path).trim();
  if (normalized.length === 0) {
    return "路径不能为空";
  }

  if (normalized.startsWith("/") || normalized.includes("/../") || normalized.startsWith("../")) {
    return "路径不允许越出跑团目录";
  }

  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      return "路径中不能有空的目录名";
    }

    const reason = validateCampaignName(segment);
    if (reason !== undefined) {
      return reason;
    }
  }

  return undefined;
}

/** 列出全部跑团（按名称排序）。 */
export async function listCampaigns(provider: ResourceProvider): Promise<CampaignSummary[]> {
  const entries = await provider.list("campaign");
  const byName = new Map<string, ResourceEntry[]>();

  for (const entry of entries) {
    const separator = entry.path.indexOf("/");
    if (separator <= 0) {
      continue;
    }

    const name = entry.path.slice(0, separator);
    const list = byName.get(name);
    if (list === undefined) {
      byName.set(name, [entry]);
    } else {
      list.push(entry);
    }
  }

  const summaries: CampaignSummary[] = [];
  for (const [name, list] of byName) {
    const files = list.filter((entry) => entry.type === "file");
    const projectEntry = files.find(
      (entry) => entry.path.slice(name.length + 1) === `${name}.dtproj.json`,
    );

    summaries.push({
      name,
      hasProject: projectEntry !== undefined,
      fileCount: files.length,
      ...(projectEntry?.modifiedAt === undefined ? {} : { updatedAt: projectEntry.modifiedAt }),
    });
  }

  return summaries.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

/** 读取跑团内的全部资源（扁平列表）。 */
export async function readCampaignEntries(
  provider: ResourceProvider,
  campaign: string,
): Promise<ResourceEntry[]> {
  const prefix = `${normalizePath(campaign)}/`;
  const entries = await provider.list("campaign");
  return entries.filter((entry) => entry.path.startsWith(prefix));
}

/**
 * 把扁平资源列表构建成树（编辑器 Assets 面板用）。
 *
 * `folders` 用于把**空目录**也显示出来（新建跑团时会建出标准子目录，
 * 但空目录不会出现在文件列表里）——例如刚创建的跑团也应看到 maps/、images/。
 */
export function buildResourceTree(
  campaign: string,
  entries: readonly ResourceEntry[],
  folders: readonly string[] = [],
): ResourceTreeNode[] {
  const root: ResourceTreeNode = {
    name: campaign,
    path: "",
    id: formatResourceId("campaign", campaignPath(campaign)),
    type: "folder",
    children: [],
  };

  const folderNodes = new Map<string, ResourceTreeNode>([["", root]]);

  const ensureFolder = (path: string): ResourceTreeNode => {
    const existing = folderNodes.get(path);
    if (existing !== undefined) {
      return existing;
    }

    const separator = path.lastIndexOf("/");
    const parentPath = separator < 0 ? "" : path.slice(0, separator);
    const name = separator < 0 ? path : path.slice(separator + 1);
    const parent = ensureFolder(parentPath);
    const node: ResourceTreeNode = {
      name,
      path,
      id: formatResourceId("campaign", campaignPath(campaign, path)),
      type: "folder",
      children: [],
    };

    parent.children?.push(node);
    folderNodes.set(path, node);
    return node;
  };

  const prefixLength = campaign.length + 1;

  // 先建出配置里的标准目录（含空目录），再挂文件
  for (const folder of folders) {
    ensureFolder(normalizePath(folder));
  }

  for (const entry of entries) {
    const relative = entry.path.slice(prefixLength);
    if (entry.type === "folder") {
      ensureFolder(relative);
      continue;
    }

    const separator = relative.lastIndexOf("/");
    const parent = separator < 0 ? root : ensureFolder(relative.slice(0, separator));
    const name = separator < 0 ? relative : relative.slice(separator + 1);

    parent.children?.push({
      name,
      path: relative,
      id: entry.id,
      type: "file",
      size: entry.size,
    });
  }

  sortTree(root);
  return root.children ?? [];
}

function sortTree(node: ResourceTreeNode): void {
  node.children?.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }

    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });

  for (const child of node.children ?? []) {
    sortTree(child);
  }
}

export interface CreateCampaignOptions {
  /** 要自动创建的子目录（相对跑团根）；缺省用配置里的 campaignFolders。 */
  readonly folders?: readonly string[];
  /** 工程文件内容（对象会被序列化）。 */
  readonly project: unknown;
}

/**
 * 创建一个跑团：建立跑团文件夹、写入工程文件、创建标准子目录。
 * 已存在同名跑团时抛错（不覆盖用户数据）。
 */
export async function createCampaign(
  provider: ResourceProvider,
  name: string,
  options: CreateCampaignOptions,
): Promise<void> {
  const reason = validateCampaignName(name);
  if (reason !== undefined) {
    throw new Error(reason);
  }

  const projectFileId = campaignProjectId(name);
  if (await provider.exists(projectFileId)) {
    throw new Error(`跑团「${name}」已存在`);
  }

  await provider.writeText(projectFileId, `${JSON.stringify(options.project, null, 2)}\n`);
  for (const folder of options.folders ?? []) {
    await provider.ensureFolder(campaignFolderId(name, folder));
  }
}

/** 删除整个跑团（连同其全部资源）。 */
export async function deleteCampaign(
  provider: ResourceProvider,
  name: string,
): Promise<{ removed: number }> {
  const reason = validateCampaignName(name);
  if (reason !== undefined) {
    throw new Error(reason);
  }

  const entries = await readCampaignEntries(provider, name);
  const files = entries.filter((entry) => entry.type === "file");
  if (files.length === 0) {
    throw new Error(`跑团「${name}」不存在`);
  }

  // 递归删除跑团根目录：文件与空目录一并清掉（provider 的 remove 对目录是递归语义）
  await provider.remove(formatResourceId("campaign", campaignPath(name)));
  return { removed: files.length };
}

/** 读取跑团的工程文件内容。 */
export async function readCampaignProject(
  provider: ResourceProvider,
  name: string,
): Promise<string> {
  return provider.readText(campaignProjectId(name));
}

/** 判断某个资源 ID 是否属于某个跑团（编辑器做权限/归属校验用）。 */
export function belongsToCampaign(id: string, campaign: string): boolean {
  try {
    const { kind, path } = parseResourceId(id);
    return kind === "campaign" && path.startsWith(`${campaign}/`);
  } catch {
    return false;
  }
}
