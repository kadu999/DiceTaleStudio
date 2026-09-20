import type { WorldRect } from "@dts/grid";
import { worldRectLeft, worldRectBottom } from "@dts/grid";
import { worldToScreen, type Point, type Viewport } from "./viewport";

/**
 * 场景变换手柄（gizmo）的**几何与命中测试**——纯数学、无 DOM，所以能直接单测。
 *
 * 三件事刻意分开，是因为它们很容易各算一套然后对不上：
 * 1. **世界几何**：矩形四角 / 四边中点、绕任意枢轴旋转、角度差（`rectCorners` 等）；
 * 2. **屏幕几何**：把上面那些点映射到画布 CSS 像素（`gizmoScreenGeometry`）；
 * 3. **命中测试**：屏幕点落在哪个手柄上（`hitTestGizmoHandles`）。
 *
 * 绘制只用第 2 步的结果（渲染器自己不比手柄位置），面板的命中测试也只用第 2 步的结果，
 * 于是「画出来的手柄」与「点得到的手柄」必然是同一份坐标。
 *
 * **所有手柄的尺寸都是屏幕像素**：视口缩到 0.05 或放到 16 倍时，手柄仍然看得见、点得到，
 * 不会变成比对象还大的方块或细得点不中的一条线。
 */

/**
 * 当前变换工具。
 *
 * - `none`：**默认**，不显示任何手柄——拖动对象本体也不改它，只选中 / 平移画布；
 * - `move`：显示移动轴，**拖对象本体 = 自由移动**（两个轴一起走，这是摆位置最顺手的一条路）；
 * - `rotate` / `scale`：显示对应的手柄，对象本体的拖动让位给「平移画布」——
 *   这两个工具下「拖本体」更可能的意思是想换个视角，而不是把对象碰歪。
 */
export type TransformTool = "none" | "move" | "rotate" | "scale";

/**
 * 这个工具是不是**有手柄**（`none` = 拖动场景，没有手柄）。
 *
 * 抽成函数是为了让三处判断**只有一个来源**：
 * 1. 手柄的命中测试（没工具就不给命中）；
 * 2. 手柄的绘制（没工具就不画）；
 * 3. **选中框那 8 个装饰方块画不画**——它和缩放手柄是同一个方块、同尺寸同配色，
 *    一起画出来就成了「移动模式下也出现了缩放的 UI」。所以有工具时只留虚线框。
 *
 * 这一条纯逻辑原先埋在 canvas 绘制里，只能靠肉眼看出来；抽出来之后单测能钉住它。
 */
export function toolHasGizmo(tool: TransformTool): boolean {
  return tool !== "none";
}

/** 手柄名。`move-*` 是轴约束的移动柄，`scale-*` 是矩形八个方位的缩放手柄。 */
export type GizmoHandle =
  | "move-x"
  | "move-y"
  | "rotate"
  | "scale-left"
  | "scale-right"
  | "scale-top"
  | "scale-bottom"
  | "scale-top-left"
  | "scale-top-right"
  | "scale-bottom-left"
  | "scale-bottom-right";

/** 缩放柄的八个方位（顺序＝绘制与命中的优先级：四个角在前，四条边在后）。 */
export const SCALE_HANDLES: readonly GizmoHandle[] = [
  "scale-top-left",
  "scale-top-right",
  "scale-bottom-right",
  "scale-bottom-left",
  "scale-top",
  "scale-right",
  "scale-bottom",
  "scale-left",
];

/**
 * 手柄的配色与尺寸（屏幕像素），与选中框同一套口径。
 *
 * 尺寸与命中容差都是**屏幕像素**，视口缩到 0.05 或放到 16 倍时手柄的大小不变——
 * 于是它永远是一枚「手指 / 光标量级」的目标，不会随缩放变得点不中。
 */
export const GIZMO_HANDLE_SIZE = 9;

/**
 * 命中容差：手柄是 9px 的小方块，**可点范围要往外再放一大圈**（上下左右各 10px）。
 *
 * 画出来的方块只是「中心在哪」的记号；真正的目标是「我想拖那个角」这件事本身。
 * 容差给足了才不会出现「明明点在手柄上却没反应」——那是这一块最常见的抱怨。
 */
export const GIZMO_HANDLE_HIT_SIZE = 10;

/**
 * 屏幕手柄的间距（**都是屏幕像素**，而且都从对象的外框往外量）。
 *
 * 从外框量起是有讲究的：手柄于是**贴着对象**——对象多大，手柄就长在多大的框外面，
 * 不会出现「小对象的手柄离它老远」或「大对象的手柄压在它身上」。
 */
export const GIZMO_AXIS_GAP = 45;
export const GIZMO_AXIS_LENGTH = 40;
export const GIZMO_RING_GAP = 22;

/** 轴条的命中半宽（屏幕像素）：轴是 2px 的线，容差按手指算（18px 宽的一条带子）。 */
export const GIZMO_AXIS_HIT_WIDTH = 9;

/** 旋转环的命中半宽（20px 宽的一圈带子）。 */
export const GIZMO_RING_HIT_WIDTH = 10;

/** 矩形小于这个屏幕尺寸就只画框、不画手柄（手柄会比框还大，糊成一团）。 */
const MIN_FRAME_SIZE = GIZMO_HANDLE_SIZE * 3;

/**
 * 这块矩形在屏幕上够不够大、能不能画手柄。
 *
 * 绘制与命中测试**共用这一个判定**：手柄比对象本身还大时画出来只会糊成一团，
 * 也让「点哪儿都是手柄」变得不可用——那种时候宁可不给手柄。
 */
export function isDrawableFrame(rect: WorldRect, viewport: Viewport): boolean {
  return (
    rect.size.width * viewport.scale >= MIN_FRAME_SIZE &&
    rect.size.height * viewport.scale >= MIN_FRAME_SIZE
  );
}

export interface GizmoHandlePoint {
  readonly handle: GizmoHandle;
  readonly world: Point;
}

/**
 * 矩形四角的世界坐标，**从左上角开始顺时针**。
 *
 * 旋转约定与 `hitTestRect` 完全同一套（局部 x 向右、y 向上，再正向旋转回世界），
 * 所以「画出来的框」与「点得到的范围」依旧是同一块矩形。
 */
export function rectCorners(
  rect: WorldRect,
  rotation = 0,
): readonly [Point, Point, Point, Point] {
  const left = worldRectLeft(rect);
  const bottom = worldRectBottom(rect);
  const right = left + rect.size.width;
  const top = bottom + rect.size.height;

  // 依次是左上 / 右上 / 右下 / 左下（元组字面量，索引不会被判成可能缺失）
  const corners: [Point, Point, Point, Point] = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];

  if (rotation === 0) {
    return corners;
  }

  return [
    rotatePointAround(corners[0], rect.center, rotation),
    rotatePointAround(corners[1], rect.center, rotation),
    rotatePointAround(corners[2], rect.center, rotation),
    rotatePointAround(corners[3], rect.center, rotation),
  ];
}

/** 绕枢轴旋转一个世界点（旋转手柄与实际旋转拖拽共用这一套符号：正角 = 屏幕逆时针）。 */
export function rotatePointAround(point: Point, pivot: Point, radians: number): Point {
  if (radians === 0) {
    return point;
  }

  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;

  return {
    x: pivot.x + dx * cos - dy * sin,
    y: pivot.y + dx * sin + dy * cos,
  };
}

/** 世界点相对枢轴的角度（弧度，`atan2` 的常规象限）。旋转拖拽用它算角度增量。 */
export function angleAround(point: Point, pivot: Point): number {
  return Math.atan2(point.y - pivot.y, point.x - pivot.x);
}

/**
 * 缩放手柄的世界位置：四角 + 四边中点，**与 `SCALE_HANDLES` 的顺序一一对应**。
 *
 * 边中点是相邻两角的平均——不用另算一遍「局部中点再旋转」，少一条会和四角对不上的路径。
 */
export function scaleHandlePoints(rect: WorldRect, rotation = 0): readonly GizmoHandlePoint[] {
  const [topLeft, topRight, bottomRight, bottomLeft] = rectCorners(rect, rotation);
  const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  return [
    { handle: "scale-top-left", world: topLeft },
    { handle: "scale-top-right", world: topRight },
    { handle: "scale-bottom-right", world: bottomRight },
    { handle: "scale-bottom-left", world: bottomLeft },
    { handle: "scale-top", world: midpoint(topLeft, topRight) },
    { handle: "scale-right", world: midpoint(topRight, bottomRight) },
    { handle: "scale-bottom", world: midpoint(bottomRight, bottomLeft) },
    { handle: "scale-left", world: midpoint(bottomLeft, topLeft) },
  ];
}

/**
 * 缩放手柄的**对侧锚点**：拖这个手柄时保持不动的那个点。
 *
 * 角手柄的锚点是对角，边手柄的锚点是对边中点——与 Unity 一致，也是用户期望的
 * 「对面不动，这一侧跟着走」。
 */
export function scaleAnchorFor(handle: GizmoHandle, rect: WorldRect, rotation = 0): Point | undefined {
  const points = new Map(scaleHandlePoints(rect, rotation).map((entry) => [entry.handle, entry.world]));
  const opposite: Partial<Record<GizmoHandle, GizmoHandle>> = {
    "scale-top-left": "scale-bottom-right",
    "scale-top-right": "scale-bottom-left",
    "scale-bottom-right": "scale-top-left",
    "scale-bottom-left": "scale-top-right",
    "scale-top": "scale-bottom",
    "scale-right": "scale-left",
    "scale-bottom": "scale-top",
    "scale-left": "scale-right",
  };

  const target = opposite[handle];
  return target === undefined ? undefined : points.get(target);
}

/** 手柄是不是「角」手柄（角 = 等比缩放，边 = 单轴）。 */
export function isCornerScaleHandle(handle: GizmoHandle): boolean {
  return (
    handle === "scale-top-left" ||
    handle === "scale-top-right" ||
    handle === "scale-bottom-right" ||
    handle === "scale-bottom-left"
  );
}

/** 边手柄管的是哪一个轴：`x` = 左右（改宽度），`y` = 上下（改高度）。 */
export function scaleAxisOf(handle: GizmoHandle): "x" | "y" | undefined {
  switch (handle) {
    case "scale-left":
    case "scale-right":
      return "x";
    case "scale-top":
    case "scale-bottom":
      return "y";
    default:
      return undefined;
  }
}

/**
 * 屏幕上的一份手柄几何（全部是 canvas 的 CSS 像素坐标）。
 *
 * `drawable` 为假表示对象在屏幕上太小（矩形不足 `MIN_FRAME_SIZE`）：这时**只画框不画手柄**，
 * 命中测试也直接返回「什么都没点到」——否则 7px 的手柄会比对象本身还大，点哪儿都是它。
 *
 * **一切距离都从 `bounds` 往外量**（对象在屏幕上的外框），所以三套手柄都贴着对象：
 * 轴条从 `bounds` 外开始画，旋转环围绕 `bounds`，缩放块落在 `bounds` 的角与边中点上。
 */
export interface GizmoScreenHandles {
  readonly center: Point;
  /**
   * 矩形**自己的**半宽 / 半高（屏幕像素，不含旋转），三套手柄都由它派生。
   *
   * 刻意不用「旋转后四角的极值」：那个值随角度变化，会让环半径与轴条间距在旋转时呼吸。
   */
  readonly bounds: { readonly halfWidth: number; readonly halfHeight: number };
  /** 外框四角在屏幕上的位置（给测 e2e 精确点手柄用；绘制走 `scale`）。 */
  readonly corners: readonly Point[];
  /** 两根移动轴（移动工具用；其它工具不画）。 */
  readonly axes: readonly GizmoAxisScreen[];
  /** 旋转环半径（旋转工具用）。 */
  readonly ringRadius: number;
  /** 八个缩放手柄（缩放工具用）。 */
  readonly scale: readonly GizmoHandlePointScreen[];
  readonly drawable: boolean;
}

/** 一根移动轴在屏幕上的起止点与末端箭头。 */
export interface GizmoAxisScreen {
  readonly handle: "move-x" | "move-y";
  readonly root: Point;
  readonly tip: Point;
}

export interface GizmoHandlePointScreen {
  readonly handle: GizmoHandle;
  readonly point: Point;
}

/**
 * 世界矩形 + 视口 → 屏幕手柄几何。**绘制与命中测试共用它**。
 *
 * 参数里带 `rotation` 是有意的：手柄要跟着对象转（对齐 Unity——旋转过的对象，
 * 它的缩放柄也转过去了），而拾取矩形用的仍是同一个 `rotation`。
 *
 * **间距与环半径从「矩形自己的半尺寸」量起**（不是旋转后四角的极值）：否则正方形转过
 * 45° 时外框极值会比半边长出 41%，旋转环与移动轴条在拖拽旋转的过程中会一会儿大一会儿小。
 * 环半径取半边对角线，于是它在**任何角度**下都包得住对象。
 */
export function gizmoScreenGeometry(
  rect: WorldRect,
  rotation: number,
  viewport: Viewport,
): GizmoScreenHandles {
  const center = worldToScreen(viewport, rect.center);
  const corners = rectCorners(rect, rotation).map((corner) => worldToScreen(viewport, corner));
  const bounds = {
    halfWidth: (rect.size.width / 2) * viewport.scale,
    halfHeight: (rect.size.height / 2) * viewport.scale,
  };

  // 轴条从对象外框外 GAP 处起、再向外 LENGTH：于是它贴着对象长，不随对象大小飘
  const axes: GizmoAxisScreen[] = (["move-x", "move-y"] as const).map((handle) => {
    const outer =
      handle === "move-x" ? bounds.halfWidth + GIZMO_AXIS_GAP : bounds.halfHeight + GIZMO_AXIS_GAP;
    const tip = moveTipOf(handle, center, outer + GIZMO_AXIS_LENGTH);
    return { handle, root: moveRootOf(handle, center, outer), tip };
  });

  return {
    center,
    bounds,
    corners,
    axes,
    // 环要包住整个对象：半径取「最远那个角 + 一段间距」，所以旋转手柄永远在对象外面
    ringRadius: Math.hypot(bounds.halfWidth, bounds.halfHeight) + GIZMO_RING_GAP,
    scale: scaleHandlePoints(rect, rotation).map((entry) => ({
      handle: entry.handle,
      point: worldToScreen(viewport, entry.world),
    })),
    drawable: isDrawableFrame(rect, viewport),
  };
}

/** 点到线段的最短距离（命中轴条用）。 */
function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - from.x, point.y - from.y);
  }

  // 投影参数夹到 [0,1]：落在线段外就算到端点的距离
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy));
}

function isInside(point: Point, target: Point, half: number): boolean {
  return Math.abs(point.x - target.x) <= half && Math.abs(point.y - target.y) <= half;
}

/**
 * 屏幕点落在哪个手柄上；没命中返回 `undefined`。
 *
 * **顺序即优先级**（和 Unity 的直觉一致：小目标优先）：
 * 1. 八个缩放手柄（角在边前面，因为角比边更「尖」，重叠时用户想抓的是角）；
 * 2. 旋转环（比轴条窄，先判它，免得环与轴的边界处判错）；
 * 3. 两根移动轴条。
 *
 * `tool` 决定哪些手柄**可交互**：不在当前工具里的手柄画着但点不到——这与「画出来就能点」
 * 不同，是有意的：旋转模式下缩放柄只是位置参照。
 */
export function hitTestGizmoHandles(
  point: Point,
  tool: TransformTool,
  geometry: GizmoScreenHandles,
): GizmoHandle | undefined {
  // 没选工具（拖动模式）时不给任何手柄命中：那个模式下对象本体的拖动就是「跟手移动」，
  // 抢过来只会让人以为「拖不动了」
  if (tool === "none" || !geometry.drawable) {
    return undefined;
  }

  if (tool === "scale") {
    for (const entry of geometry.scale) {
      if (isInside(point, entry.point, GIZMO_HANDLE_HIT_SIZE)) {
        return entry.handle;
      }
    }

    return undefined;
  }

  if (tool === "rotate") {
    const distance = Math.hypot(point.x - geometry.center.x, point.y - geometry.center.y);
    return Math.abs(distance - geometry.ringRadius) <= GIZMO_RING_HIT_WIDTH ? "rotate" : undefined;
  }

  // 移动：先判轴末端那一段（最容易点中的目标），再判整根轴条
  for (const axis of geometry.axes) {
    if (isInside(point, axis.tip, GIZMO_HANDLE_HIT_SIZE)) {
      return axis.handle;
    }
  }

  for (const axis of geometry.axes) {
    if (distanceToSegment(point, axis.root, axis.tip) <= GIZMO_AXIS_HIT_WIDTH) {
      return axis.handle;
    }
  }

  return undefined;
}

/**
 * 某一根移动轴的末端（屏幕坐标）：X 向右、Y 向上——与世界坐标同向。
 *
 * `distance` 是从**对象中心**往外量的屏幕像素距离；调用方按对象外框算好再传进来
 * （见 `gizmoScreenGeometry`），所以手柄永远贴着对象。
 */
export function moveTipOf(handle: "move-x" | "move-y", center: Point, distance: number): Point {
  return handle === "move-x"
    ? { x: center.x + distance, y: center.y }
    : { x: center.x, y: center.y - distance };
}

/** 某一根移动轴的根部（屏幕坐标）：从对象外框外起画，不会压在对象身上。 */
export function moveRootOf(handle: "move-x" | "move-y", center: Point, distance: number): Point {
  return handle === "move-x"
    ? { x: center.x + distance, y: center.y }
    : { x: center.x, y: center.y - distance };
}
