import { describe, expect, it } from "vitest";
import {
  cellPixelSize,
  cellsAreSquare,
  gridIndex,
  gridRowToImageRow,
  gridSizeFromImage,
  imageRowToGridRow,
  indexToGrid,
  isInsideGrid,
} from "../src/coords";
import { gridToWorld, worldToGrid } from "../src/world";
import type { GridSize } from "../src/coords";

// DiceTale 现有地图的实测尺寸：Map001.png 为 1920x1080，网格 64x36。
const GRID: GridSize = { width: 64, height: 36 };
const IMAGE = { width: 1920, height: 1080 };

describe("坐标契约：只有世界坐标一套（y 向上）", () => {
  it("grid.y = 0 对应图片最下面一行（唯一的行序翻转）", () => {
    expect(gridRowToImageRow(0, 36)).toBe(35);
    expect(gridRowToImageRow(35, 36)).toBe(0);
    expect(imageRowToGridRow(0, 36)).toBe(35);
    expect(imageRowToGridRow(35, 36)).toBe(0);
  });

  it("行号换算可逆", () => {
    for (let y = 0; y < GRID.height; y += 1) {
      expect(imageRowToGridRow(gridRowToImageRow(y, GRID.height), GRID.height)).toBe(y);
    }
  });

  it("网格左下角（grid 0,0）在世界坐标里是左下角（x、y 都是负的）", () => {
    const world = gridToWorld({ x: 0, y: 0 }, GRID, IMAGE);
    expect(world.x).toBeLessThan(0);
    expect(world.y).toBeLessThan(0);
    // 第一格中心：-960 + 15 = -945；-540 + 15 = -525
    expect(world).toEqual({ x: -945, y: -525 });
  });

  it("网格左上角（grid y = height-1）在世界坐标里是左上（y 为正）", () => {
    const world = gridToWorld({ x: 0, y: GRID.height - 1 }, GRID, IMAGE);
    expect(world.x).toBeLessThan(0);
    expect(world.y).toBeGreaterThan(0);
  });

  it("gridToWorld / worldToGrid 在整张地图上往返一致", () => {
    for (let y = 0; y < GRID.height; y += 1) {
      for (let x = 0; x < GRID.width; x += 1) {
        expect(worldToGrid(gridToWorld({ x, y }, GRID, IMAGE), GRID, IMAGE)).toEqual({ x, y });
      }
    }
  });

  it("worldToGrid 越界输入被钳制到边界格", () => {
    // 远在左上角之外 → 最后一列 / 最后一行；远在右下角之外 → 第一列 / 第一行
    expect(worldToGrid({ x: -99999, y: 99999 }, GRID, IMAGE)).toEqual({
      x: 0,
      y: GRID.height - 1,
    });
    expect(worldToGrid({ x: 99999, y: -99999 }, GRID, IMAGE)).toEqual({
      x: GRID.width - 1,
      y: 0,
    });
  });
});

describe("网格下标（行主序 y*width+x）", () => {
  it("gridIndex 与 indexToGrid 可逆", () => {
    for (let y = 0; y < GRID.height; y += 1) {
      for (let x = 0; x < GRID.width; x += 1) {
        expect(indexToGrid(gridIndex(x, y, GRID.width), GRID.width)).toEqual({ x, y });
      }
    }
  });

  it("第一行的起点是 0，第二行起点是 width", () => {
    expect(gridIndex(0, 0, GRID.width)).toBe(0);
    expect(gridIndex(0, 1, GRID.width)).toBe(GRID.width);
  });

  it("isInsideGrid 边界判定", () => {
    expect(isInsideGrid({ x: 0, y: 0 }, GRID)).toBe(true);
    expect(isInsideGrid({ x: 63, y: 35 }, GRID)).toBe(true);
    expect(isInsideGrid({ x: 64, y: 0 }, GRID)).toBe(false);
    expect(isInsideGrid({ x: 0, y: -1 }, GRID)).toBe(false);
  });
});

describe("图片与网格的比例不变式（对齐校验）", () => {
  it("1920x1080 对应 64x36 时每格 30x30 正方形", () => {
    expect(cellsAreSquare(GRID, IMAGE)).toBe(true);
    expect(cellPixelSize(GRID, IMAGE)).toEqual({ x: 30, y: 30 });
  });

  it("由图片尺寸推导网格尺寸得到 64x36", () => {
    expect(gridSizeFromImage(IMAGE)).toEqual({ width: 64, height: 36 });
  });

  it("非等比时不认为对齐", () => {
    expect(cellsAreSquare({ width: 64, height: 37 }, IMAGE)).toBe(false);
  });

  it("尺寸为 0 时视为不对齐（不抛错）", () => {
    expect(cellsAreSquare({ width: 0, height: 0 }, IMAGE)).toBe(false);
    expect(cellsAreSquare(GRID, { width: 0, height: 0 })).toBe(false);
  });
});
