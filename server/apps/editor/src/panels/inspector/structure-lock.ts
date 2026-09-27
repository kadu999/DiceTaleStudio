import { useEditorStore } from "../../state/editor-store";

/**
 * **运行态锁住列表的加 / 删条目**（值照旧能改）。
 *
 * 运行态是「跟现场一起跑」的那一份：这时候往清单里加减条目（声音 / 视频的清单、放大镜的状态、
 * 传送阵的候选场景…）会让前端那一侧跟着对不上（`picked` 下标、正在放的那一条、揭示记录都指不过来），
 * 所以这些**加 / 删**按钮在运行态一律禁用；改「选中哪一条 / 文字 / 位置 / 开关」这些不受影响。
 *
 * 与「运行中的改动不会保存」是两件事：那个说的是**存不存盘**，这个说的是**运行态能不能动结构**。
 */
export function useStructureLocked(): boolean {
  return useEditorStore((state) => state.mode === "run");
}

/** 锁上时贴在按钮 `title` 前面的那句说明。 */
export const STRUCTURE_LOCK_HINT = "运行态不能加减条目（点「编辑」回到编辑态再改）";

/** 把「禁用」那套类名并进按钮的 className（运行态锁住时统一用）。 */
export function structureLockedClass(locked: boolean): string {
  return locked
    ? " cursor-not-allowed opacity-40 hover:border-[var(--color-editor-border)] hover:text-[var(--color-editor-text-dim)]"
    : "";
}
