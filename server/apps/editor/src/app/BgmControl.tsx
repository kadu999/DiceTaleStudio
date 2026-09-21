import { useEditorStore, type EditorMode } from "../state/editor-store";
import type { RuntimeStatus } from "../services/runtime-client";

/**
 * 点下去会发生什么：没连上时**照样记账**，只是要等连上才补发——把这件事写在按钮的 tooltip 上。
 *
 * 与 `soundDeliveryHint` / `videoDeliveryHint` 同一套（三处的措辞必须一致：它们说的是同一件事）。
 * 返回 `undefined` 表示「现在就能发下去」。
 */
export function bgmDeliveryHint(input: {
  readonly mode: EditorMode;
  readonly status: RuntimeStatus;
  readonly clientConnected: boolean;
}): string | undefined {
  if (input.mode !== "run" || input.status !== "open") {
    return "已记录：编辑器还没连上服务端，连上后自动补发";
  }

  if (!input.clientConnected) {
    return "已记录：前端（Unity）未连接，等它连上后自动补发";
  }

  return undefined;
}

/**
 * 顶栏的「音乐」按钮：**背景音乐的唯一入口**（v16 起）。
 *
 * 它只做一件事——打开 `BgmDialog`（项目音频清单：选一首 + 底部播放 / 暂停 / 停止）。换一首 / 停一下
 * 是现场最常做的两件事，而背景音乐不属于任何对象（没有「先选中一个对象」这种不相干的动作），
 * 所以入口常驻顶栏：任何场景、任何选中状态下都在同一个位置。
 *
 * 按钮上写的是**现在在放什么**（没在放就是一句「背景音乐」），并带上播放 / 暂停标记——
 * 弹框关着的时候也一眼看得出状态。编辑器自己不出声：播放靠下发命令。
 */
export function BgmControl(): React.JSX.Element {
  const project = useEditorStore((state) => state.project.current);
  const playback = useEditorStore((state) => state.bgmPlayback);
  const openBgmDialog = useEditorStore((state) => state.openBgmDialog);
  const mode = useEditorStore((state) => state.mode);
  const status = useEditorStore((state) => state.runtime.status);
  const clientConnected = useEditorStore((state) => state.runtime.client !== null);

  const playing = playback.clip !== null;
  const paused = playing && playback.paused;
  const name =
    playback.clip === null
      ? ""
      : playback.clip.slice(playback.clip.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");

  const stateLabel = paused
    ? `♫ ${name}（已暂停）`
    : playing
      ? `♫ ${name}（播放中）`
      : "♫ 背景音乐";

  const delivery = bgmDeliveryHint({ mode, status, clientConnected });

  return (
    <button
      type="button"
      data-testid="bgm-control"
      data-state={paused ? "paused" : playing ? "playing" : "idle"}
      title={
        project === null
          ? "先打开一个项目"
          : `背景音乐：${stateLabel.replace(/^♫ /, "")}（点开曲目弹框）${
              delivery === undefined ? "" : `；${delivery}`
            }`
      }
      className={`toolbar-button hover:toolbar-button-hover ${
        playing && !paused ? "!bg-[var(--color-editor-accent-dim)]" : ""
      }`}
      onClick={() => openBgmDialog(true)}
    >
      <span className="max-w-[10rem] truncate">{stateLabel}</span>
    </button>
  );
}
