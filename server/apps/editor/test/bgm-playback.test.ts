import { describe, expect, it } from "vitest";
import {
  bgmResendActions,
  bgmResendPlan,
  emptyBgmPlayback,
  withBgmPaused,
  withBgmPlaying,
  withBgmStopped,
} from "../src/services/bgm-playback";

/**
 * 全局背景音乐的**记账**（编辑器）：纯函数，单独钉。
 *
 * 三条要钉死的语义：
 * - 缺省是「什么都没放」——进运行态**不会自动出声**（没有默认曲这回事了）；
 * - DM 点一首 / 暂停 / 继续 / 停止之后，补发的是他那一下的意图；
 * - 补发只在「前端刚连上」那一刻、且记账里确实有一首时才发生；暂停态先放再暂停。
 */

const TRACK_A = "project:C/Assets/audio/theme.mp3";
const TRACK_B = "project:C/Assets/audio/battle.wav";

const resend = (playback: ReturnType<typeof emptyBgmPlayback>, connected = true) =>
  bgmResendPlan({
    wasClientConnected: false,
    isClientConnected: connected,
    playback,
  });

describe("记账：现在该放哪一首", () => {
  it("缺省是什么都没放（播放权全交给 DM）", () => {
    expect(emptyBgmPlayback()).toEqual({ clip: null, paused: false });
  });

  it("点一首 / 换一首 → 记下这一首，并且不是暂停态", () => {
    const state = withBgmPlaying(emptyBgmPlayback(), TRACK_A);
    expect(state).toEqual({ clip: TRACK_A, paused: false });

    // 再点同一首：还是同一首，且回到「在放」（前端从头重播）
    expect(withBgmPlaying(withBgmPaused(state, true), TRACK_A)).toEqual({
      clip: TRACK_A,
      paused: false,
    });
  });

  it("暂停 / 继续只在「有一首在放」时才有意义", () => {
    const idle = emptyBgmPlayback();
    expect(withBgmPaused(idle, true)).toBe(idle);

    const playing = withBgmPlaying(idle, TRACK_A);
    const paused = withBgmPaused(playing, true);
    expect(paused).toEqual({ clip: TRACK_A, paused: true });

    // 值没变返回原对象（连点不会白刷状态）
    expect(withBgmPaused(paused, true)).toBe(paused);
    expect(withBgmPaused(paused, false)).toEqual({ clip: TRACK_A, paused: false });
  });

  it("停止 → 回到「什么都没放」，并且把「放的是哪一首」忘掉", () => {
    const playing = withBgmPlaying(emptyBgmPlayback(), TRACK_A);
    expect(withBgmStopped(playing)).toEqual({ clip: null, paused: false });

    const stopped = withBgmStopped(playing);
    expect(withBgmStopped(stopped)).toBe(stopped);
    // 暂停态下按停止同样清干净（不会留一个「暂停着但没曲目」的怪状态）
    expect(withBgmStopped(withBgmPaused(playing, true))).toEqual({ clip: null, paused: false });
  });
});

describe("补发计划：前端刚连上时补哪一首", () => {
  it("没连上 → 不补（记账不因此改变）", () => {
    expect(resend(withBgmPlaying(emptyBgmPlayback(), TRACK_A), false)).toBeNull();
  });

  it("之前就连着 → 不补（状态快照到得很频繁，不能每来一张就重播一遍）", () => {
    expect(
      bgmResendPlan({
        wasClientConnected: true,
        isClientConnected: true,
        playback: withBgmPlaying(emptyBgmPlayback(), TRACK_A),
      }),
    ).toBeNull();
  });

  it("没在放（还没点过 / 点过停止）→ 什么都不补（前端是干净的）", () => {
    expect(resend(emptyBgmPlayback())).toBeNull();
    expect(resend(withBgmStopped(withBgmPlaying(emptyBgmPlayback(), TRACK_A)))).toBeNull();
  });

  it("在放 → 补这一首；补发命令只有一条 play", () => {
    const plan = resend(withBgmPlaying(emptyBgmPlayback(), TRACK_B));
    if (plan === null) {
      throw new Error("应当有补发计划");
    }

    expect(plan).toEqual({ clip: TRACK_B, paused: false });
    expect(bgmResendActions(plan)).toEqual([{ kind: "play", clip: TRACK_B }]);
  });

  it("暂停态 → 先放再暂停（不然重连后会从头响起来）", () => {
    const plan = resend(withBgmPaused(withBgmPlaying(emptyBgmPlayback(), TRACK_A), true));
    if (plan === null) {
      throw new Error("应当有补发计划");
    }

    expect(plan).toEqual({ clip: TRACK_A, paused: true });
    expect(bgmResendActions(plan)).toEqual([
      { kind: "play", clip: TRACK_A },
      { kind: "pause" },
    ]);
  });
});
