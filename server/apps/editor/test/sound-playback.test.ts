import { describe, expect, it } from "vitest";
import {
  emptySoundPlayback,
  soundPlaybackResendPlan,
  withPlaying,
  withStopped,
} from "../src/services/sound-playback";

/**
 * 声音的**期望播放状态**（编辑器记账）：点播放 / 停止只改这份状态，
 * 前端连上时按它补发。纯函数，单独钉。
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
    expect(first.layers.bgm).toEqual(ENTRY);

    const second = withPlaying(first, {
      ...ENTRY,
      objectId: "sound-2",
      clips: [ENTRY.clips[1]!],
    });
    expect(second.layers.bgm?.objectId).toBe("sound-2");
    expect(second.layers.bgm?.clips).toEqual([ENTRY.clips[1]]);
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
