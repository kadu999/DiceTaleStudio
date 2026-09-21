import type { TransformTool } from "@dts/renderer";

/**
 * 编辑器的**界面偏好**（浏览器本地）。
 *
 * 这里存的是「怎么看、怎么操作」，不是「编辑了什么」：当前变换工具（移动 / 旋转 / 缩放）
 * 与「背景音乐弹框里显不显示路径」。它们**不进文档**、不进协议、也不下发给 Unity：
 * 换个工具是「我现在想怎么摆对象」，露不露路径是「这张清单我想看多细」，
 * 和场景内容无关，不该让文件因为点了一下按钮就变脏。
 *
 * 与网格标注偏好（`grid-paint-prefs.ts`）同一套写法：读写一律吞掉异常，
 * 隐私模式 / 禁用站点存储时记不住也不该让编辑器打不开。
 */

export interface EditorPrefs {
  /** 当前变换工具（画布上的手柄跟着它换）。 */
  readonly tool: TransformTool;
  /**
   * 「背景音乐」弹框里**在行右边显示路径**吗（默认不显示——清单干净优先）。
   *
   * 与 [网格标注](`grid-paint-prefs.ts`) 的网格线 / 标注两个开关同一类东西：
   * 纯显示项，改它不该让任何文件变脏，但下次打开还该是我上次选的那样。
   */
  readonly bgmPaths: boolean;
}

const EDITOR_PREFS_KEY = "dts.editor.ui";

/**
 * 默认偏好：**拖动**，路径**不显示**。
 *
 * 默认停在「拖动」是有意的——它正是「手柄出现之前」那个行为（拖对象 = 摆位置、
 * 拖空白 = 平移画布），所以升级到带手柄的版本时，谁的界面都不会突然换个样子，
 * 也不会有人不小心把对象拖歪。
 */
export function defaultEditorPrefs(): EditorPrefs {
  return { tool: "none", bgmPaths: false };
}

/** 读偏好；没有记录、内容损坏或存储不可用时退回默认值（不抛错）。 */
export function readEditorPrefs(): EditorPrefs {
  try {
    const raw = window.localStorage.getItem(EDITOR_PREFS_KEY);
    if (raw === null || raw.length === 0) {
      return defaultEditorPrefs();
    }

    return parseEditorPrefs(JSON.parse(raw) as unknown);
  } catch {
    return defaultEditorPrefs();
  }
}

/** 记住这次的选择。 */
export function writeEditorPrefs(prefs: EditorPrefs): void {
  try {
    window.localStorage.setItem(EDITOR_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 存储不可用：本次会话照常工作，只是下次回到默认值
  }
}

/**
 * 解析并规范化存储里的内容（认不出的工具名退回默认值，而不是塞进状态里）。
 *
 * 旧版本（还没有 `bgmPaths` 时）写下的记录里没有这一项 → 用默认值（不显示路径），
 * 与「升级后界面不会突然变样」同一条规矩。
 */
export function parseEditorPrefs(raw: unknown): EditorPrefs {
  const fallback = defaultEditorPrefs();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fallback;
  }

  const record = raw as Record<string, unknown>;
  const tool = record.tool;
  return {
    tool: isTransformTool(tool) ? tool : fallback.tool,
    bgmPaths: typeof record.bgmPaths === "boolean" ? record.bgmPaths : fallback.bgmPaths,
  };
}

/** 工具名的合法取值判定（存储是用户能改的，也可能被旧版本写坏）。 */
export function isTransformTool(value: unknown): value is TransformTool {
  return value === "none" || value === "move" || value === "rotate" || value === "scale";
}
