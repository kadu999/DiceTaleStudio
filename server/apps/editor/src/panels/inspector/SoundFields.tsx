import {
  DEFAULT_SOUND_LAYER,
  OBJECT_SOUND_LAYERS,
  SOUND_LAYER_LABELS,
  soundDataOf,
  type SceneObjectDoc,
  type SoundLayer,
} from "@dts/document";
import { useEditorStore, type EditorMode } from "../../state/editor-store";
import type { RuntimeStatus } from "../../services/runtime-client";
import { audioDisplayName } from "../audio-catalog";
import { assetDisplayPath } from "../asset-picker";
import {
  FieldRow,
  PLAYBACK_BUTTON_ACTIVE_CLASS,
  PLAYBACK_BUTTON_CLASS,
  PlaybackRow,
  PlaybackStatus,
  type PlaybackState,
} from "./fields";

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
 * - **停止 / 暂停按层级**（不是按对象）。
 *
 * **控件行与「视频」那一组完全一致**（`PlaybackRow` + 同一套按钮）：播放 / 暂停 · 继续 / 停止
 * + 一行状态；两组的措辞也一样（正在播放 / 已暂停 / 没在播放）。
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
  const audioMeta = useEditorStore((state) => state.doc.audioMeta);
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const playback = useEditorStore((state) => state.soundPlayback);
  const openSoundEditor = useEditorStore((state) => state.openSoundEditor);
  const selectSoundClip = useEditorStore((state) => state.selectSoundClip);
  const setSoundLayer = useEditorStore((state) => state.setSoundLayer);
  const playSound = useEditorStore((state) => state.playSound);
  const stopSound = useEditorStore((state) => state.stopSound);
  const pauseSound = useEditorStore((state) => state.pauseSound);
  const resumeSound = useEditorStore((state) => state.resumeSound);
  const mode = useEditorStore((state) => state.mode);
  const status = useEditorStore((state) => state.runtime.status);
  const clientConnected = useEditorStore((state) => state.runtime.client !== null);

  const sound = soundDataOf(object);
  // 手写文件里可能整个 sound 都没有（`validateScene` 会报错）：这里按「还没加音频、音效层」显示
  const clips = sound?.clips ?? [];
  const layer: SoundLayer = sound?.layer ?? DEFAULT_SOUND_LAYER;
  const picked = sound?.picked;

  /**
   * 面板上显示什么名字：**这个对象自己起的 → 音频文件自己的显示名 → 素材文件名**。
   *
   * 中间那一层是「音频文件」窗口里的项目级标注（v17 起）：同一个文件在别处（BGM 弹框、
   * 选择音频）也叫这个名字，所以对象这边留空就自动跟随，不必每个对象再起一遍。
   */
  const nameOf = (clip: string): string => audioDisplayName(audioMeta, clip, sound?.names?.[clip]);

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
  const pausedHere = playingHere && layerEntry !== undefined && layerEntry.paused;
  const holder =
    layerEntry === undefined || playingHere
      ? ""
      : (scenes
          .find((scene) => scene.name === activeSceneName)
          ?.objects.find((item) => item.id === layerEntry.objectId)?.name ?? layerEntry.objectId);

  /*
    状态只有四档，措辞与「视频」那一组**完全一致**（正在播放 / 已暂停 / 没在播放），
    多出来的 `busy` 是「按层级管」这件事特有的：本层被**别的**声音对象占着。
  */
  const playbackState: PlaybackState = !playingHere
    ? layerEntry === undefined
      ? "idle"
      : "busy"
    : pausedHere
      ? "paused"
      : "playing";
  const playbackNote =
    playbackState === "playing"
      ? `正在播放：${pickedName}`
      : playbackState === "paused"
        ? `已暂停：${pickedName}`
        : playbackState === "busy"
          ? `本层正被「${holder}」占着`
          : "没在播放";

  return (
    <>
      <FieldRow label="层级">
        <select
          data-testid="sound-layer"
          aria-label="声音层级"
          value={layer}
          title="这是「这几类声音」里的哪一类：同层同时只响一条（播新的，旧的停）；要两件事同时响就分到两类。背景音乐不在对象上（顶栏「音乐」弹框），对象上只能选音效 / 旁白"
          className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 text-[11px] outline-none"
          onChange={(event) => setSoundLayer(object.id, event.target.value as SoundLayer)}
        >
          {/*
            对象只给「音效 / 旁白」两档：背景音乐（`bgm`）已经改成顶栏「音乐」弹框那一套了。
            老文件里写着 `bgm` 的对象**照旧显示它**（下面那条提示让作者自己改），
            而不是悄悄把它改成音效——那等于替用户改了数据。
          */}
          {layer === "bgm" ? (
            <option value="bgm">{SOUND_LAYER_LABELS.bgm}（已改为弹框）</option>
          ) : null}
          {OBJECT_SOUND_LAYERS.map((value) => (
            <option key={value} value={value}>
              {SOUND_LAYER_LABELS[value]}
            </option>
          ))}
        </select>
      </FieldRow>

      {layer === "bgm" ? (
        <FieldRow label="">
          <span
            data-testid="sound-layer-legacy-bgm"
            className="text-[10px] leading-relaxed text-[var(--color-editor-warn)]"
            title="背景音乐现在是顶栏「音乐」弹框那一套（点项目 Assets/audio 下的音频）：把这条改成音效 / 旁白"
          >
            背景音乐已改成顶栏「音乐」弹框：把这条改成音效 / 旁白
          </span>
        </FieldRow>
      ) : null}

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

      {/*
        播放 / 暂停 · 继续 / 停止：与「视频」那一组**完全同一套**（同一个 `PlaybackRow`、
        同一套按钮类名），连状态那行字的措辞都对得上。这三个键是现场真的在按的，所以比
        面板里其它小按钮大一圈（尺寸在 `fields.tsx` 的 `PLAYBACK_BUTTON_CLASS` 里定）。
      */}
      <PlaybackRow>
        <button
          type="button"
          data-testid="sound-play"
          data-playing={playingHere}
          disabled={playBlocked !== undefined}
          title={
            playBlocked ??
            (playingHere
              ? `正在播放「${pickedName}」；再点一次让前端从头播一遍`
              : (delivery ?? `让前端播放「${pickedName}」（编辑器自己不出声）`))
          }
          className={playingHere ? PLAYBACK_BUTTON_ACTIVE_CLASS : PLAYBACK_BUTTON_CLASS}
          onClick={() => playSound(object.id)}
        >
          {playingHere ? <SoundWaveBars /> : "▶"} {playingHere ? "播放中" : "播放"}
        </button>

        <button
          type="button"
          data-testid="sound-pause"
          data-paused={pausedHere}
          disabled={!playingHere}
          title={
            !playingHere
              ? "这一层没在播它（先点「播放」；本层被别的对象占着时去选中那个对象）"
              : (delivery ?? (pausedHere ? "从暂停的那一帧继续放" : "暂停在当前帧（再点一次继续）"))
          }
          className={pausedHere ? PLAYBACK_BUTTON_ACTIVE_CLASS : PLAYBACK_BUTTON_CLASS}
          onClick={() => (pausedHere ? resumeSound(object.id) : pauseSound(object.id))}
        >
          {pausedHere ? "▶ 继续" : "⏸ 暂停"}
        </button>

        <button
          type="button"
          data-testid="sound-stop"
          title={delivery ?? `让前端停掉「${SOUND_LAYER_LABELS[layer]}」这一层的声音`}
          className={PLAYBACK_BUTTON_CLASS}
          onClick={() => stopSound(object.id)}
        >
          ■ 停止
        </button>
      </PlaybackRow>

      <PlaybackStatus testId="sound-status" state={playbackState} note={playbackNote} />
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
