import type { SoundLayer } from "@dts/document";
import { createPlaybackLedger } from "./playback-ledger";

/**
 * 声音的**期望播放状态**：编辑器记账「哪一层现在应该响什么」。
 *
 * 这份状态是按**层级**记的（同层同时只响一条），与前端「同层顶替」的语义对得上；
 * 视频那边是按对象记的（`video-playback.ts`）——两组的**界面**一样，**记账口径**各按自己的语义。
 * 共用的骨架（空 / 播 / 暂停 / 停 / 补发计划）在 `playback-ledger.ts`。
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

const ledger = createPlaybackLedger<"layers", string, SoundPlaybackEntry>({
  field: "layers",
  keyOf: (entry) => entry.layer,
});

export type SoundPlaybackState = ReturnType<typeof ledger.empty>;

export const emptySoundPlayback = ledger.empty;
export const withPlaying = ledger.withPlaying;
/** 没在记账里的那一层**什么都不做**（没播过就谈不上暂停）——返回原状态。 */
export const withSoundPaused = ledger.withPaused;
/** 记下「这一层要停」：把那一层从记账里删掉。 */
export const withStopped = ledger.withStopped;
export const soundPlaybackResendPlan = ledger.resendPlan;
