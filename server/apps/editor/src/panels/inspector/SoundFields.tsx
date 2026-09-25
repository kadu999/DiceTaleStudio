import { useState } from "react";
import {
  DEFAULT_SOUND_LAYER,
  OBJECT_SOUND_LAYERS,
  SOUND_LAYER_LABELS,
  soundDataOf,
  type GameObjectDoc,
  type SoundLayer,
} from "@dts/document";
import { useEditorStore, type EditorMode } from "../../state/editor-store";
import type { RuntimeStatus } from "../../services/runtime-client";
import { audioDisplayName } from "../audio-catalog";
import { assetDisplayPath, currentResourceId } from "../asset-picker";
import { ResourcePickerDialog } from "../../app/ResourcePickerDialog";
import {
  FieldRow,
  PLAYBACK_BUTTON_ACTIVE_CLASS,
  PLAYBACK_BUTTON_CLASS,
  PlaybackRow,
  PlaybackStatus,
  type PlaybackState,
} from "./fields";

/**
 * 声音对象（动作对象）的「声音」组：**层级 → 音频（小方块 + 添加 / 移出）→ 播放**。
 *
 * 清单的**全部管理都在这一组里**（没有别的窗口）：
 * - 小方块 = 加进来的音频，点一下就把「播哪一条」切过去；
 * - 每个小方块上的 `×` = 移出那一条；「清空」= 一次全部移出；
 * - `＋` = 从项目素材里**添加**（弹 `ResourcePickerDialog`：选中一条 → 点「添加」加入，一次一条）。
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

/** 「播放」现在能不能点：一条音频都没加 → 先添加；加了但没选 → 先选一条。 */
export function soundPlayBlockedReason(input: {
  readonly clips: number;
  readonly picked: string | undefined;
}): string | undefined {
  if (input.clips === 0) {
    return "先加一条音频（点「＋」从项目里挑）";
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

export function SoundFields({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
  const audioMetas = useEditorStore((state) => state.assetMetaTable);
  const assetMetas = useEditorStore((state) => state.assetMetas);
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const playback = useEditorStore((state) => state.soundPlayback);
  const addSoundClip = useEditorStore((state) => state.addSoundClip);
  const removeSoundClip = useEditorStore((state) => state.removeSoundClip);
  const clearSoundClips = useEditorStore((state) => state.clearSoundClips);
  const selectSoundClip = useEditorStore((state) => state.selectSoundClip);
  const setSoundLayer = useEditorStore((state) => state.setSoundLayer);
  const playSound = useEditorStore((state) => state.playSound);
  const stopSound = useEditorStore((state) => state.stopSound);
  const pauseSound = useEditorStore((state) => state.pauseSound);
  const resumeSound = useEditorStore((state) => state.resumeSound);
  const mode = useEditorStore((state) => state.mode);
  const status = useEditorStore((state) => state.runtime.status);
  const clientConnected = useEditorStore((state) => state.runtime.client !== null);

  /** 「选择音频」弹框开着没有（换个对象就收起来）。 */
  const [picking, setPicking] = useState(false);

  const sound = soundDataOf(object);
  // 手写文件里可能整个 sound 都没有（`validateScene` 会报错）：这里按「还没加音频、音效层」显示
  const clips = sound?.clips ?? [];
  const layer: SoundLayer = sound?.layer ?? DEFAULT_SOUND_LAYER;
  const picked = sound?.picked;

  /**
   * 面板上显示什么名字：**音频文件自己的显示名 → 素材文件名**。
   *
   * 显示名住在那个音频文件**自己的 `.meta`** 里（顶层 `name`）：同一个文件在别处
   * （BGM 弹框、选择音频）也叫这个名字，改一处全体跟随——**显示名只在文件属性上改**，
   * 对象这边没有任何自己的覆盖层。
   */
  const nameOf = (clip: string): string => audioDisplayName(audioMetas, clip);
  const pathOf = (clip: string): string =>
    assetDisplayPath(currentResourceId(clip, assetMetas) ?? clip);

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
        音频那一行：**加进来的全列出来**（单选，选中的那条就是前端会播的），
        管理也全在这一行：小方块上的 `×` 移出一条、「清空」全部移出、`＋` 添加。
        小方块会折行，所以这里自己是一个 `flex-wrap` 容器（`FieldRow` 只管标签那一列）。
      */}
      <FieldRow label="音频">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" data-testid="sound-clips">
          {clips.length === 0 ? (
            <span
              data-testid="sound-empty"
              className="text-[11px] text-[var(--color-editor-text-dim)]"
              title="点「＋」从项目里的音频素材里挑"
            >
              还没加音频
            </span>
          ) : (
            clips.map((clip) => {
              const selected = clip === picked;
              const name = nameOf(clip);
              return (
                <span
                  key={clip}
                  data-testid="sound-clip"
                  data-clip={clip}
                  data-selected={selected}
                  title={
                    selected
                      ? `${pathOf(clip)}（就是它会被播；再点一下取消选中）`
                      : `${pathOf(clip)}（点一下改成播它）`
                  }
                  className={`flex max-w-[9rem] items-center overflow-hidden rounded border text-[10px] ${
                    selected
                      ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                      : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel-alt)]"
                  }`}
                >
                  <button
                    type="button"
                    aria-pressed={selected}
                    className="min-w-0 flex-1 truncate px-1.5 py-0.5 text-left"
                    onClick={() => selectSoundClip(object.id, selected ? null : clip)}
                  >
                    {name}
                  </button>
                  {/*
                    × 用 CSS 画（::after content）：不进 textContent，e2e 对小方块
                    `toHaveText(name)` 的断言才不会被这个符号弄脏。
                  */}
                  <button
                    type="button"
                    data-testid="sound-clip-remove"
                    data-clip={clip}
                    aria-label={`移出 ${name}`}
                    title="移出这一条（素材文件不会被删）"
                    className="flex-none self-stretch px-1 text-[var(--color-editor-text-dim)] after:content-['×'] hover:text-[var(--color-editor-danger)]"
                    onClick={() => removeSoundClip(object.id, clip)}
                  />
                </span>
              );
            })
          )}

          <button
            type="button"
            data-testid="sound-add"
            title="从项目里的音频素材里挑（选中一条，点「添加」加入）"
            aria-label="添加音频"
            className="flex h-6 w-6 flex-none items-center justify-center rounded border border-dashed border-[var(--color-editor-border)] text-[13px] leading-none text-[var(--color-editor-text-dim)] hover:border-[var(--color-editor-accent)] hover:text-[var(--color-editor-text)]"
            onClick={() => setPicking(true)}
          >
            ＋
          </button>
          {clips.length === 0 ? null : (
            <button
              type="button"
              data-testid="sound-clear"
              title="全部移出（素材文件不会被删）"
              className="flex-none rounded border border-[var(--color-editor-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-editor-text-dim)] hover:border-[var(--color-editor-accent)] hover:text-[var(--color-editor-text)]"
              onClick={() => clearSoundClips(object.id)}
            >
              清空
            </button>
          )}
        </div>
      </FieldRow>

      {/* 选择音频：选中一条 → 点「添加」加入（一次一条），取消 / 关窗回到面板 */}
      <ResourcePickerDialog
        kind="audio"
        open={picking}
        onPick={(id) => addSoundClip(object.id, id)}
        onClose={() => setPicking(false)}
      />

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
