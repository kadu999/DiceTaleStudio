import { isAssetMetaPath, parseResourceId, type ResourceKind } from "./ids";
import {
  assertRenameAllowed,
  assetFolderPathsFor,
  assetMetaIdFor,
  ensureAssetMetaCore,
} from "./meta";
import type { ResourceEntry, ResourceProvider } from "./provider";

/**
 * 内存资源实现：单元测试与 Mock 用，不触碰磁盘。
 */
export class MemoryResourceProvider implements ResourceProvider {
  private readonly files = new Map<string, Uint8Array>();
  private readonly folders = new Set<string>();

  constructor(seed: Record<string, string | Uint8Array | ArrayBuffer> = {}) {
    for (const [id, value] of Object.entries(seed)) {
      this.files.set(id, toBytes(value));
    }
  }

  /** 直接写入（测试准备数据用，走 ID 校验）。 */
  seed(id: string, value: string | Uint8Array | ArrayBuffer): void {
    parseResourceId(id);
    this.files.set(id, toBytes(value));
  }

  /** 已登记的目录（测试断言用）。 */
  listFolders(): string[] {
    return [...this.folders].sort();
  }

  async list(kind?: ResourceKind): Promise<ResourceEntry[]> {
    const entries: ResourceEntry[] = [];

    for (const [id, bytes] of this.files) {
      const parsed = parseResourceId(id);
      if (kind !== undefined && parsed.kind !== kind) {
        continue;
      }

      // 素材的 meta 与文件系统实现同一条口径：元数据不进资源树 / 素材清单
      if (isAssetMetaPath(parsed.path)) {
        continue;
      }

      await this.ensureAssetMeta(id);

      entries.push({
        id,
        kind: parsed.kind,
        path: parsed.path,
        type: "file",
        size: bytes.byteLength,
      });
    }

    for (const id of this.folders) {
      if (this.files.has(id)) {
        continue;
      }

      const parsed = parseResourceId(id);
      if (kind !== undefined && parsed.kind !== kind) {
        continue;
      }

      if (isAssetMetaPath(parsed.path)) {
        continue;
      }

      entries.push({ id, kind: parsed.kind, path: parsed.path, type: "folder", size: 0 });
    }

    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  async exists(id: string): Promise<boolean> {
    parseResourceId(id);
    return this.files.has(id);
  }

  async readText(id: string): Promise<string> {
    return new TextDecoder().decode(this.require(id));
  }

  async readBinary(id: string): Promise<ArrayBuffer> {
    const bytes = this.require(id);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async writeText(id: string, text: string): Promise<void> {
    parseResourceId(id);
    this.files.set(id, new TextEncoder().encode(text));
    await this.ensureAssetMeta(id);
  }

  async writeBinary(id: string, data: ArrayBuffer): Promise<void> {
    parseResourceId(id);
    this.files.set(id, new Uint8Array(data.slice(0)));
    await this.ensureAssetMeta(id);
  }

  async ensureFolder(id: string): Promise<void> {
    const parsed = parseResourceId(id);
    this.folders.add(id);
    for (const path of assetFolderPathsFor(parsed.kind, parsed.path)) {
      await this.ensureAssetMeta(`${parsed.kind}:${path}`, true);
    }
  }

  /**
   * 删除资源。对目录 ID 做**递归删除**，与文件系统实现（`rm -rf`）语义一致，
   * 这样「删掉整个项目目录」在两处行为相同。
   */
  async remove(id: string): Promise<void> {
    parseResourceId(id);
    const metaId = assetMetaIdFor(id);
    this.files.delete(id);
    this.folders.delete(id);

    const prefix = `${id}/`;
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(prefix)) {
        this.files.delete(key);
      }
    }

    for (const key of [...this.folders]) {
      if (key.startsWith(prefix)) {
        this.folders.delete(key);
      }
    }

    if (metaId !== undefined) {
      this.files.delete(metaId);
    }
  }

  /**
   * 重命名资源。语义与文件系统实现（`FsResourceProvider`）对齐：
   *
   * - 两侧类别必须相同（跨类别重命名没有意义，直接拒绝）；
   * - 源不存在 / 目标已存在都抛错，且**绝不覆盖用户数据**；
   * - 文件只是改 key；
   * - 目录连同其下所有条目一起搬（前缀替换）。
   *
   * 之所以要这一层：场景是 `Assets/scenes/<场景名>.json` 独立文件，
   * **重命名场景就是重命名文件**，内容一个字节都不该被重写。
   */
  async rename(fromId: string, toId: string): Promise<void> {
    const from = parseResourceId(fromId);
    const to = parseResourceId(toId);
    const fromMeta = assetMetaIdFor(fromId);
    const toMeta = assetMetaIdFor(toId);
    assertRenameAllowed({
      fromId,
      toId,
      fromKind: from.kind,
      toKind: to.kind,
      fromExists: this.files.has(fromId) || this.folders.has(fromId),
      toExists: this.files.has(toId) || this.folders.has(toId),
      fromMetaId: fromMeta,
      toMetaId: toMeta,
      fromMetaExists: fromMeta !== undefined && this.files.has(fromMeta),
      toMetaExists: toMeta !== undefined && this.files.has(toMeta),
    });

    // 源自身与「源目录下的一切」统一按前缀替换：文件就是 id === fromId 的那一条
    const prefix = `${fromId}/`;
    const moved = (id: string): string => `${toId}${id.slice(fromId.length)}`;

    for (const [id, bytes] of [...this.files]) {
      if (id === fromId || id.startsWith(prefix)) {
        this.files.delete(id);
        this.files.set(moved(id), bytes);
      }
    }

    for (const id of [...this.folders]) {
      if (id === fromId || id.startsWith(prefix)) {
        this.folders.delete(id);
        this.folders.add(moved(id));
      }
    }

    if (fromMeta !== undefined && toMeta !== undefined) {
      const bytes = this.files.get(fromMeta);
      this.files.delete(fromMeta);
      if (bytes !== undefined) {
        this.files.set(toMeta, bytes);
      }
    }
    await this.ensureAssetMeta(toId);
  }

  private async ensureAssetMeta(id: string, folder = false): Promise<void> {
    const metaId = assetMetaIdFor(id);
    const ensured = await ensureAssetMetaCore({
      id,
      metaId,
      metaExists: metaId !== undefined && this.files.has(metaId),
      folder,
      isDirectory: () => this.folders.has(id),
    });
    if (ensured === undefined) {
      return;
    }

    this.files.set(ensured.metaId, new TextEncoder().encode(ensured.text));
  }

  private require(id: string): Uint8Array {
    parseResourceId(id);
    const bytes = this.files.get(id);
    if (bytes === undefined) {
      throw new Error(`资源不存在: ${id}`);
    }

    return bytes;
  }
}

/** 便捷工厂。 */
export function createMemoryResourceProvider(
  seed: Record<string, string | Uint8Array | ArrayBuffer> = {},
): MemoryResourceProvider {
  return new MemoryResourceProvider(seed);
}

function toBytes(value: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }

  return value instanceof Uint8Array ? value.slice() : new Uint8Array(value.slice(0));
}
