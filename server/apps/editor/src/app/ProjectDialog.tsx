import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useEditorStore, type ProjectDialogMode } from "../state/editor-store";

/**
 * 项目对话框：新建项目 / 打开项目。
 *
 * 一个项目 = 一个文件夹 + 一个固定名的 `project.json`；这里只负责起名与选择，
 * 实际的目录创建、项目文件写入都在后端完成。
 */

interface ProjectDialogProps {
  readonly mode: ProjectDialogMode;
  readonly onClose: () => void;
}

export function ProjectDialog({ mode, onClose }: ProjectDialogProps): React.JSX.Element {
  const project = useEditorStore((state) => state.project);
  const refreshProjects = useEditorStore((state) => state.refreshProjects);
  const createProject = useEditorStore((state) => state.createProject);
  const openProject = useEditorStore((state) => state.openProject);
  const closeProject = useEditorStore((state) => state.closeProject);
  const deleteProject = useEditorStore((state) => state.deleteProject);

  const [name, setName] = useState("");
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    if (mode === "open") {
      void refreshProjects();
    }

    if (mode !== null) {
      setName("");
      setLocalError("");
    }
  }, [mode, refreshProjects]);

  const submitCreate = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setLocalError("请输入项目名");
      return;
    }

    const ok = await createProject(trimmed);
    if (ok) {
      onClose();
    } else {
      setLocalError(project.error || "创建失败");
    }
  };

  return (
    <Dialog.Root open={mode !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid="project-dialog"
          data-mode={mode ?? "closed"}
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 text-[13px] font-semibold">
            {mode === "create" ? "新建项目" : "打开项目"}
          </Dialog.Title>

          {mode === "create" ? (
            <div className="flex flex-col gap-2">
              <label className="text-[11px] text-[var(--color-editor-text-dim)]" htmlFor="project-name">
                项目名（会作为文件夹名，不能包含 \ / : * ? " &lt; &gt; | 等字符）
              </label>
              <input
                id="project-name"
                data-testid="project-name-input"
                autoFocus
                value={name}
                placeholder="例如：迷雾山庄"
                className="rounded border border-[var(--color-editor-border)] bg-black/30 px-2 py-1 text-[12px] outline-none"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void submitCreate();
                  }
                }}
              />
            </div>
          ) : (
            <div className="max-h-[50vh] min-h-[120px] overflow-auto rounded border border-[var(--color-editor-border)]">
              {project.list.length === 0 ? (
                <div className="px-2 py-3 text-[11px] text-[var(--color-editor-text-dim)]">
                  还没有项目。用「工程 → 新建项目」创建第一个。
                </div>
              ) : (
                project.list.map((item) => (
                  <div
                    key={item.name}
                    data-testid="project-row"
                    data-name={item.name}
                    className="flex items-center gap-2 border-b border-[var(--color-editor-border)] px-2 py-1 last:border-b-0"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => {
                        void openProject(item.name).then((ok) => {
                          if (ok) {
                            onClose();
                          }
                        });
                      }}
                    >
                      <span className="truncate text-[12px]">{item.name}</span>
                      <span className="ml-2 text-[10px] text-[var(--color-editor-text-dim)]">
                        {item.fileCount} 个文件
                      </span>
                    </button>
                    <button
                      type="button"
                      className="toolbar-button hover:toolbar-button-hover"
                      onClick={() => {
                        if (confirm(`确定删除项目「${item.name}」？该操作会删除其全部资源，且不可恢复。`)) {
                          void deleteProject(item.name);
                        }
                      }}
                    >
                      删除
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {localError.length > 0 || project.error.length > 0 ? (
            <div className="mt-2 text-[11px] text-[var(--color-editor-danger)]">
              {localError || project.error}
            </div>
          ) : null}

          <div className="mt-3 flex items-center justify-end gap-2">
            {project.current !== null ? (
              <button
                type="button"
                className="toolbar-button hover:toolbar-button-hover mr-auto"
                onClick={() => {
                  closeProject();
                  onClose();
                }}
              >
                关闭当前项目
              </button>
            ) : null}
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="project-dialog-cancel"
                className="toolbar-button hover:toolbar-button-hover"
              >
                取消
              </button>
            </Dialog.Close>
            {mode === "create" ? (
              <button
                type="button"
                data-testid="confirm-create-project"
                className="rounded bg-[var(--color-editor-accent)] px-3 py-1 text-[12px] text-black"
                onClick={() => void submitCreate()}
              >
                创建
              </button>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
