import { describe, expect, it } from "vitest";
import {
  gridCornerToWorld,
  gridToWorld,
  unionWorldRects,
  worldRectOf,
  worldToGrid,
  worldToGridPoint,
} from "../src/world";
import { isInsideGrid, type GridSize } from "../src/coords";

/**
 * 世界坐标契约：**x 向右、y 向上、单位像素，世界无限大**。
 *
 * 地图是摆在世界里的一块贴图（`WorldRect` = 中心 + 尺寸），网格锚在它自己的矩形上。
 * 用例按 DiceTale 现有地图的实测尺寸：Map001.png 1920×1080、网格 64×36。
 */
const IMAGE = { width: 1920, height: 1080 };
const GRID: GridSize = { width: 64, height: 36 };
/** 摆在世界原点（最朴素的情形）：矩形中心 = (0, 0)。 */
const AT_ORIGIN = worldRectOf({ x: 0, y: 0 }, IMAGE);

describe("世界坐标 ↔ 网格（同向，不翻转）", () => {
  it("grid(0,0) 的角点在地图矩形左下角", () => {
    expect(gridCornerToWorld({ x: 0, y: 0 }, GRID, AT_ORIGIN)).toEqual({ x: -960, y: -540 });
  });

  it("grid(width, height) 的角点在地图矩形右上角", () => {
    expect(gridCornerToWorld({ x: 64, y: 36 }, GRID, AT_ORIGIN)).toEqual({ x: 960, y: 540 });
  });

  it("第一格中心离左下角半格（30px 一格）", () => {
    expect(gridToWorld({ x: 0, y: 0 }, GRID, AT_ORIGIN)).toEqual({ x: -945, y: -525 });
  });

  it("最上面一行（grid y = height-1）在世界坐标里 y 最大", () => {
    expect(gridToWorld({ x: 0, y: GRID.height - 1 }, GRID, AT_ORIGIN).y).toBeCloseTo(525, 6);
  });

  it("世界坐标落在矩形中心时是网格正中那一格", () => {
    expect(worldToGrid({ x: 0, y: 0 }, GRID, AT_ORIGIN)).toEqual({ x: 32, y: 18 });
  });

  it("worldToGrid 越界输入被钳制到边界格", () => {
    // 远在左上角之外 → 最后一列 / 最后一行；远在右下角之外 → 第一列 / 第一行
    expect(worldToGrid({ x: -99999, y: 99999 }, GRID, AT_ORIGIN)).toEqual({
      x: 0,
      y: GRID.height - 1,
    });
    expect(worldToGrid({ x: 99999, y: -99999 }, GRID, AT_ORIGIN)).toEqual({
      x: GRID.width - 1,
      y: 0,
    });
  });
});

describe("worldToGridPoint：量化的原样结果（不夹取）", () => {
  it("网格内与钳制版一致", () => {
    expect(worldToGridPoint({ x: 0, y: 0 }, GRID, AT_ORIGIN)).toEqual({ x: 32, y: 18 });
    expect(worldToGridPoint({ x: -945, y: -525 }, GRID, AT_ORIGIN)).toEqual({ x: 0, y: 0 });
    expect(worldToGridPoint({ x: 944, y: 524 }, GRID, AT_ORIGIN)).toEqual({
      x: 63,
      y: 35,
    });
  });

  it("网格外返回越界坐标，而不是边缘格", () => {
    // 地图左上角之外：列往负走、行超出 height
    const beyondLeftTop = worldToGridPoint({ x: -99999, y: 99999 }, GRID, AT_ORIGIN);
    expect(beyondLeftTop.x).toBeLessThan(0);
    expect(beyondLeftTop.y).toBeGreaterThanOrEqual(GRID.height);
    expect(isInsideGrid(beyondLeftTop, GRID)).toBe(false);

    const beyondRightBottom = worldToGridPoint({ x: 99999, y: -99999 }, GRID, AT_ORIGIN);
    expect(beyondRightBottom.x).toBeGreaterThanOrEqual(GRID.width);
    expect(beyondRightBottom.y).toBeLessThan(0);
    expect(isInsideGrid(beyondRightBottom, GRID)).toBe(false);
  });

  it("恰好落在左 / 下边界上算第 0 格，落在右 / 上边界外算越界", () => {
    // 角点是半开区间：[left, right) × [bottom, top) 属于网格
    const corner = worldRectOf({ x: 0, y: 0 }, IMAGE);
    const left = gridCornerToWorld({ x: 0, y: 0 }, GRID, corner);
    expect(worldToGridPoint(left, GRID, corner)).toEqual({ x: 0, y: 0 });

    const topRight = gridCornerToWorld({ x: GRID.width, y: GRID.height }, GRID, corner);
    expect(isInsideGrid(worldToGridPoint(topRight, GRID, corner), GRID)).toBe(false);
  });

  it("worldToGrid 就是它的夹取版", () => {
    const samples = [
      { x: -99999, y: 99999 },
      { x: 0, y: 0 },
      { x: 99999, y: -99999 },
    ];

    for (const point of samples) {
      const exact = worldToGridPoint(point, GRID, AT_ORIGIN);
      expect(worldToGrid(point, GRID, AT_ORIGIN)).toEqual({
        x: Math.min(GRID.width - 1, Math.max(0, exact.x)),
        y: Math.min(GRID.height - 1, Math.max(0, exact.y)),
      });
    }
  });
});

describe("地图摆在哪，它的网格就跟着走", () => {
  it("地图挪到 (300, -200)，格子角点整体平移同一个量", () => {
    const moved = worldRectOf({ x: 300, y: -200 }, IMAGE);

    expect(gridCornerToWorld({ x: 0, y: 0 }, GRID, moved)).toEqual({ x: -660, y: -740 });
    expect(gridCornerToWorld({ x: 64, y: 36 }, GRID, moved)).toEqual({ x: 1260, y: 340 });
  });

  it("同一世界点在不同地图上落在不同格子（网格锚在自己身上）", () => {
    const moved = worldRectOf({ x: 30, y: 0 }, IMAGE);
    // 世界原点：在居中那张图上是正中一格；图往右挪 30px（正好一格）后是 (31, 18)
    expect(worldToGrid({ x: 0, y: 0 }, GRID, AT_ORIGIN)).toEqual({ x: 32, y: 18 });
    expect(worldToGrid({ x: 0, y: 0 }, GRID, moved)).toEqual({ x: 31, y: 18 });
  });

  it("世界可以很大：坐标没有边界，也不夹取", () => {
    const far = worldRectOf({ x: 99999, y: -99999 }, IMAGE);
    expect(gridToWorld({ x: 0, y: 0 }, GRID, far)).toEqual({ x: 99054, y: -100524 });
  });
});

describe("unionWorldRects：把所有地图装进视野用的外框", () => {
  it("单张就是它自己", () => {
    expect(unionWorldRects([AT_ORIGIN])).toEqual(AT_ORIGIN);
  });

  it("两张错开的地图取并集", () => {
    const other = worldRectOf({ x: 3000, y: 0 }, { width: 1000, height: 500 });
    // 左 -960 / 右 3500 / 下 -540 / 上 540
    expect(unionWorldRects([AT_ORIGIN, other])).toEqual(
      worldRectOf({ x: 1270, y: 0 }, { width: 4460, height: 1080 }),
    );
  });

  it("没有地图时返回 undefined（不编一个默认尺寸出来）", () => {
    expect(unionWorldRects([])).toBeUndefined();
  });
});
