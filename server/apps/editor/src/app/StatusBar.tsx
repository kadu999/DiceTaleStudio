import { useEditorStore } from "../state/editor-store";

export function StatusBar(): React.JSX.Element {
  const mode = useEditorStore((state) => state.mode);
  const doc = useEditorStore((state) => state.doc);
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const selection = useEditorStore((state) => state.selectedObjectIds);
  const status = useEditorStore((state) => state.runtime.status);
  const clientConnected = useEditorStore((state) => state.runtime.clientConnected);

  const activeScene = scenes.find((scene) => scene.name === activeSceneName);

  const runtimeLabel =
    mode === "edit"
      ? "编辑状态"
      : status === "open"
        ? `运行中 · 前端${clientConnected ? "已连接" : "未连接"}`
        : status === "connecting"
          ? "运行中 · 连接中…"
          : "运行中 · 未连接";

  return (
    <footer className="flex h-6 flex-none items-center gap-4 border-t border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] px-2 text-[11px] text-[var(--color-editor-text-dim)]">
      <span data-testid="status-doc">{doc.name}</span>
      <span data-testid="status-scenes">场景 {scenes.length}</span>
      <span data-testid="status-active-scene">当前场景 {activeScene?.name ?? "—"}</span>
      <span data-testid="status-selection">已选 {selection.length}</span>
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
