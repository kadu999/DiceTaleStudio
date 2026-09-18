import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useEditorStore, type SceneDialogMode } from "../state/editor-store";

/**
 * 场景对话框：新建场景 / 重命名当前场景。
 *
 * 场景名就是 `Assets/scenes/` 下的**文件名**，所以这里只负责起名：
 * 建文件、重命名文件都在后端完成，**场景内容编辑器永不改写**。
 */

interface SceneDialogProps {
  readonly mode: SceneDialogMode;
  readonly onClose: () => void;
}

export function SceneDialog({ mode, onClose }: SceneDialogProps): React.JSX.Element {
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const createScene = useEditorStore((state) => state.createScene);
  const renameScene = useEditorStore((state) => state.renameScene);

  const [name, setName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (mode === null) {
      return;
    }

    setName(mode === "rename" ? (activeSceneName ?? "") : "");
    setError("");
  }, [mode, activeSceneName]);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("请输入场景名");
      return;
    }

    const reason = mode === "rename" ? await renameScene(trimmed) : await createScene(trimmed);
    if (reason === undefined) {
      onClose();
    } else {
      setError(reason);
    }
  };

  return (
    <Dialog.Root open={mode !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid="scene-dialog"
          data-mode={mode ?? "closed"}
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 -translate-y-1/2 rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 text-[13px] font-semibold">
            {mode === "rename" ? "重命名场景" : "新建场景"}
          </Dialog.Title>

          <input
            id="scene-name"
            data-testid="scene-name-input"
            autoFocus
            value={name}
            placeholder="场景名"
            className="w-full rounded border border-[var(--color-editor-border)] bg-black/30 px-2 py-1 text-[12px] outline-none"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void submit();
              }
            }}
          />

          {error.length > 0 ? (
            <div className="mt-2 text-[11px] text-[var(--color-editor-danger)]">{error}</div>
          ) : null}

          <div className="mt-3 flex items-center justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="scene-dialog-cancel"
                className="toolbar-button hover:toolbar-button-hover"
              >
                取消
              </button>
            </Dialog.Close>
            <button
              type="button"
              data-testid="confirm-scene"
              className="rounded bg-[var(--color-editor-accent)] px-3 py-1 text-[12px] text-black"
              onClick={() => void submit()}
            >
              {mode === "rename" ? "重命名" : "新建"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
