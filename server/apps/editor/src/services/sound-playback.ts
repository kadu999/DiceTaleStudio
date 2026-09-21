import type { SoundLayer } from "@dts/document";

/**
 * 声音的**期望播放状态**：编辑器记账「哪一层现在应该响什么」。
 *
 * 它是「后台希望前端现在响什么」，**不写文档、不进撤销栈**（与 `runtime` 镜像一样属于运行态）。
 * 点「播放 / 暂停 / 继续 / 停止」只改这里 + **尽力**下发命令：
 * - 编辑器还没连上服务端（编辑态）或前端没连 → 只记账，写明白原因；
 * - 等**前端连上**的那一刻补发一次，所以「点的时候前端不在」也不会丢。
 *
 * 这份状态是按**层级**记的（同层同时只响一条），与前端「同层顶替」的语义对得上；
 * 视频那边是按对象记的（`video-playback.ts`）——两组的**界面**一样，**记账口径**各按自己的语义。
 */

/**
 * 一层「期望播放」的内容。
 *
 * `clips` 是**下发时的快照**（对象后来被改/删也能看出当时发的是什么）；面板默认单选，
 * 所以它通常只有一个元素——留着数组是为了与协议的 `play_sound{clips}` 对齐。
 */
export interface SoundPlaybackEntry {
  readonly objectId: string;
  readonly layer: SoundLayer;
  readonly clips: readonly string[];
  /**
   * 暂停态（v6 起）：`true` = 这一层现在是**暂停**着的。
   *
   * 补发时要「先播再暂停」，否则前端会从头响——与视频那边同一个口径
   * （两组 UI 的控件行完全一致：播放 / 暂停 · 继续 / 停止）。
   */
  readonly paused: boolean;
}

export interface SoundPlaybackState {
  /** key = 层级 slug；**没有这个 key** = 这一层应该是停着的。 */
  readonly layers: Readonly<Record<string, SoundPlaybackEntry>>;
}

export function emptySoundPlayback(): SoundPlaybackState {
  return { layers: {} };
}

/** 记下「这一层要播这个」；同一层再点别的就顶掉（与前端同层顶替一致）。 */
export function withPlaying(
  state: SoundPlaybackState,
  entry: Omit<SoundPlaybackEntry, "paused">,
): SoundPlaybackState {
  return { layers: { ...state.layers, [entry.layer]: { ...entry, paused: false } } };
}

/**
 * 记下「这一层暂停 / 继续」。
 *
 * 没在记账里的那一层**什么都不做**（没播过就谈不上暂停）——返回原状态，
 * 于是调用方可以据此判断「这次点按有没有意义」（与视频的 `withVideoPaused` 同一套）。
 */
export function withSoundPaused(
  state: SoundPlaybackState,
  layer: SoundLayer,
  paused: boolean,
): SoundPlaybackState {
  const entry = state.layers[layer];
  if (entry === undefined || entry.paused === paused) {
    return state;
  }

  return { layers: { ...state.layers, [layer]: { ...entry, paused } } };
}

/** 记下「这一层要停」：把那一层从记账里删掉。 */
export function withStopped(state: SoundPlaybackState, layer: SoundLayer): SoundPlaybackState {
  if (state.layers[layer] === undefined) {
    return state;
  }

  const layers = { ...state.layers };
  delete layers[layer];
  return { layers };
}

/**
 * **前端刚连上时要补发哪些层**。
 *
 * 只在「之前没连 → 现在连上了」那一刻补，且每层只补一条（同层只响一条）；
 * 已经连着的时候不重复发（`sync_state` 快照到得很频繁，不能每来一张就重播一遍）。
 */
export function soundPlaybackResendPlan(input: {
  readonly wasClientConnected: boolean;
  readonly isClientConnected: boolean;
  readonly playback: SoundPlaybackState;
}): readonly SoundPlaybackEntry[] {
  if (input.wasClientConnected || !input.isClientConnected) {
    return [];
  }

  return Object.values(input.playback.layers);
}
