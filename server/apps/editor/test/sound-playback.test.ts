import { describe, expect, it } from "vitest";
import {
  emptySoundPlayback,
  soundPlaybackResendPlan,
  withPlaying,
  withSoundPaused,
  withStopped,
} from "../src/services/sound-playback";

/**
 * 声音的**期望播放状态**（编辑器记账）：点播放 / 暂停 / 继续 / 停止只改这份状态，
 * 前端连上时按它补发。纯函数，单独钉。
 *
 * 与视频的记账（`video-playback`）**界面一样、口径不同**：声音按**层级**管
 * （同层同时只响一条），视频按**对象**管（每个对象各自一条）。
 */

const ENTRY = {
  objectId: "sound-1",
  layer: "bgm" as const,
  clips: ["project:C/Assets/audio/a.mp3", "project:C/Assets/audio/b.mp3"],
};

describe("记账：哪一层该播什么", () => {
  it("空状态没有任何层", () => {
    expect(emptySoundPlayback().layers).toEqual({});
  });

  it("记播放按层级存；同一层再点别的就顶掉（同层只响一条）", () => {
    const first = withPlaying(emptySoundPlayback(), ENTRY);
    expect(first.layers.bgm).toEqual({ ...ENTRY, paused: false });

    const second = withPlaying(first, {
      ...ENTRY,
      objectId: "sound-2",
      clips: [ENTRY.clips[1]!],
    });
    expect(second.layers.bgm?.objectId).toBe("sound-2");
    expect(second.layers.bgm?.clips).toEqual([ENTRY.clips[1]]);
    // 换了一条就是重新播：暂停态跟着清掉
    expect(second.layers.bgm?.paused).toBe(false);
  });

  it("记暂停 / 继续：只改 paused 那一档；没记着的层不动", () => {
    const playing = withPlaying(emptySoundPlayback(), ENTRY);

    const paused = withSoundPaused(playing, "bgm", true);
    expect(paused.layers.bgm?.paused).toBe(true);

    const resumed = withSoundPaused(paused, "bgm", false);
    expect(resumed.layers.bgm?.paused).toBe(false);

    // 状态没变 / 那一层没在记账里：返回同一个对象（不做无谓的更新）
    expect(withSoundPaused(resumed, "bgm", false)).toBe(resumed);
    expect(withSoundPaused(playing, "sfx", true)).toBe(playing);
  });

  it("记停止：把那一层删掉；本来就没记着时返回同一个对象（不做无谓的更新）", () => {
    const playing = withPlaying(emptySoundPlayback(), ENTRY);

    expect(withStopped(playing, "bgm").layers).toEqual({});
    expect(withStopped(playing, "sfx")).toBe(playing);
  });
});

describe("前端刚连上时的补发计划", () => {
  const playback = withPlaying(
    withPlaying(emptySoundPlayback(), ENTRY),
    { objectId: "sound-2", layer: "sfx", clips: ["project:C/Assets/audio/step.mp3"] },
  );

  it("只在「之前没连 → 现在连上了」那一刻补，每层一条", () => {
    const plan = soundPlaybackResendPlan({
      wasClientConnected: false,
      isClientConnected: true,
      playback,
    });

    expect(plan.map((entry) => entry.layer).sort()).toEqual(["bgm", "sfx"]);
  });

  it("暂停态也带着 paused 补发：调用方据此「先播再暂停」，前端才停在原处", () => {
    const paused = withSoundPaused(playback, "bgm", true);

    const plan = soundPlaybackResendPlan({
      wasClientConnected: false,
      isClientConnected: true,
      playback: paused,
    });

    expect(plan.find((entry) => entry.layer === "bgm")?.paused).toBe(true);
    expect(plan.find((entry) => entry.layer === "sfx")?.paused).toBe(false);
  });

  it("一直连着不补（快照到得很频繁，不能每来一张就重播一遍）", () => {
    expect(
      soundPlaybackResendPlan({ wasClientConnected: true, isClientConnected: true, playback }),
    ).toEqual([]);
  });

  it("还没连上、或者这边刚断开时都不补", () => {
    expect(
      soundPlaybackResendPlan({ wasClientConnected: false, isClientConnected: false, playback }),
    ).toEqual([]);
    expect(
      soundPlaybackResendPlan({ wasClientConnected: true, isClientConnected: false, playback }),
    ).toEqual([]);
  });

  it("什么都没记着时补发计划是空的", () => {
    expect(
      soundPlaybackResendPlan({
        wasClientConnected: false,
        isClientConnected: true,
        playback: emptySoundPlayback(),
      }),
    ).toEqual([]);
  });
});
