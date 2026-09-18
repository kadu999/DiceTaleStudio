import type { GridPoint, GridSize } from "./coords";
import { isInsideGrid } from "./coords";
import { addMask, removeMask } from "./mask";

/**
 * 画笔。
 *
 * **偶数尺寸约定**：半径取 `floor((brushSize - 1) / 2)`，与 Unity `GridMapEditorState.ApplyBrush`
 * 完全一致——因此 brushSize 1/2 都是 1x1、3/4 都是 3x3、5 是 5x5。
 * 这是刻意的保真选择：Web 编辑器与 Unity 编辑器对同一份数据必须画出一致的结果。
 * 若将来要支持真正的偶数居中画笔，必须两端同步修改（见 docs/specs）。
 */
export const MIN_BRUSH_SIZE = 1;
export const MAX_BRUSH_SIZE = 5;

/** 钳制画笔尺寸到合法范围。 */
export function clampBrushSize(brushSize: number): number {
  return Math.min(MAX_BRUSH_SIZE, Math.max(MIN_BRUSH_SIZE, Math.trunc(brushSize)));
}

/** 画笔半径（与 Unity 整除语义一致）。 */
export function brushRadius(brushSize: number): number {
  return Math.floor((clampBrushSize(brushSize) - 1) / 2);
}

/** 画笔实际覆盖的边长（1/2→1，3/4→3，5→5）。 */
export function brushEffectiveSize(brushSize: number): number {
  return brushRadius(brushSize) * 2 + 1;
}

/** 以 center 为中心、按画笔尺寸枚举覆盖的格子（越界的剔除）。 */
export function brushCells(center: GridPoint, size: GridSize, brushSize: number): GridPoint[] {
  const radius = brushRadius(brushSize);
  const cells: GridPoint[] = [];

  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const point = { x: center.x + dx, y: center.y + dy };
      if (isInsideGrid(point, size)) {
        cells.push(point);
      }
    }
  }

  return cells;
}

export interface BrushOptions {
  /** 要叠加的掩码位（绘制模式）。 */
  readonly mask: number;
  readonly brushSize: number;
  /** true = 橡皮：清除 `eraseMask` 指定的位；未指定 eraseMask 时清除整格。 */
  readonly erase?: boolean;
  /** 橡皮只清除的位；缺省表示整格清零。 */
  readonly eraseMask?: number;
}

/**
 * 一笔经过的格心：`from` 与 `to` 之间按直线取格（Bresenham 整数算法），**含两端**。
 *
 * 存在的理由只有一个：**指针事件之间会跳格**。鼠标一帧能移动几十像素，只按事件位置落笔
 * 会画成断断续续的点；把两个事件点之间的格子补齐，看到的才是「一笔」。
 * 两个端点约定都在网格内（越界的端点是调用方的事，这里照常给出直线上的格心）。
 */
export function strokeCenters(from: GridPoint, to: GridPoint): GridPoint[] {
  const points: GridPoint[] = [];
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - x);
  const dy = -Math.abs(to.y - y);
  const stepX = x < to.x ? 1 : -1;
  const stepY = y < to.y ? 1 : -1;
  let error = dx + dy;

  for (;;) {
    points.push({ x, y });
    if (x === to.x && y === to.y) {
      return points;
    }

    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x += stepX;
    }

    if (doubled <= dx) {
      error += dx;
      y += stepY;
    }
  }
}

/**
 * 应用一笔到副本并返回新数组（不修改入参，便于 immer 之外的纯函数复用）。
 */
export function applyBrush(
  cells: Uint8Array,
  size: GridSize,
  center: GridPoint,
  options: BrushOptions,
): Uint8Array {
  const next = cells.slice();
  stamp(next, size, [center], options);
  return next;
}

/**
 * 从 `from` 拖到 `to` 的一整笔：把直线经过的每个格心上的画笔覆盖合并进**一份副本**。
 *
 * 与 `applyBrush` 是同一套叠加 / 擦除语义（共用 `stamp`），区别只在**整笔只拷贝一次数组**——
 * 一笔可能有几十个格心，逐点拷贝（每个都是一整张网格）纯属浪费。
 */
export function applyBrushStroke(
  cells: Uint8Array,
  size: GridSize,
  from: GridPoint,
  to: GridPoint,
  options: BrushOptions,
): Uint8Array {
  const next = cells.slice();
  stamp(next, size, strokeCenters(from, to), options);
  return next;
}

/** 把若干格心的画笔覆盖就地写进 `target`（唯一的叠加 / 擦除实现，两个入口共用）。 */
function stamp(
  target: Uint8Array,
  size: GridSize,
  centers: readonly GridPoint[],
  options: BrushOptions,
): void {
  const erase = options.erase === true;

  for (const center of centers) {
    for (const point of brushCells(center, size, options.brushSize)) {
      const index = point.y * size.width + point.x;
      const existing = target[index] ?? 0;
      if (erase) {
        target[index] = options.eraseMask === undefined ? 0 : removeMask(existing, options.eraseMask);
      } else {
        target[index] = addMask(existing, options.mask);
      }
    }
  }
}
