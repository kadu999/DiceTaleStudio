import type { GridSize } from "@dts/grid";

/**
 * 遮罩擦除的**像素运算**（移植自参考实现 `backend_diceTale` 的
 * `frontend/src/services/maskMath.ts`，与 Unity `MaskImage` 的 shader 同一套公式）。
 *
 * 为什么是像素而不是格子：运行时那块遮罩是一张**纹理**（MaskImage 的 RenderTexture /
 * 战争雾的雾层），GM 在图上擦的是软边圆刷；格子掩码是**另一件事**（雾区绑定、`.bytes` 里那套），
 * 两者的编辑方式与生命周期都不一样。所以这里只做「把 alpha 擦小」。
 *
 * 两条约定与参考实现严格一致，改任何一条都会和前端画出来的结果对不上：
 * - **只改 alpha**：RGB 不动（遮罩是黑色的，alpha 才是「盖多厚」）；
 * - **幂等**：`min` 取小——同一处擦 N 次 = 擦 1 次，渐变带不会被叠加抹平。
 */

/** 擦除笔刷的半径：占遮罩宽度的比例（参考实现是 960 宽画布上的固定 48px ≈ 5%）。 */
export const MASK_BRUSH_RATIO = 48 / 960;

/** 笔刷软边比例（0 = 硬边，1 = 全程衰减）；参考实现的 GM 笔刷固定用 1。 */
export const MASK_BRUSH_SOFTNESS = 1;

export interface MaskPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * 两个点之间按 `step` 补点（含两端）。
 *
 * 指针事件之间会跳格：鼠标一帧能移动几十像素，只按事件位置打点会擦成一串断开的圆。
 * 两点重合时返回起点本身（调用方照常打一个圆）。
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
 * 把「含已指定雾区位的格子」画成一张**不透明的黑罩**：未探索 = 黑色不透明，
 * 其它地方 = 全透明（露出底图）。
 *
 * 这就是运行时的初始状态：`FogOfWar` 只给雾位格子 alpha=1，其余透明。
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

      // 格子 (x, y) 的 y=0 是**图片最下面一行**，而像素数组的第 0 行是顶上：这里翻一次
      const px0 = Math.floor(x * cellWidth);
      const px1 = Math.min(width, Math.ceil((x + 1) * cellWidth));
      const py0 = Math.floor(height - (y + 1) * cellHeight);
      const py1 = Math.min(height, Math.ceil(height - y * cellHeight));

      for (let py = Math.max(0, py0); py < py1; py += 1) {
        for (let px = Math.max(0, px0); px < px1; px += 1) {
          const index = (py * width + px) * 4;
          pixels[index] = 0;
          pixels[index + 1] = 0;
          pixels[index + 2] = 0;
          pixels[index + 3] = 255;
        }
      }
    }
  }
}
