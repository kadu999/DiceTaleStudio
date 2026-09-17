import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { campaignApi } from "../services/campaign-api";
import { useEditorStore } from "../state/editor-store";

/**
 * 跑团工程对话框：新建项目 / 打开项目。
 *
 * 一个跑团 = 一个文件夹 + 一个工程文件；这里只负责起名与选择，
 * 实际的目录创建、工程文件写入都在后端完成。
 */

export type ProjectDialogMode = "create" | "open" | null;

interface ProjectDialogProps {
  readonly mode: ProjectDialogMode;
  readonly onClose: () => void;
}

export function ProjectDialog({ mode, onClose }: ProjectDialogProps): React.JSX.Element {
  const campaign = useEditorStore((state) => state.campaign);
  const refreshCampaigns = useEditorStore((state) => state.refreshCampaigns);
  const createProject = useEditorStore((state) => state.createProject);
  const openProject = useEditorStore((state) => state.openProject);
  const closeProject = useEditorStore((state) => state.closeProject);

  const [name, setName] = useState("");
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    if (mode === "open") {
      void refreshCampaigns();
    }

    if (mode !== null) {
      setName("");
      setLocalError("");
    }
  }, [mode, refreshCampaigns]);

  const submitCreate = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setLocalError("请输入跑团名");
      return;
    }

    const ok = await createProject(trimmed);
    if (ok) {
      onClose();
    } else {
      setLocalError(campaign.error || "创建失败");
    }
  };

  return (
    <Dialog.Root open={mode !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid="project-dialog"
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 text-[13px] font-semibold">
            {mode === "create" ? "新建项目" : "打开项目"}
          </Dialog.Title>

          {mode === "create" ? (
            <div className="flex flex-col gap-2">
              <label className="text-[11px] text-[var(--color-editor-text-dim)]" htmlFor="project-name">
                跑团名（会作为文件夹名，不能包含 \ / : * ? " &lt; &gt; | 等字符）
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
              {campaign.list.length === 0 ? (
                <div className="px-2 py-3 text-[11px] text-[var(--color-editor-text-dim)]">
                  还没有跑团。用「工程 → 新建项目」创建第一个。
                </div>
              ) : (
                campaign.list.map((item) => (
                  <div
                    key={item.name}
                    data-testid="campaign-row"
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
                        {item.hasProject ? `${item.fileCount} 个文件` : "缺少工程文件"}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="toolbar-button hover:toolbar-button-hover"
                      onClick={() => {
                        if (confirm(`确定删除跑团「${item.name}」？该操作会删除其全部资源，且不可恢复。`)) {
                          void campaignApi.remove(item.name).then(() => refreshCampaigns());
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

          {localError.length > 0 || campaign.error.length > 0 ? (
            <div className="mt-2 text-[11px] text-[var(--color-editor-danger)]">
              {localError || campaign.error}
            </div>
          ) : null}

          <div className="mt-3 flex items-center justify-end gap-2">
            {campaign.current !== null ? (
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
              <button type="button" className="toolbar-button hover:toolbar-button-hover">
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
