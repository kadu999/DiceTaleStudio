import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useEditorStore } from "../state/editor-store";
import { allTagsOf, audioCatalog } from "../panels/audio-catalog";

/**
 * 「标签」窗口（v18 起）：**标签表**的编辑页——新建 / 改名 / 删除。
 *
 * 学 Unity 的 TagManager：**tag 是个整数**（就是表里的下标 `#0`、`#1`…），名字只是它的显示文本。
 * 所以这里改名字**只改这一张表**，所有音频文件里记的 `[0, 2]` 一个字节都不用动
 * （这正是「文件里存整数、不存字符串」换来的好处：不会因为改一次名字就把每个文件翻一遍，
 * 也不会因为「战斗」和「战斗 」这种写法分裂成两个标签）。
 *
 * 三条口径：
 * - **新建**：占一个槽位。删过的槽位是**洞**（`null`），新建时**优先复用第一个洞**——
 *   ID 是身份，不能让别的标签 ID 位移；
 * - **改名**：就地改，空名字不提交（要「不显示」就删掉它）；
 * - **删除**：把这个标签从**所有**音频文件上摘掉（二次确认），表里留洞。
 *
 * 入口：「工程 → 标签…」，「音频文件」窗口右上角的「标签…」按钮。
 */
export function AudioTagEditorDialog(): React.JSX.Element {
  const open = useEditorStore((state) => state.audioTags);
  const openAudioTags = useEditorStore((state) => state.openAudioTags);
  const tree = useEditorStore((state) => state.project.tree);
  const meta = useEditorStore((state) => state.doc.audioMeta);
  const table = useEditorStore((state) => state.doc.audioTags);
  const addAudioTag = useEditorStore((state) => state.addAudioTag);
  const deleteAudioTag = useEditorStore((state) => state.deleteAudioTag);

  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (open) {
      setDraft("");
    }
  }, [open]);

  const rows = useMemo(() => audioCatalog(tree, meta, table), [tree, meta, table]);
  // 标签表按 **ID 升序**列（#0、#1、#2…）：这是「表的编辑页」，顺序该跟下标一致
  // （「选择标签」框那边是按用量排的，那里关心的是「常用的先看到」）
  const entries = useMemo(
    () => [...allTagsOf(table, rows)].sort((a, b) => a.id - b.id),
    [table, rows],
  );

  const create = (): void => {
    const name = draft.trim();
    setDraft("");
    if (name.length === 0) {
      return;
    }

    addAudioTag(name);
  };

  const remove = (id: number, name: string, count: number): void => {
    if (
      !window.confirm(
        `删除标签「${name || "（未命名）"}」？它会在全项目 ${count} 个音频文件上被摘掉（音频文件本身不动）。`,
      )
    ) {
      return;
    }

    deleteAudioTag(id);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : openAudioTags(false))}>
      <Dialog.Portal>
        {/*
          压在「音频文件」窗口之上：这个窗口能从那个窗口里打开（「标签…」按钮），
          所以层级要更高一层，否则它的遮罩会被下面的窗口盖住、点得到处乱跑。
        */}
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <Dialog.Content
          data-testid="audio-tag-editor"
          onEscapeKeyDown={(event) => {
            // 正在敲名字时按 Esc = 只还原这一格，不关窗口（与其它窗口同一套）
            if ((event.target as HTMLElement | null)?.tagName === "INPUT") {
              event.preventDefault();
            }
          }}
          className="fixed left-1/2 top-1/2 z-[70] flex h-[520px] w-[560px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-1 flex-none text-[13px] font-semibold">标签</Dialog.Title>
          <div className="mb-2 flex-none text-[11px] text-[var(--color-editor-text-dim)]">
            标签是<span className="text-[var(--color-editor-text)]">整数</span>（
            <span className="font-mono">#0</span>、<span className="font-mono">#1</span>
            …）：这里只是给每个值起名字——
            <span className="text-[var(--color-editor-text)]">改名字只改这张表</span>
            ，音频文件里记的还是原来的整数。
          </div>
          <div className="min-h-0 flex-1 overflow-auto" data-testid="audio-tag-editor-list">
            {entries.length === 0 ? (
              <div
                data-testid="audio-tag-editor-empty"
                className="flex h-full flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]"
              >
                <span>还没有标签</span>
                <span>在下面输入一个名字回车，就会占一个整数 ID</span>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {entries.map((entry) => (
                  <AudioTagEditorRow
                    key={entry.id}
                    id={entry.id}
                    name={entry.name}
                    count={entry.count}
                    onDelete={() => remove(entry.id, entry.name, entry.count)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="mt-2 flex flex-none items-center gap-2 border-t border-[var(--color-editor-border)] pt-2">
            <input
              data-testid="audio-tag-editor-new"
              value={draft}
              placeholder="新建标签…"
              aria-label="新建标签"
              title="敲一个名字回车：占一个新的（或删过的）整数 ID"
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
              data-testid="audio-tag-editor-add"
              disabled={draft.trim().length === 0}
              title="新建一个标签（同名的话就用已有的那个）"
              className="toolbar-button flex-none hover:toolbar-button-hover"
              onClick={create}
            >
              添加
            </button>
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="audio-tag-editor-close"
                className="toolbar-button flex-none hover:toolbar-button-hover"
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

/** 一行：`#ID` + 名字输入框（就地改）+ 用量 + 删除。 */
function AudioTagEditorRow({
  id,
  name,
  count,
  onDelete,
}: {
  readonly id: number;
  readonly name: string;
  readonly count: number;
  readonly onDelete: () => void;
}): React.JSX.Element {
  const renameAudioTag = useEditorStore((state) => state.renameAudioTag);
  const [draft, setDraft] = useState(name);

  useEffect(() => {
    setDraft(name);
  }, [id, name]);

  const commit = (): void => {
    if (draft.trim() === name || draft.trim().length === 0) {
      // 空名字不提交：要让一个标签「不显示」，就把它删掉
      setDraft(name);
      return;
    }

    renameAudioTag(id, draft);
  };

  return (
    <div
      data-testid="audio-tag-editor-row"
      data-id={id}
      data-name={name}
      className="flex items-center gap-2 rounded border border-[var(--color-editor-border)] px-1.5 py-1 hover:bg-[var(--color-editor-panel-alt)]"
    >
      <span
        data-testid="audio-tag-editor-id"
        className="w-8 flex-none font-mono text-[10px] text-[var(--color-editor-text-dim)]"
        title={`tag ID = ${id}（文件里记的就是这个整数）`}
      >
        #{id}
      </span>

      <input
        data-testid="audio-tag-editor-name"
        data-id={id}
        value={draft}
        placeholder="（未命名）"
        aria-label={`标签 #${id} 的名字`}
        title="改名字只改这张表：所有用到它的音频文件自动跟着变（文件里记的是整数 ID）"
        className="w-44 flex-none rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 text-[11px] outline-none placeholder:text-[var(--color-editor-text-dim)]"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(name);
          }
        }}
      />

      <span
        data-testid="audio-tag-editor-count"
        className="min-w-0 flex-1 truncate text-[10px] text-[var(--color-editor-text-dim)]"
      >
        {count} 个文件在用
      </span>

      <button
        type="button"
        data-testid="audio-tag-editor-delete"
        data-id={id}
        aria-label={`删除标签 #${id}`}
        title={`从全项目的音频文件上摘掉这个标签（影响 ${count} 个文件）`}
        className="flex-none rounded border border-[var(--color-editor-border)] px-1.5 py-0.5 text-[10px] hover:border-[var(--color-editor-danger)] hover:text-[var(--color-editor-danger)]"
        onClick={onDelete}
      >
        删除
      </button>
    </div>
  );
}
