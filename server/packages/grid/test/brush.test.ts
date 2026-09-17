import { describe, expect, it } from "vitest";
import { applyBrush, brushCells, brushEffectiveSize, brushRadius, clampBrushSize } from "../src/brush";
import { CellMask } from "../src/mask";
import type { GridSize } from "../src/coords";

const GRID: GridSize = { width: 8, height: 8 };

describe("画笔尺寸（与 Unity 整除语义保持一致）", () => {
  it("半径 floor((size-1)/2)：1/2→0，3/4→1，5→2", () => {
    expect([1, 2, 3, 4, 5].map(brushRadius)).toEqual([0, 0, 1, 1, 2]);
  });

  it("实际覆盖边长：1/2→1，3/4→3，5→5", () => {
    expect([1, 2, 3, 4, 5].map(brushEffectiveSize)).toEqual([1, 1, 3, 3, 5]);
  });

  it("尺寸被钳制到 [1,5]", () => {
    expect([-3, 0, 6, 99].map(clampBrushSize)).toEqual([1, 1, 5, 5]);
  });
});

describe("画笔覆盖格子", () => {
  it("居中的 1/3/5 号画笔分别覆盖 1/9/25 格", () => {
    expect(brushCells({ x: 4, y: 4 }, GRID, 1).length).toBe(1);
    expect(brushCells({ x: 4, y: 4 }, GRID, 3).length).toBe(9);
    expect(brushCells({ x: 4, y: 4 }, GRID, 5).length).toBe(25);
  });

  it("2 号与 4 号画笔分别等价于 1 号与 3 号（Unity 一致）", () => {
    expect(brushCells({ x: 4, y: 4 }, GRID, 2)).toEqual(brushCells({ x: 4, y: 4 }, GRID, 1));
    expect(brushCells({ x: 4, y: 4 }, GRID, 4)).toEqual(brushCells({ x: 4, y: 4 }, GRID, 3));
  });

  it("越界部分被剔除（角上 3 号画笔只剩 4 格）", () => {
    const cells = brushCells({ x: 0, y: 0 }, GRID, 3);
    expect(cells.length).toBe(4);
    expect(cells).toContainEqual({ x: 0, y: 0 });
    expect(cells).toContainEqual({ x: 1, y: 1 });
  });

  it("全部越界时返回空数组（不抛错）", () => {
    expect(brushCells({ x: -10, y: -10 }, GRID, 5)).toEqual([]);
  });
});

describe("画笔写入语义", () => {
  function empty(): Uint8Array {
    return new Uint8Array(GRID.width * GRID.height);
  }

  it("绘制为按位叠加：同一格重复画不同位会组合", () => {
    let cells = empty();
    cells = applyBrush(cells, GRID, { x: 2, y: 2 }, { mask: CellMask.Obstacle, brushSize: 1 });
    cells = applyBrush(cells, GRID, { x: 2, y: 2 }, { mask: CellMask.Fog1, brushSize: 1 });
    expect(cells[2 * GRID.width + 2]).toBe(CellMask.Obstacle | CellMask.Fog1);
  });

  it("橡皮默认整格清零", () => {
    let cells = empty();
    cells = applyBrush(cells, GRID, { x: 2, y: 2 }, { mask: CellMask.Obstacle | CellMask.Fog1, brushSize: 1 });
    cells = applyBrush(cells, GRID, { x: 2, y: 2 }, { mask: 0, brushSize: 1, erase: true });
    expect(cells[2 * GRID.width + 2]).toBe(0);
  });

  it("指定 eraseMask 时只清除该位，保留其他位", () => {
    let cells = empty();
    cells = applyBrush(cells, GRID, { x: 3, y: 3 }, { mask: CellMask.Obstacle | CellMask.Fog2, brushSize: 1 });
    cells = applyBrush(cells, GRID, { x: 3, y: 3 }, {
      mask: 0,
      brushSize: 1,
      erase: true,
      eraseMask: CellMask.Obstacle,
    });
    expect(cells[3 * GRID.width + 3]).toBe(CellMask.Fog2);
  });

  it("不修改入参数组（返回新数组）", () => {
    const original = empty();
    const next = applyBrush(original, GRID, { x: 1, y: 1 }, { mask: CellMask.Water, brushSize: 3 });
    expect([...original]).toEqual([...empty()]);
    expect(next).not.toBe(original);
  });

  it("越界格不会被写入", () => {
    const cells = applyBrush(empty(), GRID, { x: -5, y: -5 }, { mask: CellMask.Obstacle, brushSize: 5 });
    expect([...cells].every((mask) => mask === 0)).toBe(true);
  });
});
