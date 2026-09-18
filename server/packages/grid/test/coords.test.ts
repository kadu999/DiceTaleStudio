import { describe, expect, it } from "vitest";
import { cellPixelSize, gridSizeFromImage, isInsideGrid, type GridSize } from "../src/coords";
import { gridToWorld, worldRectOf, worldToGrid } from "../src/world";

// DiceTale 现有地图的实测尺寸：Map001.png 为 1920x1080，网格 64x36。
const GRID: GridSize = { width: 64, height: 36 };
const IMAGE = { width: 1920, height: 1080 };
const RECT = worldRectOf({ x: 0, y: 0 }, IMAGE);

describe("坐标契约：只有世界坐标一套（y 向上）", () => {
  it("网格左下角（grid 0,0）在地图矩形左下角（x、y 都是负的）", () => {
    const world = gridToWorld({ x: 0, y: 0 }, GRID, RECT);
    expect(world.x).toBeLessThan(0);
    expect(world.y).toBeLessThan(0);
    // 第一格中心：-960 + 15 = -945；-540 + 15 = -525
    expect(world).toEqual({ x: -945, y: -525 });
  });

  it("网格左上角（grid y = height-1）在世界坐标里是左上（y 为正）", () => {
    const world = gridToWorld({ x: 0, y: GRID.height - 1 }, GRID, RECT);
    expect(world.x).toBeLessThan(0);
    expect(world.y).toBeGreaterThan(0);
  });

  it("gridToWorld / worldToGrid 在整张地图上往返一致", () => {
    for (let y = 0; y < GRID.height; y += 1) {
      for (let x = 0; x < GRID.width; x += 1) {
        expect(worldToGrid(gridToWorld({ x, y }, GRID, RECT), GRID, RECT)).toEqual({ x, y });
      }
    }
  });
});

describe("网格范围判定", () => {
  it("isInsideGrid 边界判定", () => {
    expect(isInsideGrid({ x: 0, y: 0 }, GRID)).toBe(true);
    expect(isInsideGrid({ x: 63, y: 35 }, GRID)).toBe(true);
    expect(isInsideGrid({ x: 64, y: 0 }, GRID)).toBe(false);
    expect(isInsideGrid({ x: 0, y: -1 }, GRID)).toBe(false);
  });
});

describe("图片与网格的比例", () => {
  it("1920x1080 对应 64x36 时每格 30x30", () => {
    expect(cellPixelSize(GRID, IMAGE)).toEqual({ x: 30, y: 30 });
  });

  it("由图片尺寸推导网格尺寸得到 64x36", () => {
    expect(gridSizeFromImage(IMAGE)).toEqual({ width: 64, height: 36 });
  });
});
