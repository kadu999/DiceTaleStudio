import { cellPixelSize, type GridPoint, type GridSize, type ImageSize, type WorldPoint } from "./coords";

/**
 * 世界坐标的换算入口。
 *
 * 世界坐标是**唯一**的坐标系（x 向右、y 向上，单位像素），而且**世界是无限大的**：
 * 没有「场景范围」，也没有边界要夹。地图只是摆在世界里的对象——一块贴图
 * （`WorldRect` = 中心位置 + 贴图尺寸），格子坐标锚在**它自己那块矩形**上，
 * 所以一张场景里有多少张地图都互不干扰。
 *
 * 换算只有两件事，都不产生「第三套坐标系」：
 * 1. **世界 ↔ 网格**：按格子量化，y 同向，不翻转；
 * 2. **世界 ↔ 贴图像素**：图片的 y 天生向下，所以绘制贴图的那一步要翻一次——
 *    这件事由 `worldRectTopLeft()` 给出左上角，绘制端自己翻（只有这一个用户）。
 *
 * 屏幕坐标的换算在 `@dts/renderer` 的 `viewport.ts`（那是相机，不是坐标系）。
 */

/** 世界里的一个矩形：地图贴图占据的那块地方（`center` 是矩形中心的世界坐标）。 */
export interface WorldRect {
  readonly center: WorldPoint;
  readonly size: ImageSize;
}

export function worldRectOf(center: WorldPoint, size: ImageSize): WorldRect {
  return { center, size };
}

/** 矩形左边（世界 x 最小处）；网格 `(0, 0)` 就在左下角。 */
export function worldRectLeft(rect: WorldRect): number {
  return rect.center.x - rect.size.width / 2;
}

/** 矩形下边（世界 y 最小处）。 */
export function worldRectBottom(rect: WorldRect): number {
  return rect.center.y - rect.size.height / 2;
}

/** 矩形左上角的世界坐标：贴图绘制的锚点（canvas 的 y 向下，所以是「上」边）。 */
export function worldRectTopLeft(rect: WorldRect): WorldPoint {
  return { x: worldRectLeft(rect), y: rect.center.y + rect.size.height / 2 };
}

/**
 * 若干矩形的并集外框（「把所有地图装进视野」用）。
 *
 * 没有矩形时返回 `undefined`——**不要**编一个默认尺寸出来，那等于凭空宣布
 * 世界里有个东西。
 */
export function unionWorldRects(rects: readonly WorldRect[]): WorldRect | undefined {
  const first = rects[0];
  if (first === undefined) {
    return undefined;
  }

  let left = worldRectLeft(first);
  let right = left + first.size.width;
  let bottom = worldRectBottom(first);
  let top = bottom + first.size.height;

  for (const rect of rects.slice(1)) {
    left = Math.min(left, worldRectLeft(rect));
    right = Math.max(right, worldRectLeft(rect) + rect.size.width);
    bottom = Math.min(bottom, worldRectBottom(rect));
    top = Math.max(top, worldRectBottom(rect) + rect.size.height);
  }

  return worldRectOf(
    { x: (left + right) / 2, y: (bottom + top) / 2 },
    { width: right - left, height: top - bottom },
  );
}

/** 格子中心 → 世界坐标（x / y 都是 +0.5 格，y 不翻转）。 */
export function gridToWorld(point: GridPoint, grid: GridSize, rect: WorldRect): WorldPoint {
  const cell = cellPixelSize(grid, rect.size);
  return {
    x: worldRectLeft(rect) + (point.x + 0.5) * cell.x,
    y: worldRectBottom(rect) + (point.y + 0.5) * cell.y,
  };
}

/** 世界坐标 → 这块地图上的格子（越界时夹到网格内）。 */
export function worldToGrid(point: WorldPoint, grid: GridSize, rect: WorldRect): GridPoint {
  const cell = cellPixelSize(grid, rect.size);
  return {
    x: clampIndex(Math.floor((point.x - worldRectLeft(rect)) / cell.x), grid.width),
    y: clampIndex(Math.floor((point.y - worldRectBottom(rect)) / cell.y), grid.height),
  };
}

/** 格子左下角 → 世界坐标（画格子与网格线用）。 */
export function gridCornerToWorld(point: GridPoint, grid: GridSize, rect: WorldRect): WorldPoint {
  const cell = cellPixelSize(grid, rect.size);
  return {
    x: worldRectLeft(rect) + point.x * cell.x,
    y: worldRectBottom(rect) + point.y * cell.y,
  };
}

function clampIndex(value: number, limit: number): number {
  return Math.min(limit - 1, Math.max(0, value));
}
