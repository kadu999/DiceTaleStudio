import { describe, expect, it } from "vitest";
import { CellMask } from "@dts/grid";
import {
  MASK_BRUSH_RADIUS,
  MASK_BRUSH_RATIO,
  MASK_BRUSH_SOFTNESS,
  MASK_PREVIEW_WIDTH,
  VIDEO_BLEND_MASK_SOFTNESS,
  applyEraseToPixels,
  brushRadiusFor,
  fillFogMaskPixels,
  paintRegionPixels,
  previewMaskSizeFor,
  strokeStampCenters,
  type MaskColorOf,
  type MaskPixelColor,
} from "../src/services/mask-math";

/**
 * 遮罩擦除的像素运算（**按前端 Unity 实际执行的那套**逐字实现）。
 *
 * 这几条公式必须钉死：编辑器里擦出来的纹素范围与前端（`MaskImage.ApplyEraseStroke` +
 * `MaskEraseStamp.shader`）擦出来的要**完全一致**——否则 GM 在后台看到的和玩家看到的就是两回事。
 * 每一条的出处与算式都写在 `mask-math.ts` 的文件头。
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

describe("strokeStampCenters", () => {
  it("与前端同式：step = max(1, 半径 / 2)，两端各打一个圆", () => {
    // 半径 8 → step 4；距离 16 → samples = 4 → 5 个落点（0,4,8,12,16）
    const centers = strokeStampCenters({ x: 0, y: 0 }, { x: 16, y: 0 }, 8);
    expect(centers.map((point) => point.x)).toEqual([0, 4, 8, 12, 16]);
    expect(centers.every((point) => point.y === 0)).toBe(true);
  });

  it("半径很小时步长兜到 1（前端的 max(1, …)）", () => {
    // 半径 1 → radius * 0.5 = 0.5 → step 兜到 1 → 距离 3 打 4 个点
    expect(strokeStampCenters({ x: 0, y: 0 }, { x: 3, y: 0 }, 1)).toHaveLength(4);
  });

  it("两点重合时给出同一个点两次（前端的段循环就是 samples = 1；min 幂等所以等价）", () => {
    // 前端单点笔画走的是另一支（只打一个圆），窗口里按下也是直接打一个圆；
    // 这里保持与它的「段循环」逐字一致，重复的那一下被 min 吃掉，不影响结果
    expect(strokeStampCenters({ x: 5, y: 7 }, { x: 5, y: 7 }, 48)).toEqual([
      { x: 5, y: 7 },
      { x: 5, y: 7 },
    ]);
  });

  it("斜线也照距离补点（不是按轴）", () => {
    const centers = strokeStampCenters({ x: 0, y: 0 }, { x: 3, y: 4 }, 10);
    expect(centers).toHaveLength(2); // 距离 5 < step 5 → samples = 1
    expect(centers[1]).toEqual({ x: 3, y: 4 });
  });
});

describe("applyEraseToPixels（与 MaskEraseStamp.shader 同式）", () => {
  /** 把圆心放在纹素中心上，好算：纹素 (8,8) 的中心是 (8.5, 8.5)。 */
  const CENTER = { x: 8.5, y: 8.5 };

  it("距离从**纹素中心**算起（i.uv × _MaskSize = i + 0.5）", () => {
    const pixels = opaquePixels(16, 16);
    applyEraseToPixels(pixels, 16, 16, CENTER, 4, 1);

    // 圆心那一纹素：d = 0 → 全擦
    expect(alphaAt(pixels, 16, 8, 8)).toBe(0);
    // (11,8) 的纹素中心 (11.5,8.5)：d = 3 → 3/4 → alpha 191
    expect(alphaAt(pixels, 16, 11, 8)).toBe(Math.round((3 / 4) * 255));
    // (12,8)：d = 4（正好在半径上）→ 不动
    expect(alphaAt(pixels, 16, 12, 8)).toBe(255);
    // 再远一点更是不动
    expect(alphaAt(pixels, 16, 13, 8)).toBe(255);
  });

  it("只改 alpha：RGB 一点不动", () => {
    const pixels = opaquePixels(16, 16);
    applyEraseToPixels(pixels, 16, 16, CENTER, 4, 1);

    for (let index = 0; index < pixels.length; index += 4) {
      expect(pixels[index]).toBe(0);
      expect(pixels[index + 1]).toBe(0);
      expect(pixels[index + 2]).toBe(0);
    }
  });

  it("幂等：同一处擦 N 次 = 擦 1 次（渐变带不被叠加抹平）", () => {
    const once = opaquePixels(16, 16);
    applyEraseToPixels(once, 16, 16, CENTER, 4, 1);

    const thrice = opaquePixels(16, 16);
    for (let index = 0; index < 3; index += 1) {
      applyEraseToPixels(thrice, 16, 16, CENTER, 4, 1);
    }

    expect([...thrice]).toEqual([...once]);
  });

  it("软边曲线：softness=0 硬边（核 = 半径，核内全擦）、softness=1 全程线性", () => {
    const hard = opaquePixels(16, 16);
    applyEraseToPixels(hard, 16, 16, CENTER, 4, 0);
    // core = 4、软边带被 max(…, 1e-5) 兜到几乎为 0 → d ≤ 半径全擦、之外不动（硬边）
    expect(alphaAt(hard, 16, 8, 8)).toBe(0);
    expect(alphaAt(hard, 16, 11, 8)).toBe(0);
    expect(alphaAt(hard, 16, 12, 8)).toBe(0); // d = 4 正好在半径上：硬边把它也算在内
    expect(alphaAt(hard, 16, 13, 8)).toBe(255);

    const soft = opaquePixels(16, 16);
    applyEraseToPixels(soft, 16, 16, CENTER, 4, 1);
    // core = 0 → 全程线性：d = 1 → 64、d = 2 → 128
    expect(alphaAt(soft, 16, 9, 8)).toBe(Math.round((1 / 4) * 255));
    expect(alphaAt(soft, 16, 10, 8)).toBe(Math.round((2 / 4) * 255));
  });

  it("softness 越界（负数 / 大于 1）按 saturate 处理", () => {
    const tooBig = opaquePixels(16, 16);
    applyEraseToPixels(tooBig, 16, 16, CENTER, 4, 5);
    const exactlyOne = opaquePixels(16, 16);
    applyEraseToPixels(exactlyOne, 16, 16, CENTER, 4, 1);
    expect([...tooBig]).toEqual([...exactlyOne]);

    const negative = opaquePixels(16, 16);
    applyEraseToPixels(negative, 16, 16, CENTER, 4, -3);
    const exactlyZero = opaquePixels(16, 16);
    applyEraseToPixels(exactlyZero, 16, 16, CENTER, 4, 0);
    expect([...negative]).toEqual([...exactlyZero]);
  });

  it("视频混合的笔刷有实心核：密排落点能整片擦到 0；雾那档 1 擦不到底（这就是「擦完还混着」的原因）", () => {
    // 落点间距 = 半径的一半（`strokeStampCenters` 的 step）；擦一片区域就是这个样子
    const radius = 4;
    const sweep = (softness: number): Uint8ClampedArray => {
      const pixels = opaquePixels(32, 16);
      for (let x = 4; x <= 20; x += 2) {
        applyEraseToPixels(pixels, 32, 16, { x, y: 8 }, radius, softness);
      }

      return pixels;
    };
    const worstInside = (pixels: Uint8ClampedArray): number => {
      let max = 0;
      for (let x = 6; x <= 18; x += 1) {
        max = Math.max(max, alphaAt(pixels, 32, x, 8));
      }

      return max;
    };

    // 0.5：core = 半径的一半 = 2 > 落点之间最远的距离（~1.12）→ 整片都是 0（干净的 B）
    expect(worstInside(sweep(VIDEO_BLEND_MASK_SOFTNESS))).toBe(0);
    // 1：core = 0 → 只有落点正中心是 0，落点之间永远留一层 alpha（混合就永远糊着 A）
    expect(worstInside(sweep(MASK_BRUSH_SOFTNESS))).toBeGreaterThan(0);
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

  it("笔刷参数与前端一致：48 texel / 960 宽 / 软边 1，且半径按同一个归一化值换算", () => {
    // 前端 `MaskImage.maskWidth` 与 shader `_MaskSize` 的默认都是 960×540，
    // `useMaskEditor.ts` 的 `brushRadius` 是 48 —— 两者一起定了归一化半径 48/960 = 0.05
    expect(MASK_BRUSH_RADIUS).toBe(48);
    expect(MASK_PREVIEW_WIDTH).toBe(960);
    expect(MASK_BRUSH_SOFTNESS).toBe(1);
    // 视频混合**不是** 1：要实心核，擦到的地方才真的到 0（否则擦完还糊着一层 A）
    expect(VIDEO_BLEND_MASK_SOFTNESS).toBe(0.5);
    expect(MASK_BRUSH_RATIO).toBeCloseTo(0.05, 10);

    // 前端 `radiusTex = max(1, 归一化半径 × 遮罩宽)` 同式：遮罩宽变了，纹素半径跟着变
    expect(brushRadiusFor(960)).toBe(48);
    expect(brushRadiusFor(1920)).toBe(96);
    expect(brushRadiusFor(4)).toBe(1); // 极小遮罩兜到 1（前端的 Mathf.Max(1f, …)）
    expect(brushRadiusFor(960) / 960).toBeCloseTo(brushRadiusFor(1920) / 1920, 10);
  });
});

describe("paintRegionPixels（整区开 / 关）", () => {
  /**
   * 4×2 网格、8×4 遮罩（每格 2×2 纹素）：
   * 格 0 = 区域1 + 区域4（组合格）、格 1 = 区域4、格 2 = 区域1。
   */
  const cells = new Uint8Array([
    CellMask.Obstacle | CellMask.Fog1, CellMask.Fog1, CellMask.Obstacle, CellMask.Empty,
    CellMask.Empty, CellMask.Empty, CellMask.Empty, CellMask.Empty,
  ]);
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
  /** 格 (x, 0) 的中心纹素：8×4 遮罩、每格 2×2 → 格 x 的纹素中心是 (2x + 0.5, 3.5)。 */
  const pixelAt = (pixels: Uint8ClampedArray, cellIndex: number) => {
    const index = (3 * 8 + cellIndex * 2) * 4;
    return {
      r: pixels[index] ?? -1,
      g: pixels[index + 1] ?? -1,
      b: pixels[index + 2] ?? -1,
      a: pixels[index + 3] ?? -1,
    };
  };
  /** 铺一遍初始遮罩（两个区域都指定上）。 */
  const withMask = (): Uint8ClampedArray => {
    const pixels = new Uint8ClampedArray(8 * 4 * 4);
    fillFogMaskPixels(pixels, 8, 4, cells, GRID, CellMask.Obstacle | CellMask.Fog1, COLOR_OF);
    return pixels;
  };

  it("打开某区：含这一位的格子整块揭示，别的区照旧", () => {
    const pixels = withMask();
    // 初始：格 1 是区域4 的蓝
    expect(pixelAt(pixels, 1)).toEqual({ r: 0, g: 0, b: 255, a: 204 });

    paintRegionPixels(pixels, 8, 4, cells, GRID, CellMask.Fog1, COLOR_OF, true);

    expect(pixelAt(pixels, 1).a).toBe(0); // 区域4 的格子揭示
    expect(pixelAt(pixels, 0).a).toBe(0); // 组合格（区域1+区域4）也整块揭示
    expect(pixelAt(pixels, 2).r).toBe(255); // 只属于区域1 的格子**不动**
  });

  it("关闭某区：按区域配色整块盖回去（组合格是两层叠加）", () => {
    const pixels = withMask();
    paintRegionPixels(pixels, 8, 4, cells, GRID, CellMask.Fog1, COLOR_OF, true);
    paintRegionPixels(pixels, 8, 4, cells, GRID, CellMask.Fog1, COLOR_OF, false);

    expect(pixelAt(pixels, 1)).toEqual({ r: 0, g: 0, b: 255, a: 204 });
    // 组合格：红蓝叠加，两层都在
    const combined = pixelAt(pixels, 0);
    expect(combined.a).toBeGreaterThan(200);
    expect(combined.r).toBeGreaterThan(0);
    expect(combined.b).toBeGreaterThan(0);
  });

  it("开一个区不影响另一个区的格子（区域1 ↔ 区域4 互不干扰）", () => {
    const pixels = withMask();
    paintRegionPixels(pixels, 8, 4, cells, GRID, CellMask.Obstacle, COLOR_OF, true);

    expect(pixelAt(pixels, 2).a).toBe(0); // 区域1 的格子揭示
    expect(pixelAt(pixels, 1).a).toBe(204); // 只属于区域4 的格子原样
  });
});
describe("previewMaskSizeFor / brushRadiusFor", () => {
  it("宽钉在 960、高度按贴图比例推（圆刷显示不变形）", () => {
    // 16:9 的贴图 → 正好是参考实现那块默认遮罩的尺寸
    expect(previewMaskSizeFor({ width: 1920, height: 1080 })).toEqual({ width: 960, height: 540 });
    // 4:3 / 1:1 / 竖图都保住比例
    expect(previewMaskSizeFor({ width: 400, height: 300 })).toEqual({ width: 960, height: 720 });
    expect(previewMaskSizeFor({ width: 512, height: 512 })).toEqual({ width: 960, height: 960 });
    expect(previewMaskSizeFor({ width: 600, height: 1200 })).toEqual({ width: 960, height: 1920 });
  });

  it("极端长宽比等比缩到上限（不是只裁一边）", () => {
    const size = previewMaskSizeFor({ width: 100, height: 2000 }); // 1:20
    expect(Math.max(size.width, size.height)).toBe(2048);
    // 等比：宽高比仍是 1:20（±1px 取整误差）
    expect(size.width / size.height).toBeCloseTo(100 / 2000, 2);
  });

  it("尺寸坏掉（0 / 负数）时不炸：至少 1 像素、长边不超上限", () => {
    for (const broken of [
      { width: 0, height: 0 },
      { width: 0, height: 100 },
      { width: -10, height: -10 },
      { width: 100, height: 0 },
    ]) {
      const size = previewMaskSizeFor(broken);
      expect(size.width).toBeGreaterThanOrEqual(1);
      expect(size.height).toBeGreaterThanOrEqual(1);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2048);
    }
  });

  it("半径：960 宽时就是参考实现的 48；遮罩宽度变了按同一比例缩", () => {
    expect(brushRadiusFor(960)).toBe(48);
    // 缩过的遮罩（极端长宽比）也保持「宽度的 5%」这个归一化半径
    expect(brushRadiusFor(480)).toBe(24);
    expect(brushRadiusFor(960) / 960).toBeCloseTo(brushRadiusFor(480) / 480, 10);
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

    // 圆心落在纹素中心上 → 那一纹素全擦
    applyEraseToPixels(pixels, 8, 4, { x: 4.5, y: 2.5 }, 3, 1);
    expect(alphaAt(pixels, 8, 4, 2)).toBe(0);

    // 「关掉再打开」就是这个动作：按文档重新画一遍
    fillFogMaskPixels(pixels, 8, 4, cells, GRID, CellMask.Fog1, COLOR_OF);
    expect(alphaAt(pixels, 8, 4, 2)).toBe(204);
  });
});
