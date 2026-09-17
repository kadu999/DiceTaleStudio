/**
 * 坐标转换：**全项目唯一的坐标换算入口**。
 *
 * 三套坐标系（务必区分，这里是历史上反复出错的地方）：
 *
 * 1. 图像像素 `px`：原点图片左上角，x 向右，y 向下。
 * 2. 归一化 `norm`：`[0,1]`，x 向右，**y 向下**（与后端协议 GameStateSnapshot / GM 控制台一致）。
 * 3. 网格 `grid`：x 向右，**y 向上**；`grid.y = 0` 对应 Unity `GridMap.GridOrigin`（网格左下角，-Z 侧）。
 *
 * 关键结论（由 Unity `MapManager.GetNormalizedPosition` 与 `GridMap.GridToWorld` 推导）：
 *   `norm.y = 1 - (worldZ - originZ) / height`，而 `grid.y` 随 `worldZ` 递增，
 *   因此 **`grid.y = 0` 是图片最下面一行**，即：
 *
 *       imageRow = height - 1 - gridY
 *       gridY    = height - 1 - imageRow
 *
 * 任何地方需要在这两套坐标间换算，都必须走本模块。
 */

export interface GridSize {
  readonly width: number;
  readonly height: number;
}

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** 归一化坐标点（`[0,1]`，y 向下）。 */
export interface NormPoint {
  readonly x: number;
  readonly y: number;
}

/** 网格坐标点（整数，y 向上）。 */
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

/** 格子中心 → 归一化坐标（y 向下）。 */
export function gridToNorm(point: GridPoint, size: GridSize): NormPoint {
  return {
    x: (point.x + 0.5) / size.width,
    y: 1 - (point.y + 0.5) / size.height,
  };
}

/** 归一化坐标 → 所在格子（y 向下换算回网格）。 */
export function normToGrid(point: NormPoint, size: GridSize): GridPoint {
  return {
    x: Math.min(size.width - 1, Math.max(0, Math.floor(point.x * size.width))),
    y: Math.min(
      size.height - 1,
      Math.max(0, Math.floor((1 - point.y) * size.height)),
    ),
  };
}

/** 归一化坐标 → 图像像素坐标。 */
export function normToImagePixel(point: NormPoint, image: ImageSize): { x: number; y: number } {
  return { x: point.x * image.width, y: point.y * image.height };
}

/** 图像像素坐标 → 归一化坐标。 */
export function imagePixelToNorm(px: number, py: number, image: ImageSize): NormPoint {
  return { x: px / image.width, y: py / image.height };
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

/** 每格在图片上的像素尺寸（用于渲染换算；非等比时取 x 方向并给出 y 方向）。 */
export function cellPixelSize(
  grid: GridSize,
  image: ImageSize,
): { x: number; y: number } {
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
