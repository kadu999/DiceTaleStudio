/**
 * 视口变换（纯数学，无 DOM）。
 *
 * 世界坐标 = 地图图片的像素坐标（原点左上，y 向下）。
 * 屏幕坐标 = canvas 的 CSS 像素坐标（原点左上）。
 * 变换：`screen = world * scale + t`
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

export function createViewport(scale = 1, tx = 0, ty = 0): Viewport {
  return { scale, tx, ty };
}

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  return Math.min(max, Math.max(min, scale));
}

export function worldToScreen(viewport: Viewport, point: Point): Point {
  return {
    x: point.x * viewport.scale + viewport.tx,
    y: point.y * viewport.scale + viewport.ty,
  };
}

export function screenToWorld(viewport: Viewport, point: Point): Point {
  return {
    x: (point.x - viewport.tx) / viewport.scale,
    y: (point.y - viewport.ty) / viewport.scale,
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
    ty: anchor.y - world.y * nextScale,
  };
}

/** 让内容适配到视口内（居中 + 留边距）。 */
export function fitViewport(
  content: { width: number; height: number },
  view: { width: number; height: number },
  padding = 16,
  limits: { min?: number; max?: number } = {},
): Viewport {
  if (content.width <= 0 || content.height <= 0 || view.width <= 0 || view.height <= 0) {
    return createViewport();
  }

  const usableWidth = Math.max(1, view.width - padding * 2);
  const usableHeight = Math.max(1, view.height - padding * 2);
  const scale = clampScale(
    Math.min(usableWidth / content.width, usableHeight / content.height),
    limits.min ?? MIN_SCALE,
    limits.max ?? MAX_SCALE,
  );

  return {
    scale,
    tx: (view.width - content.width * scale) / 2,
    ty: (view.height - content.height * scale) / 2,
  };
}

/**
 * 约束平移：内容比视口小时居中，比视口大时不允许拖出视口外（保留 `margin` 像素余量）。
 */
export function clampViewport(
  viewport: Viewport,
  content: { width: number; height: number },
  view: { width: number; height: number },
  margin = 48,
): Viewport {
  const scaledWidth = content.width * viewport.scale;
  const scaledHeight = content.height * viewport.scale;

  const clampAxis = (
    t: number,
    scaled: number,
    viewSize: number,
  ): number => {
    if (scaled <= viewSize) {
      return (viewSize - scaled) / 2;
    }

    // 内容更大：允许 [-scaled + viewSize - margin, margin] 区间
    const min = viewSize - scaled - margin;
    const max = margin;
    return Math.min(max, Math.max(min, t));
  };

  return {
    scale: viewport.scale,
    tx: clampAxis(viewport.tx, scaledWidth, view.width),
    ty: clampAxis(viewport.ty, scaledHeight, view.height),
  };
}

/** 当前视口在世界坐标里的可见矩形（用于裁剪绘制）。 */
export function visibleWorldRect(
  viewport: Viewport,
  view: { width: number; height: number },
): { left: number; top: number; right: number; bottom: number } {
  const topLeft = screenToWorld(viewport, { x: 0, y: 0 });
  const bottomRight = screenToWorld(viewport, { x: view.width, y: view.height });
  return {
    left: topLeft.x,
    top: topLeft.y,
    right: bottomRight.x,
    bottom: bottomRight.y,
  };
}
