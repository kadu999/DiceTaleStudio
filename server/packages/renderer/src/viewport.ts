import type { ImageSize } from "@dts/grid";

/**
 * 视口变换（纯数学，无 DOM）。
 *
 * 世界坐标只有一套（见 `@dts/grid/coords`）：原点 = 场景中心 `(0, 0)`，x 向右、**y 向上**，
 * 单位像素。这里唯一的另一套是**屏幕坐标**——canvas 的 CSS 像素，原点左上、y 向下，
 * 它是画布自己的像素栅格，不需要也不应该进入文档。
 *
 * 变换（`center` = 视口中心）：
 *
 * ```
 * screen.x = center.x + world.x * scale
 * screen.y = center.y - world.y * scale
 * ```
 *
 * 也就是说 **`createViewport()`（scale 1、无平移）就是「世界原点正好在视口中心」**，
 * 1 世界像素 = 1 CSS 像素。y 的符号就是这套坐标系的「y 向上」。
 */

export interface Viewport {
  readonly scale: number;
  readonly tx: number;
  readonly ty: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 16;

/**
 * 默认视口：世界原点正好落在视口中心。
 *
 * `tx` / `ty` 是**屏幕坐标里的平移量**，与世界坐标无关：世界坐标原点在屏幕上的位置就是
 * `(tx, ty)`，所以「居中」= `tx = width / 2, ty = height / 2`。
 */
export function createViewport(scale = 1, tx = 0, ty = 0): Viewport {
  return { scale, tx, ty };
}

/** 让世界原点落在视口中心（1:1 像素）。 */
export function createCenteredViewport(view: ImageSize): Viewport {
  return createViewport(1, view.width / 2, view.height / 2);
}

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  return Math.min(max, Math.max(min, scale));
}

export function worldToScreen(viewport: Viewport, point: Point): Point {
  return {
    x: viewport.tx + point.x * viewport.scale,
    y: viewport.ty - point.y * viewport.scale,
  };
}

export function screenToWorld(viewport: Viewport, point: Point): Point {
  return {
    x: (point.x - viewport.tx) / viewport.scale,
    y: (viewport.ty - point.y) / viewport.scale,
  };
}

export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return { scale: viewport.scale, tx: viewport.tx + dx, ty: viewport.ty + dy };
}

/**
 * 以屏幕锚点为中心缩放：锚点下的世界坐标在缩放前后保持不动
 * （滚轮缩放锚定光标、双指捏合锚定中点都走这里）。
 */
export function zoomAt(
  viewport: Viewport,
  factor: number,
  anchor: Point,
  limits: { min?: number; max?: number } = {},
): Viewport {
  const nextScale = clampScale(
    viewport.scale * factor,
    limits.min ?? MIN_SCALE,
    limits.max ?? MAX_SCALE,
  );
  if (nextScale === viewport.scale) {
    return viewport;
  }

  const world = screenToWorld(viewport, anchor);
  return {
    scale: nextScale,
    tx: anchor.x - world.x * nextScale,
    ty: anchor.y + world.y * nextScale,
  };
}

/**
 * 让场景铺满视口：内容（贴图的世界范围）居中 + 留边距。
 *
 * 世界坐标本来就以场景中心为原点，所以「内容居中」就是**世界原点落在视口中心**，
 * 只有缩放比需要算。
 */
export function fitViewport(
  scene: ImageSize,
  view: ImageSize,
  padding = 16,
  limits: { min?: number; max?: number } = {},
): Viewport {
  if (scene.width <= 0 || scene.height <= 0 || view.width <= 0 || view.height <= 0) {
    return createCenteredViewport(view);
  }

  const usableWidth = Math.max(1, view.width - padding * 2);
  const usableHeight = Math.max(1, view.height - padding * 2);
  const scale = clampScale(
    Math.min(usableWidth / scene.width, usableHeight / scene.height),
    limits.min ?? MIN_SCALE,
    limits.max ?? MAX_SCALE,
  );

  return createViewport(scale, view.width / 2, view.height / 2);
}

/**
 * 约束平移：场景比视口小时居中，比视口大时不允许拖出视口外（保留 `margin` 像素余量）。
 *
 * 约束的是**场景边缘**的屏幕位置：`tx - halfWidth * scale >= -margin` 且
 * `tx + halfWidth * scale <= view.width + margin`（y 同理，注意 y 向上的符号）。
 */
export function clampViewport(
  viewport: Viewport,
  scene: ImageSize,
  view: ImageSize,
  margin = 48,
): Viewport {
  const scaledHalfWidth = (scene.width / 2) * viewport.scale;
  const scaledHalfHeight = (scene.height / 2) * viewport.scale;

  return {
    scale: viewport.scale,
    tx: clampAxis(viewport.tx, scaledHalfWidth, view.width, margin),
    ty: clampAxis(viewport.ty, scaledHalfHeight, view.height, margin),
  };
}

function clampAxis(t: number, scaledHalf: number, viewSize: number, margin: number): number {
  if (scaledHalf <= viewSize / 2) {
    // 场景比视口小：只能居中，不允许拖走
    return viewSize / 2;
  }

  // 场景更大：场景边缘最多露到 margin 处
  const min = viewSize - scaledHalf - margin;
  const max = scaledHalf + margin;
  return Math.min(max, Math.max(min, t));
}

/** 当前视口在世界坐标里的可见范围（用于裁剪绘制）。 */
export function visibleWorldRect(
  viewport: Viewport,
  view: ImageSize,
): { left: number; top: number; right: number; bottom: number } {
  const topLeft = screenToWorld(viewport, { x: 0, y: 0 });
  const bottomRight = screenToWorld(viewport, { x: view.width, y: view.height });
  return {
    left: topLeft.x,
    // 世界 y 向上：屏幕顶边对应世界 y 的最大值
    top: topLeft.y,
    right: bottomRight.x,
    bottom: bottomRight.y,
  };
}

