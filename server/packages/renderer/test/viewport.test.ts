import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  clampViewport,
  createViewport,
  fitViewport,
  panBy,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
} from "../src/viewport";

describe("视口变换", () => {
  it("世界坐标与屏幕坐标互转可逆", () => {
    const viewport = { scale: 2.5, tx: -120, ty: 40 };
    const point = { x: 640, y: 360 };
    const screen = worldToScreen(viewport, point);
    const back = screenToWorld(viewport, screen);
    expect(back.x).toBeCloseTo(point.x, 9);
    expect(back.y).toBeCloseTo(point.y, 9);
  });

  it("默认视口为 1:1 无偏移", () => {
    expect(createViewport()).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it("panBy 只改平移", () => {
    const moved = panBy({ scale: 3, tx: 10, ty: 20 }, -5, 7);
    expect(moved).toEqual({ scale: 3, tx: 5, ty: 27 });
  });
});

describe("缩放锚定", () => {
  it("缩放后锚点下的世界坐标保持不变（滚轮锚定光标 / 捏合锚定中点）", () => {
    const viewport = { scale: 1, tx: 0, ty: 0 };
    const anchor = { x: 300, y: 200 };
    const worldBefore = screenToWorld(viewport, anchor);

    const zoomed = zoomAt(viewport, 2, anchor);
    const worldAfter = screenToWorld(zoomed, anchor);

    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 9);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 9);
    expect(zoomed.scale).toBe(2);
  });

  it("多次连续缩放仍锚定同一点", () => {
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
  it("内容被完整放入并居中（留出内边距）", () => {
    const viewport = fitViewport({ width: 1920, height: 1080 }, { width: 960, height: 540 }, 0);
    expect(viewport.scale).toBeCloseTo(0.5, 6);
    expect(viewport.tx).toBeCloseTo(0, 6);
    expect(viewport.ty).toBeCloseTo(0, 6);
  });

  it("宽高比不同时按较小比例适配（不裁切）", () => {
    const viewport = fitViewport({ width: 1000, height: 1000 }, { width: 400, height: 200 }, 0);
    expect(viewport.scale).toBeCloseTo(0.2, 6);
    // 居中：(400 - 1000*0.2) / 2 = 100
    expect(viewport.tx).toBeCloseTo(100, 6);
  });

  it("尺寸为 0 时退回默认视口（不产生 NaN）", () => {
    expect(fitViewport({ width: 0, height: 0 }, { width: 100, height: 100 })).toEqual(createViewport());
    expect(fitViewport({ width: 100, height: 100 }, { width: 0, height: 0 })).toEqual(createViewport());
  });
});

describe("平移约束", () => {
  it("内容小于视口时居中", () => {
    const clamped = clampViewport({ scale: 0.2, tx: 999, ty: -999 }, { width: 100, height: 100 }, { width: 400, height: 400 });
    expect(clamped.tx).toBeCloseTo((400 - 20) / 2, 6);
    expect(clamped.ty).toBeCloseTo((400 - 20) / 2, 6);
  });

  it("内容大于视口时不允许拖出太远（保留余量）", () => {
    const clamped = clampViewport(
      { scale: 1, tx: 100000, ty: 100000 },
      { width: 1000, height: 1000 },
      { width: 400, height: 400 },
      48,
    );
    expect(clamped.tx).toBe(48);
    expect(clamped.ty).toBe(48);

    const clampedMin = clampViewport(
      { scale: 1, tx: -100000, ty: -100000 },
      { width: 1000, height: 1000 },
      { width: 400, height: 400 },
      48,
    );
    expect(clampedMin.tx).toBe(400 - 1000 - 48);
    expect(clampedMin.ty).toBe(400 - 1000 - 48);
  });
});

describe("可见世界矩形（绘制裁剪用）", () => {
  it("按视口算出可见范围", () => {
    const rect = visibleWorldRect({ scale: 2, tx: -100, ty: -50 }, { width: 400, height: 300 });
    expect(rect.left).toBeCloseTo(50, 6);
    expect(rect.top).toBeCloseTo(25, 6);
    expect(rect.right).toBeCloseTo(250, 6);
    expect(rect.bottom).toBeCloseTo(175, 6);
  });
});
