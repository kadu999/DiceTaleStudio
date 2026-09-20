import { createHash } from "node:crypto";
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
 * - 后端没有 zip 依赖，自研 writer 用 STORED 才不必实现 deflate，能用真实解压器验证；
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

  const files: ZipInput[] = [];
  for (const entry of manifest.entries) {
    const data = Buffer.from(await provider.readBinary(entry.id));
    files.push({ name: entry.path, data, mtime: new Date(entry.mtimeMs) });
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
  files.push({ name: BUNDLE_MANIFEST_NAME, data: manifestFile, mtime: new Date() });

  return {
    manifest,
    zip: writeZipStored(files),
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

// ---------------------------------------------------------------- 最小 zip writer（STORED）

interface ZipInput {
  readonly name: string;
  readonly data: Buffer;
  readonly mtime: Date;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_SIGNATURE = 0x06054b50;
/** 版本 2.0：只声明「支持 deflate 之外的 STORED」也够了，用 20 最通用。 */
const VERSION_NEEDED = 20;
/** 通用位标记 0x0800：文件名是 UTF-8（条目名含中文，必须声明）。 */
const FLAG_UTF8 = 0x0800;
/** 压缩方式 0 = STORED。 */
const METHOD_STORED = 0;

/**
 * 写一个 STORED（不压缩）zip。
 *
 * 布局是最朴素的「本地文件头 + 数据（连续若干条）+ 中央目录 + EOCD」——
 * 不使用数据描述符（CRC 与大小在写头之前已知），所以不需要流式回填，逻辑最简单。
 */
function writeZipStored(inputs: readonly ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const input of inputs) {
    const nameBytes = Buffer.from(input.name, "utf8");
    const crc = crc32(input.data);
    const { dosTime, dosDate } = toDosDateTime(input.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_STORED, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(input.data.length, 18);
    local.writeUInt32LE(input.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // 无 extra field

    locals.push(local, nameBytes, input.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    central.writeUInt16LE(VERSION_NEEDED, 4); // 创建者版本
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(METHOD_STORED, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(input.data.length, 20);
    central.writeUInt32LE(input.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // 起始磁盘
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42); // 本地头偏移

    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + input.data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_SIGNATURE, 0);
  end.writeUInt16LE(0, 4); // 本磁盘号
  end.writeUInt16LE(0, 6); // 中央目录起始磁盘
  end.writeUInt16LE(inputs.length, 8);
  end.writeUInt16LE(inputs.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // 无注释

  return Buffer.concat([...locals, centralBuffer, end]);
}

/** 把时间转成 MS-DOS 的 (date, time)（zip 头里只有这个精度，秒按 2 秒粒度）。 */
function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  // 1980 年之前无法表示：zip 的时间戳下限就是 1980-01-01
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

/** CRC32（zip 用的那个多项式）。自己算，不依赖 Node 版本是否带 zlib.crc32。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}
