import { useCallback, useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useEditorStore } from "../state/editor-store";
import { assetDisplayName } from "../panels/asset-info";
import {
  audioCatalog,
  filterAudioRows,
  sortAudioRowsByName,
  tagOptionsOf,
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
 * 怎么快速找到那一首（v19 收敛）：
 * - 清单**按显示名排序、不分组**：再拿目录切一层壳只是把清单切碎；
 * - 搜索框只搜**名字 / 文件名 / 路径**；**路径默认不露**，要看就点右上角那个「路径」开关
 *   （编辑器偏好，记在浏览器本地）；
 * - **标签是勾的，不是敲的**：清单上方那一排就是标签表里的全部标签，点一下 = 按它筛
 *   （可多选，AND），选中的再点一下取消；
 * - **行上只写「一首曲子是哪一首」**（标记 + 显示名 [+ 路径]）：一首带着哪几个标签在这张清单上
 *   不是要回答的问题，把 chip 摊在每一行只会把清单糊住——标签只在上面那一排；
 * - **一行 = 一次选中**（点行只选中，不出声）；**播放键只有底部那一枚**，作用在选中的那一首上，
 *   与暂停 · 继续 / 停止 排在一起（与属性面板的声音 / 视频两组同一套）；
 * - 打开时**把当前那一首滚到眼前**（正在放的那一首；没在放就是上次选的那一首）；
 * - 清单里**不列**「文件已经没了」的标注（点了只会发出一条注定失败的命令）。
 *
 * 这一页**不写说明文字**：弹框只做「找 + 播」，名字 / 标签去哪儿配是另一件事
 * （选中音频 → 属性面板；标签表 → 工程 → 标签…），占着一行的地方讲这件事，看的人只会跳过它。
 *
 * 编辑器自己不出声：点下去只是**记账 + 尽力下发**（前端不在就等它连上补发），
 * 所以按钮的 tooltip 会把「已记录、等前端连上补发」写清楚。
 */
export function BgmDialog(): React.JSX.Element {
  const open = useEditorStore((state) => state.bgmDialog);
  const openBgmDialog = useEditorStore((state) => state.openBgmDialog);
  const tree = useEditorStore((state) => state.project.tree);
  // 显示名与标签住在**各音频文件自己的 `.meta`** 里（v24 起），标签的**名字**仍在工程文件的表里
  const metas = useEditorStore((state) => state.assetMetaTable);
  const identities = useEditorStore((state) => state.assetMetas);
  const table = useEditorStore((state) => state.doc.audioTags);
  const playback = useEditorStore((state) => state.bgmPlayback);
  const playBgm = useEditorStore((state) => state.playBgm);
  const pauseBgm = useEditorStore((state) => state.pauseBgm);
  const resumeBgm = useEditorStore((state) => state.resumeBgm);
  const stopBgm = useEditorStore((state) => state.stopBgm);
  const mode = useEditorStore((state) => state.mode);
  const status = useEditorStore((state) => state.runtime.status);
  const clientConnected = useEditorStore((state) => state.runtime.client !== null);
  /** 行右边显示不显示路径（编辑器偏好，默认不显示）。 */
  const showPaths = useEditorStore((state) => state.ui.bgmPaths);
  const setBgmPaths = useEditorStore((state) => state.setBgmPaths);

  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState<readonly string[]>([]);
  /**
   * 清单里选中的那一首（底部「播放」作用在它身上）。
   *
   * 选中**不等于**正在放：可以选中另一首让它等着，正在放的那一首照旧响着（行上的 ● / ⏸ 说的是后者）。
   * 弹框关掉再打开时它还在（`BgmDialog` 一直挂着，只是 Radix 的内容会卸载）——加上下面那条
   * 跟随正在播放的同步，就是「打开时恢复选中状态」。
   */
  const [selected, setSelected] = useState<string | null>(null);

  /** 项目里的音频（清单就是资源树里那些文件；没有「标注指向已删文件」这类行了）。 */
  const rows = useMemo(() => audioCatalog(tree, metas, table), [tree, metas, table]);
  const currentIdOf = (clip: string): string => {
    const oldMeta = metas[clip];
    if (oldMeta !== undefined) {
      return Object.entries(identities.byId).find(([, meta]) => meta.guid === oldMeta.guid)?.[0] ?? clip;
    }
    return rows.find((row) => row.id === clip || row.guid === clip)?.id ?? clip;
  };
  const rowKey = (row: (typeof rows)[number]): string => row.guid ?? row.id;
  const rowForReference = (reference: string): (typeof rows)[number] | undefined =>
    rows.find((row) => row.id === currentIdOf(reference) || row.guid === reference);
  const visible = useMemo(
    () =>
      sortAudioRowsByName(
        filterAudioRows(rows, { query, tags: activeTags, searchTags: false }),
      ),
    [rows, query, activeTags],
  );

  /** 勾选那一排：标签表里的全部标签（还没人用的也列——先建后用是正常用法）。 */
  const tagOptions = useMemo(() => tagOptionsOf(table), [table]);

  const playing = playback.clip !== null;
  const paused = playback.clip !== null && playback.paused;
  const delivery = bgmDeliveryHint({ mode, status, clientConnected });

  /** 选中那一首（文件已经不在了 / 还没选 → `undefined`：播放键点不动）。 */
  const selectedRow =
    selected === null ? undefined : rowForReference(selected);
  /** 选中的这一首正是**正在放**的那一首吗（播放键因此亮起来）。 */
  const playingSelected =
    selected !== null && playback.clip !== null && rowForReference(playback.clip) === rowForReference(selected);
  /** 打开弹框时要把哪一行带到眼前：正在放的那一首；没在放就是选中的那一首。 */
  const focusRow = playback.clip === null ? undefined : rowForReference(playback.clip);
  const focusClip =
    playback.clip === null ? selected : focusRow === undefined ? currentIdOf(playback.clip) : rowKey(focusRow);

  const currentNameOf = (clip: string): string =>
    rowForReference(clip)?.displayName ??
    assetDisplayName(clip.slice(clip.lastIndexOf("/") + 1));

  const toggleTag = (tag: string): void => {
    setActiveTags((previous) =>
      previous.includes(tag) ? previous.filter((item) => item !== tag) : [...previous, tag],
    );
  };

  /**
   * 正在放的那一首**就是选中的那一首**。
   *
   * 播放态是 store 里的公共状态（顶栏、补发都看它），选中只是这一页的事，所以让选中跟着它走：
   * 一打开弹框、或者别处（顶栏补发、撤销）换了歌，清单里亮着的就是它——不用自己再找一遍。
   */
  useEffect(() => {
    if (playback.clip !== null) {
      setSelected(rowForReference(playback.clip) === undefined ? currentIdOf(playback.clip) : rowKey(rowForReference(playback.clip)!));
    }
  }, [playback.clip, metas, identities]);

  /**
   * 打开弹框时**把当前那一首带到眼前**。
   *
   * 清单可能几十首，不滚过去，「现在放的是哪首 / 上次选的是哪首」就得自己找一遍。
   *
   * 做法是**回调 ref**而不是 `useEffect`：Radix 的 portal 要等一个 layout effect 才把内容挂出来，
   * 组件自己的 `useEffect` 跑在**第一次提交**（那时清单里一行都还没有），拿不到任何节点。
   * 回调 ref 在节点真的挂上时被调用——无论是刚打开，还是选中 / 正在放的那一行换了。
   *
   * `scrollIntoView` 在 jsdom 里没有：可选调用，跑测试时自然跳过。
   */
  const scrollFocusRowIntoView = useCallback((node: HTMLButtonElement | null) => {
    node?.scrollIntoView?.({ block: "nearest" });
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => openBgmDialog(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid="bgm-dialog"
          className="fixed left-1/2 top-1/2 z-50 flex h-[560px] w-[680px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">背景音乐</Dialog.Title>

          <div className="mb-2 flex flex-none items-center gap-2">
            <input
              data-testid="bgm-search"
              value={query}
              placeholder="搜名字 / 路径…"
              aria-label="搜索背景音乐"
              className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-2 py-1 text-[11px] outline-none placeholder:text-[var(--color-editor-text-dim)]"
              onChange={(event) => setQuery(event.target.value)}
            />
            {/*
              「路径」开关：路径**默认不显示**（清单干净优先），要看它在哪儿再点开。
              这是**看的方式**，所以进编辑器偏好（浏览器本地），换个项目 / 重开浏览器都还在。
            */}
            <button
              type="button"
              data-testid="bgm-paths-toggle"
              data-shown={showPaths}
              aria-pressed={showPaths}
              title={showPaths ? "不显示路径" : "在行右边显示路径"}
              className={`flex-none rounded border px-2 py-1 text-[10px] ${
                showPaths
                  ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                  : "border-[var(--color-editor-border)] text-[var(--color-editor-text-dim)] hover:border-[var(--color-editor-accent)] hover:text-[var(--color-editor-text)]"
              }`}
              onClick={() => setBgmPaths(!showPaths)}
            >
              路径
            </button>
          </div>

          {/*
            标签是**勾的**（标签表里的全部标签，多选 = AND），与「选择标签」框同一套语义：
            点一下选上、再点一下取消。这里没有输入框——标签的名字只在「标签」窗口里改。
          */}
          {tagOptions.length === 0 ? null : (
            <div
              data-testid="bgm-tag-picker"
              className="mb-2 flex flex-none flex-wrap items-center gap-1 text-[10px]"
            >
              <span className="text-[var(--color-editor-text-dim)]">标签</span>
              {tagOptions.map((tag) => {
                const active = activeTags.includes(tag.name);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    data-testid="bgm-tag-option"
                    data-id={tag.id}
                    data-tag={tag.name}
                    data-selected={active}
                    aria-pressed={active}
                    title={active ? `取消「${tag.name}」` : `只看带「${tag.name}」的`}
                    className={`flex-none rounded-full border px-1.5 py-0.5 ${
                      active
                        ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                        : "border-[var(--color-editor-border)] text-[var(--color-editor-text-dim)] hover:border-[var(--color-editor-accent)] hover:text-[var(--color-editor-text)]"
                    }`}
                    onClick={() => toggleTag(tag.name)}
                  >
                    {tag.name}
                  </button>
                );
              })}
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
                    <span className="font-mono">放进 Assets/audio/ 就会列在这里</span>
                  </>
                ) : (
                  <span>没有匹配的音频</span>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {visible.map((row) => {
                  const isPlaying = playback.clip !== null && rowForReference(playback.clip) === row;
                  const isSelected = selected !== null && rowForReference(selected) === row;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      // 正在放的那一行（没在放时是选中的那一行）把节点交出来：
                      // 挂上 / 成为它时滚到它上面去
                      ref={rowKey(row) === focusClip ? scrollFocusRowIntoView : undefined}
                      data-testid="bgm-track"
                      data-clip={row.id}
                      data-selected={isSelected}
                      data-playing={isPlaying}
                      aria-pressed={isSelected}
                      title={`选中「${row.displayName}」${showPaths ? `：${row.path}` : ""}`}
                      className={`flex items-center gap-2 rounded border px-1.5 py-1 text-left ${
                        isSelected
                          ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)]"
                          : "border-[var(--color-editor-border)] hover:border-[var(--color-editor-accent)] hover:bg-[var(--color-editor-panel-alt)]"
                      }`}
                      onClick={() => setSelected(rowKey(row))}
                    >
                      {/*
                        **点行只选中，不出声**：出声的键只有下面那一排的三个（播放 / 暂停 / 停止），
                        整行当命中区时手一滑就把正在放的曲子切了。
                        ● / ⏸ 说的是**这一首真的在放**（与选中是两件事：可以选中另一首、让它等着）。
                      */}
                      <span className="w-4 flex-none text-center text-[10px] text-[var(--color-editor-accent)]">
                        {isPlaying ? (paused ? "⏸" : "●") : ""}
                      </span>
                      <span className="w-44 flex-none truncate text-[11px]">{row.displayName}</span>

                      {showPaths ? (
                        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--color-editor-text-dim)]">
                          {row.path}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/*
            **播放 / 暂停 · 继续 / 停止**三个键，与属性面板上声音 / 视频那两组**同一套类名与措辞**：
            同一件事在两处长一样，别让人以为是两套用法。播放键只有一个——作用在**选中的那一首**上。
          */}
          <div
            data-testid="bgm-playback-row"
            className="mt-2 flex flex-none flex-wrap items-center gap-2 border-t border-[var(--color-editor-border)] pt-2"
          >
            <button
              type="button"
              data-testid="bgm-play"
              disabled={selectedRow === undefined}
              title={
                selectedRow === undefined
                  ? "先在清单里选一首"
                  : (delivery ?? `从头上放「${selectedRow.displayName}」`)
              }
              className={
                playingSelected && !paused ? PLAYBACK_BUTTON_ACTIVE_CLASS : PLAYBACK_BUTTON_CLASS
              }
              onClick={() => {
                if (selectedRow !== undefined) {
                  playBgm(selectedRow.id);
                }
              }}
            >
              ▶ 播放
            </button>
            <button
              type="button"
              data-testid="bgm-pause"
              data-paused={paused}
              disabled={!playing}
              title={
                !playing
                  ? "现在没有在放的背景音乐（先选一首，再按播放）"
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
              title={delivery ?? "让前端停掉背景音乐（再点播放 = 从头放）"}
              className={PLAYBACK_BUTTON_CLASS}
              onClick={stopBgm}
            >
              ■ 停止
            </button>

            {/* 只有真的在放时才写一句「在放什么」；没在放就什么都不说（空着也是把「关闭」推到右边的那根弹簧） */}
            <span
              data-testid="bgm-status"
              className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-editor-text-dim)]"
            >
              {playback.clip === null
                ? ""
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
