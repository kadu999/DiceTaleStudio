/**
 * 坐标契约：**全项目只有一套坐标系——世界坐标**。
 *
 * ```
 * 世界坐标 world：原点 = 场景中心 (0, 0)，x 向右，y 向上，单位像素
 *   左上 (-w/2, +h/2)   右上 (+w/2, +h/2)
 *   左下 (-w/2, -h/2)   右下 (+w/2, -h/2)      (w, h = 贴图像素尺寸)
 * ```
 *
 * **网格坐标不是另一套坐标系**，只是把世界坐标按格子量化：
 * `grid.y` 与世界 y **同向**（都向上），`grid (0, 0)` 在场景左下角，
 * 也就是图片的**最下面一行**（与 Unity `GridMap` 一致）。因此：
 *
 *      世界 y 最小的一行 = 图片最下面一行 = grid.y = 0
 *
 * 唯一的翻转发生在「世界坐标 ↔ 图像像素」之间（图片的 y 天生向下），
 * 那是贴图绘制与鼠标命中才需要的一步，换算在 `world.ts` 里，别处不要再写。
 */

export interface GridSize {
  readonly width: number;
  readonly height: number;
}

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** 世界坐标点。 */
export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

/** 网格坐标点（整数，y 向上，与世界同向）。 */
export interface GridPoint {
  readonly x: number;
  readonly y: number;
}

/** 网格坐标 → `.bytes` 中的线性下标（行主序 `y * width + x`，y=0 为图片最下面一行）。 */
export function gridIndex(x: number, y: number, width: number): number {
  return y * width + x;
}

/** 线性下标 → 网格坐标。 */
export function indexToGrid(index: number, width: number): GridPoint {
  return { x: index % width, y: Math.floor(index / width) };
}

/** 网格行号 → 图像行号（0 = 图片最上面一行）。 */
export function gridRowToImageRow(gridY: number, height: number): number {
  return height - 1 - gridY;
}

/** 图像行号 → 网格行号（0 = 图片最下面一行）。 */
export function imageRowToGridRow(imageRow: number, height: number): number {
  return height - 1 - imageRow;
}

/** 判断网格坐标是否在范围内。 */
export function isInsideGrid(point: GridPoint, size: GridSize): boolean {
  return point.x >= 0 && point.x < size.width && point.y >= 0 && point.y < size.height;
}

/** 图片与网格是否等比对齐（同一缩放系数），用于导入时校验地图贴图与网格尺寸是否匹配。 */
export function cellsAreSquare(grid: GridSize, image: ImageSize): boolean {
  if (grid.width <= 0 || grid.height <= 0 || image.width <= 0 || image.height <= 0) {
    return false;
  }

  return Math.abs(image.width / grid.width - image.height / grid.height) < 1e-6;
}

/** 每格在世界坐标里的尺寸（非等比时 x / y 各自算）。 */
export function cellPixelSize(grid: GridSize, image: ImageSize): { x: number; y: number } {
  return { x: image.width / grid.width, y: image.height / grid.height };
}

/**
 * 由图片尺寸与「每格像素数」推导网格尺寸（导入地图贴图时用）。
 * `cellPixels` 缺省时按 30px 一格（DiceTale 现有地图 Map001 的实测值）。
 */
export function gridSizeFromImage(image: ImageSize, cellPixels = 30): GridSize {
  return {
    width: Math.max(1, Math.round(image.width / cellPixels)),
    height: Math.max(1, Math.round(image.height / cellPixels)),
  };
}
