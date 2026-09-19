import { describe, expect, it } from "vitest";
import { dialogSizeFor, fitBox } from "../src/app/dialog-size";

/**
 * 两个格子编辑窗口的尺寸算法（原来是写死的 820×560，宽屏上太小）。
 *
 * jsdom 里量不了布局，但这两条是纯算术，正好钉在单测里：比例、上下限、以及
 * 「长宽比盒子不能被挤出可视区」——挤出的话那部分既看不见也点不到（踩过一次）。
 */

describe("dialogSizeFor", () => {
  it("按窗口比例算：宽 80%、高 86%", () => {
    // 1440×900 桌面：1152 × 774（原来写死 820×560，大了不少）
    expect(dialogSizeFor({ width: 1440, height: 900 })).toEqual({ width: 1152, height: 774 });
    // 1920×1080：1536 × 929（没到 1680×1200 的上限）
    expect(dialogSizeFor({ width: 1920, height: 1080 })).toEqual({ width: 1536, height: 929 });
  });

  it("超大窗口夹在上限（别变成整屏）", () => {
    expect(dialogSizeFor({ width: 3840, height: 2160 })).toEqual({ width: 1680, height: 1200 });
  });

  it("小窗口先保底、再服从 92% 的窗口上限（不会比窗口还大）", () => {
    // 820×1180 平板竖屏：保底 720 宽，高度按比例 1015
    expect(dialogSizeFor({ width: 820, height: 1180 })).toEqual({ width: 720, height: 1015 });
    // 600×400 小窗：保底值比窗口还大 → 压回窗口的 92%
    expect(dialogSizeFor({ width: 600, height: 400 })).toEqual({ width: 552, height: 368 });
  });

  it("窗口尺寸坏掉（0）时也给出可用结果（不会算出 NaN）", () => {
    const size = dialogSizeFor({ width: 0, height: 0 });
    expect(Number.isFinite(size.width)).toBe(true);
    expect(Number.isFinite(size.height)).toBe(true);
    expect(size.width).toBeGreaterThanOrEqual(1);
    expect(size.height).toBeGreaterThanOrEqual(1);
  });
});

describe("fitBox", () => {
  it("按长宽比装进可用区域，两种情况都不溢出", () => {
    // 宽是瓶颈：800 宽正好放下 4:3
    expect(fitBox({ width: 800, height: 600 }, 4 / 3)).toEqual({ width: 800, height: 600 });
    // 高是瓶颈：400 高 → 宽收到 533
    expect(fitBox({ width: 800, height: 400 }, 4 / 3)).toEqual({ width: 533, height: 399 });
    // 16:9 的贴图放进方框
    expect(fitBox({ width: 400, height: 400 }, 16 / 9)).toEqual({ width: 400, height: 225 });
  });

  it("可用区域或比例坏掉时给 0（不渲染那块盒子，而不是画一个 NaN 尺寸）", () => {
    expect(fitBox({ width: 0, height: 600 }, 1.5)).toEqual({ width: 0, height: 0 });
    expect(fitBox({ width: 800, height: 0 }, 1.5)).toEqual({ width: 0, height: 0 });
    expect(fitBox({ width: 800, height: 600 }, 0)).toEqual({ width: 0, height: 0 });
    expect(fitBox({ width: 800, height: 600 }, Number.NaN)).toEqual({ width: 0, height: 0 });
  });
});
