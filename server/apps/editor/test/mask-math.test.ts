import { describe, expect, it } from "vitest";
import { CellMask } from "@dts/grid";
import {
  MASK_BRUSH_RADIUS,
  MASK_BRUSH_SOFTNESS,
  applyEraseToPixels,
  fillFogMaskPixels,
  interpolateStrokePoints,
  type MaskColorOf,
  type MaskPixelColor,
} from "../src/services/mask-math";

/**
 * 遮罩擦除的像素运算（移植自参考实现 `backend_diceTale` 的 `maskMath`）。
 *
 * 这几条公式必须钉死：编辑器里擦出来的样子与前端（Unity `MaskImage` 的 shader）
 * 擦出来的样子要对得上——两边一旦不一致，GM 在后台看到的和玩家看到的就是两回事。
 */

const GRID = { width: 4, height: 2 };

/** 读某个像素的 alpha。 */
function alphaAt(pixels: Uint8ClampedArray, width: number, x: number, y: number): number {
  return pixels[(y * width + x) * 4 + 3] ?? -1;
}

/** 全不透明黑的遮罩（运行时未探索的样子）。 */
function opaquePixels(width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index + 3] = 255;
  }

  return pixels;
}

describe("interpolateStrokePoints", () => {
  it("按步长补点、含两端", () => {
    const points = interpolateStrokePoints({ x: 0, y: 0 }, { x: 1, y: 0 }, 0.25);
    expect(points).toHaveLength(5);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[4]).toEqual({ x: 1, y: 0 });
    // 中间点均匀分布（快拖时靠它把两个事件点连成一条线）
    expect(points[2]?.x).toBeCloseTo(0.5, 6);
  });

  it("两点重合时只有一个点（单击照常打一个圆）", () => {
    expect(interpolateStrokePoints({ x: 0.3, y: 0.7 }, { x: 0.3, y: 0.7 }, 0.1)).toEqual([
      { x: 0.3, y: 0.7 },
    ]);
  });

  it("步长非法（0 / 负数）时退化成起点，不做除零", () => {
    expect(interpolateStrokePoints({ x: 0, y: 0 }, { x: 1, y: 1 }, 0)).toEqual([{ x: 0, y: 0 }]);
    expect(interpolateStrokePoints({ x: 0, y: 0 }, { x: 1, y: 1 }, -1)).toEqual([{ x: 0, y: 0 }]);
  });
});

describe("applyEraseToPixels", () => {
  it("圆心全擦、边缘不擦，且只改 alpha（RGB 不动）", () => {
    const pixels = opaquePixels(16, 16);
    applyEraseToPixels(pixels, 16, 16, { x: 8, y: 8 }, 4, 1);

    expect(alphaAt(pixels, 16, 8, 8)).toBe(0);
    // 半径之外原样
    expect(alphaAt(pixels, 16, 0, 0)).toBe(255);
    // 边缘（d ≈ r）几乎没擦掉
    expect(alphaAt(pixels, 16, 12, 8)).toBeGreaterThan(200);

    // RGB 一直是黑的：遮罩的「厚薄」只由 alpha 表达
    for (let index = 0; index < pixels.length; index += 4) {
      expect(pixels[index]).toBe(0);
      expect(pixels[index + 1]).toBe(0);
      expect(pixels[index + 2]).toBe(0);
    }
  });

  it("幂等：同一处擦 N 次 = 擦 1 次（渐变带不被叠加抹平）", () => {
    const once = opaquePixels(16, 16);
    applyEraseToPixels(once, 16, 16, { x: 8, y: 8 }, 4, 1);

    const thrice = opaquePixels(16, 16);
    for (let index = 0; index < 3; index += 1) {
      applyEraseToPixels(thrice, 16, 16, { x: 8, y: 8 }, 4, 1);
    }

    expect([...thrice]).toEqual([...once]);
  });

  it("软边 0 = 硬边（半径内全擦）", () => {
    const pixels = opaquePixels(16, 16);
    applyEraseToPixels(pixels, 16, 16, { x: 8, y: 8 }, 4, 0);

    expect(alphaAt(pixels, 16, 8, 8)).toBe(0);
    expect(alphaAt(pixels, 16, 11, 8)).toBe(0);
    expect(alphaAt(pixels, 16, 13, 8)).toBe(255);
  });

  it("越界的圆不会写坏数组（边缘落笔不崩）", () => {
    const pixels = opaquePixels(8, 8);
    applyEraseToPixels(pixels, 8, 8, { x: -4, y: 4 }, 3, 1);
    applyEraseToPixels(pixels, 8, 8, { x: 12, y: 12 }, 5, 1);

    // 右上角离两个圆都远，仍是不透明的
    expect(alphaAt(pixels, 8, 7, 0)).toBe(255);
    expect(pixels).toHaveLength(8 * 8 * 4);
  });

  it("半径非正时什么都不做（不除零）", () => {
    const pixels = opaquePixels(4, 4);
    applyEraseToPixels(pixels, 4, 4, { x: 2, y: 2 }, 0, 1);
    expect(alphaAt(pixels, 4, 2, 2)).toBe(255);
  });

  it("笔刷参数与参考实现一致：半径固定 48 纹理像素、软边 1", () => {
    // 参考实现 `useMaskEditor.ts` 的 `const brushRadius = 48`（与遮罩尺寸无关，不是比例）
    expect(MASK_BRUSH_RADIUS).toBe(48);
    expect(MASK_BRUSH_SOFTNESS).toBe(1);
  });
});

describe("fillFogMaskPixels", () => {
  /** 测试用的配色：区域1 = 红（alpha 153）、区域4 = 蓝（alpha 204）。 */
  const COLOR_OF: MaskColorOf = (mask) => {
    const layers: MaskPixelColor[] = [];
    if ((mask & CellMask.Obstacle) !== 0) {
      layers.push({ r: 255, g: 0, b: 0, a: 153 });
    }
    if ((mask & CellMask.Fog1) !== 0) {
      layers.push({ r: 0, g: 0, b: 255, a: 204 });
    }
    return layers;
  };

  /** 读一个像素的 RGBA。 */
  const pixelAt = (pixels: Uint8ClampedArray, width: number, x: number, y: number) => {
    const index = (y * width + x) * 4;
    return {
      r: pixels[index] ?? -1,
      g: pixels[index + 1] ?? -1,
      b: pixels[index + 2] ?? -1,
      a: pixels[index + 3] ?? -1,
    };
  };

  it("只有含已指定雾区位的格子着色（按区域颜色），其余全透明", () => {
    // 4×2 网格：格子 (0,0) 与 (3,1) 带雾位（区域4），另一个格子带**别的**区域位
    const cells = new Uint8Array([
      CellMask.Fog1, CellMask.Empty, CellMask.Obstacle, CellMask.Empty,
      CellMask.Empty, CellMask.Empty, CellMask.Empty, CellMask.Fog1,
    ]);

    const pixels = new Uint8ClampedArray(8 * 4 * 4);
    fillFogMaskPixels(pixels, 8, 4, cells, GRID, CellMask.Fog1, COLOR_OF);

    // 每个格子 2×2 像素：格子 (0,0) 在**左下角**（y=0 是图片最下面一行）
    expect(pixelAt(pixels, 8, 1, 3)).toEqual({ r: 0, g: 0, b: 255, a: 204 });
    expect(pixelAt(pixels, 8, 1, 2).a).toBe(204);
    // 格子 (3,1) 在右上角
    expect(pixelAt(pixels, 8, 7, 0).a).toBe(204);
    // 只有区域1（位 1）的格子不是雾：透明（哪怕它在别的窗口里是红的）
    expect(pixelAt(pixels, 8, 5, 3).a).toBe(0);
    // 空格子透明
    expect(pixelAt(pixels, 8, 5, 1).a).toBe(0);
  });

  it("一格同时属于两个雾区时逐层叠加（不是只取其中一位）", () => {
    const cells = new Uint8Array(GRID.width * GRID.height).fill(CellMask.Obstacle | CellMask.Fog1);
    const pixels = new Uint8ClampedArray(8 * 4 * 4);
    fillFogMaskPixels(
      pixels,
      8,
      4,
      cells,
      GRID,
      CellMask.Obstacle | CellMask.Fog1,
      COLOR_OF,
    );

    // source-over：红(0.6) 在下、蓝(0.8) 在上 → 蓝占大头但红透出来一点
    const pixel = pixelAt(pixels, 8, 1, 3);
    expect(pixel.a).toBe(Math.round((0.8 + 0.6 * 0.2) * 255));
    expect(pixel.b).toBeGreaterThan(pixel.r);
    expect(pixel.r).toBeGreaterThan(0);
  });

  it("没指定雾区 / 没有雾格时整张罩子全透明", () => {
    const cells = new Uint8Array(GRID.width * GRID.height).fill(CellMask.Fog1);
    const pixels = new Uint8ClampedArray(8 * 4 * 4).fill(255);

    fillFogMaskPixels(pixels, 8, 4, cells, GRID, 0, COLOR_OF);
    expect([...pixels].every((value) => value === 0)).toBe(true);
  });

  it("可重复调用：先擦过的罩子重画一遍就回到未探索的样子", () => {
    const cells = new Uint8Array(GRID.width * GRID.height).fill(CellMask.Fog1);
    const pixels = new Uint8ClampedArray(8 * 4 * 4);
    fillFogMaskPixels(pixels, 8, 4, cells, GRID, CellMask.Fog1, COLOR_OF);

    applyEraseToPixels(pixels, 8, 4, { x: 4, y: 2 }, 3, 1);
    expect(alphaAt(pixels, 8, 4, 2)).toBe(0);

    // 「关掉再打开」就是这个动作：按文档重新画一遍
    fillFogMaskPixels(pixels, 8, 4, cells, GRID, CellMask.Fog1, COLOR_OF);
    expect(alphaAt(pixels, 8, 4, 2)).toBe(204);
  });
});
