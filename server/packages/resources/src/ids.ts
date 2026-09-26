/**
 * 资源逻辑 ID 规则。
 *
 * 布局：**一个项目 = 一个文件夹 + 一个固定名的项目文件**（类似 UE 的 `MyGame.uproject` 放在 `MyGame/` 根下）：
 *
 * ```
 * resources/
 * ├─ config/                        编辑器全局配置（不属于任何项目）
 * │  └─ app.json
 * └─ projects/                      ★ 所有项目
 *    └─ 我的项目/                     ★ 一个项目一个唯一文件夹
 *       ├─ project.json              ★ 项目文件（固定名；打开/保存的就是它）
 *       └─ Assets/                   ★ 所有资源都在这里（对齐 Unity 的 Assets/）
 *          ├─ config/               该项目自己的配置
 *          ├─ scenes/               场景数据：<场景>.bytes（导出的网格，Unity 位精确兼容）
 *          ├─ images/               图片资源：场景贴图 <场景>.png（与场景同名）
 *          ├─ audio/
 *          └─ video/
 * ```
 *
 * 代码里**不允许出现资源路径字面量**：一律用 `kind:path` 逻辑 ID 寻址，
 * 由 `ResourceProvider` 实现解析成真实位置。
 * 类别只有两种：`config`（编辑器全局）与 `project`（项目内容）；
 * 项目内部再按用途分子目录，子目录名由本文件的 `PROJECT_FOLDERS` 统一约定。
 *
 * 资源**不由编辑器写入**：素材由人/外部工具提交到这些指定目录，编辑器只负责查看与引用
 * （因此目录面板目前是只读的）。
 */

/** 资源类别。每个类别对应资源根下的一个子目录。 */
export type ResourceKind = "config" | "project";

export const RESOURCE_KINDS: readonly ResourceKind[] = ["config", "project"];

/** 项目内所有资源的根目录名（对齐 Unity 的 `Assets/`）。 */
const ASSETS = "Assets";

/**
 * 项目文件夹内的标准子目录名（**唯一约定来源**，不要在别处再拼一遍）。
 *
 * 除项目文件本身外，**一切都在 `Assets/` 下**——素材、配置、导出物一视同仁，
 * 这样项目根永远只有「项目文件 + Assets」，不会随功能增长而变乱。
 */
export const PROJECT_FOLDERS = {
  /** 所有资源的根 */
  assets: ASSETS,
  /** 该项目自己的配置 */
  config: `${ASSETS}/config`,
  /** 场景数据：`Assets/scenes/<场景>.bytes`（导出的网格，与 Unity 位精确兼容） */
  scenes: `${ASSETS}/scenes`,
  /** 图片资源：场景贴图 `Assets/images/<场景>.png`，与场景同名 */
  images: `${ASSETS}/images`,
  audio: `${ASSETS}/audio`,
  video: `${ASSETS}/video`,
} as const;

/** 创建项目时默认建立的子目录。 */
export const DEFAULT_PROJECT_FOLDERS: readonly string[] = [
  PROJECT_FOLDERS.config,
  PROJECT_FOLDERS.scenes,
  PROJECT_FOLDERS.images,
  PROJECT_FOLDERS.audio,
  PROJECT_FOLDERS.video,
];

/**
 * 项目文件名：**固定名**，不含项目名。
 *
 * 项目名已经是文件夹名，再重复进文件名只会让「重命名项目 = 改文件夹 + 改文件名」
 * 变成两处约定；固定名之后，项目文件永远是 `<项目名>/project.json`。
 */
export const PROJECT_FILE_NAME = "project.json";

/**
 * 属于项目本身、**不作为「资源」显示**的特殊文件（相对项目根的路径）。
 *
 * 项目文件是项目的元数据，不是项目内容：资源面板里既不显示、也不允许删除
 * （删掉它项目就不成立了）。真正的资源（地图、贴图、道具库…）照常显示。
 */
export const PROJECT_SPECIAL_FILES: readonly string[] = [PROJECT_FILE_NAME];

/**
 * **素材元数据**文件的后缀：每个素材旁边一个 `<素材>.meta`（对齐 Unity）。
 *
 * 里面是**素材自己的数据**（稳定 GUID + 导入设置 + 切分），不是素材本身：
 * 和 `project.json` 一样属于"元数据"，**不进资源树、也不进素材清单**，
 * 由编辑器按需要写（见 `docs/specs/2026-09-23-asset-meta.md`）。
 */
export const ASSET_META_SUFFIX = ".meta";

/** 这个路径是不是 meta 文件（`Assets/images/A.png.meta` → `true`）。 */
export function isAssetMetaPath(path: string): boolean {
  return normalizePath(path).endsWith(ASSET_META_SUFFIX);
}

/** 素材的 meta 文件路径（`Assets/images/A.png` → `Assets/images/A.png.meta`）。 */
export function assetMetaPathOf(assetPath: string): string {
  return `${normalizePath(assetPath)}${ASSET_META_SUFFIX}`;
}

/** 素材的 meta 文件 ID（键与素材本身同一套 `kind:path`，只是路径多了 `.meta`）。 */
export function assetMetaIdOf(id: string): string {
  const { kind, path } = parseResourceId(id);
  return formatResourceId(kind, assetMetaPathOf(path));
}

/** 由 meta 文件 ID 反推素材 ID；不是 meta 文件就返回 `undefined`。 */
export function assetIdOfMetaId(id: string): string | undefined {
  const { kind, path } = parseResourceId(id);
  if (!isAssetMetaPath(path)) {
    return undefined;
  }

  return formatResourceId(kind, path.slice(0, -ASSET_META_SUFFIX.length));
}

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
  if (normalized.startsWith("/")) {
    throw new Error(`资源路径不允许越出资源根: ${id}`);
  }

  // `.` / `..` **逐段拒绝**（与 `validateProjectRelativePath` 同口径）：
  // 只查 `includes("/../")` 会漏掉结尾那一段，`project:a/..` 这种能绕过去。
  for (const segment of normalized.split("/")) {
    if (segment === "." || segment === "..") {
      throw new Error(`资源路径不允许越出资源根: ${id}`);
    }
  }

  return { kind, path: normalized };
}

// ---------------------------------------------------------------- 项目

/** 项目根目录内的相对路径。 */
export function projectPath(project: string, subPath = ""): string {
  const base = normalizePath(project);
  if (subPath.length === 0) {
    return base;
  }

  return `${base}/${normalizePath(subPath)}`;
}

/** 项目文件 ID（打开/保存的就是它；固定为 `<项目名>/project.json`）。 */
export function projectFileId(project: string): string {
  return formatResourceId("project", projectPath(project, PROJECT_FILE_NAME));
}

/** 项目内任意资源的 ID。 */
export function projectAssetId(project: string, subPath: string): string {
  return formatResourceId("project", projectPath(project, subPath));
}

/** 项目内的标准子目录 ID（用于列目录 / 建目录）。 */
export function projectFolderId(project: string, folder: string): string {
  return formatResourceId("project", projectPath(project, folder));
}

/** 场景网格二进制 ID：`scenes/<场景>.bytes`（与 Unity 位精确兼容）。 */
export function projectSceneBytesId(project: string, sceneName: string): string {
  return projectAssetId(project, `${PROJECT_FOLDERS.scenes}/${sceneName}.bytes`);
}

/** 场景贴图 ID：`images/<场景>.png`——与场景同名，这是唯一的关联约定。 */
export function projectSceneImageId(project: string, sceneName: string, extension = "png"): string {
  return projectAssetId(project, `${PROJECT_FOLDERS.images}/${sceneName}.${extension}`);
}

/** 场景文件后缀。列目录时要靠它把场景文件从 `Assets/scenes/` 里认出来。 */
export const PROJECT_SCENE_FILE_EXTENSION = ".json";

/**
 * 场景文件 ID：`Assets/scenes/<场景名>.json`。
 *
 * **场景名就是文件名**（文件内容里不存名字），所以重命名场景 = 重命名这个文件，
 * 内容一个字节都不用重写。
 */
export function projectSceneFileId(project: string, sceneName: string): string {
  return projectAssetId(project, `${PROJECT_FOLDERS.scenes}/${sceneName}${PROJECT_SCENE_FILE_EXTENSION}`);
}

/** 从项目内资源 ID 反推项目名（`project:我的项目/...` → `我的项目`）。 */
export function projectNameFromId(id: string): string {
  const { kind, path } = parseResourceId(id);
  if (kind !== "project") {
    throw new Error(`不是项目资源 ID: ${id}`);
  }

  const separator = path.indexOf("/");
  if (separator <= 0) {
    throw new Error(`项目资源 ID 缺少项目名: ${id}`);
  }

  return path.slice(0, separator);
}

/** 从项目内资源 ID 取「项目根之后的相对路径」。 */
export function projectRelativePathFromId(id: string): string {
  const { kind, path } = parseResourceId(id);
  if (kind !== "project") {
    throw new Error(`不是项目资源 ID: ${id}`);
  }

  const separator = path.indexOf("/");
  return separator < 0 ? "" : path.slice(separator + 1);
}

/** 从项目文件 ID 反推项目名（校验路径确实是 `<项目名>/project.json`）。 */
export function projectNameFromFileId(id: string): string {
  const project = projectNameFromId(id);
  const relative = projectRelativePathFromId(id);
  if (relative !== PROJECT_FILE_NAME) {
    throw new Error(`不是项目文件 ID: ${id}`);
  }

  return project;
}

// ---------------------------------------------------------------- 编辑器全局配置

/** 应用配置 ID（`config/<name>.json`）。 */
export function configId(name: string): string {
  return formatResourceId("config", `${name}.json`);
}
