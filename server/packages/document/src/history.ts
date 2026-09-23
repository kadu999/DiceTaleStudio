import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from "immer";
import type { SceneDoc } from "./types";

enablePatches();

/**
 * 场景列表 recipe 的 draft 类型。
 *
 * 场景是独立文件、不进工程文件，所以场景/对象编辑的历史挂在**场景列表**上；
 * 编辑器不必直接依赖 immer。
 */
export type SceneListDraft = Draft<readonly SceneDoc[]>;

/**
 * 补丁式撤销 / 重做。
 *
 * 用 immer 的 `produceWithPatches` 记录可逆补丁，因此每个命令不需要手写反向逻辑；
 * 补丁本身可序列化，将来做「操作广播 / 协同」时可直接复用。
 */

export interface HistoryEntry {
  label: string;
  patches: Patch[];
  inversePatches: Patch[];
  /** 连续同类操作（拖拽、连续绘制、连续输入）的合并键。 */
  coalesceKey?: string;
  time: number;
}

export interface HistoryOptions {
  /** 历史栈上限。 */
  readonly limit?: number;
  /** 同一 coalesceKey 在该时间窗内合并为一条记录。 */
  readonly coalesceWindowMs?: number;
}

export interface ApplyOptions {
  /**
   * 合并键：同一键的连续操作合并成一条历史记录（例如一次拖拽、一笔绘制）。
   * 不传则每次调用都是一条独立记录。
   */
  readonly coalesceKey?: string;
}

export const DEFAULT_HISTORY_LIMIT = 200;
export const DEFAULT_COALESCE_WINDOW_MS = 700;

/**
 * 文档历史容器。持有当前值、撤销栈、重做栈，并对外广播变更。
 */
export class DocumentHistory<T> {
  private present: T;
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly limit: number;
  private readonly coalesceWindowMs: number;

  constructor(initial: T, options: HistoryOptions = {}) {
    this.present = initial;
    this.limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
    this.coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
  }

  /** 当前文档值。 */
  get current(): T {
    return this.present;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 撤销栈标签（最近的在末尾），用于「撤销 xxx」菜单文案。 */
  get undoLabel(): string | undefined {
    return this.undoStack.at(-1)?.label;
  }

  get redoLabel(): string | undefined {
    return this.redoStack.at(-1)?.label;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 应用一次修改。返回值表示是否真的产生了变更（无变更时**不入历史栈**）。
   */
  apply(label: string, recipe: (draft: Draft<T>) => void, options: ApplyOptions = {}): boolean {
    const [next, patches, inversePatches] = produceWithPatches(this.present, recipe);
    if (patches.length === 0) {
      return false;
    }

    const now = Date.now();
    const last = this.undoStack.at(-1);
    const canCoalesce =
      options.coalesceKey !== undefined &&
      last !== undefined &&
      last.coalesceKey === options.coalesceKey &&
      now - last.time <= this.coalesceWindowMs &&
      this.redoStack.length === 0;

    if (canCoalesce && last !== undefined) {
      // 合并：补丁追加，逆补丁前插（撤销时按相反顺序回放）
      last.patches.push(...patches);
      last.inversePatches.unshift(...inversePatches);
      last.time = now;
      last.label = label;
    } else {
      this.undoStack.push({
        label,
        patches: [...patches],
        inversePatches: [...inversePatches],
        ...(options.coalesceKey === undefined ? {} : { coalesceKey: options.coalesceKey }),
        time: now,
      });

      if (this.undoStack.length > this.limit) {
        this.undoStack.shift();
      }
    }

    this.redoStack.length = 0;
    this.present = next;
    this.emit();
    return true;
  }

  /** 结束一次合并序列（松手 / 落笔），使后续同键操作不再并入上一条。 */
  endCoalescing(): void {
    const last = this.undoStack.at(-1);
    if (last !== undefined) {
      delete last.coalesceKey;
    }
  }

  /**
   * 丢掉重做栈（撤销栈不动）。
   *
   * 给「两套历史共用一个撤销入口」的编辑器用：一旦在**另一条轨道**上产生了新的修改，
   * 这条轨道上那些重做记录就属于一条已经不存在的未来——留着它们会让「重做」跳回旧状态。
   * 正常单轨使用时不需要它（`apply` 自己就会清空重做栈）。
   */
  clearRedo(): void {
    this.redoStack.length = 0;
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (entry === undefined) {
      return false;
    }

    // immer 的 applyPatches 约束为 Objectish；T 是我们自己的文档类型，这里显式断言
    this.present = applyPatches(this.present as object, entry.inversePatches) as T;
    this.redoStack.push(entry);
    this.emit();
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (entry === undefined) {
      return false;
    }

    this.present = applyPatches(this.present as object, entry.patches) as T;
    this.undoStack.push(entry);
    this.emit();
    return true;
  }

  /** 整体替换文档（打开/新建项目）并清空历史。 */
  reset(next: T): void {
    this.present = next;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emit();
  }

  /** 历史与当前值的快照（测试与调试用）。 */
  snapshot(): { present: T; undo: HistoryEntry[]; redo: HistoryEntry[] } {
    return {
      present: this.present,
      undo: this.undoStack.map(cloneEntry),
      redo: this.redoStack.map(cloneEntry),
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function cloneEntry(entry: HistoryEntry): HistoryEntry {
  return {
    label: entry.label,
    patches: [...entry.patches],
    inversePatches: [...entry.inversePatches],
    ...(entry.coalesceKey === undefined ? {} : { coalesceKey: entry.coalesceKey }),
    time: entry.time,
  };
}
