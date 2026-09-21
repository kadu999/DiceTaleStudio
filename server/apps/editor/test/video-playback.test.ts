import { describe, expect, it } from "vitest";
import {
  emptyVideoPlayback,
  videoPlaybackResendPlan,
  withVideoPaused,
  withVideoPlaying,
  withVideoStopped,
} from "../src/services/video-playback";

/**
 * 视频的**期望播放状态**（编辑器记账）：点播放 / 暂停 / 继续 / 停止只改这份状态，
 * 前端连上时按它补发。纯函数，单独钉。
 *
 * 与声音的记账（`sound-playback`）有一个关键区别：**按对象记**，不是按层级——
 * 视频挂在对象自己身上，每个对象各自一条、互不影响（地图放着背景视频时精灵也能同时放）。
 */

const ENTRY = {
  objectId: "map-1",
  clip: "project:C/Assets/video/opening.mp4",
  loop: false,
  audio: false,
};

describe("记账：哪个对象该放什么", () => {
  it("空状态没有任何对象", () => {
    expect(emptyVideoPlayback().objects).toEqual({});
  });

  it("记播放按对象存；同一个对象再点别的就顶掉（一个对象一次只放一条）", () => {
    const first = withVideoPlaying(emptyVideoPlayback(), ENTRY);
    expect(first.objects["map-1"]).toEqual({ ...ENTRY, paused: false });

    const second = withVideoPlaying(first, {
      ...ENTRY,
      clip: "project:C/Assets/video/rain.mp4",
      loop: true,
    });
    expect(second.objects["map-1"]?.clip).toBe("project:C/Assets/video/rain.mp4");
    expect(second.objects["map-1"]?.loop).toBe(true);
  });

  it("两个对象各记各的（互不顶掉）", () => {
    const both = withVideoPlaying(
      withVideoPlaying(emptyVideoPlayback(), ENTRY),
      { objectId: "sprite-1", clip: "project:C/Assets/video/fire.mp4", loop: true, audio: true },
    );

    expect(Object.keys(both.objects).sort()).toEqual(["map-1", "sprite-1"]);
    expect(both.objects["sprite-1"]?.audio).toBe(true);
    expect(both.objects["map-1"]?.audio).toBe(false);
  });

  it("记暂停 / 继续：只改 paused 那一档；没记着的对象不动", () => {
    const playing = withVideoPlaying(emptyVideoPlayback(), ENTRY);

    const paused = withVideoPaused(playing, "map-1", true);
    expect(paused.objects["map-1"]?.paused).toBe(true);

    const resumed = withVideoPaused(paused, "map-1", false);
    expect(resumed.objects["map-1"]?.paused).toBe(false);

    // 状态没变 / 对象没在记账里：返回同一个对象（不做无谓的更新）
    expect(withVideoPaused(resumed, "map-1", false)).toBe(resumed);
    expect(withVideoPaused(playing, "sprite-1", true)).toBe(playing);
  });

  it("记停止：把这个对象删掉；本来就没记着时返回同一个对象", () => {
    const playing = withVideoPlaying(emptyVideoPlayback(), ENTRY);

    expect(withVideoStopped(playing, "map-1").objects).toEqual({});
    expect(withVideoStopped(playing, "sprite-1")).toBe(playing);
  });
});

describe("前端刚连上时的补发计划", () => {
  const playback = withVideoPaused(
    withVideoPlaying(withVideoPlaying(emptyVideoPlayback(), ENTRY), {
      objectId: "sprite-1",
      clip: "project:C/Assets/video/fire.mp4",
      loop: true,
      audio: true,
    }),
    "sprite-1",
    true,
  );

  it("只在「之前没连 → 现在连上了」那一刻补，每个对象一条（暂停态也带着 paused）", () => {
    const plan = videoPlaybackResendPlan({
      wasClientConnected: false,
      isClientConnected: true,
      playback,
    });

    expect(plan.map((entry) => entry.objectId).sort()).toEqual(["map-1", "sprite-1"]);
    // 暂停态要带着 paused 补发：调用方据此「先放再暂停」，前端才回到同一帧
    expect(plan.find((entry) => entry.objectId === "sprite-1")?.paused).toBe(true);
    expect(plan.find((entry) => entry.objectId === "map-1")?.paused).toBe(false);
  });

  it("一直连着不补（快照到得很频繁，不能每来一张就重放一遍）", () => {
    expect(
      videoPlaybackResendPlan({ wasClientConnected: true, isClientConnected: true, playback }),
    ).toEqual([]);
  });

  it("还没连上、或者这边刚断开时都不补", () => {
    expect(
      videoPlaybackResendPlan({ wasClientConnected: false, isClientConnected: false, playback }),
    ).toEqual([]);
    expect(
      videoPlaybackResendPlan({ wasClientConnected: true, isClientConnected: false, playback }),
    ).toEqual([]);
  });

  it("什么都没记着时补发计划是空的", () => {
    expect(
      videoPlaybackResendPlan({
        wasClientConnected: false,
        isClientConnected: true,
        playback: emptyVideoPlayback(),
      }),
    ).toEqual([]);
  });
});
