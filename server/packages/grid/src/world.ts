import { cellPixelSize, type GridPoint, type GridSize, type ImageSize, type WorldPoint } from "./coords";

/**
 * 世界坐标的换算入口。
 *
 * 世界坐标是**唯一**的坐标系（原点 = 场景中心，x 向右、y 向上，单位像素），
 * 这里只有两件事要做，都不产生「第三套坐标系」：
 *
 * 1. **世界 ↔ 图像像素**：图片的 y 天生向下，所以贴图绘制与鼠标命中的那一步要翻一次；
 * 2. **世界 ↔ 网格**：按格子量化，y 同向，不翻转。
 *
 * 屏幕坐标的换算在 `@dts/renderer` 的 `viewport.ts`（那是相机，不是坐标系）。
 */

/** 场景范围：世界坐标里可见区域的一半宽高（= 贴图像素尺寸的一半）。 */
export interface WorldExtent {
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/** 由贴图 / 场景尺寸得到世界范围。 */
export function worldExtentOf(size: ImageSize): WorldExtent {
  return { halfWidth: size.width / 2, halfHeight: size.height / 2 };
}

/** 世界坐标 → 图像像素坐标（原点左上，y 向下）。 */
export function worldToImagePixel(point: WorldPoint, size: ImageSize): WorldPoint {
  return { x: point.x + size.width / 2, y: size.height / 2 - point.y };
}

/** 图像像素坐标 → 世界坐标。 */
export function imagePixelToWorld(point: WorldPoint, size: ImageSize): WorldPoint {
  return { x: point.x - size.width / 2, y: size.height / 2 - point.y };
}

/** 格子中心 → 世界坐标（x / y 都是 +0.5 格，y 不翻转）。 */
export function gridToWorld(point: GridPoint, grid: GridSize, size: ImageSize): WorldPoint {
  const cell = cellPixelSize(grid, size);
  return {
    x: (point.x + 0.5) * cell.x - size.width / 2,
    y: (point.y + 0.5) * cell.y - size.height / 2,
  };
}

/** 世界坐标 → 所在格子（越界时夹到网格内）。 */
export function worldToGrid(point: WorldPoint, grid: GridSize, size: ImageSize): GridPoint {
  const cell = cellPixelSize(grid, size);
  return {
    x: clampIndex(Math.floor((point.x + size.width / 2) / cell.x), grid.width),
    y: clampIndex(Math.floor((point.y + size.height / 2) / cell.y), grid.height),
  };
}

/** 格子左下角 → 世界坐标（画格子与网格线用）。 */
export function gridCornerToWorld(point: GridPoint, grid: GridSize, size: ImageSize): WorldPoint {
  const cell = cellPixelSize(grid, size);
  return {
    x: point.x * cell.x - size.width / 2,
    y: point.y * cell.y - size.height / 2,
  };
}

/** 世界坐标是否落在场景范围内（含边界）。 */
export function isInsideWorld(point: WorldPoint, extent: WorldExtent): boolean {
  return (
    point.x >= -extent.halfWidth &&
    point.x <= extent.halfWidth &&
    point.y >= -extent.halfHeight &&
    point.y <= extent.halfHeight
  );
}

/** 世界坐标是否落在网格覆盖的范围内。 */
export function isInsideWorldGrid(point: WorldPoint, grid: GridSize, size: ImageSize): boolean {
  const cell = worldToGrid(point, grid, size);
  return cell.x >= 0 && cell.x < grid.width && cell.y >= 0 && cell.y < grid.height;
}

function clampIndex(value: number, limit: number): number {
  return Math.min(limit - 1, Math.max(0, value));
}
