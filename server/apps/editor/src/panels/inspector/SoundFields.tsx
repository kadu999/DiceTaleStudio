import {
  DEFAULT_SOUND_LAYER,
  SOUND_LAYERS,
  SOUND_LAYER_LABELS,
  type SceneObjectDoc,
  type SoundLayer,
} from "@dts/document";
import { useEditorStore, type EditorMode } from "../../state/editor-store";
import type { RuntimeStatus } from "../../services/runtime-client";
import { assetDisplayName } from "../asset-info";
import { assetDisplayPath, findAssetById } from "../asset-picker";
import { FieldRow } from "./fields";

/**
 * 声音对象（动作对象）的「声音」组：**层级 → 音频 → 编辑音频… → 播放**。
 *
 * 两个地方分工，别混：
 * - **这里（面板）**：把**加进来的音频全列出来**（小方块），点一下就把「播哪一条」切过去；
 * - **「编辑声音」窗口**（`app/SoundEditDialog.tsx`，下面那行「编辑音频…」唤出）：加音频 /
 *   删音频 / 起名字——那里看得见每个文件的路径，面板太窄放不下。
 *
 * 编辑器**不播放**：没有试听、不接音频解码。点「播放」只是**记账**（哪一层该播什么）+
 * 尽力把命令发给前端；所以按钮**不要求前端在场**，没连上时状态记着、等连上补发。
 *
 * 三条语义（前端按同一套实现）：
 * - **层级 = 声道分组**：同层同时只响一条，播新的时旧的停；
 * - **一条声音对象一次只播一条**（面板单选）：命令里带的就是选中的那条；
 * - **停止**按层级停（不是按对象）。
 */

/** 「播放」现在能不能点：一条音频都没加 → 先去窗口里加；加了但没选 → 先选一条。 */
export function soundPlayBlockedReason(input: {
  readonly clips: number;
  readonly picked: string | undefined;
}): string | undefined {
  if (input.clips === 0) {
    return "先加一条音频（点「编辑」从项目里挑）";
  }

  return input.picked === undefined ? "先选一条声音" : undefined;
}

/**
 * 点下去会发生什么：没连上时**照样记账**，只是要等连上才补发——把这件事写在按钮的 tooltip 上。
 *
 * 返回 `undefined` 表示「现在就能发下去」。
 */
export function soundDeliveryHint(input: {
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

export function SoundFields({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  const tree = useEditorStore((state) => state.project.tree);
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const playback = useEditorStore((state) => state.soundPlayback);
  const openSoundEditor = useEditorStore((state) => state.openSoundEditor);
  const selectSoundClip = useEditorStore((state) => state.selectSoundClip);
  const setSoundLayer = useEditorStore((state) => state.setSoundLayer);
  const playSound = useEditorStore((state) => state.playSound);
  const stopSound = useEditorStore((state) => state.stopSound);
  const mode = useEditorStore((state) => state.mode);
  const status = useEditorStore((state) => state.runtime.status);
  const clientConnected = useEditorStore((state) => state.runtime.clientConnected);

  const sound = object.sound;
  // 手写文件里可能整个 sound 都没有（`validateScene` 会报错）：这里按「还没加音频、音效层」显示
  const clips = sound?.clips ?? [];
  const layer: SoundLayer = sound?.layer ?? DEFAULT_SOUND_LAYER;
  const picked = sound?.picked;

  /** 面板上显示什么名字：自己起过就用它，否则用素材文件名（去掉扩展名）。 */
  const nameOf = (clip: string): string => {
    const fileName = findAssetById(tree, clip)?.name ?? clip;
    return sound?.names?.[clip] ?? assetDisplayName(fileName);
  };

  const pickedName = picked === undefined ? "" : nameOf(picked);
  const playBlocked = soundPlayBlockedReason({ clips: clips.length, picked });
  const delivery = soundDeliveryHint({ mode, status, clientConnected });

  /*
    点下去要有**看得见的变化**：本层记账里就是这个对象 → 按钮写成「播放中」并高亮；
    记的是别的对象 → 明说本层被谁占着（同层同时只响一条）；没记 → 本层没在播。
    记账是运行态（不写文档），所以切场景 / 换项目后会回到「没在播」。
  */
  const layerEntry = playback.layers[layer];
  const playingHere = layerEntry?.objectId === object.id;
  const holder =
    layerEntry === undefined || playingHere
      ? ""
      : (scenes
          .find((scene) => scene.name === activeSceneName)
          ?.objects.find((item) => item.id === layerEntry.objectId)?.name ?? layerEntry.objectId);

  const playbackState = playingHere ? "playing" : layerEntry === undefined ? "idle" : "busy";
  const playbackNote =
    playbackState === "playing"
      ? `本层正在播：${pickedName}`
      : playbackState === "busy"
        ? `本层正被「${holder}」占着`
        : "本层没在播";

  const buttonClass =
    "flex-none rounded border border-[var(--color-editor-border)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-editor-panel-alt)] disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <>
      <FieldRow label="层级">
        <select
          data-testid="sound-layer"
          aria-label="声音层级"
          value={layer}
          title="声道分组：同层同时只响一条（播新的，旧的停）；要两件事同时响就分到两层"
          className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 text-[11px] outline-none"
          onChange={(event) => setSoundLayer(object.id, event.target.value as SoundLayer)}
        >
          {SOUND_LAYERS.map((value) => (
            <option key={value} value={value}>
              {SOUND_LAYER_LABELS[value]}
            </option>
          ))}
        </select>
      </FieldRow>

      {/*
        音频那一行：**加进来的全列出来**（单选，选中的那条就是前端会播的）。
        小方块会折行，所以这里自己是一个 `flex-wrap` 容器（`FieldRow` 只管标签那一列）。
      */}
      <FieldRow label="音频">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" data-testid="sound-clips">
          {clips.length === 0 ? (
            <span
              data-testid="sound-empty"
              className="text-[11px] text-[var(--color-editor-text-dim)]"
              title="点下面的「编辑音频…」从项目里的音频素材里挑"
            >
              还没加音频
            </span>
          ) : (
            clips.map((clip) => {
              const selected = clip === picked;
              return (
                <button
                  key={clip}
                  type="button"
                  data-testid="sound-clip"
                  data-clip={clip}
                  data-selected={selected}
                  aria-pressed={selected}
                  title={
                    selected
                      ? `${assetDisplayPath(clip)}（就是它会被播；再点一下取消选中）`
                      : `${assetDisplayPath(clip)}（点一下改成播它）`
                  }
                  className={`max-w-[8rem] truncate rounded border px-1.5 py-0.5 text-[10px] ${
                    selected
                      ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                      : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel-alt)]"
                  }`}
                  onClick={() => selectSoundClip(object.id, selected ? null : clip)}
                >
                  {nameOf(clip)}
                </button>
              );
            })
          )}
        </div>
      </FieldRow>

      {/*
        开窗口的按钮**单独占一行**：它和小方块挤在一行时，想换「播哪条」很容易点到它
        （一个点错是换声音、一个点错是弹窗口）。标签留空 = 让按钮与上面那排小方块左对齐。
      */}
      <FieldRow label="">
        <button
          type="button"
          data-testid="sound-edit"
          title="打开「编辑声音」窗口：加 / 删音频、看路径、给每个音频起名字"
          className="toolbar-button flex-none hover:toolbar-button-hover"
          onClick={() => openSoundEditor(object.id)}
        >
          编辑音频…
        </button>
      </FieldRow>

      <FieldRow label="播放">
        <button
          type="button"
          data-testid="sound-play"
          data-playing={playingHere}
          disabled={playBlocked !== undefined}
          title={
            playBlocked ??
            (playingHere
              ? `本层正在播「${pickedName}」；再点一次让前端从头播一遍`
              : (delivery ?? `让前端播放「${pickedName}」（编辑器自己不出声）`))
          }
          className={
            playingHere
              ? "flex-none rounded border border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] px-1.5 py-0.5 text-[10px] text-white hover:bg-[var(--color-editor-panel-alt)] disabled:opacity-40"
              : buttonClass
          }
          onClick={() => playSound(object.id)}
        >
          {playingHere ? <SoundWaveBars /> : "▶"} {playingHere ? "播放中" : "播放"}
        </button>
        <button
          type="button"
          data-testid="sound-stop"
          title={delivery ?? `让前端停掉「${SOUND_LAYER_LABELS[layer]}」这一层的声音`}
          className={buttonClass}
          onClick={() => stopSound(object.id)}
        >
          ■ 停止
        </button>
      </FieldRow>

      {/*
        状态自己一行（与上面两个按钮左对齐）：挤在按钮后面时，稍长的音频名就被截没了——
        而这行字正是「点下去到底有没有生效」的答案。
      */}
      <FieldRow label="">
        <span
          data-testid="sound-status"
          data-state={playbackState}
          title={playbackNote}
          className={`min-w-0 flex-1 truncate text-[10px] ${
            playbackState === "playing"
              ? "text-[var(--color-editor-accent)]"
              : "text-[var(--color-editor-text-dim)]"
          }`}
        >
          {playbackNote}
        </span>
      </FieldRow>
    </>
  );
}

/**
 * 「正在播」的**动效图标**：三根跳动的声音条（关键帧在 `styles/index.css` 的 `editor-sound-wave`）。
 *
 * 为什么要有它：点「播放」只是把命令记下来、发给前端（编辑器自己不出声），光靠文字容易以为
 * 点了没反应——一个在动的东西才一眼看得出「有个音频正在播」。纯 CSS 动画，不引 JS 定时器、
 * 也不让面板每帧重渲染；系统里关了动画就不动（状态本来就有文字）。
 *
 * 装饰性的，所以 `aria-hidden`：说给读屏听的是按钮文案（「播放中」）与旁边那行状态。
 */
function SoundWaveBars(): React.JSX.Element {
  return (
    <span className="editor-sound-bars" data-testid="sound-wave" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
