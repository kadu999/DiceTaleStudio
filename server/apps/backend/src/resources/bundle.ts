import { createHash } from "node:crypto";
import { zipSync, type Zippable } from "fflate";
import {
  PROJECT_FOLDERS,
  PROJECT_SPECIAL_FILES,
  projectExists,
  readProjectEntries,
  type ResourceProvider,
} from "@dts/resources";

/**
 * 运行态**资源包**：把一个项目的 `Assets/` 打成**一个 zip**，让前端连上后一次拉完。
 *
 * 为什么是整包而不是逐文件：前端要的是「本地先有一份完整素材，之后不再逐张走 HTTP」
 * （离线可跑、切图不再等网络）。逐文件要 N 次往返且没有原子性，整包一次请求、
 * 一次校验、一次落盘，简单得多。包里的条目名就是**项目根相对路径**
 * （`Assets/images/Map001.png`），前端按逻辑 ID 就能直接映射到本地文件。
 *
 * **压缩方式刻意选 STORED（不压缩）**：
 * - 使用成熟 ZIP 实现并设置 level 0，保持 STORED，不对已压缩素材重复压缩；
 * - 素材本身（png / mp4 / mp3 / wav）已经是压缩格式，deflate 基本省不下体积；
 * - 代价是传输量 = 文件字节总和，`app.json` 的 `bundle.maxTotalBytes` 兜住上限。
 *
 * 内存口径：整包在内存里拼（读文件 → 拼 Buffer）。当前项目量级（几十 MB）没问题，
 * 超过 `maxTotalBytes`（默认 256 MB）会被 HTTP 层以 413 拒绝，不会把内存吃光。
 */

/** 不允许进包的项目内文件（相对项目根的路径）。 */
const EXCLUDED_FILES: readonly string[] = [...PROJECT_SPECIAL_FILES];

/** 包内的清单文件名（前端解压后可以用它校验包内容）。 */
export const BUNDLE_MANIFEST_NAME = "dts-bundle.json";

/** 包内一个文件。 */
export interface BundleEntry {
  /** 资源逻辑 ID（前端镜像里用的就是它）。 */
  readonly id: string;
  /** 项目根相对路径（= zip 里的条目名），如 `Assets/images/Map001.png`。 */
  readonly path: string;
  readonly size: number;
  /** 修改时间（毫秒）；内存 provider 可能不提供，缺失时为 0。 */
  readonly mtimeMs: number;
}

/** 一个项目的资源清单 + 指纹。 */
export interface ProjectManifest {
  readonly project: string;
  /** 全部文件按 `path:size:mtimeMs` 排序汇总后的 hash，变了才需要重下。 */
  readonly fingerprint: string;
  readonly entries: readonly BundleEntry[];
  /** 全部文件字节数之和。 */
  readonly bytes: number;
}

/** 打好的包。 */
export interface BuiltBundle {
  readonly manifest: ProjectManifest;
  readonly zip: Buffer;
  /** 响应头（含包内清单，省得前端再解一次才知道内容）。 */
  readonly headers: Readonly<Record<string, string>>;
}

/** 项目不存在时抛的错误（HTTP 层据此回 404，不靠字符串匹配）。 */
export class ProjectNotFoundError extends Error {
  constructor(readonly project: string) {
    super(`项目「${project}」不存在`);
    this.name = "ProjectNotFoundError";
  }
}

/** 整包超过上限时抛的错误（HTTP 层据此回 413）。 */
export class BundleTooLargeError extends Error {
  constructor(
    readonly project: string,
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `项目「${project}」的资源包 ${bytes} 字节，超过上限 ${maxBytes} 字节；` +
        `请改用逐文件 /api/resources/raw，或调大 app.json 的 bundle.maxTotalBytes`,
    );
    this.name = "BundleTooLargeError";
  }
}

/**
 * 列出一个项目要进包的文件，并算指纹。
 *
 * 只收 `Assets/` 下的文件：项目文件（`project.json`）是元数据、`.gitkeep` 是占位，
 * 都不该下发给前端。
 */
export async function readProjectManifest(
  provider: ResourceProvider,
  project: string,
): Promise<ProjectManifest> {
  if (!(await projectExists(provider, project))) {
    throw new ProjectNotFoundError(project);
  }

  const assetsPrefix = `${PROJECT_FOLDERS.assets}/`;
  const entries: BundleEntry[] = [];

  for (const entry of await readProjectEntries(provider, project)) {
    if (entry.type !== "file") {
      continue;
    }

    const relative = projectRelativePath(entry.path, project);
    if (!relative.startsWith(assetsPrefix)) {
      continue;
    }

    if (EXCLUDED_FILES.includes(relative) || relative.endsWith("/.gitkeep")) {
      continue;
    }

    entries.push({
      id: entry.id,
      path: relative,
      size: entry.size,
      mtimeMs: entry.modifiedAt === undefined ? 0 : safeParseTime(entry.modifiedAt),
    });
  }

  // 排序保证指纹稳定（provider 的返回顺序不该影响「有没有变」的判定）
  entries.sort((a, b) => a.path.localeCompare(b.path));

  return {
    project,
    fingerprint: fingerprintOf(entries),
    entries,
    bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
  };
}

/**
 * 打进 zip。
 *
 * 除素材外还会写一份 `dts-bundle.json`（清单本身）：前端解压后可以直接核对
 * 「包里有几个文件、指纹是什么」，不用再去问服务端一遍。
 */
export async function buildBundle(
  provider: ResourceProvider,
  project: string,
  options: { readonly maxTotalBytes?: number } = {},
): Promise<BuiltBundle> {
  const manifest = await readProjectManifest(provider, project);
  const maxTotalBytes = options.maxTotalBytes;
  if (maxTotalBytes !== undefined && manifest.bytes > maxTotalBytes) {
    throw new BundleTooLargeError(project, manifest.bytes, maxTotalBytes);
  }

  const files = Object.create(null) as Zippable;
  for (const entry of manifest.entries) {
    const data = Buffer.from(await provider.readBinary(entry.id));
    files[entry.path] = [data, { level: 0, mtime: zipMtimeOf(entry.mtimeMs) }];
  }

  // 清单本身也进包：前端据此校验，不必依赖响应头
  const manifestFile = Buffer.from(
    `${JSON.stringify(
      {
        project: manifest.project,
        fingerprint: manifest.fingerprint,
        bytes: manifest.bytes,
        files: manifest.entries,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  files[BUNDLE_MANIFEST_NAME] = [manifestFile, { level: 0, mtime: new Date() }];

  const zip = Buffer.from(zipSync(files));
  markZipNamesAsUtf8(zip);

  return {
    manifest,
    zip,
    headers: {
      "x-dts-project": encodeURIComponent(manifest.project),
      "x-dts-fingerprint": manifest.fingerprint,
      "x-dts-file-count": String(manifest.entries.length),
      "x-dts-bytes": String(manifest.bytes),
    },
  };
}

/** 指纹：`path:size:mtimeMs` 按 path 排序后拼接的 sha1 前 16 位。 */
export function fingerprintOf(entries: readonly BundleEntry[]): string {
  const text = entries
    .map((entry) => `${entry.path}:${entry.size}:${Math.trunc(entry.mtimeMs)}`)
    .join("\n");
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** 项目内相对路径（去掉 `<项目名>/` 前缀）。 */
function projectRelativePath(path: string, project: string): string {
  const prefix = `${project}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** 解析 ISO 时间；坏值当 0（不影响包的正确性，只影响「会不会被判成变了」）。 */
function safeParseTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function zipMtimeOf(mtimeMs: number): Date {
  const date = new Date(mtimeMs);
  return date.getFullYear() < 1980 ? new Date(1980, 0, 1) : date;
}

/** fflate encodes names as UTF-8 but leaves the ZIP language-encoding flag unset. */
function markZipNamesAsUtf8(zip: Buffer): void {
  const endOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let centralOffset = zip.readUInt32LE(endOffset + 16);
  const entryCount = zip.readUInt16LE(endOffset + 10);

  for (let index = 0; index < entryCount; index += 1) {
    const localOffset = zip.readUInt32LE(centralOffset + 42);
    zip.writeUInt16LE(zip.readUInt16LE(localOffset + 6) | 0x0800, localOffset + 6);

    const nameLength = zip.readUInt16LE(centralOffset + 28);
    const extraLength = zip.readUInt16LE(centralOffset + 30);
    const commentLength = zip.readUInt16LE(centralOffset + 32);
    zip.writeUInt16LE(zip.readUInt16LE(centralOffset + 8) | 0x0800, centralOffset + 8);
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
}
