import type { ResourceKind } from "./ids";

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
  /** 类别目录内的相对路径（项目资源即 `<项目名>/...`）。 */
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
  /** 确保目录存在（新建项目时建立标准子目录；已存在则不报错）。 */
  ensureFolder(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /**
   * 重命名资源（两侧必须是同一类别）。
   * 源不存在抛 `<源 id> 不存在`；目标已存在抛 `<目标 id> 已存在`（绝不覆盖用户数据）。
   */
  rename(fromId: string, toId: string): Promise<void>;
}

/** 各类别目录名 → 资源根下的实际目录。 */
export type ResourceDirs = { readonly [kind in ResourceKind]: string };

/** 默认目录名（与 resources/ 下的实际结构一致）。 */
export const DEFAULT_RESOURCE_DIRS: ResourceDirs = {
  config: "config",
  project: "projects",
};
