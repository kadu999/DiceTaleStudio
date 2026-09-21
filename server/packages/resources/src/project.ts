import {
  PROJECT_FILE_NAME,
  PROJECT_SPECIAL_FILES,
  formatResourceId,
  normalizePath,
  parseResourceId,
  projectFileId,
  projectFolderId,
  projectPath,
} from "./ids";
import type { ResourceEntry, ResourceProvider } from "./provider";

/**
 * 项目（一个项目 = 一个文件夹 + 一个固定名的项目文件）的读写操作。
 *
 * 这些是纯业务操作，只依赖 `ResourceProvider` 抽象，因此浏览器端（HTTP）、
 * 后端（文件系统）、测试（内存）三处行为一致。
 */

/** 项目概览（编辑器「打开项目」列表用）。 */
export interface ProjectSummary {
  readonly name: string;
  readonly fileCount: number;
  readonly updatedAt?: string;
}

/** 资源树节点（编辑器 Assets 面板用）。 */
export interface ResourceTreeNode {
  /** 显示名（最后一段） */
  readonly name: string;
  /** 项目内的相对路径（空串表示项目根） */
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
 * 校验项目名。返回错误原因；合法时返回 undefined。
 *
 * 项目名会直接成为文件夹名，因此必须挡住路径分隔符、Windows 非法字符与保留名。
 */
export function validateProjectName(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "项目名不能为空";
  }

  if (trimmed !== name) {
    return "项目名首尾不能有空白字符";
  }

  if (trimmed.length > 64) {
    return "项目名不能超过 64 个字符";
  }

  if (/[\\/:*?"<>|]/.test(trimmed)) {
    return '项目名不能包含 \\ / : * ? " < > | 等字符';
  }

  if (trimmed === "." || trimmed === "..") {
    return "项目名不合法";
  }

  if (RESERVED_NAMES.has(trimmed.toLowerCase())) {
    return `"${trimmed}" 是系统保留名，请换一个`;
  }

  return undefined;
}

/**
 * 校验项目内的相对路径（新建文件夹 / 上传文件 / 在文件管理器里定位时用）。
 *
 * `.` 与 `..` **逐段拒绝**：`validateProjectName` 只管文件名本身的字符，会放行这两个
 * （它们不含分隔符也不是保留名），于是 `a/..` 这种「整段是点点」的路径能绕开上面那条
 * `/../` 检查——拼进真实路径后它会把结果抬到项目目录之外。
 */
export function validateProjectRelativePath(path: string): string | undefined {
  const normalized = normalizePath(path).trim();
  if (normalized.length === 0) {
    return "路径不能为空";
  }

  if (normalized.startsWith("/") || normalized.includes("/../") || normalized.startsWith("../")) {
    return "路径不允许越出项目目录";
  }

  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      return "路径中不能有空的目录名";
    }

    if (segment === "." || segment === "..") {
      return "路径不允许使用 . 或 ..";
    }

    const reason = validateProjectName(segment);
    if (reason !== undefined) {
      return reason;
    }
  }

  return undefined;
}

/**
 * 列出全部项目（按名称排序）。
 *
 * **判定标准只有一条：项目文件夹里有 `project.json`。** 没有的目录直接不算项目
 * （半途创建的目录、只剩资源的残骸都不该出现在「打开项目」列表里）。
 */
export async function listProjects(provider: ResourceProvider): Promise<ProjectSummary[]> {
  const entries = await provider.list("project");

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

  const summaries: ProjectSummary[] = [];
  for (const [name, list] of byName) {
    const files = list.filter((entry) => entry.type === "file");
    const projectEntry = files.find(
      (entry) => entry.path.slice(name.length + 1) === PROJECT_FILE_NAME,
    );
    if (projectEntry === undefined) {
      continue;
    }

    summaries.push({
      name,
      fileCount: files.length,
      ...(projectEntry.modifiedAt === undefined ? {} : { updatedAt: projectEntry.modifiedAt }),
    });
  }

  return summaries.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

/** 该项目是否存在（= 项目文件夹里有 `project.json`）。 */
export async function projectExists(
  provider: ResourceProvider,
  name: string,
): Promise<boolean> {
  const reason = validateProjectName(name);
  if (reason !== undefined) {
    return false;
  }

  return provider.exists(projectFileId(name));
}

/** 读取项目内的全部资源（扁平列表）。 */
export async function readProjectEntries(
  provider: ResourceProvider,
  project: string,
): Promise<ResourceEntry[]> {
  const prefix = `${normalizePath(project)}/`;
  const entries = await provider.list("project");
  return entries.filter((entry) => entry.path.startsWith(prefix));
}

/**
 * 把扁平资源列表构建成树（编辑器 Assets 面板用）。
 *
 * `folders` 用于把**空目录**也显示出来（新建项目时会建出标准子目录，
 * 但空目录不会出现在文件列表里）——例如刚创建的项目也应看到 maps/、images/。
 *
 * `PROJECT_SPECIAL_FILES`（目前是 `project.json`）会被跳过：项目文件是元数据，
 * 不该混在资源里，更不该让用户从资源面板里把它删掉。
 */
export function buildResourceTree(
  project: string,
  entries: readonly ResourceEntry[],
  folders: readonly string[] = [],
): ResourceTreeNode[] {
  const root: ResourceTreeNode = {
    name: project,
    path: "",
    id: formatResourceId("project", projectPath(project)),
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
      id: formatResourceId("project", projectPath(project, path)),
      type: "folder",
      children: [],
    };

    parent.children?.push(node);
    folderNodes.set(path, node);
    return node;
  };

  const prefixLength = project.length + 1;

  // 先建出配置里的标准目录（含空目录），再挂文件
  for (const folder of folders) {
    ensureFolder(normalizePath(folder));
  }

  for (const entry of entries) {
    const relative = entry.path.slice(prefixLength);
    // 特殊文件（项目文件）不进资源树：它是项目元数据，不是项目内容
    if (entry.type === "file" && PROJECT_SPECIAL_FILES.includes(relative)) {
      continue;
    }

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

export interface CreateProjectOptions {
  /** 要自动创建的子目录（相对项目根）；缺省用配置里的 projectFolders。 */
  readonly folders?: readonly string[];
  /** 项目文件内容（对象会被序列化）。 */
  readonly project: unknown;
}

/**
 * 创建一个项目：建立项目文件夹、写入项目文件、创建标准子目录。
 * 已存在同名项目时抛错（不覆盖用户数据）。
 */
export async function createProject(
  provider: ResourceProvider,
  name: string,
  options: CreateProjectOptions,
): Promise<void> {
  const reason = validateProjectName(name);
  if (reason !== undefined) {
    throw new Error(reason);
  }

  const projectFile = projectFileId(name);
  if (await provider.exists(projectFile)) {
    throw new Error(`项目「${name}」已存在`);
  }

  await provider.writeText(projectFile, `${JSON.stringify(options.project, null, 2)}\n`);
  for (const folder of options.folders ?? []) {
    await provider.ensureFolder(projectFolderId(name, folder));
  }
}

/** 删除整个项目（连同其全部资源）。 */
export async function deleteProject(
  provider: ResourceProvider,
  name: string,
): Promise<{ removed: number }> {
  const reason = validateProjectName(name);
  if (reason !== undefined) {
    throw new Error(reason);
  }

  if (!(await provider.exists(projectFileId(name)))) {
    throw new Error(`项目「${name}」不存在`);
  }

  const entries = await readProjectEntries(provider, name);

  // 递归删除项目根目录：文件与空目录一并清掉（provider 的 remove 对目录是递归语义）
  await provider.remove(formatResourceId("project", projectPath(name)));
  return { removed: entries.filter((entry) => entry.type === "file").length };
}

/** 读取项目的项目文件内容。 */
export async function readProjectFile(
  provider: ResourceProvider,
  name: string,
): Promise<string> {
  return provider.readText(projectFileId(name));
}

/** 判断某个资源 ID 是否属于某个项目（编辑器做权限/归属校验用）。 */
export function belongsToProject(id: string, project: string): boolean {
  try {
    const { kind, path } = parseResourceId(id);
    return kind === "project" && path.startsWith(`${project}/`);
  } catch {
    return false;
  }
}
