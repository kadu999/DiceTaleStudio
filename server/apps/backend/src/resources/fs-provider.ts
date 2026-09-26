import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  RESOURCE_KINDS,
  assertRenameAllowed,
  assetFolderPathsFor,
  assetMetaIdFor,
  ensureAssetMetaCore,
  formatResourceId,
  isAssetMetaPath,
  parseResourceId,
  type ResourceDirs,
  type ResourceEntry,
  type ResourceKind,
  type ResourceProvider,
} from "@dts/resources";
import { toArrayBuffer } from "../values";

/**
 * 文件系统资源实现——**全后端唯一触碰磁盘的地方**。
 *
 * 逻辑 ID → 真实路径的解析只发生在这里，并对越权路径做二次校验
 * （`parseResourceId` 已挡一层，这里再确认解析结果确实落在类别目录内）。
 */
export class FsResourceProvider implements ResourceProvider {
  private readonly root: string;
  private readonly dirs: ResourceDirs;

  constructor(root: string, dirs: ResourceDirs) {
    this.root = resolve(root);
    this.dirs = dirs;
    this.assertDirsInsideRoot();
  }

  async list(kind?: ResourceKind): Promise<ResourceEntry[]> {
    const kinds = kind === undefined ? RESOURCE_KINDS : [kind];
    const entries: ResourceEntry[] = [];

    for (const current of kinds) {
      const base = this.baseFor(current);
      let names: string[];
      try {
        names = await readdir(base, { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }

        throw error;
      }

      for (const name of names) {
        const full = join(base, name);
        let info;
        try {
          info = await stat(full);
        } catch {
          continue;
        }

        const path = name.split(sep).join("/");
        if (path.endsWith(".gitkeep")) {
          continue;
        }

        // 素材的 meta（`A.png.meta`）是元数据、不是素材：资源树与素材清单里都不该出现
        // （它与 `project.json` 同一档，见 `docs/specs/2026-09-23-asset-meta.md`）
        if (isAssetMetaPath(path)) {
          continue;
        }

        // 写入用的临时文件（写完立刻 rename 掉）：万一进程在中间崩了留下一个，也别让它
        // 出现在资源树里冒充用户的素材
        if (path.endsWith(TEMP_SUFFIX)) {
          continue;
        }

        // 目录也要列（编辑器里刚建的空目录必须可见）
        if (info.isDirectory()) {
          entries.push({
            id: formatResourceId(current, path),
            kind: current,
            path,
            type: "folder",
            size: 0,
            modifiedAt: info.mtime.toISOString(),
          });
          continue;
        }

        if (!info.isFile()) {
          continue;
        }

        // Resource listing is the single entry point for externally added assets.
        try {
          await this.ensureAssetMeta(formatResourceId(current, path));
        } catch {
          // Metadata is auxiliary; read-only or permission errors do not block listing.
        }

        entries.push({
          id: formatResourceId(current, path),
          kind: current,
          path,
          type: "file",
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
      }
    }

    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  async exists(id: string): Promise<boolean> {
    try {
      const info = await stat(this.pathFor(id));
      return info.isFile();
    } catch {
      return false;
    }
  }

  async readText(id: string): Promise<string> {
    return readFile(this.pathFor(id), "utf8");
  }

  async readBinary(id: string): Promise<ArrayBuffer> {
    return toArrayBuffer(await readFile(this.pathFor(id)));
  }

  async writeText(id: string, text: string): Promise<void> {
    await writeAtomically(this.pathFor(id), text);
    await this.ensureAssetMeta(id);
  }

  async writeBinary(id: string, data: ArrayBuffer): Promise<void> {
    await writeAtomically(this.pathFor(id), Buffer.from(data));
    await this.ensureAssetMeta(id);
  }

  async ensureFolder(id: string): Promise<void> {
    const parsed = parseResourceId(id);
    await mkdir(this.pathFor(id), { recursive: true });
    for (const path of assetFolderPathsFor(parsed.kind, parsed.path)) {
      await this.ensureAssetMeta(`${parsed.kind}:${path}`, true);
    }
  }

  async remove(id: string): Promise<void> {
    const metaId = assetMetaIdFor(id);
    await rm(this.pathFor(id), { force: true, recursive: true });
    if (metaId !== undefined) {
      await rm(this.pathFor(metaId), { force: true, recursive: false });
    }
  }

  /**
   * 重命名资源（文件或目录）。
   *
   * 校验顺序与错误消息跟内存实现一致（`assertRenameAllowed` 唯一一份）：类别一致 →
   * 源存在 → 目标不存在。**绝不覆盖用户数据**：目标已存在时直接抛错，磁盘上不做任何动作。
   * 重命名场景（`Assets/scenes/<场景名>.json`）就靠它——只搬文件，内容不重写。
   */
  async rename(fromId: string, toId: string): Promise<void> {
    const from = parseResourceId(fromId);
    const to = parseResourceId(toId);

    // pathFor 顺带做越权校验；下面两个 stat 都按「路径是否存在」判断，目录同样算存在
    const fromPath = this.pathFor(fromId);
    const toPath = this.pathFor(toId);
    const fromMeta = assetMetaIdFor(fromId);
    const toMeta = assetMetaIdFor(toId);
    const fromMetaPath = fromMeta === undefined ? undefined : this.pathFor(fromMeta);
    const toMetaPath = toMeta === undefined ? undefined : this.pathFor(toMeta);
    assertRenameAllowed({
      fromId,
      toId,
      fromKind: from.kind,
      toKind: to.kind,
      fromExists: await existsAt(fromPath),
      toExists: await existsAt(toPath),
      fromMetaId: fromMeta,
      toMetaId: toMeta,
      fromMetaExists: fromMetaPath !== undefined && (await existsAt(fromMetaPath)),
      toMetaExists: toMetaPath !== undefined && (await existsAt(toMetaPath)),
    });

    await mkdir(dirname(toPath), { recursive: true });
    await rename(fromPath, toPath);
    if (fromMetaPath !== undefined && toMetaPath !== undefined && (await existsAt(fromMetaPath))) {
      await mkdir(dirname(toMetaPath), { recursive: true });
      await rename(fromMetaPath, toMetaPath);
    }
    await this.ensureAssetMeta(toId);
  }

  private async ensureAssetMeta(id: string, folder = false): Promise<void> {
    const metaId = assetMetaIdFor(id);
    const ensured = await ensureAssetMetaCore({
      id,
      metaId,
      metaExists: metaId !== undefined && (await this.exists(metaId)),
      folder,
      // folder 为 true 时调用方已知是目录，这里不会再 stat 一次
      isDirectory: async () => (await stat(this.pathFor(id))).isDirectory() === true,
    });
    if (ensured === undefined) {
      return;
    }

    await writeAtomically(this.pathFor(ensured.metaId), ensured.text);
  }

  private baseFor(kind: ResourceKind): string {
    return resolve(this.root, this.dirs[kind]);
  }

  private pathFor(id: string): string {
    const { kind, path } = parseResourceId(id);
    const base = this.baseFor(kind);
    const full = resolve(base, path);
    const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
    if (full !== base && !full.startsWith(prefix)) {
      throw new Error(`资源路径越出类别目录: ${id}`);
    }

    return full;
  }

  /** 配置里的目录名必须是相对路径且不越出资源根，否则直接拒绝启动。 */
  private assertDirsInsideRoot(): void {
    for (const kind of RESOURCE_KINDS) {
      const dir = this.dirs[kind];
      if (isAbsolute(dir)) {
        throw new Error(`资源配置目录不允许是绝对路径: ${kind} = ${dir}`);
      }

      const resolved = resolve(this.root, dir);
      const prefix = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
      if (resolved !== this.root && !resolved.startsWith(prefix)) {
        throw new Error(`资源配置目录越出资源根: ${kind} = ${dir}`);
      }
    }
  }
}

/**
 * 写入临时文件用的后缀：写完立刻 `rename` 掉（`list()` 会跳过它们）。
 *
 * 为什么绕这一下：`writeFile` 是「先截断、再写」的，**并发读的人会看到空文件或半截 JSON**。
 * 而场景文件是「随时随地自动存」的，编辑器、e2e 用例、外部工具都可能在写的同时读它——
 * 读到半截就会出现「JSON 解析失败」这种看起来毫不相干的偶发错误。
 * `rename` 是原子的（Windows 上 Node 用 MoveFileEx 覆盖目标），所以读的人要么看到旧内容、
 * 要么看到新内容，绝不会看到写了一半的。代价是进程在两步之间崩掉会留一个 `.dts-tmp` 文件——
 * 它不会被列进资源树，也不会被误当成素材。
 */
const TEMP_SUFFIX = ".dts-tmp";

/**
 * 原子写入：同目录临时文件 + rename（必须同卷才能 rename）。
 *
 * 临时文件名**每次都不一样**：同一个文件可能被并发写（自动存与手动保存撞在一起），
 * 共用一个临时名会让先写的那次 `rename` 找不到文件（已经被后写的 rename 走了）。
 */
async function writeAtomically(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid.toString(36)}-${(tempSeq += 1).toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}${TEMP_SUFFIX}`;

  // 写入本身失败（磁盘满 / 权限）也会留下那个临时文件：清理要把它一起包进来，
  // 不能只包住 rename（注释里承诺的「失败就别留垃圾」要覆盖整段）。
  try {
    await writeFile(temp, data);
    await renameWithRetry(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** 临时文件名里的自增序号（同一进程内不重名）。 */
let tempSeq = 0;

/** rename 重试次数与间隔：Windows 上「目标正被别人打开」是可等的（对方读完就放）。 */
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 5;

/**
 * `rename` 带重试。
 *
 * Windows 上替换一个**正被读取方打开**的文件会失败（`EPERM` / `EACCES` / `EBUSY`，
 * 底下是 MoveFileEx 撞上共享冲突）。读取方（HTTP 接口、e2e 用例）都是短命操作，
 * 等几毫秒再试就好——比「写失败」或「把半截文件暴露出去」都强。
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!retryable || attempt >= RENAME_ATTEMPTS) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
    }
  }
}

/**
 * 路径是否存在（不管它是文件还是目录）。
 *
 * 不能复用 `provider.exists`：那个方法按「是不是文件」回答，重命名目录时会被判成不存在。
 */
async function existsAt(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
