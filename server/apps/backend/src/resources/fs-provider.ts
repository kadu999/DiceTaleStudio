import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  RESOURCE_KINDS,
  formatResourceId,
  parseResourceId,
  type ResourceDirs,
  type ResourceEntry,
  type ResourceKind,
  type ResourceProvider,
} from "@dts/resources";

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
    const buffer = await readFile(this.pathFor(id));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  }

  async writeText(id: string, text: string): Promise<void> {
    const path = this.pathFor(id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf8");
  }

  async writeBinary(id: string, data: ArrayBuffer): Promise<void> {
    const path = this.pathFor(id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(data));
  }

  async ensureFolder(id: string): Promise<void> {
    await mkdir(this.pathFor(id), { recursive: true });
  }

  async remove(id: string): Promise<void> {
    await rm(this.pathFor(id), { force: true, recursive: true });
  }

  /**
   * 重命名资源（文件或目录）。
   *
   * 校验顺序与错误消息跟内存实现一致：类别一致 → 源存在 → 目标不存在。
   * **绝不覆盖用户数据**：目标已存在时直接抛错，磁盘上不做任何动作。
   * 重命名场景（`Assets/scenes/<场景名>.json`）就靠它——只搬文件，内容不重写。
   */
  async rename(fromId: string, toId: string): Promise<void> {
    const from = parseResourceId(fromId);
    const to = parseResourceId(toId);
    if (from.kind !== to.kind) {
      throw new Error(`重命名两端类别必须一致: ${fromId} → ${toId}`);
    }

    // pathFor 顺带做越权校验；下面两个 stat 都按「路径是否存在」判断，目录同样算存在
    const fromPath = this.pathFor(fromId);
    const toPath = this.pathFor(toId);
    if (!(await existsAt(fromPath))) {
      throw new Error(`资源不存在: ${fromId}`);
    }

    if (await existsAt(toPath)) {
      throw new Error(`资源已存在: ${toId}`);
    }

    await mkdir(dirname(toPath), { recursive: true });
    await rename(fromPath, toPath);
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
