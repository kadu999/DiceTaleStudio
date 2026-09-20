import { describe, expect, it } from "vitest";
import { audioBadgeAnimation, kindMarkerColor } from "../src/scene-renderer";

/**
 * 声音徽标「正在播」的动画参数。
 *
 * 它是**纯函数**（只跟 `playing` 与时刻有关），所以能在没有画布的环境里把「两圈错开、
 * 越扩越大越淡、周期性重复」这几件事钉住——不用去比像素。
 *
 * 为什么要这个动画：编辑器自己不出声（出声在前端），画布上「有个音频正在播」只能靠
 * **看得见的变化**表达；静态图标谁也分不出它是在响还是待命。
 */

const PERIOD_MS = 1200;

describe("声音徽标的播放动画", () => {
  it("不播时没有声波圈、喇叭也不胀缩（就是静止那一帧）", () => {
    expect(audioBadgeAnimation({ playing: false, timeMs: 0 })).toEqual({ rings: [], waveScale: 1 });
    expect(audioBadgeAnimation({ playing: false, timeMs: 4200 })).toEqual({
      rings: [],
      waveScale: 1,
    });
  });

  it("正在播：两圈声波，错开半个周期（一圈刚出牌面、另一圈已经走到半路）", () => {
    const { rings } = audioBadgeAnimation({ playing: true, timeMs: 0 });

    expect(rings).toHaveLength(2);
    // 第一圈：贴着一半牌面起（1.05 × 半边），最实
    expect(rings[0]?.radiusFactor).toBeCloseTo(1.05, 5);
    expect(rings[0]?.alpha).toBeCloseTo(0.75, 5);
    // 第二圈：错开半个周期，已经扩到一半路程、淡了一半
    expect(rings[1]?.radiusFactor).toBeCloseTo(1.05 + 0.95 * 0.5, 5);
    expect(rings[1]?.alpha).toBeCloseTo(0.375, 5);
  });

  it("同一圈随时间往外扩，并且**越扩越淡**（最后淡到看不见）", () => {
    const at = (timeMs: number) => audioBadgeAnimation({ playing: true, timeMs }).rings[0]!;

    const start = at(0);
    const middle = at(PERIOD_MS * 0.4);
    const end = at(PERIOD_MS * 0.9);

    expect(start.radiusFactor).toBeLessThan(middle.radiusFactor);
    expect(middle.radiusFactor).toBeLessThan(end.radiusFactor);
    expect(end.alpha).toBeLessThan(middle.alpha);
    expect(middle.alpha).toBeLessThan(start.alpha);
    // 扩到 2 倍（超出牌面一圈，像声波送出去），淡到几乎看不见
    expect(end.radiusFactor).toBeCloseTo(1.05 + 0.95 * 0.9, 5);
    expect(end.alpha).toBeLessThan(0.1);
  });

  it("周期性重复：隔一个周期回到同一帧（动画不跳），时刻为负也算得出来", () => {
    const first = audioBadgeAnimation({ playing: true, timeMs: 137 });
    expect(audioBadgeAnimation({ playing: true, timeMs: 137 + PERIOD_MS })).toEqual(first);
    expect(audioBadgeAnimation({ playing: true, timeMs: 137 - PERIOD_MS })).toEqual(first);
    expect(audioBadgeAnimation({ playing: true, timeMs: -50 }).rings).toHaveLength(2);
  });

  it("喇叭自己在「呼吸」：四分之一周期最胀、四分之三周期最缩", () => {
    expect(audioBadgeAnimation({ playing: true, timeMs: 0 }).waveScale).toBeCloseTo(1, 5);
    expect(audioBadgeAnimation({ playing: true, timeMs: PERIOD_MS * 0.25 }).waveScale).toBeCloseTo(
      1.18,
      5,
    );
    expect(audioBadgeAnimation({ playing: true, timeMs: PERIOD_MS * 0.75 }).waveScale).toBeCloseTo(
      0.82,
      5,
    );
  });
});

describe("对象类型色（弹框的色点与内置徽标共用）", () => {
  it("动作对象都有自己的颜色，两个传送阵 / 声音彼此分得开", () => {
    // 徽标牌面用的就是这两色：撞色会让「这是什么」变得不好认
    expect(kindMarkerColor("PlaySound")).not.toBe(kindMarkerColor("Teleport"));
    expect(kindMarkerColor("Teleport")).toMatch(/^#[0-9a-f]{6}$/);
    // 未知类型仍然退回默认灰（不抛、也不编一个新颜色出来）
    expect(kindMarkerColor("Portal")).toBe(kindMarkerColor("NotAKind"));
  });
});
