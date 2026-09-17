import { parseResourceId, type ResourceKind } from "./ids";
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
  }

  async writeBinary(id: string, data: ArrayBuffer): Promise<void> {
    parseResourceId(id);
    this.files.set(id, new Uint8Array(data.slice(0)));
  }

  async ensureFolder(id: string): Promise<void> {
    parseResourceId(id);
    this.folders.add(id);
  }

  /**
   * 删除资源。对目录 ID 做**递归删除**，与文件系统实现（`rm -rf`）语义一致，
   * 这样「删掉整个跑团目录」在两处行为相同。
   */
  async remove(id: string): Promise<void> {
    parseResourceId(id);
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
