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
  normalizeRegions,
  regionsToMask,
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
    expect(maskToLabel(CellMask.Obstacle)).toBe("区域1");
    expect(maskToLabel(CellMask.Obstacle | CellMask.Fog1)).toBe("区域1+区域4");
  });

  it("类型的显示名是按可绘制顺序编号的「区域1–8」（与位值无关）", () => {
    // 位值是 1/2/4/8/…（2 的幂），编号是 1..8 的序号——两者故意不是一回事
    expect(PAINTABLE_MASKS.map((bit) => maskToLabel(bit))).toEqual([
      "区域1",
      "区域2",
      "区域3",
      "区域4",
      "区域5",
      "区域6",
      "区域7",
      "区域8",
    ]);
    // 越界位仍然如实报出来，不假装它是某个区域
    expect(maskToLabel(256)).toBe("未知(256)");
  });

  it("normalizeRegions / regionsToMask：只留可绘制位、去重、升序", () => {
    // 0 = 橡皮擦（不是区域）、3 = 两个位的和（不是单个位）、256 = 越界，全部丢掉
    expect(normalizeRegions([16, 1, 16, 0, 3, 256])).toEqual([1, 16]);
    expect(normalizeRegions([])).toEqual([]);
    // 规范化后的顺序与位值大小一致（低位在前），于是「指定雾区」写进文件时是稳定的
    expect(normalizeRegions([CellMask.Fog5, CellMask.Obstacle, CellMask.Fog1])).toEqual([1, 8, 128]);

    expect(regionsToMask([16, 1, 16])).toBe(17);
    expect(regionsToMask([0, 3])).toBe(0);
    expect(regionsToMask([])).toBe(0);
    // 合并后的掩码要能直接拿去判「这一格算不算」——这正是它存在的理由
    expect(hasMask(CellMask.Obstacle | CellMask.Fog3, regionsToMask([8, 32]))).toBe(true);
    expect(hasMask(CellMask.Difficult, regionsToMask([8, 32]))).toBe(false);
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

  it("真实尺寸数据往返一致（64x36 全是区域1）", () => {
    const cells = new Uint8Array(64 * 36).fill(CellMask.Obstacle);
    const runs = encodeRle(cells);
    expect(runs).toEqual([[CellMask.Obstacle, 64 * 36]]);
    expect([...decodeRle(runs, 64 * 36)]).toEqual([...cells]);
  });
});
