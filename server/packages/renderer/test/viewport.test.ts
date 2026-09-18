import { describe, expect, it } from "vitest";
import { worldRectOf } from "@dts/grid";
import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  createCenteredViewport,
  createViewport,
  fitViewport,
  panBy,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
} from "../src/viewport";

const MAP_1920 = worldRectOf({ x: 0, y: 0 }, { width: 1920, height: 1080 });

describe("世界 ↔ 屏幕", () => {
  it("世界原点落在 (tx, ty)，y 轴上下翻转", () => {
    const viewport = createViewport(2, 100, 50);
    expect(worldToScreen(viewport, { x: 0, y: 0 })).toEqual({ x: 100, y: 50 });
    expect(worldToScreen(viewport, { x: 10, y: 10 })).toEqual({ x: 120, y: 30 });
  });

  it("往返一致", () => {
    const viewport = createViewport(1.75, 33, -12);
    const point = { x: -420.5, y: 88.25 };
    expect(screenToWorld(viewport, worldToScreen(viewport, point))).toEqual(point);
  });
});

describe("平移与缩放", () => {
  it("平移只改屏幕平移量", () => {
    expect(panBy(createViewport(2, 0, 0), 10, -5)).toEqual({ scale: 2, tx: 10, ty: -5 });
  });

  it("缩放锚点下的世界坐标不动", () => {
    const viewport = createViewport(1, 100, 100);
    const anchor = { x: 130, y: 80 };
    const before = screenToWorld(viewport, anchor);
    const zoomed = zoomAt(viewport, 2, anchor);
    expect(screenToWorld(zoomed, anchor).x).toBeCloseTo(before.x, 6);
    expect(screenToWorld(zoomed, anchor).y).toBeCloseTo(before.y, 6);
  });

  it("缩放被夹在上下限内", () => {
    expect(clampScale(0.001)).toBe(MIN_SCALE);
    expect(clampScale(9999)).toBe(MAX_SCALE);
    expect(zoomAt(createViewport(MIN_SCALE, 0, 0), 0.5, { x: 0, y: 0 }).scale).toBe(MIN_SCALE);
    expect(zoomAt(createViewport(MAX_SCALE, 0, 0), 2, { x: 0, y: 0 }).scale).toBe(MAX_SCALE);
  });

  it("缩放已达到上限时返回原视口（不产生漂移）", () => {
    const viewport = createViewport(MAX_SCALE, 10, 20);
    expect(zoomAt(viewport, 2, { x: 5, y: 5 })).toBe(viewport);
  });
});

describe("适配视口：把所有地图装进视野", () => {
  it("单张居中的地图：比例 0.5、原点落在视口正中", () => {
    const viewport = fitViewport([MAP_1920], { width: 960, height: 540 }, 0);
    expect(viewport.scale).toBeCloseTo(0.5, 6);
    expect(worldToScreen(viewport, { x: 0, y: 0 })).toEqual({ x: 480, y: 270 });
  });

  it("宽高比不同时按较小比例适配（不裁切）", () => {
    const viewport = fitViewport(
      [worldRectOf({ x: 0, y: 0 }, { width: 1000, height: 1000 })],
      { width: 400, height: 200 },
      0,
    );
    expect(viewport.scale).toBeCloseTo(0.2, 6);
    expect(worldToScreen(viewport, { x: 0, y: 0 })).toEqual({ x: 200, y: 100 });
  });

  it("地图不在原点时，居中挪的是地图外框（原点因此偏出屏幕中心）", () => {
    const far = worldRectOf({ x: 1000, y: 500 }, { width: 200, height: 100 });
    const viewport = fitViewport([far], { width: 400, height: 400 }, 0);

    // 外框中心 (1000, 500) 落在视口正中
    const center = worldToScreen(viewport, { x: 1000, y: 500 });
    expect(center.x).toBeCloseTo(200, 6);
    expect(center.y).toBeCloseTo(200, 6);
  });

  it("多张地图按并集外框装进去", () => {
    const viewport = fitViewport(
      [MAP_1920, worldRectOf({ x: 3000, y: 0 }, { width: 1000, height: 500 })],
      { width: 4460, height: 1080 },
      0,
    );
    expect(viewport.scale).toBeCloseTo(1, 6);
    expect(worldToScreen(viewport, { x: 1270, y: 0 }).x).toBeCloseTo(2230, 6);
  });

  it("一张地图都没有时退回「世界原点居中」（不凭空造尺寸）", () => {
    expect(fitViewport([], { width: 100, height: 80 })).toEqual(createCenteredViewport({ width: 100, height: 80 }));
  });

  it("视口尺寸为 0 时也不产生 NaN", () => {
    expect(fitViewport([MAP_1920], { width: 0, height: 0 })).toEqual(createViewport(1, 0, 0));
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
