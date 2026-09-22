import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useEditorStore } from "../state/editor-store";
import { audioCatalog, filterAudioRows } from "../panels/audio-catalog";

/**
 * 「选择音频」弹框（与「选择贴图」同一个习惯）：列出**当前项目里的全部音频**，
 * **点一条就加进这条声音对象**，可以连着点几条；已经加过的标出来、不再重复加。
 *
 * 它只负责「从已有素材里挑」——编辑器**不导入素材**（素材由外部提交到 `Assets/audio/`），
 * 也**不播放**：这里没有试听播放器、不碰音频解码。
 *
 * v17 起显示的是**显示名**（「音频文件」窗口里配的名字）并带上标签：素材一多，
 * 「01-xxx.mp3」这种文件名根本认不出内容，按名字 / 标签搜一下才挑得动。
 * 显示名与标签在「音频文件」窗口里改（顶栏「音乐」弹框与工程菜单都有入口）。
 */

interface AudioPickerDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 已经加进来的音频（这些行标「已加入」、点不动）。 */
  readonly added: readonly string[];
  readonly onPick: (id: string) => void;
}

export function AudioPickerDialog({
  open,
  onClose,
  added,
  onPick,
}: AudioPickerDialogProps): React.JSX.Element {
  const tree = useEditorStore((state) => state.project.tree);
  const metas = useEditorStore((state) => state.assetMetaTable);
  const table = useEditorStore((state) => state.doc.audioTags);
  const [query, setQuery] = useState("");

  // 清单就是项目里的音频（每个素材一行，名字 / 标签来自它自己那份 `.meta`）
  const rows = useMemo(() => audioCatalog(tree, metas, table), [tree, metas, table]);
  const visible = useMemo(
    () => filterAudioRows(rows, { query, tags: [] }),
    [rows, query],
  );

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        {/* 比「编辑声音」窗口再高一层：两层模态叠着，关掉这层回到那个窗口 */}
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <Dialog.Content
          data-testid="audio-picker-dialog"
          className="fixed left-1/2 top-1/2 z-[70] flex h-[460px] w-[620px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">选择音频</Dialog.Title>

          <input
            data-testid="audio-picker-search"
            value={query}
            placeholder="搜名字 / 标签 / 文件名 / 路径…"
            aria-label="搜索音频"
            className="mb-2 flex-none rounded border border-[var(--color-editor-border)] bg-black/30 px-2 py-1 text-[11px] outline-none placeholder:text-[var(--color-editor-text-dim)]"
            onChange={(event) => setQuery(event.target.value)}
          />

          <div className="min-h-0 flex-1 overflow-auto" data-testid="audio-picker-list">
            {visible.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]">
                {rows.length === 0 ? (
                  <>
                    <span>项目里还没有音频素材</span>
                    <span className="font-mono">把音频放到 Assets/audio/ 下即可在这里选到</span>
                  </>
                ) : (
                  <span>没有匹配的音频</span>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {visible.map((row) => {
                  const isAdded = added.includes(row.id);
                  return (
                    <button
                      key={row.id}
                      type="button"
                      data-testid="audio-picker-item"
                      data-asset-id={row.id}
                      data-added={isAdded}
                      data-tags={row.tags.join(",")}
                      disabled={isAdded}
                      title={
                        isAdded ? "已经加进来了" : `加进来：${row.path}`
                      }
                      className={`flex items-center gap-2 rounded border px-1.5 py-1 text-left ${
                        isAdded
                          ? "border-[var(--color-editor-border)] opacity-50"
                          : "border-[var(--color-editor-border)] hover:border-[var(--color-editor-accent)] hover:bg-[var(--color-editor-panel-alt)]"
                      }`}
                      onClick={() => onPick(row.id)}
                    >
                      <span className="w-44 flex-none truncate text-[11px]">{row.displayName}</span>

                      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-[10px] text-[var(--color-editor-text-dim)]">
                        {row.tags.map((tag) => (
                          <span
                            key={tag.id}
                            data-testid="audio-picker-tag"
                            data-id={tag.id}
                            data-tag={tag.name}
                            className="flex-none rounded-full border border-[var(--color-editor-border)] px-1.5"
                          >
                            {tag.name}
                          </span>
                        ))}
                        <span className="min-w-0 flex-1 truncate font-mono">{row.path}</span>
                      </span>

                      <span
                        className={`flex-none text-[10px] ${
                          isAdded
                            ? "text-[var(--color-editor-text-dim)]"
                            : "text-[var(--color-editor-accent)]"
                        }`}
                      >
                        {isAdded ? "已加入" : "＋"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-2 flex flex-none items-center justify-between gap-2 text-[11px] text-[var(--color-editor-text-dim)]">
            <span>点一条就加进来（可以连着加几条）；名字 / 标签在「音频文件」窗口里改</span>
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="audio-picker-close"
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
