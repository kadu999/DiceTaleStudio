import { useEditorStore } from "../state/editor-store";

/**
 * 空状态占位。
 *
 * 这一处**必须显式提示**：没有项目 / 没有场景时面板和画布都是空的，
 * 而「为什么是空的」看不出来——不像空对象列表那样一眼可见（那是内容本身如此）。
 *
 * 没有场景时占位**本身就是入口**：点一下直接弹「新建场景」，不用去菜单里找。
 */
export function EmptyState(): React.JSX.Element {
  const hasProject = useEditorStore((state) => state.project.current !== null);
  const openSceneDialog = useEditorStore((state) => state.openSceneDialog);

  if (!hasProject) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="rounded border border-dashed border-[var(--color-editor-border)] px-4 py-3 text-center text-[11px] leading-relaxed text-[var(--color-editor-text-dim)]">
          <div className="text-[12px] text-[var(--color-editor-text)]">没有打开项目</div>
          <div className="mt-1">菜单「工程」里可以新建或打开项目</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <button
        type="button"
        data-testid="empty-create-scene"
        onClick={() => openSceneDialog("create")}
        className="rounded border border-dashed border-[var(--color-editor-border)] px-4 py-3 text-center text-[11px] leading-relaxed text-[var(--color-editor-text-dim)] hover:border-[var(--color-editor-accent)] hover:text-[var(--color-editor-text)]"
      >
        <span className="block text-[12px] text-[var(--color-editor-text)]">没有场景</span>
        <span className="mt-1 block">点这里新建一个场景</span>
      </button>
    </div>
  );
}
