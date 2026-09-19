import type { GridSize } from "@dts/grid";

/**
 * 遮罩擦除的**像素运算**。
 *
 * **出处（逐行移植）**：`backend_diceTale/frontend/src/services/maskMath.ts` 的
 * `interpolateStrokePoints` 与 `applyEraseToPixels`——连 `softness + 0.001` 这种
 * 「避开 `pow(0, 0)`」的小把戏都照搬。并与 Unity `DiceTale/Shaders/MaskEraseStamp.shader`
 * 对齐：在 **softness = 1**（参考实现唯一用到的取值，`MaskEditorDialog.vue` 里写死 1）下，
 * 着色器的 `min(1, d/r)` 与这里的 `1 - (1 - d/r)^1.001` 是同一条曲线，差 0.1% 量级。
 * ⚠️ softness 换成别的值时**两者并不等价**（着色器是「核 + 线性带」，这里是幂曲线）——
 * 哪天把 softness 做成可调，两边得一起改。
 *
 * 为什么是像素而不是格子：运行时那块遮罩是一张**纹理**（MaskImage 的 RenderTexture /
 * 战争雾的雾层），GM 在图上擦的是软边圆刷；格子掩码是**另一件事**（雾区绑定、`.bytes` 里那套），
 * 两者的编辑方式与生命周期都不一样。所以这里只做「把 alpha 擦小」。
 *
 * 两条约定与参考实现严格一致，改任何一条都会和前端画出来的结果对不上：
 * - **只改 alpha**：RGB 不动（遮罩是黑的，alpha 才是「盖多厚」）；
 * - **幂等**：`min` 取小——同一处擦 N 次 = 擦 1 次，渐变带不会被叠加抹平。
 *
 * **有意与参考实现不同的两处**（写在这里，免得日后被当成 bug）：
 * 1. **初值**：参考实现是整张全黑；这里只把「已指定雾区的格子」按区域配色画上
 *    （见 `fillFogMaskPixels`）——编辑器要的是「雾盖在哪」而不是「盖满整张图」；
 * 2. **只做本地预览**：参考实现擦完会把笔画发给前端（`erase_mask`）；这里还没接
 *    （前端 `FogOfWar` 也还没有消费方）。
 * 另外补了两处防御：`radius <= 0` 直接返回、`step <= 0` 返回起点（理由见各自函数上）。
 */

/**
 * 预览遮罩的宽度：**与参考实现的默认遮罩一致**（`MaskImage.maskWidth` 与 shader 的
 * `_MaskSize` 默认都是 960×540）。它同时决定了「48 纹理像素」占多宽——见 `brushRadiusFor`。
 */
export const MASK_PREVIEW_WIDTH = 960;

/**
 * 预览遮罩长边的上限：极端长宽比（例如 1:10）时等比缩一下，
 * 别为一张预览图吃掉几十 MB。缩放是**等比**的，所以圆刷在屏幕上不会被拉成椭圆。
 */
const MAX_PREVIEW_EDGE = 2048;

/** 擦除笔刷半径：参考实现 `useMaskEditor.ts` 的 `brushRadius = 48`（纹理像素）。 */
export const MASK_BRUSH_RADIUS = 48;

/** 笔刷软边比例（0 = 硬边，1 = 全程衰减）；参考实现的 GM 笔刷固定用 1。 */
export const MASK_BRUSH_SOFTNESS = 1;

/**
 * 预览遮罩的纹理尺寸：**960 宽**、高度按贴图比例推。
 *
 * 为什么高度跟着贴图走：遮罩要铺在贴图上显示，比例不一致的话圆刷在屏幕上会变成椭圆。
 * 宽度钉在 960 是因为**参考实现就是这么大**——它的笔刷固定 48 纹理像素，
 * 于是归一化半径（它真正下发给前端的那个数）正好是 `48/960 = 宽度 5%`。
 * 我们原来把遮罩做成贴图的像素尺寸，同样 48 texel 在小图上偏大、在 1920 宽的大图上只有 2.5%，
 * 屏幕上比参考实现小一半以上。
 */
export function previewMaskSizeFor(image: {
  readonly width: number;
  readonly height: number;
}): { width: number; height: number } {
  const aspect = image.height / Math.max(1, image.width);
  let width = MASK_PREVIEW_WIDTH;
  let height = Math.max(1, Math.round(width * aspect));

  const longest = Math.max(width, height);
  if (longest > MAX_PREVIEW_EDGE) {
    const scale = MAX_PREVIEW_EDGE / longest;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  return { width, height };
}

/**
 * 这张遮罩上的笔刷半径（纹理像素）：参考实现的 48 texel 是按 960 宽的遮罩定的，
 * 所以遮罩宽度一变就按同一比例缩——**保持的始终是「宽度的 5%」这个归一化半径**，
 * 也就是参考实现下发给前端的那个数。
 */
export function brushRadiusFor(maskWidth: number): number {
  return (MASK_BRUSH_RADIUS * maskWidth) / MASK_PREVIEW_WIDTH;
}

export interface MaskPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * 两个点之间按 `step` 补点（含两端）。
 *
 * 指针事件之间会跳格：鼠标一帧能移动几十像素，只按事件位置打点会擦成一串断开的圆。
 * 两点重合时返回起点本身（调用方照常打一个圆）。
 *
 * `step <= 0` 也返回起点：参考实现没挡这个，而 `ceil(dist / 0)` 是 `Infinity`，
 * 循环会直接卡死（`step` 由调用方按半径算，半径算错时不该把页面拖死）。
 */
export function interpolateStrokePoints(
  a: MaskPoint,
  b: MaskPoint,
  step: number,
): MaskPoint[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0 || step <= 0) {
    return [a];
  }

  const count = Math.max(1, Math.ceil(dist / step));
  const points: MaskPoint[] = [];
  for (let index = 0; index <= count; index += 1) {
    const t = index / count;
    points.push({ x: a.x + dx * t, y: a.y + dy * t });
  }

  return points;
}

/**
 * 在 `pixels`（RGBA）上按一个软边圆擦一次。
 *
 * 擦除强度：`alpha = (1 - d / radius) ^ softness`——圆心处全擦（alpha 变 0），
 * 边缘处几乎不擦；`softness = 0` 是硬边（参考实现里 `+0.001` 是为了避开 `pow(0, 0)`）。
 *
 * `radius <= 0` 直接返回：参考实现没挡这个，而 `d / 0` 会算出 `NaN`，
 * 那一圈像素的 alpha 会被写成一个「看起来全擦掉」的 0——宁可什么都不做。
 */
export function applyEraseToPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  center: MaskPoint,
  radius: number,
  softness: number,
): void {
  if (radius <= 0) {
    return;
  }

  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(center.x - radius));
  const x1 = Math.min(width - 1, Math.ceil(center.x + radius));
  const y0 = Math.max(0, Math.floor(center.y - radius));
  const y1 = Math.min(height - 1, Math.ceil(center.y + radius));

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - center.x;
      const dy = y - center.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) {
        continue;
      }

      const d = Math.sqrt(d2);
      const factor = Math.min(1, d / radius); // 0 = 圆心，1 = 边缘
      const alpha = Math.pow(1 - factor, softness + 0.001);
      const index = (y * width + x) * 4 + 3;
      // min：同一处擦多次 = 擦一次，渐变带不被叠加抹平
      pixels[index] = Math.min(pixels[index] ?? 255, Math.round((1 - alpha) * 255));
    }
  }
}

/**
 * 一个像素的颜色（各分量 0-255）。
 *
 * 由调用方按**区域配色**给（编辑器里雾是按区域颜色显示的：一眼看出哪块是哪区）；
 * 运行时那边统一是黑色，等前端重构完再说——`mask-math` 只认颜色，不认「该是什么色」。
 */
export interface MaskPixelColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** 一格要盖的颜色：按绘制顺序给（先画的在下面），空数组 = 这一格不盖。 */
export type MaskColorOf = (mask: number) => readonly MaskPixelColor[];

/**
 * 逐层 source-over 叠加（与画布上「高位先画、低位在上」同一套），返回 0-255 的分量。
 *
 * 一格可以同时属于多个雾区（`Fog1 | Fog2`，运行时的 `FogOfWar` 也把它当一个独立分组），
 * 所以不能只取其中一位的颜色——那样画出来和实际数据对不上。
 */
function compositeOver(layers: readonly MaskPixelColor[]): readonly [number, number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;

  for (const layer of layers) {
    const sourceAlpha = layer.a / 255;
    if (sourceAlpha <= 0) {
      continue;
    }

    const outAlpha = sourceAlpha + a * (1 - sourceAlpha);
    if (outAlpha <= 0) {
      continue;
    }

    r = (layer.r * sourceAlpha + r * a * (1 - sourceAlpha)) / outAlpha;
    g = (layer.g * sourceAlpha + g * a * (1 - sourceAlpha)) / outAlpha;
    b = (layer.b * sourceAlpha + b * a * (1 - sourceAlpha)) / outAlpha;
    a = outAlpha;
  }

  return [Math.round(r), Math.round(g), Math.round(b), Math.round(a * 255)];
}

/**
 * 把「含已指定雾区位的格子」按**区域颜色**画到遮罩上：不入 `colorOf` 的地方保持透明
 * （露出底图），于是擦除就是把这些颜色擦掉。
 *
 * 初始状态对应运行时的「未探索」：`FogOfWar` 只给雾位格子着色，其余透明。
 * 窗口每次打开都按当前文档重新画一遍——所以「擦了不保存、重开恢复原样」是自然结果。
 *
 * `pixels` 会被就地重写（`width × height × 4` 的 RGBA）。
 */
export function fillFogMaskPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  cells: Uint8Array,
  grid: GridSize,
  fogMask: number,
  colorOf: MaskColorOf,
): void {
  pixels.fill(0);

  const cellWidth = width / grid.width;
  const cellHeight = height / grid.height;

  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const mask = cells[y * grid.width + x] ?? 0;
      if ((mask & fogMask) === 0) {
        continue;
      }

      const layers = colorOf(mask);
      if (layers.length === 0) {
        continue;
      }

      const [r, g, b, a] = compositeOver(layers);
      if (a <= 0) {
        continue;
      }

      // 格子 (x, y) 的 y=0 是**图片最下面一行**，而像素数组的第 0 行是顶上：这里翻一次
      const px0 = Math.max(0, Math.floor(x * cellWidth));
      const px1 = Math.min(width, Math.ceil((x + 1) * cellWidth));
      const py0 = Math.max(0, Math.floor(height - (y + 1) * cellHeight));
      const py1 = Math.min(height, Math.ceil(height - y * cellHeight));

      for (let py = py0; py < py1; py += 1) {
        for (let px = px0; px < px1; px += 1) {
          const index = (py * width + px) * 4;
          pixels[index] = r;
          pixels[index + 1] = g;
          pixels[index + 2] = b;
          pixels[index + 3] = a;
        }
      }
    }
  }
}
