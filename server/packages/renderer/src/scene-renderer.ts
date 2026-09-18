import {
  cellPixelSize,
  gridCornerToWorld,
  worldRectBottom,
  worldRectLeft,
  worldRectTopLeft,
  type GridSize,
  type ImageSize,
  type WorldRect,
} from "@dts/grid";
import { visibleWorldRect, worldToScreen, type Viewport } from "./viewport";

/**
 * Canvas 2D 场景渲染器。
 *
 * 只读输入、无副作用：调用方（编辑器）在 rAF 循环里把当前状态传进来即可。
 *
 * 只有**世界坐标**一套（x 向右、y 向上，单位像素），而且**世界无限大**：
 * - 对象要显示的图片各占一块矩形（`SceneLayer.rect` = 中心 + 图片尺寸）：地图的贴图、
 *   精灵的图片都走这条路，贴图铺满矩形、格子锚在矩形上，有多少张都各画各的；
 * - 网格：格子 `(x, y)` 与世界 y 同向，`(0, 0)` 在**那张地图矩形的左下角**；
 * - 标记点：直接用世界坐标，不做任何换算。
 *
 * 渲染顺序：背景 → 每层图片（棋盘格 → 贴图 → 格子着色 → 网格线）→ 原点十字 → 标记。
 */

/** 对象标记（网格地图 / 精灵 / 玩家 / 道具 / 事件）。 */
export interface SceneMarker {
  readonly id: string;
  /** 世界坐标（y 向上）。 */
  readonly position: { x: number; y: number };
  readonly kind: string;
  readonly label?: string;
  readonly selected?: boolean;
  /** 覆盖默认配色（CSS 颜色）。 */
  readonly color?: string;
}

/**
 * 世界里的一张图片：铺在一块矩形上，**可选**带网格。
 *
 * 地图就是「带网格的图片」，精灵只是「一张图片」——同一套绘制（棋盘格 → 贴图 → 格子
 * 着色 → 网格线），全部裁剪在这块矩形里，所以一张场景里有多少张都互不干扰。
 */
export interface SceneLayer {
  /** 贴图；还没加载好时为 `null`（只画棋盘格与网格）。 */
  readonly image?: CanvasImageSource | null;
  /** 这张图片占据的世界矩形（贴图铺满它，网格锚在它上面）。 */
  readonly rect: WorldRect;
  readonly grid?: GridSize;
  /** 行主序 `y*width+x`，y=0 为图片最下面一行（= 世界 y 最小的一行）。 */
  readonly cells?: Uint8Array;
  /** 掩码 → CSS 颜色；返回 null 表示不绘制该格。 */
  readonly cellColor?: (mask: number) => string | null;
  readonly showGrid?: boolean;
  readonly gridColor?: string;
}

export interface SceneRenderInput {
  readonly viewport: Viewport;
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** 场景里的图片，**按顺序叠加绘制**（先画的在下面）。 */
  readonly layers?: readonly SceneLayer[];
  /** 画在世界原点的十字光标，便于判断 0,0 在哪。 */
  readonly showOrigin?: boolean;
  readonly markers?: readonly SceneMarker[];
  readonly background?: string;
  /** 标记半径（屏幕像素）。 */
  readonly markerRadius?: number;
}

export interface SceneRenderer {
  readonly canvas: HTMLCanvasElement;
  /** 按 CSS 尺寸与设备像素比调整后备缓冲（DPR 上限由调用方决定）。 */
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  draw(input: SceneRenderInput): void;
  dispose(): void;
}

const DEFAULT_BACKGROUND = "#14161a";
const DEFAULT_GRID_COLOR = "rgba(255,255,255,0.12)";
const ORIGIN_COLOR = "rgba(255,255,255,0.35)";
const CHECKER_LIGHT = "#1e2127";
const CHECKER_DARK = "#191c21";
const CHECKER_SIZE = 16;

/** 网格线在该屏幕上间距小于此值时不再绘制（避免密到糊成一片）。 */
const MIN_GRID_LINE_SPACING = 4;

/** 网格线条数上限：视口缩得极小时不至于画上百万条线。 */
const MAX_GRID_LINES = 4000;

/** 标记点按对象类型着色。 */
const KIND_MARKER_COLORS: Record<string, string> = {
  SceneObject: "#4f9cf9",
  Player: "#3fbf6f",
  Item: "#e0a13c",
  Event: "#b06ef0",
};

const DEFAULT_MARKER_COLOR = "#9aa4b2";

/**
 * 取某类型标记点的颜色（未知类型走默认灰）。
 *
 * 画布上的标记点与「新建对象」弹框里的类型色点共用一个来源，两边颜色必须对得上。
 */
export function kindMarkerColor(kind: string): string {
  return KIND_MARKER_COLORS[kind] ?? DEFAULT_MARKER_COLOR;
}

export function createCanvasSceneRenderer(canvas: HTMLCanvasElement): SceneRenderer {
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("无法获取 2D 绘图上下文");
  }

  // 棋盘格纹样只建一次（每帧 fillRect 几百次会把填充率吃光）
  const checker = createCheckerPattern(context);

  return {
    canvas,

    resize(cssWidth: number, cssHeight: number, dpr: number): void {
      const nextWidth = Math.max(1, Math.round(cssWidth * dpr));
      const nextHeight = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }

      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    },

    draw(input: SceneRenderInput): void {
      const { cssWidth, cssHeight, viewport } = input;
      const dpr = cssWidth > 0 ? canvas.width / cssWidth : 1;

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, cssWidth, cssHeight);

      const view: ImageSize = { width: cssWidth, height: cssHeight };
      const visible = visibleWorldRect(viewport, view);

      context.fillStyle = input.background ?? DEFAULT_BACKGROUND;
      context.fillRect(0, 0, cssWidth, cssHeight);

      for (const layer of input.layers ?? []) {
        drawLayer(context, layer, viewport, visible, view, checker);
      }

      drawMarkers(context, input, viewport);

      if (input.showOrigin === true) {
        drawOriginCross(context, viewport);
      }
    },

    dispose(): void {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}

/** 16px 的棋盘格纹样（透明区域的背景）。 */
function createCheckerPattern(context: CanvasRenderingContext2D): CanvasPattern | null {
  const tile = document.createElement("canvas");
  tile.width = CHECKER_SIZE * 2;
  tile.height = CHECKER_SIZE * 2;
  const tileContext = tile.getContext("2d");
  if (tileContext === null) {
    return null;
  }

  tileContext.fillStyle = CHECKER_LIGHT;
  tileContext.fillRect(0, 0, CHECKER_SIZE * 2, CHECKER_SIZE * 2);
  tileContext.fillStyle = CHECKER_DARK;
  tileContext.fillRect(0, 0, CHECKER_SIZE, CHECKER_SIZE);
  tileContext.fillRect(CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE);

  return context.createPattern(tile, "repeat");
}

/**
 * 画一层图片：棋盘格（贴图的透明区露出来的底纹）→ 贴图 → 格子着色 → 网格线。
 *
 * **全部裁剪在这张地图的矩形里**：世界无限大，一张小地图的网格线不该横穿整个屏幕，
 * 多张地图之间也不该互相越界。整块都在视口外时直接跳过（地图可以摆在世界任何地方）。
 */
function drawLayer(
  context: CanvasRenderingContext2D,
  layer: SceneLayer,
  viewport: Viewport,
  visible: { left: number; top: number; right: number; bottom: number },
  view: ImageSize,
  checker: CanvasPattern | null,
): void {
  const box = screenBoxOf(layer.rect, viewport);
  if (box.right < 0 || box.bottom < 0 || box.left > view.width || box.top > view.height) {
    return;
  }

  context.save();
  context.beginPath();
  context.rect(box.left, box.top, box.right - box.left, box.bottom - box.top);
  context.clip();

  if (checker !== null) {
    context.fillStyle = checker;
    context.fillRect(0, 0, view.width, view.height);
  }

  if (layer.image != null) {
    context.imageSmoothingEnabled = viewport.scale < 4;
    context.drawImage(layer.image, box.left, box.top, box.right - box.left, box.bottom - box.top);
  }

  if (layer.grid !== undefined) {
    if (layer.cells !== undefined && layer.cellColor !== undefined) {
      drawCells(context, layer, viewport, visible);
    }

    if (layer.showGrid === true) {
      drawGridLines(context, layer, viewport, visible, view);
    }
  }

  context.restore();
}

/** 图片矩形在屏幕上的外框（贴图就画在这个框里）。 */
function screenBoxOf(
  rect: WorldRect,
  viewport: Viewport,
): { left: number; top: number; right: number; bottom: number } {
  const topLeft = worldToScreen(viewport, worldRectTopLeft(rect));
  return {
    left: topLeft.x,
    top: topLeft.y,
    right: topLeft.x + rect.size.width * viewport.scale,
    bottom: topLeft.y + rect.size.height * viewport.scale,
  };
}

function drawCells(
  context: CanvasRenderingContext2D,
  layer: SceneLayer,
  viewport: Viewport,
  visible: { left: number; top: number; right: number; bottom: number },
): void {
  const grid = layer.grid;
  const cells = layer.cells;
  const cellColor = layer.cellColor;
  if (grid === undefined || cells === undefined || cellColor === undefined) {
    return;
  }

  const rect = layer.rect;
  const cell = cellPixelSize(grid, rect.size);
  const left = worldRectLeft(rect);
  const bottom = worldRectBottom(rect);

  // 网格与世界同向：列号随世界 x 递增，行号随世界 y 递增（y=0 在最下面）
  const firstCol = Math.max(0, Math.floor((visible.left - left) / cell.x));
  const lastCol = Math.min(grid.width - 1, Math.ceil((visible.right - left) / cell.x) - 1);
  const firstRow = Math.max(0, Math.floor((visible.bottom - bottom) / cell.y));
  const lastRow = Math.min(grid.height - 1, Math.ceil((visible.top - bottom) / cell.y) - 1);

  const size = cell.y * viewport.scale + 1;

  for (let y = firstRow; y <= lastRow; y += 1) {
    // 格子底边的屏幕 y（画的时候从这里往上画一格）
    const cellBottom = worldToScreen(viewport, gridCornerToWorld({ x: 0, y }, grid, rect)).y;

    for (let x = firstCol; x <= lastCol; x += 1) {
      const mask = cells[y * grid.width + x] ?? 0;
      if (mask === 0) {
        continue;
      }

      const color = cellColor(mask);
      if (color === null) {
        continue;
      }

      const cellLeft = worldToScreen(viewport, gridCornerToWorld({ x, y: 0 }, grid, rect)).x;
      context.fillStyle = color;
      context.fillRect(cellLeft, cellBottom - size, cell.x * viewport.scale + 1, size);
    }
  }
}

function drawGridLines(
  context: CanvasRenderingContext2D,
  layer: SceneLayer,
  viewport: Viewport,
  visible: { left: number; top: number; right: number; bottom: number },
  view: ImageSize,
): void {
  const grid = layer.grid;
  if (grid === undefined) {
    return;
  }

  const rect = layer.rect;
  const cell = cellPixelSize(grid, rect.size);
  const left = worldRectLeft(rect);
  const bottom = worldRectBottom(rect);
  const spacingX = cell.x * viewport.scale;
  const spacingY = cell.y * viewport.scale;
  if (spacingX < MIN_GRID_LINE_SPACING && spacingY < MIN_GRID_LINE_SPACING) {
    return;
  }

  context.strokeStyle = layer.gridColor ?? DEFAULT_GRID_COLOR;
  context.lineWidth = 1;
  context.beginPath();

  if (spacingX >= MIN_GRID_LINE_SPACING) {
    // 只画与可见范围相交的那几列，避免缩小时画出上百万条线
    const first = Math.max(0, Math.ceil((visible.left - left) / cell.x));
    const last = Math.min(grid.width, Math.floor((visible.right - left) / cell.x));
    for (let x = first; x <= last && x - first <= MAX_GRID_LINES; x += 1) {
      const screenX =
        Math.round(worldToScreen(viewport, gridCornerToWorld({ x, y: 0 }, grid, rect)).x) + 0.5;
      context.moveTo(screenX, 0);
      context.lineTo(screenX, view.height);
    }
  }

  if (spacingY >= MIN_GRID_LINE_SPACING) {
    const first = Math.max(0, Math.ceil((visible.bottom - bottom) / cell.y));
    const last = Math.min(grid.height, Math.floor((visible.top - bottom) / cell.y));
    for (let y = first; y <= last && y - first <= MAX_GRID_LINES; y += 1) {
      const screenY =
        Math.round(worldToScreen(viewport, gridCornerToWorld({ x: 0, y }, grid, rect)).y) + 0.5;
      context.moveTo(0, screenY);
      context.lineTo(view.width, screenY);
    }
  }

  context.stroke();
}

/** 世界原点（场景中心）的十字光标。 */
function drawOriginCross(context: CanvasRenderingContext2D, viewport: Viewport): void {
  const origin = worldToScreen(viewport, { x: 0, y: 0 });
  const arm = 7;
  const cx = Math.round(origin.x) + 0.5;
  const cy = Math.round(origin.y) + 0.5;

  context.strokeStyle = ORIGIN_COLOR;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(cx - arm, cy);
  context.lineTo(cx + arm, cy);
  context.moveTo(cx, cy - arm);
  context.lineTo(cx, cy + arm);
  context.stroke();
}

function drawMarkers(
  context: CanvasRenderingContext2D,
  input: SceneRenderInput,
  viewport: Viewport,
): void {
  const markers = input.markers;
  if (markers === undefined) {
    return;
  }

  const radius = input.markerRadius ?? 7;

  for (const marker of markers) {
    const screen = worldToScreen(viewport, marker.position);

    if (
      screen.x < -radius * 2 ||
      screen.y < -radius * 2 ||
      screen.x > input.cssWidth + radius * 2 ||
      screen.y > input.cssHeight + radius * 2
    ) {
      continue;
    }

    const color = marker.color ?? kindMarkerColor(marker.kind);

    if (marker.selected === true) {
      context.beginPath();
      context.arc(screen.x, screen.y, radius + 4, 0, Math.PI * 2);
      context.strokeStyle = "#ffffff";
      context.lineWidth = 2;
      context.stroke();
    }

    context.beginPath();
    context.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.strokeStyle = "rgba(0,0,0,0.55)";
    context.lineWidth = 1.5;
    context.stroke();
  }
}
