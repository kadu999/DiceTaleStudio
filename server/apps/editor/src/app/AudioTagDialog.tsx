import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useEditorStore } from "../state/editor-store";
import { allTagsOf, audioCatalog, tagFromInput } from "../panels/audio-catalog";

/**
 * 「选择标签」框（v18 起）：**给一个音频文件勾标签**——只做加 / 去。
 *
 * 从「音频文件」窗口每行的「＋ 标签」按钮弹出。列的是**标签表里的全部标签**
 * （tag 是整数、名字在表里，见 `AudioTagEditorDialog`），点一行 = 这个文件加上 / 去掉它。
 *
 * 三条口径：
 * - **勾选** = 这个文件有没有这个 tag ID（走 `setAudioTags`，整份 ID 清单进文档命令：进撤销栈、可撤销）；
 * - 表里还没有的名字：下面输入框**新建并立即挂上**（一条撤销记录里做完两件事）；
 * - 「改名 / 删除标签」不在这里（那是标签表的事）——本窗口只管**给文件勾哪个**；
 *   表里没人用的标签也会列出来（tag 是整数，先建后用是正常用法）。
 */
export function AudioTagDialog({
  clipId,
  onClose,
}: {
  readonly clipId: string | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  const tree = useEditorStore((state) => state.project.tree);
  const meta = useEditorStore((state) => state.doc.audioMeta);
  const table = useEditorStore((state) => state.doc.audioTags);
  const setAudioTags = useEditorStore((state) => state.setAudioTags);
  const addAudioTagToClip = useEditorStore((state) => state.addAudioTagToClip);
  const openAudioTags = useEditorStore((state) => state.openAudioTags);

  const [draft, setDraft] = useState("");

  // 每次换目标（或重新打开）都清掉没提交的新标签名
  useEffect(() => {
    setDraft("");
  }, [clipId]);

  const rows = useMemo(() => audioCatalog(tree, meta, table), [tree, meta, table]);
  const target = clipId === null ? undefined : rows.find((row) => row.id === clipId);
  const entries = useMemo(() => allTagsOf(table, rows), [table, rows]);

  const selected = target?.tags.map((tag) => tag.id) ?? [];
  const toggle = (tagId: number): void => {
    if (clipId === null) {
      return;
    }

    setAudioTags(
      clipId,
      selected.includes(tagId) ? selected.filter((id) => id !== tagId) : [...selected, tagId],
    );
  };

  /** 新建一个标签并**立刻挂到这个文件上**（表里已有同名 → 复用它的 ID，再挂上）。 */
  const create = (): void => {
    const name = tagFromInput(draft);
    setDraft("");
    if (name === undefined || clipId === null) {
      return;
    }

    addAudioTagToClip(clipId, name);
  };

  return (
    <Dialog.Root open={clipId !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        {/* 压在「音频文件」窗口之上（与「选择音频」两层模态同一套层级） */}
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <Dialog.Content
          data-testid="audio-tag-dialog"
          onEscapeKeyDown={(event) => {
            // 正在敲新标签名时按 Esc = 只清掉这一格，不关窗口（与「音频文件」窗口同一套）
            if ((event.target as HTMLElement | null)?.tagName === "INPUT") {
              event.preventDefault();
            }
          }}
          className="fixed left-1/2 top-1/2 z-[70] flex h-[460px] w-[480px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-1 flex-none text-[13px] font-semibold">
            选择标签{target === undefined ? "" : `：${target.displayName}`}
          </Dialog.Title>
          <div className="mb-2 flex flex-none text-[11px] text-[var(--color-editor-text-dim)]">
            勾选 = 这个文件有它；框里新建的名字会直接挂上。改名 / 删除标签在
            <button
              type="button"
              data-testid="audio-tag-open-editor"
              title="打开「标签」窗口：给每个 tag ID 改名字 / 删除"
              className="ml-1 text-[var(--color-editor-accent)] underline"
              onClick={() => {
                // 先收起本框：三层模态叠着容易点错（标签窗口本身是独立入口）
                onClose();
                openAudioTags(true);
              }}
            >
              「标签」窗口
            </button>
            里做。
          </div>

          <div className="min-h-0 flex-1 overflow-auto" data-testid="audio-tag-list">
            {entries.length === 0 ? (
              <div
                data-testid="audio-tag-empty"
                className="flex h-full flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]"
              >
                <span>标签表还是空的</span>
                <span>在下面输入一个名字回车：建一个 tag 并挂到这个文件上</span>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {entries.map((entry) => {
                  const active = selected.includes(entry.id);
                  const name = entry.name.length === 0 ? `#${entry.id}（未命名）` : entry.name;
                  return (
                    <div
                      key={entry.id}
                      data-testid="audio-tag-row"
                      data-id={entry.id}
                      data-tag={entry.name}
                      data-selected={active}
                      data-count={entry.count}
                      className={`flex items-center gap-2 rounded border px-1.5 py-1 ${
                        active
                          ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)]"
                          : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel-alt)]"
                      }`}
                    >
                      <button
                        type="button"
                        data-testid="audio-tag-toggle"
                        data-id={entry.id}
                        aria-pressed={active}
                        title={active ? `把这个文件上的「${name}」去掉` : `给这个文件加上「${name}」`}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => toggle(entry.id)}
                      >
                        <span className="w-3 flex-none text-center text-[11px] text-[var(--color-editor-accent)]">
                          {active ? "✓" : ""}
                        </span>
                        <span className="w-7 flex-none font-mono text-[10px] text-[var(--color-editor-text-dim)]">
                          #{entry.id}
                        </span>
                        <span className="truncate text-[11px]">{name}</span>
                        <span className="ml-auto flex-none pl-2 text-[10px] text-[var(--color-editor-text-dim)]">
                          {entry.count} 个文件在用
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {target === undefined ? (
            <div className="mt-2 flex-none text-[11px] text-[var(--color-editor-warn)]">
              这个音频文件已经不在了（它的标注可能刚被清掉）——关掉就行。
            </div>
          ) : (
            <div className="mt-2 flex flex-none items-center gap-2 border-t border-[var(--color-editor-border)] pt-2">
              <input
                data-testid="audio-tag-new"
                value={draft}
                placeholder="新建标签…"
                aria-label="新建标签"
                title="敲一个名字回车：占一个 tag ID 并挂到这个文件上（表里已有同名就用它）"
                className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-2 py-1 text-[11px] outline-none placeholder:text-[var(--color-editor-text-dim)]"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    create();
                  } else if (event.key === "Escape") {
                    setDraft("");
                  }
                }}
              />
              <button
                type="button"
                data-testid="audio-tag-create"
                disabled={tagFromInput(draft) === undefined}
                title="建出这个标签并挂到当前文件上"
                className="toolbar-button flex-none hover:toolbar-button-hover"
                onClick={create}
              >
                添加
              </button>
            </div>
          )}

          <div className="mt-2 flex flex-none justify-end">
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="audio-tag-close"
                className="toolbar-button hover:toolbar-button-hover"
              >
                关闭
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
