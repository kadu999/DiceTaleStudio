import { describe, expect, it } from "vitest";
import {
  ALL_MASK,
  CellMask,
  PAINTABLE_MASKS,
  addMask,
  hasMask,
  isBlocked,
  isEmptyMask,
  isFogMask,
  isValidMask,
  maskToLabel,
  removeMask,
} from "../src/mask";
import { decodeRle, encodeRle } from "../src/rle";

describe("掩码位运算", () => {
  it("数值与 Unity GridCellType 严格一致", () => {
    expect(CellMask.Empty).toBe(0);
    expect(CellMask.Obstacle).toBe(1);
    expect(CellMask.Difficult).toBe(2);
    expect(CellMask.Water).toBe(4);
    expect(CellMask.Fog1).toBe(8);
    expect(CellMask.Fog2).toBe(16);
    expect(CellMask.Fog3).toBe(32);
    expect(CellMask.Fog4).toBe(64);
    expect(CellMask.Fog5).toBe(128);
    expect(ALL_MASK).toBe(255);
  });

  it("可绘制类型与 Unity PaintableTypes 顺序一致（8 类）", () => {
    expect(PAINTABLE_MASKS).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);
  });

  it("addMask 叠加且不越界", () => {
    expect(addMask(0, CellMask.Obstacle)).toBe(1);
    expect(addMask(CellMask.Obstacle, CellMask.Fog3)).toBe(33);
    expect(addMask(255, 255)).toBe(255);
  });

  it("removeMask 只清指定位", () => {
    expect(removeMask(CellMask.Obstacle | CellMask.Fog1, CellMask.Obstacle)).toBe(CellMask.Fog1);
    expect(removeMask(CellMask.Empty, CellMask.Obstacle)).toBe(0);
  });

  it("hasMask / isEmptyMask / isBlocked / isFogMask", () => {
    expect(hasMask(CellMask.Obstacle | CellMask.Fog1, CellMask.Fog1)).toBe(true);
    expect(hasMask(CellMask.Water, CellMask.Obstacle)).toBe(false);
    expect(isEmptyMask(0)).toBe(true);
    expect(isEmptyMask(CellMask.Water)).toBe(false);
    expect(isBlocked(CellMask.Obstacle | CellMask.Fog1)).toBe(true);
    expect(isBlocked(CellMask.Difficult)).toBe(false);
    expect(isFogMask(CellMask.Fog5)).toBe(true);
    expect(isFogMask(CellMask.Obstacle)).toBe(false);
  });

  it("isValidMask 拒绝越界与非整数", () => {
    expect(isValidMask(0)).toBe(true);
    expect(isValidMask(255)).toBe(true);
    expect(isValidMask(256)).toBe(false);
    expect(isValidMask(-1)).toBe(false);
    expect(isValidMask(1.5)).toBe(false);
  });

  it("maskToLabel 可读化", () => {
    expect(maskToLabel(0)).toBe("空");
    expect(maskToLabel(CellMask.Obstacle)).toBe("障碍");
    expect(maskToLabel(CellMask.Obstacle | CellMask.Fog1)).toBe("障碍+雾1");
  });
});

describe("RLE 游程编码", () => {
  it("往返一致（含跨行连续相同掩码合并）", () => {
    const cells = new Uint8Array([
      1, 1, 1, 1,
      2, 2, 2, 2,
    ]);
    const runs = encodeRle(cells);
    expect(runs).toEqual([
      [1, 4],
      [2, 4],
    ]);
    expect([...decodeRle(runs, cells.length)]).toEqual([...cells]);
  });

  it("全空数据编码为单个游程", () => {
    expect(encodeRle(new Uint8Array(6))).toEqual([[0, 6]]);
  });

  it("空输入编码为空数组，解码也为空", () => {
    expect(encodeRle(new Uint8Array(0))).toEqual([]);
    expect(decodeRle([], 0).length).toBe(0);
  });

  it("展开格数与期望不符时抛错", () => {
    expect(() => decodeRle([[1, 3]], 5)).toThrow(/不匹配/);
  });

  it("游程长度为负数或非整数时抛错", () => {
    expect(() => decodeRle([[1, -1]])).toThrow(/非法/);
    expect(() => decodeRle([[1, 1.5]])).toThrow(/非法/);
  });

  it("真实尺寸数据往返一致（64x36 全障碍）", () => {
    const cells = new Uint8Array(64 * 36).fill(CellMask.Obstacle);
    const runs = encodeRle(cells);
    expect(runs).toEqual([[CellMask.Obstacle, 64 * 36]]);
    expect([...decodeRle(runs, 64 * 36)]).toEqual([...cells]);
  });
});
