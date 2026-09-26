import type { VideoBlendAudio } from "@dts/document";
import { createPlaybackLedger } from "./playback-ledger";

/**
 * 视频混合的**期望播放状态**：编辑器记账「哪个对象现在应该混合放哪两条视频」。
 *
 * 与视频的记账（`video-playback.ts`）同一套骨架、同一套规矩（不写文档、不进撤销栈；
 * 点播放 / 暂停 / 停止只改它 + 尽力下发；前端连上补发；切场景清），差别只有条目内容：
 * 视频混合有**两条通道**、声音来源是三档枚举（`none|a|b`）而不是布尔。
 * 共用的骨架（空 / 播 / 暂停 / 停 / 补发计划）在 `playback-ledger.ts`。
 */

/** 一个对象「期望混合播放」的内容。 */
export interface VideoBlendPlaybackEntry {
  readonly objectId: string;
  /**
   * 下发时的**两条通道快照**（哪条没选就不列进来；对象后来换视频 / 被删也看得出当时放的是什么）。
   * 前端真正放的仍是镜像里 `VideoBlend` 的两条 `picked`——命令只是触发器。
   */
  readonly clips: readonly string[];
  /** 下发时的循环 / 声音来源快照（面板上那份是文档数据，这里留一份便于日志与诊断）。 */
  readonly loop: boolean;
  readonly audio: VideoBlendAudio;
  /** 暂停态：补发时要「先放再暂停」，否则前端会从头开始放。 */
  readonly paused: boolean;
}

const ledger = createPlaybackLedger<"objects", string, VideoBlendPlaybackEntry>({
  field: "objects",
  keyOf: (entry) => entry.objectId,
});

export type VideoBlendPlaybackState = ReturnType<typeof ledger.empty>;

export const emptyVideoBlendPlayback = ledger.empty;
export const withVideoBlendPlaying = ledger.withPlaying;
/** 没在记账里的对象**什么都不做**（没播过就谈不上暂停）——返回原状态。 */
export const withVideoBlendPaused = ledger.withPaused;
export const withVideoBlendStopped = ledger.withStopped;
export const videoBlendPlaybackResendPlan = ledger.resendPlan;
