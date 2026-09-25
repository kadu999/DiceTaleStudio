import { createPlaybackLedger } from "./playback-ledger";

/**
 * 视频的**期望播放状态**：编辑器记账「哪个对象现在应该放什么视频」。
 *
 * 与声音的记账（`sound-playback.ts`）同一套思路，但**按对象记**而不是按层级：
 * 视频挂在对象自己身上，每个对象各自一条、互不影响（地图放着背景视频时，精灵也能同时放）。
 * 共用的骨架（空 / 播 / 暂停 / 停 / 补发计划）在 `playback-ledger.ts`。
 */

/** 一个对象「期望播放」的内容。 */
export interface VideoPlaybackEntry {
  readonly objectId: string;
  /**
   * 下发时的**视频快照**（对象后来换视频 / 被删也看得出当时放的是什么）；
   * 前端真正放的仍是镜像里 `video.picked` 那一条——命令只是触发器。
   */
  readonly clip: string;
  /** 下发时的循环 / 声音开关快照（面板上那份是文档数据，这里留一份便于日志与诊断）。 */
  readonly loop: boolean;
  readonly audio: boolean;
  /** 暂停态：补发时要「先放再暂停」，否则前端会从头开始放。 */
  readonly paused: boolean;
}

const ledger = createPlaybackLedger<"objects", string, VideoPlaybackEntry>({
  field: "objects",
  keyOf: (entry) => entry.objectId,
});

export type VideoPlaybackState = ReturnType<typeof ledger.empty>;

export const emptyVideoPlayback = ledger.empty;
export const withVideoPlaying = ledger.withPlaying;
/** 没在记账里的对象**什么都不做**（没播过就谈不上暂停）——返回原状态。 */
export const withVideoPaused = ledger.withPaused;
export const withVideoStopped = ledger.withStopped;
export const videoPlaybackResendPlan = ledger.resendPlan;
