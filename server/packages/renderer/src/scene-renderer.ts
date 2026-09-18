import { cellPixelSize, type GridSize, type ImageSize } from "@dts/grid";
import { visibleWorldRect, worldToScreen, type Viewport } from "./viewport";

/**
 * Canvas 2D 场景渲染器。
 *
 * 只读输入、无副作用：调用方（编辑器）在 rAF 循环里把当前状态传进来即可。
 * 渲染顺序：背景 → 地图贴图 → 格子着色 → 网格线 → 标记 → 选中框。
 */

/** 对象标记（玩家 / 场景物体 / 道具 / 事件）。 */
export interface SceneMarker {
  readonly id: string;
  /** 归一化坐标（`[0,1]`，y 向下）。 */
  readonly position: { x: number; y: number };
  readonly kind: string;
  readonly label?: string;
  readonly selected?: boolean;
  /** 覆盖默认配色（CSS 颜色）。 */
  readonly color?: string;
}

export interface SceneRenderInput {
  readonly viewport: Viewport;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly image?: CanvasImageSource | null;
  readonly imageSize?: ImageSize;
  readonly grid?: GridSize;
  /** 行主序 `y*width+x`，y=0 为图片最下面一行。 */
  readonly cells?: Uint8Array;
  /** 掩码 → CSS 颜色；返回 null 表示不绘制该格。 */
  readonly cellColor?: (mask: number) => string | null;
  readonly showGrid?: boolean;
  readonly gridColor?: string;
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
const CHECKER_LIGHT = "#1e2127";
const CHECKER_DARK = "#191c21";
const CHECKER_SIZE = 16;

/** 网格线在该屏幕上间距小于此值时不再绘制（避免密到糊成一片）。 */
const MIN_GRID_LINE_SPACING = 4;

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

      drawBackground(context, input);

      const view = { width: cssWidth, height: cssHeight };
      const visible = visibleWorldRect(viewport, view);

      if (input.image != null && input.imageSize !== undefined) {
        drawImage(context, input.image, input.imageSize, viewport, visible);
      }

      if (input.grid !== undefined) {
        if (input.cells !== undefined && input.cellColor !== undefined && input.imageSize !== undefined) {
          drawCells(context, input, viewport, visible);
        }

        if (input.showGrid === true && input.imageSize !== undefined) {
          drawGridLines(context, input, viewport, view);
        }
      }

      drawMarkers(context, input, viewport);
    },

    dispose(): void {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}

function drawBackground(context: CanvasRenderingContext2D, input: SceneRenderInput): void {
  context.fillStyle = input.background ?? DEFAULT_BACKGROUND;
  context.fillRect(0, 0, input.cssWidth, input.cssHeight);

  // 有地图区域才铺棋盘：没给 imageSize（例如项目里还没有场景）时不该画出
  // 一个「看起来像地图」的区域，否则「什么都没有」看起来就像「有个空地图」
  if (input.image != null || input.imageSize === undefined) {
    return;
  }

  for (let y = 0; y < input.cssHeight; y += CHECKER_SIZE) {
    for (let x = 0; x < input.cssWidth; x += CHECKER_SIZE) {
      const light = ((x / CHECKER_SIZE + y / CHECKER_SIZE) | 0) % 2 === 0;
      context.fillStyle = light ? CHECKER_LIGHT : CHECKER_DARK;
      context.fillRect(x, y, CHECKER_SIZE, CHECKER_SIZE);
    }
  }
}

function drawImage(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  imageSize: ImageSize,
  viewport: Viewport,
  visible: { left: number; top: number; right: number; bottom: number },
): void {
  if (
    visible.right < 0 ||
    visible.bottom < 0 ||
    visible.left > imageSize.width ||
    visible.top > imageSize.height
  ) {
    return;
  }

  const origin = worldToScreen(viewport, { x: 0, y: 0 });
  context.imageSmoothingEnabled = viewport.scale < 4;
  context.drawImage(
    image,
    origin.x,
    origin.y,
    imageSize.width * viewport.scale,
    imageSize.height * viewport.scale,
  );
}

function drawCells(
  context: CanvasRenderingContext2D,
  input: SceneRenderInput,
  viewport: Viewport,
  visible: { left: number; top: number; right: number; bottom: number },
): void {
  const grid = input.grid;
  const imageSize = input.imageSize;
  const cells = input.cells;
  const cellColor = input.cellColor;
  if (grid === undefined || imageSize === undefined || cells === undefined || cellColor === undefined) {
    return;
  }

  const cell = cellPixelSize(grid, imageSize);

  const firstCol = Math.max(0, Math.floor(visible.left / cell.x));
  const lastCol = Math.min(grid.width - 1, Math.ceil(visible.right / cell.x) - 1);
  const firstImageRow = Math.max(0, Math.floor(visible.top / cell.y));
  const lastImageRow = Math.min(grid.height - 1, Math.ceil(visible.bottom / cell.y) - 1);

  for (let imageRow = firstImageRow; imageRow <= lastImageRow; imageRow += 1) {
    // 图像行（0 = 最上面）→ 网格 y（0 = 最下面）
    const gridY = grid.height - 1 - imageRow;
    const top = worldToScreen(viewport, { x: 0, y: imageRow * cell.y }).y;
    const height = cell.y * viewport.scale + 1;

    for (let x = firstCol; x <= lastCol; x += 1) {
      const mask = cells[gridY * grid.width + x] ?? 0;
      if (mask === 0) {
        continue;
      }

      const color = cellColor(mask);
      if (color === null) {
        continue;
      }

      const left = worldToScreen(viewport, { x: x * cell.x, y: 0 }).x;
      context.fillStyle = color;
      context.fillRect(left, top, cell.x * viewport.scale + 1, height);
    }
  }
}

function drawGridLines(
  context: CanvasRenderingContext2D,
  input: SceneRenderInput,
  viewport: Viewport,
  view: { width: number; height: number },
): void {
  const grid = input.grid;
  const imageSize = input.imageSize;
  if (grid === undefined || imageSize === undefined) {
    return;
  }

  const cell = cellPixelSize(grid, imageSize);
  const spacingX = cell.x * viewport.scale;
  const spacingY = cell.y * viewport.scale;
  if (spacingX < MIN_GRID_LINE_SPACING && spacingY < MIN_GRID_LINE_SPACING) {
    return;
  }

  context.strokeStyle = input.gridColor ?? DEFAULT_GRID_COLOR;
  context.lineWidth = 1;
  context.beginPath();

  if (spacingX >= MIN_GRID_LINE_SPACING) {
    for (let x = 0; x <= grid.width; x += 1) {
      const screenX = Math.round(worldToScreen(viewport, { x: x * cell.x, y: 0 }).x) + 0.5;
      context.moveTo(screenX, 0);
      context.lineTo(screenX, view.height);
    }
  }

  if (spacingY >= MIN_GRID_LINE_SPACING) {
    for (let y = 0; y <= grid.height; y += 1) {
      const screenY = Math.round(worldToScreen(viewport, { x: 0, y: y * cell.y }).y) + 0.5;
      context.moveTo(0, screenY);
      context.lineTo(view.width, screenY);
    }
  }

  context.stroke();
}

function drawMarkers(
  context: CanvasRenderingContext2D,
  input: SceneRenderInput,
  viewport: Viewport,
): void {
  const markers = input.markers;
  const imageSize = input.imageSize;
  if (markers === undefined || imageSize === undefined) {
    return;
  }

  const radius = input.markerRadius ?? 7;

  for (const marker of markers) {
    const screen = worldToScreen(viewport, {
      x: marker.position.x * imageSize.width,
      y: marker.position.y * imageSize.height,
    });

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
