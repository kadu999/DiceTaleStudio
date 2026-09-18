import { describe, expect, it } from "vitest";
import {
  gridCornerToWorld,
  gridToWorld,
  imagePixelToWorld,
  isInsideWorld,
  isInsideWorldGrid,
  worldExtentOf,
  worldToGrid,
  worldToImagePixel,
} from "../src/world";
import type { GridSize } from "../src/coords";

/**
 * 世界坐标契约：**场景中心 = (0, 0)，x 向右，y 向上，单位像素**。
 *
 * 用例都按 DiceTale 现有地图的实测尺寸：Map001.png 1920×1080、网格 64×36。
 */
const IMAGE = { width: 1920, height: 1080 };
const GRID: GridSize = { width: 64, height: 36 };
const EXTENT = worldExtentOf(IMAGE);

describe("世界范围与四角", () => {
  it("范围是贴图尺寸的一半", () => {
    expect(EXTENT).toEqual({ halfWidth: 960, halfHeight: 540 });
  });

  it("场景中心就是原点", () => {
    expect(isInsideWorld({ x: 0, y: 0 }, EXTENT)).toBe(true);
  });

  it("四角坐标分别是 ±宽/2、±高/2（y 向上）", () => {
    // 图像像素四角 → 世界坐标
    expect(imagePixelToWorld({ x: 0, y: 0 }, IMAGE)).toEqual({ x: -960, y: 540 });
    expect(imagePixelToWorld({ x: 1920, y: 0 }, IMAGE)).toEqual({ x: 960, y: 540 });
    expect(imagePixelToWorld({ x: 0, y: 1080 }, IMAGE)).toEqual({ x: -960, y: -540 });
    expect(imagePixelToWorld({ x: 1920, y: 1080 }, IMAGE)).toEqual({ x: 960, y: -540 });
  });

  it("越界判定含边界", () => {
    expect(isInsideWorld({ x: 960, y: -540 }, EXTENT)).toBe(true);
    expect(isInsideWorld({ x: 961, y: 0 }, EXTENT)).toBe(false);
    expect(isInsideWorld({ x: 0, y: 541 }, EXTENT)).toBe(false);
  });
});

describe("世界坐标 ↔ 图像像素（唯一需要翻转的一步）", () => {
  it("往返一致", () => {
    for (const point of [
      { x: 0, y: 0 },
      { x: -960, y: 540 },
      { x: 123, y: -456 },
    ]) {
      expect(imagePixelToWorld(worldToImagePixel(point, IMAGE), IMAGE)).toEqual(point);
    }
  });
});

describe("世界坐标 ↔ 网格（同向，不翻转）", () => {
  it("grid(0,0) 的角点在场景左下角", () => {
    expect(gridCornerToWorld({ x: 0, y: 0 }, GRID, IMAGE)).toEqual({ x: -960, y: -540 });
  });

  it("grid(width, height) 的角点在场景右上角", () => {
    expect(gridCornerToWorld({ x: 64, y: 36 }, GRID, IMAGE)).toEqual({ x: 960, y: 540 });
  });

  it("第一格中心离左下角半格（30px 一格）", () => {
    expect(gridToWorld({ x: 0, y: 0 }, GRID, IMAGE)).toEqual({ x: -945, y: -525 });
  });

  it("最上面一行（grid y = height-1）在世界坐标里 y 最大", () => {
    const top = gridToWorld({ x: 0, y: GRID.height - 1 }, GRID, IMAGE);
    expect(top.y).toBeCloseTo(525, 6);
  });

  it("世界坐标落在场景中心时是网格正中那一格", () => {
    expect(worldToGrid({ x: 0, y: 0 }, GRID, IMAGE)).toEqual({ x: 32, y: 18 });
  });

  it("isInsideWorldGrid 边界判定", () => {
    expect(isInsideWorldGrid({ x: 0, y: 0 }, GRID, IMAGE)).toBe(true);
    expect(isInsideWorldGrid({ x: 959, y: 539 }, GRID, IMAGE)).toBe(true);
    // 场景范围比网格覆盖范围大一点点时（非整除）才可能落在网格外
    expect(isInsideWorldGrid({ x: 0, y: 0 }, { width: 10, height: 10 }, IMAGE)).toBe(true);
  });
});
