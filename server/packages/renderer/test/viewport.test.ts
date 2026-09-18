import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  clampViewport,
  createCenteredViewport,
  createViewport,
  fitViewport,
  panBy,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
} from "../src/viewport";

/**
 * 视口是「相机」，不是坐标系：世界坐标只有一套（中心为原点、y 向上），
 * 屏幕坐标是画布自己的像素栅格（原点左上、y 向下）。
 */
describe("视口变换", () => {
  it("默认视口把世界原点放在视口中心（1 世界像素 = 1 CSS 像素）", () => {
    expect(createViewport()).toEqual({ scale: 1, tx: 0, ty: 0 });
    expect(createCenteredViewport({ width: 800, height: 600 })).toEqual({
      scale: 1,
      tx: 400,
      ty: 300,
    });
  });

  it("世界原点映射到 (tx, ty)", () => {
    const viewport = createCenteredViewport({ width: 800, height: 600 });
    expect(worldToScreen(viewport, { x: 0, y: 0 })).toEqual({ x: 400, y: 300 });
  });

  it("y 向上：世界 y 变大，屏幕 y 变小", () => {
    const viewport = createViewport(2, 0, 0);
    expect(worldToScreen(viewport, { x: 10, y: 10 })).toEqual({ x: 20, y: -20 });
    expect(worldToScreen(viewport, { x: 10, y: -10 })).toEqual({ x: 20, y: 20 });
  });

  it("世界坐标与屏幕坐标互转可逆", () => {
    const viewport = { scale: 2.5, tx: -120, ty: 40 };
    const point = { x: 640, y: -360 };
    const screen = worldToScreen(viewport, point);
    const back = screenToWorld(viewport, screen);
    expect(back.x).toBeCloseTo(point.x, 9);
    expect(back.y).toBeCloseTo(point.y, 9);
  });

  it("panBy 只改平移", () => {
    const moved = panBy({ scale: 3, tx: 10, ty: 20 }, -5, 7);
    expect(moved).toEqual({ scale: 3, tx: 5, ty: 27 });
  });
});

describe("缩放锚定", () => {
  it("缩放后锚点下的世界坐标保持不变（滚轮锚定光标 / 捏合锚定中点）", () => {
    const viewport = createCenteredViewport({ width: 600, height: 400 });
    const anchor = { x: 300, y: 200 };
    const worldBefore = screenToWorld(viewport, anchor);

    const zoomed = zoomAt(viewport, 2, anchor);
    const worldAfter = screenToWorld(zoomed, anchor);

    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 9);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 9);
    expect(zoomed.scale).toBe(2);
  });

  it("多次连续缩放仍锚定同一点（y 翻转让符号错误无处可藏）", () => {
    let viewport = createViewport(1, 0, 0);
    const anchor = { x: 123, y: 456 };
    const worldBefore = screenToWorld(viewport, anchor);

    for (const factor of [1.2, 1.2, 0.8, 1.5, 0.5]) {
      viewport = zoomAt(viewport, factor, anchor);
    }

    const worldAfter = screenToWorld(viewport, anchor);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);
  });

  it("缩放被钳制在 [MIN_SCALE, MAX_SCALE]", () => {
    const huge = zoomAt(createViewport(1, 0, 0), 1000, { x: 0, y: 0 });
    expect(huge.scale).toBe(MAX_SCALE);

    const tiny = zoomAt(createViewport(1, 0, 0), 0.0001, { x: 0, y: 0 });
    expect(tiny.scale).toBe(MIN_SCALE);

    expect(clampScale(1e9)).toBe(MAX_SCALE);
    expect(clampScale(-5)).toBe(MIN_SCALE);
  });

  it("缩放已达到上限时返回原视口（不产生漂移）", () => {
    const viewport = createViewport(MAX_SCALE, 10, 20);
    expect(zoomAt(viewport, 2, { x: 5, y: 5 })).toBe(viewport);
  });
});

describe("适配视口", () => {
  it("场景铺满并居中：1920×1080 放进 960×540，比例 0.5、原点在正中", () => {
    const viewport = fitViewport({ width: 1920, height: 1080 }, { width: 960, height: 540 }, 0);
    expect(viewport.scale).toBeCloseTo(0.5, 6);
    expect(viewport.tx).toBeCloseTo(480, 6);
    expect(viewport.ty).toBeCloseTo(270, 6);
    // 世界原点落在视口中心
    expect(worldToScreen(viewport, { x: 0, y: 0 })).toEqual({ x: 480, y: 270 });
  });

  it("宽高比不同时按较小比例适配（不裁切）", () => {
    const viewport = fitViewport({ width: 1000, height: 1000 }, { width: 400, height: 200 }, 0);
    expect(viewport.scale).toBeCloseTo(0.2, 6);
    // 内容本来就以原点为中心，居中就是视口中心
    expect(viewport.tx).toBeCloseTo(200, 6);
    expect(viewport.ty).toBeCloseTo(100, 6);
  });

  it("尺寸为 0 时退回「原点居中」的默认视口（不产生 NaN）", () => {
    expect(fitViewport({ width: 0, height: 0 }, { width: 100, height: 100 })).toEqual({
      scale: 1,
      tx: 50,
      ty: 50,
    });
    expect(fitViewport({ width: 100, height: 100 }, { width: 0, height: 0 })).toEqual(
      createViewport(1, 0, 0),
    );
  });
});

describe("平移约束", () => {
  it("场景小于视口时居中（不允许拖走）", () => {
    const clamped = clampViewport(
      { scale: 0.2, tx: 999, ty: -999 },
      { width: 100, height: 100 },
      { width: 400, height: 400 },
    );
    expect(clamped.tx).toBeCloseTo(200, 6);
    expect(clamped.ty).toBeCloseTo(200, 6);
  });

  it("场景大于视口时不允许拖出太远（保留余量）", () => {
    const clamped = clampViewport(
      { scale: 1, tx: 100000, ty: 100000 },
      { width: 1000, height: 1000 },
      { width: 400, height: 400 },
      48,
    );
    // 场景半宽 500：tx 最大 = 500 + 48
    expect(clamped.tx).toBe(548);
    expect(clamped.ty).toBe(548);

    const clampedMin = clampViewport(
      { scale: 1, tx: -100000, ty: -100000 },
      { width: 1000, height: 1000 },
      { width: 400, height: 400 },
      48,
    );
    expect(clampedMin.tx).toBe(-148);
    expect(clampedMin.ty).toBe(-148);
  });
});

describe("可见范围（绘制裁剪用）", () => {
  it("按视口算出可见世界矩形；top 是 y 的最大值（y 向上）", () => {
    const rect = visibleWorldRect({ scale: 2, tx: 100, ty: -50 }, { width: 400, height: 300 });
    // 屏幕左上 (0,0) → 世界 x = (0-100)/2 = -50、y = (-50-0)/2 = -25
    // 屏幕右下 (400,300) → 世界 x = (400-100)/2 = 150、y = (-50-300)/2 = -175
    expect(rect.left).toBeCloseTo(-50, 6);
    expect(rect.top).toBeCloseTo(-25, 6);
    expect(rect.right).toBeCloseTo(150, 6);
    expect(rect.bottom).toBeCloseTo(-175, 6);
  });

  it("原点居中时可见范围左右对称（中心视口）", () => {
    const rect = visibleWorldRect(
      createCenteredViewport({ width: 400, height: 300 }),
      { width: 400, height: 300 },
    );
    expect(rect.left).toBeCloseTo(-200, 6);
    expect(rect.right).toBeCloseTo(200, 6);
    expect(rect.top).toBeCloseTo(150, 6);
    expect(rect.bottom).toBeCloseTo(-150, 6);
  });
});
