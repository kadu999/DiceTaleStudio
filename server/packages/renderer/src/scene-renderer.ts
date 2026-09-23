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
import { GIZMO_HANDLE_SIZE, toolHasGizmo, type GizmoHandle, type TransformTool } from "./gizmo";

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
  /**
   * **只画图片里的这一块**（**图片像素**，左上角原点、y 向下，与 canvas `drawImage` 同向）。
   *
   * 有它 = 这个对象显示的是图集里的一个**子图**（v20 的精灵）：源矩形由调用方按
   * 「切分 + 加载到的图片尺寸」算好（`@dts/document` 的 `spritePixelRectOf`）；
   * 没有 = 铺满整张（老样子）。
   *
   * **它只影响「贴哪里」**：对象占的世界矩形（裁剪、命中测试、选中框、变换手柄）仍按
   * `displayRectOf` 算——「看到的框」与「点得到的范围」因此照旧是同一块。
   */
  readonly sprite?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** 这张图片占据的世界矩形（贴图铺满它，网格锚在它上面）。 */
  readonly rect: WorldRect;
  /**
   * 绕**矩形中心**的旋转（弧度，与文档的 `GameObject.rotation` 同一套）。
   *
   * 贴图、格子、网格线、选中框**一起转**——它们本来就画在同一块矩形上，
   * 而拾取走 `hitTestRect(point, rect, rotation)`，所以「看到的框」与「点得到的范围」
   * 仍然完全一致。省略 = 不转。
   */
  readonly rotation?: number;
  readonly grid?: GridSize;
  /** 行主序 `y*width+x`，y=0 为图片最下面一行（= 世界 y 最小的一行）。 */
  readonly cells?: Uint8Array;
  /**
   * 掩码 → 这一格要画的颜色，**按顺序依次叠加绘制**（先画的在下面）。
   *
   * 之所以是一串颜色而不是一个：一个格子可以同时是多种类型（区域1 + 区域4），
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
  /**
   * 对象被**锁住**（拖不动）：选中框画成灰色。
   *
   * 画布上「为什么拖不动」总得有个说法——锁不改对象长什么样，换个框的颜色就能一眼看出来。
   */
  readonly locked?: boolean;
  /**
   * **没有贴图时**在矩形里画的**内置图标**（有贴图就画贴图，不画图标）。
   *
   * 现在只有一种：`"audio"` = 声音对象（动作对象）的喇叭徽标——它和别的对象一样摆在
   * 世界里，刚建出来还没有图，画一个徽标才能「看得见、点得到、拖得动」。
   */
  readonly icon?: "audio" | "teleport";
  /**
   * 这个声音对象**现在正在播**（只对 `icon: "audio"` 有意义）：徽标会画成「活的」——
   * 一圈圈往外扩的声波 + 随节拍一胀一缩的喇叭，配合 `animationTimeMs` 出动画。
   *
   * 为什么要动：编辑器自己不出声，「有个音频正在播」在画布上只能靠**看得见的变化**表达；
   * 静态画面里谁也分不出这个图标是在响还是待命。
   */
  readonly playing?: boolean;
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
  /**
   * 动画用的当前时刻（毫秒，一般给 `performance.now()`）；缺省 `0` = 静止的第一帧。
   *
   * 只有**正在播**的声音徽标会用它（见 `SceneLayer.playing`）：编辑器本来就每帧重绘，
   * 所以只要把时刻传进来，图标就动起来了——不需要另起定时器。
   */
  readonly animationTimeMs?: number;
  /**
   * 变换手柄（移动轴 / 旋转环 / 缩放块）。
   *
   * **几何由调用方算好**（见 `gizmoScreenGeometry`），渲染器只负责画：
   * 于是「画出来的手柄」与「点得到的手柄」永远共用同一份坐标，不可能对不上。
   * 缺省 = 不画（不开手柄时与以前完全一样）。
   */
  readonly tools?: SceneToolHandles;
}

/**
 * 变换手柄的屏幕几何（全部是 canvas 的 CSS 像素坐标）。
 *
 * 与 `GizmoScreenHandles` 同形但不直接引用它：渲染器只认「一串点和半径」，
 * 不需要知道它们是怎么从世界坐标算出来的。
 */
export interface SceneToolHandles {
  readonly tool: TransformTool;
  readonly center: Point;
  readonly corners: readonly Point[];
  /** 两根移动轴（移动工具画）。 */
  readonly axes: readonly { readonly handle: "move-x" | "move-y"; readonly root: Point; readonly tip: Point }[];
  readonly scale: readonly { readonly handle: GizmoHandle; readonly point: Point }[];
  readonly ringRadius: number;
  /** 对象被锁住：手柄画成灰的（「看得见但拖不动」，与灰色选中框同一套说法）。 */
  readonly locked: boolean;
  /** 对象在屏幕上太小：只画框不画手柄（手柄会比对象本身还大）。 */
  readonly drawable: boolean;
  /**
   * **正在拖的那个手柄**：画成强调色并放大——「按下去了」必须有看得见的反馈，
   * 否则抓住环之后整块手柄纹丝不动，用户不知道到底抓上了没有。
   */
  readonly activeHandle?: GizmoHandle | null;
  /** **光标悬停的那个手柄**：淡高亮，作为「这里能点」的提示。 */
  readonly hoveredHandle?: GizmoHandle | null;
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

/** 对象类型色（弹框里那个小圆点、以及声音对象那枚内置图标都用它）。 */
const KIND_MARKER_COLORS: Record<string, string> = {
  // 精灵（v22 前叫 `GameObject`：那时它复用泛用的场景对象名）
  Sprite: "#4f9cf9",
  // 贴图对象（v21，v22 前叫 `Texture`）：与精灵分开——两者都显示一张图，但精灵会取图集里的一格。
  // 用一个偏青的粉紫，和上面五个都分得开（弹框里两个瓦片一眼看得出不是一个东西）
  Image: "#c084fc",
  Player: "#3fbf6f",
  Item: "#e0a13c",
  Event: "#b06ef0",
  // 动作对象（播放声音）：画布上的内置音频图标也用它（见 drawAudioBadge）。
  // 用**暖橙**是有意的：地图底图多是草地 / 水面 / 石头（绿蓝灰一片），暖色在那种底上跳得出来
  PlaySound: "#ff7a1a",
  // 动作对象（传送阵）：内置传送徽标用它。青色与上面五个都分得开
  Teleport: "#22c7d6",
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
        drawLayer(context, layer, viewport, visible, view, input.animationTimeMs ?? 0);
      }

      // 选中框画在**所有图层之后**：被别的图片盖住的对象也要看得见自己的框。
      // 框同样要绕矩形中心旋转——否则「转过的对象」配上「正着的框」，看着就错位了。
      //
      // **开了变换工具就只留虚线框、不画那 8 个装饰方块**（`toolHasGizmo`）：
      // 它们和缩放手柄长得一模一样（同一个 `drawHandleSquare`，同尺寸同配色），
      // 一起画出来会让人以为「移动模式下也出现了缩放的 UI」。
      // 选中框只要有框就够说明「选中的是它」，手柄交给当前工具那一套。
      const activeTool = input.tools !== undefined && toolHasGizmo(input.tools.tool);
      for (const layer of input.layers ?? []) {
        if (layer.selected === true) {
          drawRotatedSelectionFrame(context, layer, viewport, !activeTool);
        }
      }

      // 变换手柄画在最后：它是**操作目标**，必须压在所有东西（含选中框）上面
      if (input.tools !== undefined) {
        drawGizmo(context, input.tools);
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
  visible: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
  view: ImageSize,
  animationTimeMs: number,
): void {
  const rotation = layer.rotation ?? 0;
  const box = screenBoxOf(layer.rect, viewport);
  // 早退要用**旋转后**的外接框：`box` 是矩形自己那块框，转过角度后它的角会伸到框外，
  // 按 `box` 判断会把「框已经在屏幕外、但转过来的那个角还在屏幕里」的对象整块漏掉
  const cull = rotation === 0 ? box : rotateScreenBox(box, rotation);
  if (cull.right < 0 || cull.bottom < 0 || cull.left > view.width || cull.top > view.height) {
    return;
  }

  // 旋转：绕矩形中心转，**在裁剪之前**做——裁剪框跟着一起转，
  // 于是贴图 / 格子 / 网格线 / 选中框全在这块转过的矩形里，和拾取用的那块完全一致
  if (rotation !== 0) {
    context.save();
    context.translate((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    context.rotate(rotation);
    context.translate(-(box.left + box.right) / 2, -(box.top + box.bottom) / 2);
  }

  // 内置徽标（动作对象）**不裁剪**：正在播时那几圈声波要扩到矩形外面去，裁剪会把它切掉；
  // 这块矩形里本来也没有别的东西（徽标与贴图互斥），所以挪到裁剪之外画不影响别人
  const badgeOnly = layer.image == null && layer.icon !== undefined;

  if (!badgeOnly) {
    context.save();
    context.beginPath();
    context.rect(box.left, box.top, box.right - box.left, box.bottom - box.top);
    context.clip();
  }

  if (layer.image != null) {
    context.imageSmoothingEnabled = viewport.scale < 4;
    // 九个参数的 drawImage = 从图片里**取一块**再铺到对象矩形上（子图）；没有源矩形时
    // 走五个参数那条（整张铺满）——两条路的落点都是同一个 `box`
    if (layer.sprite !== undefined) {
      context.drawImage(
        layer.image,
        layer.sprite.x,
        layer.sprite.y,
        layer.sprite.width,
        layer.sprite.height,
        box.left,
        box.top,
        box.right - box.left,
        box.bottom - box.top,
      );
    } else {
      context.drawImage(layer.image, box.left, box.top, box.right - box.left, box.bottom - box.top);
    }
  }

  if (layer.grid !== undefined) {
    if (layer.cells !== undefined && layer.cellColors !== undefined) {
      drawCells(context, layer, viewport, visible);
    }

    if (layer.showGrid === true) {
      drawGridLines(context, layer, viewport, visible, view);
    }
  }

  if (!badgeOnly) {
    context.restore();
  } else if (layer.icon === "teleport") {
    drawTeleportBadge(context, box);
  } else {
    drawAudioBadge(context, box, { playing: layer.playing === true, timeMs: animationTimeMs });
  }

  // 收掉旋转那层 save（与上面 `rotation !== 0` 的 save 配对）
  if (rotation !== 0) {
    context.restore();
  }
}

/** 徽标画到这个屏幕尺寸以下就不画了（缩得极小时画出来只是几个像素的噪点）。 */
const MIN_AUDIO_BADGE_SIZE = 6;

/**
 * 「正在播」的动画：**一圈圈往外扩的声波**（毫秒一个周期）。
 *
 * 取 1200ms：比心跳慢一点，看上去像声音一圈圈送出去，而不是在闪。
 */
const AUDIO_PULSE_PERIOD_MS = 1200;

/** 同一个周期里**同时有几圈**声波在往外走（错开半个周期，看起来是连续的）。 */
const AUDIO_PULSE_RING_COUNT = 2;

/** 一圈往外扩的声波（半径与透明度都只由相位决定，方便单测）。 */
export interface AudioPulseRing {
  /** 半径 = 徽标半边长（`badge / 2`）的几倍。 */
  readonly radiusFactor: number;
  /** 描边的不透明度（越往外越淡）。 */
  readonly alpha: number;
}

export interface AudioBadgeAnimation {
  /** 正在播时才有：错开相位的一圈圈声波；不播时为空数组。 */
  readonly rings: readonly AudioPulseRing[];
  /** 喇叭自身声波的胀缩系数（不播时恒为 1）。 */
  readonly waveScale: number;
}

/**
 * `#rrggbb` → `rgba(r,g,b,a)`（半透明地画声波圈用）。
 *
 * 只认这一种输入：颜色都是本文件里的常量（`KIND_MARKER_COLORS`）。不做通用解析是为了
 * 不引一堆用不上的格式分支，也不用猜 `#abc` 这种缩写。
 */
function withAlpha(hex: string, alpha: number): string {
  const value = hex.startsWith("#") ? hex.slice(1) : hex;
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(3)})`;
}

/**
 * 声音徽标的动画参数（**纯函数**，只跟 `playing` 与时刻有关——所以能直接单测，不用真画布）。
 *
 * 两件事：
 * - **外圈声波**：两圈错开半个周期，从贴着牌面扩到牌面半边的 1.9 倍，边走边淡；
 * - **喇叭呼吸**：内部两道声波按周期 ±18% 胀缩，让图标本身也「在动」。
 */
export function audioBadgeAnimation(input: {
  readonly playing: boolean;
  readonly timeMs: number;
}): AudioBadgeAnimation {
  if (!input.playing) {
    return { rings: [], waveScale: 1 };
  }

  // 取模成 0..1 的相位；负时刻（时钟回拨）也能算出合法相位
  const period = AUDIO_PULSE_PERIOD_MS;
  const base = (((input.timeMs % period) + period) % period) / period;

  const rings: AudioPulseRing[] = [];
  for (let index = 0; index < AUDIO_PULSE_RING_COUNT; index += 1) {
    const phase = (base + index / AUDIO_PULSE_RING_COUNT) % 1;
    rings.push({
      // 1.05 起（刚好贴着牌面）→ 2 倍（扩到矩形外一圈，像声波送出去）
      radiusFactor: 1.05 + 0.95 * phase,
      // 一路淡下去（线性，单调；一头是刚出牌面最实，一头的半径到顶时淡到看不见）
      // 起始不透明度给得足一点：这圈声波是「正在播」的主要信号，压在小图标上本来就显小
      alpha: 0.75 * (1 - phase),
    });
  }

  return { rings, waveScale: 1 + 0.18 * Math.sin(base * Math.PI * 2) };
}

/**
 * 声音对象的**内置徽标**：一块圆角牌 + 一个白色喇叭，画在它那块矩形正中。
 *
 * 声音对象没有贴图（图标固定、不给换），所以这里要保证它在**任何底图上都看得清**，
 * 三条一起用：
 * - 牌面是**实色**（类型色），不是半透明——半透明压在花花绿绿的地图上会糊成一团；
 * - 牌外面先描一圈**深色**（亮底：雪地 / 白墙 / 浅色地图，靠它把图标「抠」出来）；
 * - 喇叭与声波是**白色**（深色底上最清楚）。
 *
 * 全部用路径画——**不占资产、也不依赖字体**（emoji / 字形在不同机器上大小不一，还会被
 * 字号顶得忽大忽小）。尺寸只由矩形决定，所以缩放对象时它跟着一起缩放。
 *
 * `playing`（这个声音对象正在播）时再画上动画：外面一圈圈扩出去的声波 + 喇叭呼吸
 * （参数见 `audioBadgeAnimation`）。**画布上「有个音频在响」只能靠看得见的变化表达**——
 * 编辑器自己不出声，静态图标谁也分不出它是在响还是待命。
 */
function drawAudioBadge(
  context: CanvasRenderingContext2D,
  box: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
  animation: { readonly playing: boolean; readonly timeMs: number },
): void {
  const boxSize = Math.min(box.right - box.left, box.bottom - box.top);
  if (boxSize < MIN_AUDIO_BADGE_SIZE) {
    return;
  }

  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  // 徽标占矩形的大半（剩下那点留白让「这块矩形」本身也看得出来——选中框画的正是它）
  const badge = boxSize * 0.72;
  const half = badge / 2;
  const left = cx - half;
  const top = cy - half;
  const radius = badge * 0.2;
  const color = kindMarkerColor("PlaySound");
  const motion = audioBadgeAnimation({ playing: animation.playing, timeMs: animation.timeMs });

  const outline = (): void => {
    context.beginPath();
    context.moveTo(left + radius, top);
    context.arcTo(left + badge, top, left + badge, top + badge, radius);
    context.arcTo(left + badge, top + badge, left, top + badge, radius);
    context.arcTo(left, top + badge, left, top, radius);
    context.arcTo(left, top, left + badge, top, radius);
    context.closePath();
  };

  context.save();

  // 0) 正在播：先铺外圈声波（画在牌面**下面**，被牌面盖住内半边，看着就像从喇叭里送出来的）
  for (const ring of motion.rings) {
    if (ring.alpha <= 0.01) {
      continue;
    }

    context.beginPath();
    context.arc(cx, cy, half * ring.radiusFactor, 0, Math.PI * 2);
    context.lineWidth = Math.max(2, badge * 0.09);
    context.strokeStyle = withAlpha(color, ring.alpha);
    context.stroke();
  }

  // 1) 深色外描边（一半在牌外、一半被牌面盖住 → 亮底上也有清晰边界）
  outline();
  context.lineWidth = Math.max(2, badge * 0.12);
  context.strokeStyle = "rgba(0,0,0,0.62)";
  context.stroke();

  // 2) 实色牌面（类型色）
  outline();
  context.fillStyle = color;
  context.fill();

  // 3) 喇叭：音箱（小方块）+ 号角（梯形）+ 右侧两道声波，统一白色
  const midY = cy;
  const unit = badge / 100;
  context.beginPath();
  context.rect(left + 22 * unit, midY - 11 * unit, 13 * unit, 22 * unit);
  context.moveTo(left + 35 * unit, midY - 11 * unit);
  context.lineTo(left + 56 * unit, midY - 25 * unit);
  context.lineTo(left + 56 * unit, midY + 25 * unit);
  context.lineTo(left + 35 * unit, midY + 11 * unit);
  context.closePath();
  context.fillStyle = "#ffffff";
  context.fill();

  context.strokeStyle = "#ffffff";
  context.lineWidth = Math.max(1.2, badge * 0.075);
  context.lineCap = "round";
  for (const [radiusFactor, spread] of [
    [0.16, 0.95],
    [0.29, 0.8],
  ] as const) {
    context.beginPath();
    // 正在播时这两道声波跟着「呼吸」，图标自己也在动
    context.arc(left + 56 * unit, midY, badge * radiusFactor * motion.waveScale, -spread, spread);
    context.stroke();
  }

  context.restore();
}

/**
 * 传送阵（动作对象）的**内置徽标**：一块圆角牌 + 一个白色「旋涡 + 箭头」。
 *
 * 与音频徽标同一套理由与画法：**全部用路径画**（不占资产、不依赖字体），牌面实色 + 深色
 * 外描边 + 白色图形，压在任何底图上都看得清；尺寸只由矩形决定，所以缩放对象时它跟着缩放。
 *
 * **不画动画**：传送阵是个记号，不是「正在发生的事」（对比音频徽标那圈声波——那是「正在播」
 * 的可见信号）。要动起来再说，编辑器画布本来就每帧重绘。
 */
function drawTeleportBadge(
  context: CanvasRenderingContext2D,
  box: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
): void {
  const boxSize = Math.min(box.right - box.left, box.bottom - box.top);
  if (boxSize < MIN_AUDIO_BADGE_SIZE) {
    return;
  }

  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const badge = boxSize * 0.72;
  const half = badge / 2;
  const left = cx - half;
  const top = cy - half;
  const radius = badge * 0.2;
  const color = kindMarkerColor("Teleport");

  const outline = (): void => {
    context.beginPath();
    context.moveTo(left + radius, top);
    context.arcTo(left + badge, top, left + badge, top + badge, radius);
    context.arcTo(left + badge, top + badge, left, top + badge, radius);
    context.arcTo(left, top + badge, left, top, radius);
    context.arcTo(left, top, left + badge, top, radius);
    context.closePath();
  };

  context.save();

  // 1) 深色外描边（一半在牌外、一半被牌面盖住 → 亮底上也有清晰边界）
  outline();
  context.lineWidth = Math.max(2, badge * 0.12);
  context.strokeStyle = "rgba(0,0,0,0.62)";
  context.stroke();

  // 2) 实色牌面（类型色）
  outline();
  context.fillStyle = color;
  context.fill();

  // 3) 旋涡：一圈外环 + 内圈两道错开的弧（开口朝同一侧 → 看着在转）
  context.strokeStyle = "#ffffff";
  context.lineCap = "round";
  context.lineWidth = Math.max(1.5, badge * 0.085);
  context.beginPath();
  context.arc(cx, cy, badge * 0.3, 0, Math.PI * 2);
  context.stroke();

  context.lineWidth = Math.max(1.2, badge * 0.07);
  for (const [radiusFactor, from, to] of [
    [0.19, 0.35, 1.25],
    [0.19, 1.75, 2.65],
  ] as const) {
    context.beginPath();
    context.arc(cx, cy, badge * radiusFactor, from * Math.PI, to * Math.PI);
    context.stroke();
  }

  // 4) 箭头：从环右外侧指出去（「传送到那边」），一根杆 + 一个实心三角
  context.strokeStyle = "#ffffff";
  context.lineWidth = Math.max(1.5, badge * 0.08);
  context.beginPath();
  context.moveTo(cx + badge * 0.2, cy);
  context.lineTo(cx + badge * 0.46, cy);
  context.stroke();

  context.beginPath();
  context.moveTo(cx + badge * 0.48, cy);
  context.lineTo(cx + badge * 0.32, cy - badge * 0.11);
  context.lineTo(cx + badge * 0.32, cy + badge * 0.11);
  context.closePath();
  context.fillStyle = "#ffffff";
  context.fill();

  context.restore();
}

/** 把视口整体挪一下，使底纹的锚点（世界坐标）落到世界原点上——底纹于是与地图对齐。 */function viewportForChecker(
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

/**
 * 把一个屏幕框按 `rotation` 绕**它自己的中心**转一下之后的外接框。
 *
 * 只用于「整块是不是在视口外」的早退判断：绘制仍然在原始框里做（canvas 自己转），
 * 所以这里宽一点没关系——**宁可多画一层，也不能把转过来露在屏幕里的角漏掉**。
 */
function rotateScreenBox(
  box: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
  rotation: number,
): { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } {
  const centerX = (box.left + box.right) / 2;
  const centerY = (box.top + box.bottom) / 2;
  const halfWidth = (box.right - box.left) / 2;
  const halfHeight = (box.bottom - box.top) / 2;
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  const width = halfWidth * cos + halfHeight * sin;
  const height = halfWidth * sin + halfHeight * cos;

  return {
    left: centerX - width,
    top: centerY - height,
    right: centerX + width,
    bottom: centerY + height,
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
/** 锁住的对象：框用灰的（「拖不动」的提示，见 `SceneLayer.locked`）。 */
const SELECTION_LOCKED_COLOR = "#8d95a3";
const SELECTION_HANDLE_SIZE = 7;
const SELECTION_DASH: readonly [number, number] = [4, 3];

/**
 * 选中框：矩形**四角 + 四边中点**共 8 个手柄，外加一圈虚线描边。
 *
 * 刻意**不画中心点**：中心点会被误读成「对象就长这个点」，而对象其实铺满整块矩形。
 * 手柄用实心方块 + 细描边（Unity 那套），在任何贴图上都看得清。
 * `locked` 为真时整框换成灰色：锁住的对象拖不动，画布上得看得出「为什么」。
 */
function drawRotatedSelectionFrame(
  context: CanvasRenderingContext2D,
  layer: SceneLayer,
  viewport: Viewport,
  showHandles = true,
): void {
  const rotation = layer.rotation ?? 0;
  if (rotation === 0) {
    drawSelectionFrame(context, layer.rect, viewport, layer.locked === true, showHandles);
    return;
  }

  const box = screenBoxOf(layer.rect, viewport);
  context.save();
  context.translate((box.left + box.right) / 2, (box.top + box.bottom) / 2);
  context.rotate(rotation);
  context.translate(-(box.left + box.right) / 2, -(box.top + box.bottom) / 2);
  drawSelectionFrame(context, layer.rect, viewport, layer.locked === true, showHandles);
  context.restore();
}

function drawSelectionFrame(
  context: CanvasRenderingContext2D,
  rect: WorldRect,
  viewport: Viewport,
  locked = false,
  /** 有变换工具在用时**不画装饰方块**，见下面那条注释。 */
  showHandles = true,
): void {
  const topLeft = worldToScreen(viewport, worldRectTopLeft(rect));
  const width = rect.size.width * viewport.scale;
  const height = rect.size.height * viewport.scale;
  const color = locked ? SELECTION_LOCKED_COLOR : SELECTION_COLOR;

  // 太小的矩形（缩得很远）只画框、不画手柄：手柄会比框还大，糊成一团
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
  context.strokeStyle = color;

  // 虚线描边容易被当成「对象的一部分」，但它能把带旋转的框也画得清清楚楚
  context.setLineDash([...SELECTION_DASH]);
  context.strokeRect(topLeft.x + 0.5, topLeft.y + 0.5, width - 1, height - 1);
  context.setLineDash([]);

  if (
    showHandles &&
    width >= SELECTION_HANDLE_SIZE * 2 &&
    height >= SELECTION_HANDLE_SIZE * 2
  ) {
    for (const handle of handles) {
      drawHandleSquare(context, handle, SELECTION_HANDLE_SIZE, color);
    }
  }

  context.restore();
}

/**
 * 一个实心手柄方块 + 细描边（Unity 那套画法：在任何贴图上都看得清）。
 *
 * 选中框与变换手柄共用它，于是「框上的装饰点」与「能拖的缩放柄」长得一模一样、
 * 大小也一样——用户看到的就是他能抓的。
 */
function drawHandleSquare(
  context: CanvasRenderingContext2D,
  center: Point,
  size: number,
  color: string,
): void {
  const half = size / 2;

  context.fillStyle = color;
  context.fillRect(Math.round(center.x - half), Math.round(center.y - half), size, size);
  context.strokeStyle = "rgba(0,0,0,0.6)";
  context.strokeRect(
    Math.round(center.x - half) + 0.5,
    Math.round(center.y - half) + 0.5,
    size - 1,
    size - 1,
  );
}

/** 手柄的线段宽度（屏幕像素）：轴条与旋转环。2px 起步，缩到很远也还看得见。 */
const GIZMO_LINE_WIDTH = 2;

/** 按下 / 悬停时的线宽（屏幕像素）：比常态粗一倍，一眼看得出「抓上了」。 */
const GIZMO_ACTIVE_LINE_WIDTH = 3.5;

/**
 * 按下时手柄放大的像素数：方块变 `GIZMO_HANDLE_SIZE + 3`。
 *
 * 放大而不是换形状，是为了让「我抓的是它」这件事不改变手柄的语义（还是那个方块）。
 */
const GIZMO_ACTIVE_HANDLE_GROWTH = 3;

/** 按下时的强调色（与编辑器的 `--color-editor-warn` 同色）：比常态蓝更「热」。 */
const GIZMO_ACTIVE_COLOR = "#e0a13c";

/** 悬停色：常态蓝的亮版本，只是「这里能点」的提示，不抢按下的强调色。 */
const GIZMO_HOVER_COLOR = "#93c5fd";

/** 移动轴末端箭头的大小（屏幕像素，半宽）。 */
const GIZMO_ARROW_HALF = 5;

/**
 * 变换手柄：**只按调用方给好的屏幕坐标画**，自己不做任何几何计算。
 *
 * 这一点是刻意的：手柄的命中测试在编辑器那边（`hitTestGizmoHandles`），
 * 两边只要共用同一份 `GizmoScreenHandles`，就不可能「画在一处、点的是另一处」。
 *
 * **只画当前工具有的那一套**（对齐 Unity：切工具 = 换手柄的样子）：
 *
 * - `move`：对象外框外两根轴条 + 末端箭头（X 向右、Y 向上，与世界坐标同向）；
 * - `rotate`：围绕整个对象的一圈细环；
 * - `scale`：外框八个方位的方形手柄（与选中框上的装饰点同一套画法）；
 * - `none`（拖动模式）：什么都不画——只留选中框，拖动对象本体就是跟手移动。
 *
 * **按下 / 悬停的那个手柄单独再画一遍**（强调色 + 放大）：手柄是唯一能改对象的入口，
 * 点下去没有任何变化会让人以为「没点上」。先画整块常态手柄，再盖一层高亮的，于是
 * 高亮一定在最上面、也不会因为绘制顺序而缺席。
 */
function drawGizmo(context: CanvasRenderingContext2D, tools: SceneToolHandles): void {
  if (!tools.drawable || tools.tool === "none") {
    return;
  }

  const color = tools.locked ? SELECTION_LOCKED_COLOR : SELECTION_COLOR;
  const active = tools.activeHandle ?? null;
  const hovered = tools.hoveredHandle ?? null;
  // 锁定的对象不给「按下」的强调色：它本来就点不中，画成黄的等于说「你抓住了」
  const activeColor = tools.locked ? SELECTION_LOCKED_COLOR : GIZMO_ACTIVE_COLOR;
  const hoverColor = tools.locked ? SELECTION_LOCKED_COLOR : GIZMO_HOVER_COLOR;
  const highlight = active ?? hovered;

  context.save();
  context.lineWidth = GIZMO_LINE_WIDTH;
  context.strokeStyle = color;
  context.fillStyle = color;

  if (tools.tool === "rotate") {
    context.beginPath();
    context.arc(tools.center.x, tools.center.y, tools.ringRadius, 0, Math.PI * 2);
    context.stroke();
  }

  if (tools.tool === "move") {
    for (const axis of tools.axes) {
      drawMoveAxis(context, axis, GIZMO_LINE_WIDTH, color, GIZMO_ARROW_HALF);
    }
  }

  if (tools.tool === "scale") {
    for (const entry of tools.scale) {
      drawHandleSquare(context, entry.point, GIZMO_HANDLE_SIZE, color);
    }
  }

  // 高亮：整块里只有「抓住 / 悬停的那一个」再画一遍，强调色 + 更粗 / 更大
  if (highlight !== null) {
    const highlightColor = active === null ? hoverColor : activeColor;
    const lineWidth = active === null ? GIZMO_LINE_WIDTH * 2 : GIZMO_ACTIVE_LINE_WIDTH;
    const handleSize =
      active === null
        ? GIZMO_HANDLE_SIZE + GIZMO_ACTIVE_HANDLE_GROWTH / 2
        : GIZMO_HANDLE_SIZE + GIZMO_ACTIVE_HANDLE_GROWTH;

    context.lineWidth = lineWidth;
    context.strokeStyle = highlightColor;
    context.fillStyle = highlightColor;

    if (tools.tool === "rotate" && highlight === "rotate") {
      context.beginPath();
      context.arc(tools.center.x, tools.center.y, tools.ringRadius, 0, Math.PI * 2);
      context.stroke();
    }

    if (tools.tool === "move") {
      for (const axis of tools.axes) {
        if (axis.handle === highlight) {
          drawMoveAxis(context, axis, lineWidth, highlightColor, GIZMO_ARROW_HALF);
        }
      }
    }

    if (tools.tool === "scale") {
      for (const entry of tools.scale) {
        if (entry.handle === highlight) {
          drawHandleSquare(context, entry.point, handleSize, highlightColor);
        }
      }
    }
  }

  context.restore();
}

/** 一根移动轴（线 + 末端三角箭头）。常态与高亮共用它，两边画法不会分叉。 */
function drawMoveAxis(
  context: CanvasRenderingContext2D,
  axis: { readonly handle: "move-x" | "move-y"; readonly root: Point; readonly tip: Point },
  lineWidth: number,
  color: string,
  arrowHalf: number,
): void {
  const previousWidth = context.lineWidth;
  context.lineWidth = lineWidth;
  context.strokeStyle = color;
  context.fillStyle = color;

  context.beginPath();
  context.moveTo(axis.root.x, axis.root.y);
  context.lineTo(axis.tip.x, axis.tip.y);
  context.stroke();

  // 箭头：一条以轴为对称轴的等腰三角形（X 轴水平、Y 轴竖直，所以两条分支很直白）
  context.beginPath();
  if (axis.handle === "move-x") {
    context.moveTo(axis.tip.x, axis.tip.y);
    context.lineTo(axis.tip.x - arrowHalf * 2, axis.tip.y - arrowHalf);
    context.lineTo(axis.tip.x - arrowHalf * 2, axis.tip.y + arrowHalf);
  } else {
    context.moveTo(axis.tip.x, axis.tip.y);
    context.lineTo(axis.tip.x - arrowHalf, axis.tip.y + arrowHalf * 2);
    context.lineTo(axis.tip.x + arrowHalf, axis.tip.y + arrowHalf * 2);
  }

  context.closePath();
  context.fill();

  context.lineWidth = previousWidth;
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
