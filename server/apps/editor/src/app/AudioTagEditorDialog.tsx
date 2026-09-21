import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useEditorStore } from "../state/editor-store";

/**
 * 「标签」窗口（v18 起）：**标签表**的编辑页。
 *
 * 学 Unity 的 TagManager：**tag 是个整数**（就是表里的下标 `#0`、`#1`…），名字只是它的显示文本。
 * 所以这里改名字**只改这一张表**，所有音频文件里记的 `[0, 2]` 一个字节都不用动
 * （这正是「文件里存整数、不存字符串」换来的好处：不会因为改一次名字就把每个文件翻一遍，
 * 也不会因为「战斗」和「战斗 」这种写法分裂成两个标签）。
 *
 * **序号是定好的，这里只填名字**——没有「添加」按钮、没有「删除」：
 * - 一列 `#0`…`#15` 从一开始就在（已经用过的序号一并列出、哪怕超过 16 个）；
 * - 往哪个格子敲名字，**那个序号**就是它以后的 ID（`setAudioTagName` 会把中间的空槽补出来）；
 * - 填满这一屏的最后一格会自动再接一屏（上限见 `MAX_SLOTS`），序号永远够用。
 *
 * **只关心这一张表**：不显示「多少个文件在用」——那个数字要把全项目的音频标注扫一遍、
 * 还得跟着文件增删实时变，为了一个参考数字把两个面板耦在一起不划算。要用量就去「选择标签」框
 * （那里本来就在挑「哪个标签用得多」）。
 *
 * 洞（`null`，手改过的数据里可能有）照旧**不显示**：那是删过的记号，不能拿空名字去顶它。
 *
 * 入口：「工程 → 标签…」，属性面板标签行右边的「标签…」按钮。
 */

/** 默认铺多少个空槽（已经用过的序号一并列出，实际行数取两者更大的那个）。 */
const SLOTS_PER_PAGE = 16;

/** 一次最多铺到多少个序号（填满这一屏的最后一个格子会自动再续一屏）。 */
const MAX_SLOTS = 32;

export function AudioTagEditorDialog(): React.JSX.Element {
  const open = useEditorStore((state) => state.audioTags);
  const openAudioTags = useEditorStore((state) => state.openAudioTags);
  const table = useEditorStore((state) => state.doc.audioTags);

  /**
   * 要列出来的序号：**已有槽位**（含洞的位置——洞不画，但占着序号）与**一屏空槽**取大的那个。
   *
   * 空槽是**界面上铺出来的**，不是数据：只有真的在某个格子里敲了名字，那个序号才会写进文档。
   * 所以打开这个窗口看一眼不会改任何东西。
   */
  const [extraSlots, setExtraSlots] = useState(SLOTS_PER_PAGE);
  useEffect(() => {
    if (open) {
      setExtraSlots(SLOTS_PER_PAGE);
    }
  }, [open]);

  const usedCount = table?.length ?? 0;
  const slotCount = Math.min(Math.max(usedCount, extraSlots), MAX_SLOTS);
  const slots = Array.from({ length: slotCount }, (_, id) => id);

  /** 名字提交后：如果他填的是**最后一个空格子**，后面再接一屏（序号够用，不用来回找按钮）。 */
  const commit = (id: number, name: string): boolean => {
    const changed = useEditorStore.getState().setAudioTagName(id, name);
    if (changed && id >= slotCount - 1) {
      setExtraSlots((previous) => Math.min(previous + SLOTS_PER_PAGE, MAX_SLOTS));
    }

    return changed;
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
          // 窄一点、高一点：这一页只有「序号 + 名字」两列，宽度浪费在空白上，
          // 而一屏 16 行需要的是高度
          className="fixed left-1/2 top-1/2 z-[70] flex h-[640px] w-[420px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">标签</Dialog.Title>
          <div className="min-h-0 flex-1 overflow-auto" data-testid="audio-tag-editor-list">
            <div className="flex flex-col gap-1">
              {slots
                // 洞不画（手改过的数据里可能有）：序号照旧占位，只是不给这一行
                .filter((id) => table?.[id] !== null)
                .map((id) => (
                  <AudioTagEditorRow
                    key={id}
                    id={id}
                    name={(table?.[id] ?? "").trim()}
                    onCommit={commit}
                  />
                ))}
            </div>
          </div>

          <div className="mt-2 flex flex-none justify-end">
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="audio-tag-editor-close"
                // 与「选择标签」框同一个尺寸：关闭是收尾动作，别做成小按钮
                className="toolbar-button h-8 flex-none px-4 text-[12px] hover:toolbar-button-hover"
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

/**
 * 一行：`#序号` + 名字输入框。**序号是死的，名字是活的**。
 *
 * 输入框里敲完（Enter / 失焦）就改表：名字为空 = 这一行还是「没有名字」，
 * 什么都不写（所以打开窗口随手点一下不会留下空槽数据）。
 *
 * 不显示用量：这一页只跟**标签表**打交道（要看用量去「选择标签」框）。
 */
function AudioTagEditorRow({
  id,
  name,
  onCommit,
}: {
  readonly id: number;
  readonly name: string;
  readonly onCommit: (id: number, name: string) => boolean;
}): React.JSX.Element {
  const [draft, setDraft] = useState(name);

  // 表在别处变了（撤销、换项目）：这一格跟着走——除非它正被编辑（那时 drafts 才是用户的意思）
  useEffect(() => {
    setDraft(name);
  }, [id, name]);

  const commit = (): void => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || trimmed === name) {
      // 空名字不写进数据：序号存在与否不该由「随手点过一个空格子」决定
      setDraft(name);
      return;
    }

    if (!onCommit(id, draft)) {
      setDraft(name);
    }
  };

  return (
    <div
      data-testid="audio-tag-editor-row"
      data-id={id}
      data-name={name}
      // 行本身是干净的：**只有名字那一格有底色**，这样一列名字跟窗口分得开，
      // 又不会变成 16 个色块。鼠标移上去整行淡淡亮一下，方便看清点的是哪一行。
      className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-[var(--color-editor-panel-alt)]"
    >
      <span
        data-testid="audio-tag-editor-id"
        className="w-6 flex-none text-right font-mono text-[10px] text-[var(--color-editor-text-dim)]"
        title={`tag ID = ${id}`}
      >
        {id}
      </span>

      <input
        data-testid="audio-tag-editor-name"
        data-id={id}
        value={draft}
        placeholder="（未命名）"
        aria-label={`标签 ${id} 的名字`}
        title="填名字"
        // 名字这一格**自带底色**（跟窗口底色分开，一眼看出「这里能填」）；
        // 光标进去再亮一档、加一圈强调色边框
        className="min-w-0 flex-1 rounded border border-transparent bg-black/25 px-1.5 py-0.5 text-[11px] outline-none focus:border-[var(--color-editor-accent)] focus:bg-black/40 placeholder:text-[var(--color-editor-text-dim)]"
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
    </div>
  );
}
