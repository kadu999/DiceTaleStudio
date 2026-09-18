/**
 * 坐标契约：**全项目只有一套坐标系——世界坐标**。
 *
 * ```
 * 世界坐标 world：x 向右，y 向上，单位像素，**世界无限大**（没有边界、没有「场景范围」）
 * ```
 *
 * 地图只是摆在世界里的一块贴图（`WorldRect` = 中心位置 + 贴图尺寸），
 * `grid (0, 0)` 在**那张地图自己的左下角**，也就是图片的**最下面一行**
 * （与 Unity `GridMap` 一致），因此：
 *
 *      世界 y 最小的一行 = 图片最下面一行 = grid.y = 0
 *
 * `grid.y` 与世界 y **同向**（都向上），所以网格不是另一套坐标系，
 * 只是把世界坐标按格子量化。唯一的翻转发生在绘制贴图那一步（图片的 y 天生向下），
 * 由 `world.ts` 的 `worldRectTopLeft()` 给出锚点，别处不要再写。
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

/** 判断网格坐标是否在范围内。 */
export function isInsideGrid(point: GridPoint, size: GridSize): boolean {
  return point.x >= 0 && point.x < size.width && point.y >= 0 && point.y < size.height;
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
