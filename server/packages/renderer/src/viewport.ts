import { unionWorldRects, type ImageSize, type WorldRect } from "@dts/grid";

/**
 * 视口变换（纯数学，无 DOM）。
 *
 * 世界坐标只有一套（见 `@dts/grid/coords`）：x 向右、**y 向上**，单位像素，
 * 而且**世界无限大**。这里唯一的另一套是**屏幕坐标**——canvas 的 CSS 像素，
 * 原点左上、y 向下，它是画布自己的像素栅格，不需要也不应该进入文档。
 *
 * 变换（`tx` / `ty` = 世界原点在屏幕上的位置）：
 *
 * ```
 * screen.x = tx + world.x * scale
 * screen.y = ty - world.y * scale
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
 * 把若干世界矩形**一起**装进视口：外框居中 + 按需缩放，四周留 `padding` 边距。
 *
 * 世界无限大，所以没有「把场景铺满」这回事——这里装的是**所有地图的并集外框**
 * （地图可能摆在世界任何地方，所以居中要把原点挪到外框中心，不能想当然地放在屏幕正中）；
 * 一张地图都没有时退回「世界原点居中」。
 */
export function fitViewport(
  rects: readonly WorldRect[],
  view: ImageSize,
  padding = 16,
  limits: { min?: number; max?: number } = {},
): Viewport {
  const bounds = unionWorldRects(rects);
  if (
    bounds === undefined ||
    bounds.size.width <= 0 ||
    bounds.size.height <= 0 ||
    view.width <= 0 ||
    view.height <= 0
  ) {
    return createCenteredViewport(view);
  }

  const usableWidth = Math.max(1, view.width - padding * 2);
  const usableHeight = Math.max(1, view.height - padding * 2);
  const scale = clampScale(
    Math.min(usableWidth / bounds.size.width, usableHeight / bounds.size.height),
    limits.min ?? MIN_SCALE,
    limits.max ?? MAX_SCALE,
  );

  // 外框中心落在视口正中：世界原点因此在屏幕上偏掉（地图不一定摆在原点）
  return {
    scale,
    tx: view.width / 2 - bounds.center.x * scale,
    ty: view.height / 2 + bounds.center.y * scale,
  };
}

/** 屏幕坐标里的一块矩形（canvas CSS 像素，y 向下）。 */
export interface ScreenBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** 当前视口在世界坐标里的可见范围（用于裁剪绘制）。 */
export function visibleWorldRect(viewport: Viewport, view: ImageSize): ScreenBox {
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

