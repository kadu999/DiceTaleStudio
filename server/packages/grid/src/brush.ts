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
 * 应用一笔到副本并返回新数组（不修改入参，便于 immer 之外的纯函数复用）。
 */
export function applyBrush(
  cells: Uint8Array,
  size: GridSize,
  center: GridPoint,
  options: BrushOptions,
): Uint8Array {
  const next = cells.slice();
  const erase = options.erase === true;

  for (const point of brushCells(center, size, options.brushSize)) {
    const index = point.y * size.width + point.x;
    const existing = next[index] ?? 0;
    if (erase) {
      next[index] = options.eraseMask === undefined ? 0 : removeMask(existing, options.eraseMask);
    } else {
      next[index] = addMask(existing, options.mask);
    }
  }

  return next;
}
