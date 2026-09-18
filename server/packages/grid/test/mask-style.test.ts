import { describe, expect, it } from "vitest";
import {
  CellMask,
  PAINTABLE_MASKS,
  cellMaskCss,
  defaultCellMaskColors,
  defaultCellMaskStyle,
  isHexColor,
  visibleMaskBits,
} from "../src/mask";

/**
 * 格子类型的**外观**（默认颜色 / 透明度）与**绘制顺序**。
 *
 * 这两件事决定了「标注画上去长什么样」，所以与 Unity 的数值逐一对齐：
 * - 颜色来自 `GridMapEditorState.GetDefaultColor`；
 * - 顺序来自 `GridMapEditorRenderer.DrawCells`（高位先画、低位在上）。
 */

describe("默认颜色：与 Unity GetDefaultColor 严格一致", () => {
  it("每种可绘制类型都有 `#rrggbb` + 固定透明度", () => {
    const expected: ReadonlyArray<readonly [number, string, number]> = [
      [CellMask.Obstacle, "#ff0000", 0.6],
      [CellMask.Difficult, "#ff8000", 0.6],
      [CellMask.Water, "#0080ff", 0.6],
      [CellMask.Fog1, "#d9d9d9", 0.55],
      [CellMask.Fog2, "#4dcce6", 0.6],
      [CellMask.Fog3, "#a666e6", 0.65],
      [CellMask.Fog4, "#ffa626", 0.7],
      [CellMask.Fog5, "#f24d4d", 0.75],
    ];

    for (const [bit, hex, alpha] of expected) {
      expect(defaultCellMaskStyle(bit)).toEqual({ hex, alpha });
    }
  });

  it("默认颜色表覆盖全部可绘制类型（取色器初值）", () => {
    const colors = defaultCellMaskColors();
    expect(Object.keys(colors).map(Number).sort((a, b) => a - b)).toEqual([...PAINTABLE_MASKS]);

    for (const bit of PAINTABLE_MASKS) {
      expect(colors[bit]).toBe(defaultCellMaskStyle(bit).hex);
    }
  });

  it("未知位退回不透明白色（不抛错）", () => {
    expect(defaultCellMaskStyle(1 << 10)).toEqual({ hex: "#ffffff", alpha: 1 });
  });

  it("透明度不给改：RGB 变了透明度还是类型自己的", () => {
    expect(cellMaskCss("#00ff00", defaultCellMaskStyle(CellMask.Obstacle).alpha)).toBe(
      "rgba(0,255,0,0.6)",
    );
  });
});

describe("cellMaskCss / isHexColor", () => {
  it("拼出 canvas 认的 rgba", () => {
    expect(cellMaskCss("#ff0000", 0.6)).toBe("rgba(255,0,0,0.6)");
    expect(cellMaskCss("#4dcce6", 0.6)).toBe("rgba(77,204,230,0.6)");
  });

  it("大小写不敏感，脏数据退回白色（宁可变白也不要画错色）", () => {
    expect(cellMaskCss("#ABCDEF", 1)).toBe("rgba(171,205,239,1)");
    expect(cellMaskCss("red", 0.5)).toBe("rgba(255,255,255,0.5)");
    expect(cellMaskCss("#fff", 0.5)).toBe("rgba(255,255,255,0.5)");
  });

  it("isHexColor 只认 6 位十六进制", () => {
    expect(isHexColor("#00ff00")).toBe(true);
    expect(isHexColor("#00FF00")).toBe(true);
    expect(isHexColor("#0f0")).toBe(false);
    expect(isHexColor("00ff00")).toBe(false);
    expect(isHexColor("#00ff0g")).toBe(false);
  });
});

describe("visibleMaskBits：绘制顺序与显示开关", () => {
  it("单个位就是它自己", () => {
    expect(visibleMaskBits(CellMask.Water)).toEqual([CellMask.Water]);
  });

  it("多位按高位→低位（低位后画 = 显示在最上层），与 Unity 一致", () => {
    expect(visibleMaskBits(CellMask.Obstacle | CellMask.Water | CellMask.Fog5)).toEqual([
      CellMask.Fog5,
      CellMask.Water,
      CellMask.Obstacle,
    ]);
  });

  it("顺序恒为 PaintableTypes 的倒序（不管掩码怎么组合）", () => {
    const all = PAINTABLE_MASKS.reduce((mask, bit) => mask | bit, 0);
    expect(visibleMaskBits(all)).toEqual([...PAINTABLE_MASKS].reverse());
  });

  it("隐藏的位被跳过，其余照画", () => {
    const mask = CellMask.Obstacle | CellMask.Fog2;
    expect(visibleMaskBits(mask, CellMask.Obstacle)).toEqual([CellMask.Fog2]);
    expect(visibleMaskBits(mask, CellMask.Fog2)).toEqual([CellMask.Obstacle]);
  });

  it("整格都被隐藏时返回空数组（这一格不画）", () => {
    expect(visibleMaskBits(CellMask.Obstacle | CellMask.Fog2, CellMask.Obstacle | CellMask.Fog2)).toEqual([]);
  });

  it("空格子返回空（掩码 0 没有任何位）", () => {
    expect(visibleMaskBits(CellMask.Empty)).toEqual([]);
  });
});
