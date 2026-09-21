import { useEditorStore } from "../state/editor-store";
import type { SceneSaveState } from "../state/editor-store";
import type { TransformTool } from "@dts/renderer";

/** 保存状态的显示文案（自动存与手动保存共用同一个状态；场景与工程文件各有各的）。 */
const SAVE_STATE_LABELS: Record<SceneSaveState, string> = {
  saved: "已保存",
  pending: "未保存",
  saving: "保存中…",
  error: "保存失败",
  // 运行态下不写盘（退出运行会整体还原），所以这里不是「未保存」而是「不保存」
  runtime: "运行中（不保存）",
};

/** 变换工具的中文名（状态栏显示用）。 */
const TOOL_LABELS: Record<TransformTool, string> = {
  none: "拖动",
  move: "移动",
  rotate: "旋转",
  scale: "缩放",
};

export function StatusBar(): React.JSX.Element {
  const mode = useEditorStore((state) => state.mode);
  const doc = useEditorStore((state) => state.doc);
  // 只要「有几个场景」这个数：订阅整个 `scenes` 会让状态栏在每次拖手柄时都跟着重渲染
  const sceneCount = useEditorStore((state) => state.scenes.length);
  // 当前场景名（字符串原始值）：同样不必订阅整个场景列表
  const activeSceneName = useEditorStore(
    (state) => state.scenes.find((scene) => scene.name === state.activeSceneName)?.name ?? "—",
  );
  const saveState = useEditorStore((state) => state.sceneSaveState);
  const projectSaveState = useEditorStore((state) => state.projectSaveState);
  const selection = useEditorStore((state) => state.selectedObjectIds);
  const status = useEditorStore((state) => state.runtime.status);
  const runtimeActive = useEditorStore((state) => state.runtime.runtimeActive);
  const clientConnected = useEditorStore((state) => state.runtime.client !== null);
  const tool = useEditorStore((state) => state.ui.tool);

  const runtimeLabel =
    mode === "edit"
      ? "编辑状态"
      : status === "open"
        ? runtimeActive
          ? `运行中 · 前端${clientConnected ? "已连接" : "等待连接"}`
          : "运行中 · 正在开闸…"
        : status === "connecting"
          ? "运行中 · 连接中…"
          : "运行中 · 未连接";

  return (
    <footer className="flex h-6 flex-none items-center gap-4 border-t border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] px-2 text-[11px] text-[var(--color-editor-text-dim)]">
      <span data-testid="status-doc">{doc.name}</span>
      <span data-testid="status-scenes">场景 {sceneCount}</span>
      <span
        data-testid="status-scene-save"
        data-state={saveState}
        className={saveState === "error" ? "text-[var(--color-editor-danger)]" : undefined}
      >
        {SAVE_STATE_LABELS[saveState]}
      </span>
      {/* 工程文件（全局设置）的保存状态单独一格：它与场景是两份文件，
          合起来说「已保存」会让人以为两边都落了盘 */}
      <span
        data-testid="status-project-save"
        data-state={projectSaveState}
        className={projectSaveState === "error" ? "text-[var(--color-editor-danger)]" : undefined}
        title="工程文件（project.json：全局设置）的保存状态"
      >
        工程{SAVE_STATE_LABELS[projectSaveState]}
      </span>
      <span data-testid="status-active-scene">当前场景 {activeSceneName}</span>
      <span data-testid="status-selection">已选 {selection.length}</span>
      {/* 当前变换工具：与场景面板上的开关同一个值。放状态栏是为了**一眼确认**
          「现在拖动是摆位置还是转角度」——切错了工具却不知道，是最容易白费功夫的一种错 */}
      <span data-testid="status-tool" data-tool={tool}>
        工具 {TOOL_LABELS[tool]}
      </span>
      <span data-testid="status-mode" data-mode={mode} className="ml-auto flex items-center gap-1">
        <span
          data-testid="status-mode-dot"
          className="inline-block h-2 w-2 rounded-full"
          style={{
            background:
              mode === "edit"
                ? "var(--color-editor-text-dim)"
                : status === "open"
                  ? "var(--color-editor-ok)"
                  : status === "error"
                    ? "var(--color-editor-danger)"
                    : "var(--color-editor-warn)",
          }}
        />
        {runtimeLabel}
      </span>
    </footer>
  );
}
