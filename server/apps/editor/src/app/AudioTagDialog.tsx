import { useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useEditorStore } from "../state/editor-store";
import { allTagsOf, audioCatalog } from "../panels/audio-catalog";

/**
 * 「选择标签」框（v18 起）：**给一个音频文件勾标签**——只做加 / 去。
 *
 * 从属性面板标签行的「＋」按钮弹出。列的是**标签表里的全部标签**
 * （tag 是整数、名字在表里，见 `AudioTagEditorDialog`），点一行 = 这个文件加上 / 去掉它。
 *
 * 口径：
 * - **勾选** = 这个文件有没有这个 tag ID（走 `setAudioTags`，整份 ID 清单进文档命令：进撤销栈、可撤销）；
 * - 这里**只能从已有的标签里挑**：新增 / 改名都在「标签」窗口（序号预先定好、只填名字）里做，
 *   所以本窗口没有新建入口——标签表在那边是完整的一列，没必要再抄一份输入框；
 * - 表里没人用的标签也会列出来（tag 是整数，先建后用是正常用法）。
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
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">
            选择标签{target === undefined ? "" : `：${target.displayName}`}
          </Dialog.Title>

          <div className="min-h-0 flex-1 overflow-auto" data-testid="audio-tag-list">
            {entries.length === 0 ? (
              <div
                data-testid="audio-tag-empty"
                className="flex h-full flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]"
              >
                <span>还没有标签</span>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {entries.map((entry) => {
                  const active = selected.includes(entry.id);
                  const name = entry.name.length === 0 ? "（未命名）" : entry.name;
                  return (
                    <div
                      key={entry.id}
                      data-testid="audio-tag-row"
                      data-id={entry.id}
                      data-tag={entry.name}
                      data-selected={active}
                      data-count={entry.count}
                      // 与「标签」窗口同一套画法：**不画线框、给淡底色**（跟窗口底色分开），
                      // 勾上的那行换成强调色底。边框宽度一直在（未勾时透明），免得勾选时整屏跳一下。
                      className={`rounded border ${
                        active
                          ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)]"
                          : "border-transparent bg-[var(--color-editor-panel-alt)] hover:bg-[var(--color-editor-bar)]"
                      }`}
                    >
                      {/*
                        一条属性行的样子：**左边名字、右边动作**。
                        整行都是「加上 / 去掉」的命中区（点哪都行），右侧那枚 ＋/－ 只是把
                        「点一下会发生什么」写在最右边——与属性面板其它行同一个阅读方向。
                      */}
                      <button
                        type="button"
                        data-testid="audio-tag-toggle"
                        data-id={entry.id}
                        aria-pressed={active}
                        title={active ? `去掉「${name}」` : `加上「${name}」`}
                        className="flex w-full items-center gap-2 px-1.5 py-1 text-left"
                        onClick={() => toggle(entry.id)}
                      >
                        <span className="w-7 flex-none font-mono text-[10px] text-[var(--color-editor-text-dim)]">
                          {entry.id}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[11px]">{name}</span>
                        <span className="flex-none text-[10px] text-[var(--color-editor-text-dim)]">
                          {entry.count} 个文件在用
                        </span>
                        <span
                          aria-hidden="true"
                          className={`w-4 flex-none text-center text-[13px] leading-none ${
                            active ? "text-[var(--color-editor-accent)]" : ""
                          }`}
                        >
                          {active ? "－" : "＋"}
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
              这个音频文件已经不在了。
            </div>
          ) : null}

          <div className="mt-2 flex flex-none justify-end">
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="audio-tag-close"
                // 「关闭」是这里唯一的收尾动作，做**大一点**：小按钮在平板上根本按不准
                className="toolbar-button h-8 px-4 text-[12px] hover:toolbar-button-hover"
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
