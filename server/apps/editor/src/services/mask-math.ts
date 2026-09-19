import type { GridSize } from "@dts/grid";

/**
 * 遮罩擦除的**像素运算**——按**前端（Unity）实际执行的那套**逐字实现，前后端只要发同一个
 * 归一化半径，擦出来的纹素范围就完全一致。
 *
 * **出处（两处，逐字对齐）**：
 * - `DiceTale/Scripts/Backend/Components/MaskImage.cs` → `ApplyEraseStroke`：
 *   归一化半径 × 遮罩纹理宽 → 纹理像素半径；沿线段按 `step = max(1, radiusTex × 0.5)`
 *   补 `samples = max(1, ceil(distance / step))` 个点，逐点打一个擦除圆；
 * - `DiceTale/Resources/Shaders/MaskEraseStamp.shader` → `frag`：
 *   逐**纹素中心**算距离（`i.uv × _MaskSize` 就是 `i + 0.5`），
 *   `core = radius × (1 - softness)`，输出 `min(当前 alpha, saturate((d - core) / max(radius - core, 1e-5)))`
 *   ——核内全擦、核外到半径处线性收尾，`min` 幂等（同一处擦 N 次 = 擦 1 次）。
 *   （两个 Unity 副本里这个 shader 完全相同；`MaskImage.cs` 的差异只在参数校验与动作触发。）
 *
 * **契约（前后端对得上的三个数）**：
 * 1. **半径用归一化值**：`归一化半径 = 半径 / 遮罩宽`。参考实现是 960 宽的遮罩上取 48
 *    → `0.05`；前端收到后再乘**它自己**的遮罩宽。所以两边只要都按这个比例，擦除范围一致。
 * 2. **补点步长 = 半径的一半**（纹理像素，且不小于 1）——两边同式，快拖时打的点也一样密。
 * 3. **y 方向**：GM 画布是左上原点、y 向下；前端把它翻转成纹理的自下而上（`(1-y) × 高`）。
 *    本编辑器的遮罩行序也是 y 向下，所以翻转只发生在前端那一侧。
 *
 * 为什么是像素而不是格子：遮罩是一张**纹理**（MaskImage 的 RenderTexture / 战争雾的雾层），
 * GM 在图上擦的是软边圆刷；格子掩码是**另一件事**（雾区绑定、`.bytes` 里那套）。
 *
 * **有意与前端不同的两处**（写在这里，免得日后被当成 bug）：
 * 1. **初值**：前端那张遮罩从全黑开始；这里只把「已指定雾区的格子」按区域配色画上
 *    （见 `fillFogMaskPixels`）——编辑器要的是「雾盖在哪」而不是「盖满整张图」；
 * 2. **只做本地预览**：前端擦完由 GM 把笔画发过去（`erase_mask`）；这里还没接
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

/** 擦除笔刷半径：参考实现 `useMaskEditor.ts` 的 `brushRadius = 48`（960 宽遮罩上的纹理像素）。 */
export const MASK_BRUSH_RADIUS = 48;

/** 笔刷软边比例（0 = 硬边，1 = 全程衰减）；参考实现的 GM 笔刷固定用 1（前端 `edgeFeather` 默认也是 1）。 */
export const MASK_BRUSH_SOFTNESS = 1;

/** 下发给前端的**归一化半径**（`48 / 960`）：前端拿它乘自己的遮罩宽。 */
export const MASK_BRUSH_RATIO = MASK_BRUSH_RADIUS / MASK_PREVIEW_WIDTH;

/**
 * 一个点在**纹理像素坐标**里（左上原点、y 向下，与 GM 画布一致）。
 *
 * 与前端只差一个 y 翻转：它收到归一化点后算 `(1 - y) × 高`（纹理自下而上），这里不翻。
 */
export interface MaskPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * 预览遮罩的纹理尺寸：**960 宽**、高度按贴图比例推。
 *
 * 为什么高度跟着贴图走：遮罩要铺在贴图上显示，比例不一致的话圆刷在屏幕上会变成椭圆。
 * 宽度钉在 960 是因为**前端的遮罩默认就是这么大**——它的笔刷固定 48 纹理像素，
 * 于是归一化半径正好是 `48/960 = 0.05`（真正跨端传的那个数）。
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
 * 这张遮罩上的笔刷半径（纹理像素）：**与前端 `ApplyEraseStroke` 的 `radiusTex` 同式**——
 * 归一化半径 × 遮罩宽，且不小于 1。960 宽的遮罩上就是参考实现的 48。
 */
export function brushRadiusFor(maskWidth: number): number {
  return Math.max(1, MASK_BRUSH_RATIO * maskWidth);
}

/**
 * 擦除强度 → 这一纹素擦完后的 alpha 倍率（0 = 全擦，1 = 不动）。
 *
 * 与 shader 同式：`saturate((d - core) / max(radius - core, 1e-5))`，
 * 其中 `core = radius × (1 - saturate(softness))`。`softness = 0` 是硬边（核 = 半径），
 * `softness = 1` 无平顶核、全程线性衰减。
 */
function alphaMultiplierAt(distance: number, radius: number, softness: number): number {
  const s = Math.min(1, Math.max(0, softness));
  const core = radius * (1 - s);
  const band = Math.max(radius - core, 1e-5);
  return Math.min(1, Math.max(0, (distance - core) / band));
}

/**
 * 在 `pixels`（RGBA，行主序、y 向下）上按一个软边圆擦一次。
 *
 * 距离从**纹素中心**量起（`x + 0.5`、`y + 0.5`）——shader 里的 `i.uv × _MaskSize` 就是
 * `i + 0.5`，差这半个纹素会让边缘差一圈。只改 alpha（RGB 不动），`min` 取小（幂等）。
 *
 * `radius <= 0` 直接返回：前端那边有 `Mathf.Max(1f, …)` 兜底，这里宁可什么都不做，
 * 也不要把 `d / 0` 算成 NaN 再把一圈像素写成「看起来全擦掉」。
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

  const x0 = Math.max(0, Math.floor(center.x - radius));
  const x1 = Math.min(width - 1, Math.ceil(center.x + radius));
  const y0 = Math.max(0, Math.floor(center.y - radius));
  const y1 = Math.min(height - 1, Math.ceil(center.y + radius));

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x + 0.5 - center.x;
      const dy = y + 0.5 - center.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > radius) {
        // 半径之外 shader 也会算出「不动」，这里直接跳过（等价，快得多）
        continue;
      }

      const target = Math.round(alphaMultiplierAt(distance, radius, softness) * 255);
      const index = (y * width + x) * 4 + 3;
      // min：同一处擦多次 = 擦一次，渐变带不被叠加抹平
      pixels[index] = Math.min(pixels[index] ?? 255, target);
    }
  }
}

/**
 * 一笔的落点（**纹理像素坐标**）：与前端 `ApplyEraseStroke` 的补点循环同式——
 * `step = max(1, radius × 0.5)`、`samples = max(1, ceil(distance / step))`，
 * 从 `from` 到 `to` 连两端各打一个圆。
 *
 * 指针事件之间会跳格：鼠标一帧能移动几十像素，只按事件位置打点会擦成一串断开的圆。
 * 两点重合时只会给出起点本身（前端单点分支也是只打一个圆）。
 */
export function strokeStampCenters(
  from: MaskPoint,
  to: MaskPoint,
  radius: number,
): MaskPoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const step = Math.max(1, radius * 0.5);
  const samples = Math.max(1, Math.ceil(distance / step));

  const centers: MaskPoint[] = [];
  for (let index = 0; index <= samples; index += 1) {
    const t = index / samples;
    centers.push({ x: from.x + dx * t, y: from.y + dy * t });
  }

  return centers;
}

/**
 * 一个像素的颜色（各分量 0-255）。
 *
 * 由调用方按**区域配色**给（编辑器里雾是按区域颜色显示的：一眼看出哪块是哪区）；
 * 前端那边统一是黑色（prefab 里 `fogColor` 就是黑的），等前端重构完再对齐——
 * `mask-math` 只认颜色，不认「该是什么色」。
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
 * 一格可以同时属于多个雾区（`Fog1 | Fog2`，前端的 `FogOfWar` 也把它当一个独立分组），
 * 所以不能只取其中一位的颜色——那样画出来和实际数据对不上。
 */
function compositeOver(
  layers: readonly MaskPixelColor[],
): readonly [number, number, number, number] {
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
 * 初始状态对应前端的「未探索」：`FogOfWar` 只给雾位格子着色，其余透明。
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

      // 格子 (x, y) 的 y=0 是**图片最下面一行**，而遮罩行序是 y 向下（第 0 行在顶上）：这里翻一次
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
