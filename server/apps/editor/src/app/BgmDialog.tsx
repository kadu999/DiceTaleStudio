import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useEditorStore } from "../state/editor-store";
import { assetDisplayName } from "../panels/asset-info";
import {
  audioCatalog,
  filterAudioRows,
  groupByDir,
} from "../panels/audio-catalog";
import { PLAYBACK_BUTTON_ACTIVE_CLASS, PLAYBACK_BUTTON_CLASS } from "../panels/inspector/fields";
import { bgmDeliveryHint } from "./BgmControl";

/**
 * 「背景音乐」弹框（v16 起）：**项目里的音频清单 + 点一首就播**。
 *
 * 为什么是弹框：现场最常做的一件事是**换一首 / 停一下**，而背景音乐不属于任何对象——
 * 塞进某个面板就意味着「先选中一个对象」这种毫不相干的动作。顶栏那个常驻按钮点开就是它，
 * 在任何场景、任何选中状态下都在同一个位置。
 *
 * 怎么快速找到那一首（v17 起）：
 * - 清单里显示的是**显示名**（在「音频文件」窗口里起过名就用它，否则用素材文件名）；
 * - 搜索框匹配**显示名 / 标签 / 文件名 / 路径**；点行上的标签 = 按它筛（可叠加，AND）；
 * - 清单里**不列**「文件已经没了」的标注（点了只会发出一条注定失败的命令）。
 *
 * 编辑器自己不出声：点下去只是**记账 + 尽力下发**（前端不在就等它连上补发），
 * 所以按钮的 tooltip 会把「已记录、等前端连上补发」写清楚。
 */
export function BgmDialog(): React.JSX.Element {
  const open = useEditorStore((state) => state.bgmDialog);
  const openBgmDialog = useEditorStore((state) => state.openBgmDialog);
  const tree = useEditorStore((state) => state.project.tree);
  const meta = useEditorStore((state) => state.doc.audioMeta);
  const table = useEditorStore((state) => state.doc.audioTags);
  const playback = useEditorStore((state) => state.bgmPlayback);
  const playBgm = useEditorStore((state) => state.playBgm);
  const pauseBgm = useEditorStore((state) => state.pauseBgm);
  const resumeBgm = useEditorStore((state) => state.resumeBgm);
  const stopBgm = useEditorStore((state) => state.stopBgm);
  const mode = useEditorStore((state) => state.mode);
  const status = useEditorStore((state) => state.runtime.status);
  const clientConnected = useEditorStore((state) => state.runtime.client !== null);

  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState<readonly string[]>([]);

  /** 项目里**还在**的音频（标注指向已删文件的那些不列：点了必然失败）。 */
  const rows = useMemo(
    () => audioCatalog(tree, meta, table).filter((row) => !row.missing),
    [tree, meta, table],
  );
  const visible = useMemo(
    () => filterAudioRows(rows, { query, tags: activeTags }),
    [rows, query, activeTags],
  );
  const groups = useMemo(() => groupByDir(visible), [visible]);

  const playing = playback.clip !== null;
  const paused = playback.clip !== null && playback.paused;
  const delivery = bgmDeliveryHint({ mode, status, clientConnected });

  const currentNameOf = (clip: string): string =>
    rows.find((row) => row.id === clip)?.displayName ??
    assetDisplayName(clip.slice(clip.lastIndexOf("/") + 1));

  const toggleTag = (tag: string): void => {
    setActiveTags((previous) =>
      previous.includes(tag) ? previous.filter((item) => item !== tag) : [...previous, tag],
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => openBgmDialog(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid="bgm-dialog"
          className="fixed left-1/2 top-1/2 z-50 flex h-[560px] w-[680px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-1 flex-none text-[13px] font-semibold">背景音乐</Dialog.Title>
          <div className="mb-2 flex-none text-[11px] text-[var(--color-editor-text-dim)]">
            清单就是项目 <span className="font-mono">Assets/audio/</span> 下的音频——点一首就播
            （编辑器自己不出声，前端出声）。名字 / 标签在属性面板里配（选中那个音频文件即可），
            标签表在「工程 → 标签…」。
          </div>

          <input
            data-testid="bgm-search"
            value={query}
            placeholder="搜名字 / 标签 / 文件名 / 路径…"
            aria-label="搜索背景音乐"
            className="mb-2 flex-none rounded border border-[var(--color-editor-border)] bg-black/30 px-2 py-1 text-[11px] outline-none placeholder:text-[var(--color-editor-text-dim)]"
            onChange={(event) => setQuery(event.target.value)}
          />

          {activeTags.length === 0 ? null : (
            <div className="mb-2 flex flex-none flex-wrap items-center gap-1 text-[10px]">
              <span className="text-[var(--color-editor-text-dim)]">筛选：</span>
              {activeTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  data-testid="bgm-tag-filter"
                  data-tag={tag}
                  title={`取消筛选「${tag}」`}
                  className="flex-none rounded-full border border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] px-1.5 py-0.5 text-white"
                  onClick={() => toggleTag(tag)}
                >
                  {tag} ×
                </button>
              ))}
              <button
                type="button"
                data-testid="bgm-clear-filter"
                className="toolbar-button ml-1 hover:toolbar-button-hover"
                onClick={() => setActiveTags([])}
              >
                清除筛选
              </button>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto" data-testid="bgm-list">
            {visible.length === 0 ? (
              <div
                data-testid="bgm-empty"
                className="flex h-full flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]"
              >
                {rows.length === 0 ? (
                  <>
                    <span>项目里还没有音频素材</span>
                    <span className="font-mono">把音频放到 Assets/audio/ 下就会列在这里</span>
                  </>
                ) : (
                  <span>没有匹配的音频</span>
                )}
              </div>
            ) : (
              groups.map(([dir, groupRows]) => (
                <div key={dir} className="mb-2">
                  <div className="px-1 pb-1 font-mono text-[10px] text-[var(--color-editor-text-dim)]">
                    {dir}
                  </div>
                  <div className="flex flex-col gap-1">
                    {groupRows.map((row) => {
                      const active = playback.clip === row.id;
                      return (
                        <div
                          key={row.id}
                          data-testid="bgm-track"
                          data-clip={row.id}
                          data-active={active}
                          data-tags={row.tags.map((tag) => tag.name).join(",")}
                          className={`flex items-center gap-2 rounded border px-1.5 py-1 ${
                            active
                              ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)]"
                              : "border-[var(--color-editor-border)] hover:border-[var(--color-editor-accent)] hover:bg-[var(--color-editor-panel-alt)]"
                          }`}
                        >
                          <button
                            type="button"
                            data-testid="bgm-track-play"
                            data-clip={row.id}
                            title={`${row.path}${
                              active ? "（正在放；再点一次从头重播）" : "（点一下切到它）"
                            }`}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            onClick={() => playBgm(row.id)}
                          >
                            <span className="w-4 flex-none text-center text-[10px] text-[var(--color-editor-accent)]">
                              {active ? (paused ? "⏸" : "●") : ""}
                            </span>
                            <span className="w-44 flex-none truncate text-[11px]">
                              {row.displayName}
                            </span>
                          </button>

                          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                            {row.tags.map((tag) => (
                              <button
                                key={tag.id}
                                type="button"
                                data-testid="bgm-tag"
                                data-id={tag.id}
                                data-tag={tag.name}
                                title={`只看带「${tag.name}」的`}
                                className="flex-none rounded-full border border-[var(--color-editor-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-editor-text-dim)] hover:border-[var(--color-editor-accent)] hover:text-[var(--color-editor-text)]"
                                onClick={() => toggleTag(tag.name)}
                              >
                                {tag.name}
                              </button>
                            ))}
                          </div>

                          <span className="min-w-0 flex-none truncate font-mono text-[10px] text-[var(--color-editor-text-dim)]">
                            {row.path}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>

          {/*
            与属性面板上声音 / 视频那两组的控件行**同一套类名与措辞**：
            同一件事在两处长一样，别让人以为是两套用法。
          */}
          <div
            data-testid="bgm-playback-row"
            className="mt-2 flex flex-none flex-wrap items-center gap-2 border-t border-[var(--color-editor-border)] pt-2"
          >
            <button
              type="button"
              data-testid="bgm-pause"
              data-paused={paused}
              disabled={!playing}
              title={
                !playing
                  ? "现在没有在放的背景音乐（先点一首曲子）"
                  : (delivery ?? (paused ? "从暂停处继续" : "暂停在当前处"))
              }
              className={paused ? PLAYBACK_BUTTON_ACTIVE_CLASS : PLAYBACK_BUTTON_CLASS}
              onClick={() => {
                if (paused) {
                  resumeBgm();
                } else {
                  pauseBgm();
                }
              }}
            >
              {paused ? "▶ 继续" : "⏸ 暂停"}
            </button>
            <button
              type="button"
              data-testid="bgm-stop"
              disabled={!playing}
              title={delivery ?? "让前端停掉背景音乐（再点一首 = 从头放）"}
              className={PLAYBACK_BUTTON_CLASS}
              onClick={stopBgm}
            >
              ■ 停止
            </button>

            <span
              data-testid="bgm-status"
              className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-editor-text-dim)]"
            >
              {playback.clip === null
                ? "没在放"
                : `正在放：${currentNameOf(playback.clip)}${paused ? "（已暂停）" : ""}`}
            </span>

            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="bgm-close"
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
