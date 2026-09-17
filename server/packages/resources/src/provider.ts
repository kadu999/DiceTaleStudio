import type { ResourceKind } from "./ids";
import { RESOURCE_KINDS } from "./ids";

/**
 * 资源访问抽象。
 *
 * 三种实现（浏览器 / Node / 测试），业务代码只依赖本接口：
 * - `MemoryResourceProvider`（测试）
 * - `FsResourceProvider`（apps/backend，唯一碰磁盘的地方）
 * - `HttpResourceProvider`（apps/editor，走 /api/resources/*）
 */
export interface ResourceEntry {
  readonly id: string;
  readonly kind: ResourceKind;
  /** 类别目录内的相对路径（跑团资源即 `<跑团名>/...`）。 */
  readonly path: string;
  /** 目录条目也要列出来——否则编辑器里刚建的空目录会「看不见」。 */
  readonly type: "file" | "folder";
  /** 文件字节数；目录为 0。 */
  readonly size: number;
  /** ISO 时间字符串；内存实现可能不提供。 */
  readonly modifiedAt?: string;
}

export interface ResourceProvider {
  /** 列出某类别（不传则列出全部）下的资源。 */
  list(kind?: ResourceKind): Promise<ResourceEntry[]>;
  exists(id: string): Promise<boolean>;
  readText(id: string): Promise<string>;
  readBinary(id: string): Promise<ArrayBuffer>;
  writeText(id: string, text: string): Promise<void>;
  writeBinary(id: string, data: ArrayBuffer): Promise<void>;
  /** 确保目录存在（新建跑团时建立标准子目录；已存在则不报错）。 */
  ensureFolder(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** 各类别目录名 → 资源根下的实际目录。 */
export type ResourceDirs = { readonly [kind in ResourceKind]: string };

/** 默认目录名（与 resources/ 下的实际结构一致）。 */
export const DEFAULT_RESOURCE_DIRS: ResourceDirs = {
  config: "config",
  campaign: "campaigns",
};

/** 校验 ResourceDirs 覆盖了全部类别。 */
export function assertCompleteDirs(dirs: Partial<ResourceDirs>): ResourceDirs {
  const missing = RESOURCE_KINDS.filter((kind) => !dirs[kind]);
  if (missing.length > 0) {
    throw new Error(`资源配置缺少目录: ${missing.join(", ")}`);
  }

  return dirs as ResourceDirs;
}
