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
import { visibleWorldRect, worldToScreen, type Point, type Viewport } from "./viewport";

/**
 * Canvas 2D 场景渲染器。
 *
 * 只读输入、无副作用：调用方（编辑器）在 rAF 循环里把当前状态传进来即可。
 *
 * 只有**世界坐标**一套（x 向右、y 向上，单位像素），而且**世界无限大**：
 * - 对象要显示的图片各占一块矩形（`SceneLayer.rect` = 中心 + 图片尺寸）：地图的贴图、
 *   精灵的图片都走这条路，贴图铺满矩形、格子锚在矩形上，有多少张都各画各的；
 * - 网格：格子 `(x, y)` 与世界 y 同向，`(0, 0)` 在**那张地图矩形的左下角**；
 * - 对象：每层一张图片（可以没有图片），选中时在它那块矩形上画选中框。
 *
 * 渲染顺序：背景 + 棋盘底纹 → 每层图片（底纹 → 贴图 → 格子着色 → 网格线）→ 选中框 → 原点十字。
 *
 * **没有「标记点」这回事了**：对象在画布上就是它那块矩形（拾取、选中框、贴图同一块矩形），
 * 所以看不见的对象不存在，需要用点/圆来兜底。
 */

/**
 * 世界里的一张图片：铺在一块矩形上，**可选**带网格。
 *
 * 地图就是「带网格的图片」，精灵只是「一张图片」——同一套绘制（贴图 → 格子
 * 着色 → 网格线），全部裁剪在这块矩形里，所以一张场景里有多少张都互不干扰。
 */
export interface SceneLayer {
  /** 贴图；还没加载好时为 `null`（只看得到底纹）。 */
  readonly image?: CanvasImageSource | null;
  /** 这张图片占据的世界矩形（贴图铺满它，网格锚在它上面）。 */
  readonly rect: WorldRect;
  readonly grid?: GridSize;
  /** 行主序 `y*width+x`，y=0 为图片最下面一行（= 世界 y 最小的一行）。 */
  readonly cells?: Uint8Array;
  /**
   * 掩码 → 这一格要画的颜色，**按顺序依次叠加绘制**（先画的在下面）。
   *
   * 之所以是一串颜色而不是一个：一个格子可以同时是多种类型（障碍 + 雾1），
   * 每种的半透明色要各画一层，叠出来的效果才与 Unity 编辑窗口一致
   * （`GridMapEditorRenderer.DrawCells` 就是逐位画若干个半透明矩形）。
   * 返回空数组 = 这一格不画。
   */
  readonly cellColors?: (mask: number) => readonly string[];
  readonly showGrid?: boolean;
  readonly gridColor?: string;
  /**
   * 选中：在这块矩形上画**选中框**（4 个角点 + 4 条边中点，不画中心点）。
   *
   * 画在矩形自己的位置上，所以「选中了谁」和「点哪能选中它」用的是**同一块矩形**
   * （见 `hitTestRect`）——两者的旋转与缩放必然一致，不会出现「框在左、点不到」。
   */
  readonly selected?: boolean;
}

export interface SceneRenderInput {
  readonly viewport: Viewport;
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** 场景里的图片，**按顺序叠加绘制**（先画的在下面）。 */
  readonly layers?: readonly SceneLayer[];
  /** 画在世界原点的十字光标，便于判断 0,0 在哪。 */
  readonly showOrigin?: boolean;
  readonly background?: string;
  /**
   * 空处（以及贴图的透明处）垫的黑灰棋盘底纹；默认打开。
   *
   * 传 `false` 就只剩 `background` 的纯色。
   */
  readonly checker?: boolean;
  /**
   * 棋盘底纹对齐到世界里的哪一点（默认世界原点）。
   *
   * 调用方一般给**底图矩形的左下角**：底纹的格子于是与地图的网格对齐，平移画布时
   * 底纹跟着地图走，而不是像贴在屏幕上一样滑动。它只影响底纹的相位，不影响别的绘制。
   */
  readonly checkerOrigin?: Point;
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

/**
 * 「透明底纹」的黑灰棋盘格。
 *
 * 对比度是刻意拉开一点的：它要能一眼看出「这里是空的（或者贴图在这里是透明的）」。
 * 太暗会和背景糊成一片纯黑——那正是它看上去「消失」的原因。
 */
const CHECKER_LIGHT = "#2b303a";
const CHECKER_DARK = "#22262e";

/** 棋盘格在世界里的边长（世界像素）；缩放后会夹在上下限内，免得缩远了糊成噪点。 */
const CHECKER_WORLD_SIZE = 32;

/** 棋盘格画在屏幕上的边长下限 / 上限（屏幕像素）。 */
const CHECKER_MIN_SCREEN_SIZE = 6;
const CHECKER_MAX_SCREEN_SIZE = 48;

/**
 * 棋盘格的绘制上限：一格一格铺，缩得极小时不至于画满屏几十万个方块。
 * 超过就退回纯色背景（那时格子本身也小得看不见了）。
 */
const MAX_CHECKER_TILES = 8192;

/** 网格线在该屏幕上间距小于此值时不再绘制（避免密到糊成一片）。 */
const MIN_GRID_LINE_SPACING = 4;

/** 网格线条数上限：视口缩得极小时不至于画上百万条线。 */
const MAX_GRID_LINES = 4000;

/** 对象类型色（新建对象弹框里那个小圆点用；画布上不再画标记点）。 */
const KIND_MARKER_COLORS: Record<string, string> = {
  SceneObject: "#4f9cf9",
  Player: "#3fbf6f",
  Item: "#e0a13c",
  Event: "#b06ef0",
};

const DEFAULT_MARKER_COLOR = "#9aa4b2";

/**
 * 取某类型对象的颜色（未知类型走默认灰）。
 *
 * 「新建对象」弹框里的类型色点用它；画布上不再画标记点，但配色仍从这里取，
 * 免得弹框和别处各写一套颜色。
 */
export function kindMarkerColor(kind: string): string {
  return KIND_MARKER_COLORS[kind] ?? DEFAULT_MARKER_COLOR;
}

/**
 * 矩形绕自己的中心旋转 `rotation` 弧度后，是否覆盖世界点 `point`。
 *
 * 这是**拾取对象**用的碰撞体：和选中框、和贴图铺的那块矩形**完全同一块**，
 * 所以「看到的框」与「点得到的范围」永远一致。判定在**世界坐标**里做——
 * 命中区域于是与视口缩放无关（1:1 点和放大 8 倍点，命中的是同一个对象）。
 *
 * 做法是把点**反变换回矩形的本地坐标**（先平移到中心、再反向旋转），
 * 于是旋转矩形也只是一个 `|x| ≤ 半宽 && |y| ≤ 半高` 的判断，
 * 不用写四条边的交点、也不会在边界上算错。
 */
export function hitTestRect(point: Point, rect: WorldRect, rotation = 0): boolean {
  const dx = point.x - rect.center.x;
  const dy = point.y - rect.center.y;
  const halfWidth = rect.size.width / 2;
  const halfHeight = rect.size.height / 2;

  if (rotation === 0) {
    return Math.abs(dx) <= halfWidth && Math.abs(dy) <= halfHeight;
  }

  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;

  return Math.abs(localX) <= halfWidth && Math.abs(localY) <= halfHeight;
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

      // 底色 + 黑灰棋盘格铺满整个视口：贴图外的空白、以及**贴图自己的透明处**
      // 都是「透出底下这一层」的效果，所以底纹只需要画这一次。
      context.fillStyle = input.background ?? DEFAULT_BACKGROUND;
      context.fillRect(0, 0, cssWidth, cssHeight);

      if (input.checker !== false) {
        fillChecker(
          context,
          checker,
          viewportForChecker(viewport, input.checkerOrigin),
          view,
        );
      }

      for (const layer of input.layers ?? []) {
        drawLayer(context, layer, viewport, visible, view);
      }

      // 选中框画在**所有图层之后**：被别的图片盖住的对象也要看得见自己的框
      for (const layer of input.layers ?? []) {
        if (layer.selected === true) {
          drawSelectionFrame(context, layer.rect, viewport);
        }
      }

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

/** 两格见方的黑灰棋盘格纹样（透明底纹的图案单元，2×2 像素 = 2×2 格）。 */
function createCheckerPattern(context: CanvasRenderingContext2D): CanvasPattern | null {
  const tile = document.createElement("canvas");
  tile.width = 2;
  tile.height = 2;
  const tileContext = tile.getContext("2d");
  if (tileContext === null) {
    return null;
  }

  tileContext.fillStyle = CHECKER_LIGHT;
  tileContext.fillRect(0, 0, 2, 2);
  tileContext.fillStyle = CHECKER_DARK;
  tileContext.fillRect(0, 0, 1, 1);
  tileContext.fillRect(1, 1, 1, 1);

  return context.createPattern(tile, "repeat");
}

/**
 * 铺满视口的黑灰棋盘底纹。
 *
 * 格子边长取 `棋盘格世界尺寸 × 缩放`（夹在上下限内），相位由 `viewport` 里的
 * 世界原点在屏幕上的位置决定——所以底纹跟着地图一起平移 / 缩放，而不是贴在屏幕上的
 * 静态花纹；缩得再远也只是格子变小，不会变成噪点，也不会画到屏幕外去。
 *
 * 缩放靠**画布变换**实现（`pattern.setTransform` 在老 Safari 上还没有），
 * 因此这里只用到 `save` / `restore` / `scale` / `translate` 这几个老牌 API。
 */
function fillChecker(
  context: CanvasRenderingContext2D,
  checker: CanvasPattern | null,
  viewport: Viewport,
  view: ImageSize,
): void {
  if (checker === null) {
    return;
  }

  const size = Math.min(
    CHECKER_MAX_SCREEN_SIZE,
    Math.max(CHECKER_MIN_SCREEN_SIZE, CHECKER_WORLD_SIZE * viewport.scale),
  );
  if (view.width / size > MAX_CHECKER_TILES || view.height / size > MAX_CHECKER_TILES) {
    return;
  }

  // 相位落在 [0, size) 内：把图案整体挪一下，使世界原点那一格正好对齐
  const offsetX = ((viewport.tx % size) + size) % size;
  const offsetY = ((viewport.ty % size) + size) % size;

  context.save();
  context.scale(size, size);
  context.translate(offsetX / size, offsetY / size);
  context.fillStyle = checker;
  context.fillRect(-offsetX / size, -offsetY / size, view.width / size, view.height / size);
  context.restore();
}

/**
 * 画一层图片：底纹（只有地图开）→ 贴图 → 格子着色 → 网格线。
 *
 * **全部裁剪在这块图片的矩形里**：世界无限大，一张小地图的网格线不该横穿整个屏幕，
 * 多张地图之间也不该互相越界。整块都在视口外时直接跳过（图片可以摆在世界任何地方）。
 */
function drawLayer(
  context: CanvasRenderingContext2D,
  layer: SceneLayer,
  viewport: Viewport,
  visible: { left: number; top: number; right: number; bottom: number },
  view: ImageSize,
): void {
  const box = screenBoxOf(layer.rect, viewport);
  if (box.right < 0 || box.bottom < 0 || box.left > view.width || box.top > view.height) {
    return;
  }

  context.save();
  context.beginPath();
  context.rect(box.left, box.top, box.right - box.left, box.bottom - box.top);
  context.clip();

  if (layer.image != null) {
    context.imageSmoothingEnabled = viewport.scale < 4;
    context.drawImage(layer.image, box.left, box.top, box.right - box.left, box.bottom - box.top);
  }

  if (layer.grid !== undefined) {
    if (layer.cells !== undefined && layer.cellColors !== undefined) {
      drawCells(context, layer, viewport, visible);
    }

    if (layer.showGrid === true) {
      drawGridLines(context, layer, viewport, visible, view);
    }
  }

  context.restore();
}

/** 把视口整体挪一下，使底纹的锚点（世界坐标）落到世界原点上——底纹于是与地图对齐。 */
function viewportForChecker(
  viewport: Viewport,
  origin: { readonly x: number; readonly y: number } | undefined,
): Viewport {
  if (origin === undefined || (origin.x === 0 && origin.y === 0)) {
    return viewport;
  }

  return {
    scale: viewport.scale,
    tx: viewport.tx + origin.x * viewport.scale,
    ty: viewport.ty - origin.y * viewport.scale,
  };
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
  const cellColors = layer.cellColors;
  if (grid === undefined || cells === undefined || cellColors === undefined) {
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

      const colors = cellColors(mask);
      if (colors.length === 0) {
        continue;
      }

      const cellLeft = worldToScreen(viewport, gridCornerToWorld({ x, y: 0 }, grid, rect)).x;

      // 逐层叠加：一个格子含多个类型位时，每一位的半透明色各画一遍（低位在上）
      for (const color of colors) {
        context.fillStyle = color;
        context.fillRect(cellLeft, cellBottom - size, cell.x * viewport.scale + 1, size);
      }
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

/** 选中框的配色与尺寸（屏幕像素）。 */
const SELECTION_COLOR = "#4f9cf9";
const SELECTION_HANDLE_SIZE = 7;
const SELECTION_DASH: readonly [number, number] = [4, 3];

/**
 * 选中框：矩形**四角 + 四边中点**共 8 个手柄，外加一圈虚线描边。
 *
 * 刻意**不画中心点**：中心点会被误读成「对象就长这个点」，而对象其实铺满整块矩形。
 * 手柄用实心方块 + 细描边（Unity 那套），在任何贴图上都看得清。
 */
function drawSelectionFrame(
  context: CanvasRenderingContext2D,
  rect: WorldRect,
  viewport: Viewport,
): void {
  const topLeft = worldToScreen(viewport, worldRectTopLeft(rect));
  const width = rect.size.width * viewport.scale;
  const height = rect.size.height * viewport.scale;

  // 太小的矩形（缩得很远）只画框、不画手柄：手柄会比框还大，糊成一团
  const half = SELECTION_HANDLE_SIZE / 2;
  const handles: Point[] = [
    { x: topLeft.x, y: topLeft.y },
    { x: topLeft.x + width / 2, y: topLeft.y },
    { x: topLeft.x + width, y: topLeft.y },
    { x: topLeft.x + width, y: topLeft.y + height / 2 },
    { x: topLeft.x + width, y: topLeft.y + height },
    { x: topLeft.x + width / 2, y: topLeft.y + height },
    { x: topLeft.x, y: topLeft.y + height },
    { x: topLeft.x, y: topLeft.y + height / 2 },
  ];

  context.save();
  context.lineWidth = 1;
  context.strokeStyle = SELECTION_COLOR;

  // 虚线描边容易被当成「对象的一部分」，但它能把带旋转的框也画得清清楚楚
  context.setLineDash([...SELECTION_DASH]);
  context.strokeRect(topLeft.x + 0.5, topLeft.y + 0.5, width - 1, height - 1);
  context.setLineDash([]);

  if (width >= SELECTION_HANDLE_SIZE * 2 && height >= SELECTION_HANDLE_SIZE * 2) {
    for (const handle of handles) {
      context.fillStyle = SELECTION_COLOR;
      context.fillRect(
        Math.round(handle.x - half),
        Math.round(handle.y - half),
        SELECTION_HANDLE_SIZE,
        SELECTION_HANDLE_SIZE,
      );
      context.strokeStyle = "rgba(0,0,0,0.6)";
      context.strokeRect(
        Math.round(handle.x - half) + 0.5,
        Math.round(handle.y - half) + 0.5,
        SELECTION_HANDLE_SIZE - 1,
        SELECTION_HANDLE_SIZE - 1,
      );
    }
  }

  context.restore();
}

/** 世界原点（场景中心）的十字光标。 */function drawOriginCross(context: CanvasRenderingContext2D, viewport: Viewport): void {
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
