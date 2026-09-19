import {
  brushCells,
  cellMaskCss,
  cellPixelSize,
  decodeRle,
  defaultCellMaskStyle,
  gridCornerToWorld,
  hasMask,
  visibleMaskBits,
  worldRectOf,
  type GridPoint,
  type GridSize,
  type RleRun,
  type WorldRect,
} from "@dts/grid";
import type { SceneLayer } from "@dts/renderer";

/**
 * 网格标注的**绘制侧**纯工具：把「文档里的 RLE + 编辑器偏好」翻译成渲染器要的颜色与图层。
 *
 * 放在场景面板旁边而不是 store 里，是因为这些函数只被绘制循环用；
 * 它们也不依赖 store（页面每秒跑 60 次，能少一层间接就少一层）。
 */

/**
 * 一格里要画的颜色（按绘制顺序），与 Unity 编辑窗口一致：逐位半透明叠加。
 *
 * 文档只存掩码位，颜色是**渲染时**按「偏好里的取色 + 类型自带的透明度」拼出来的——
 * 所以改颜色不会写文档（对齐 Unity：颜色属于编辑窗口的显示设置）。
 */
export function cellColorsOf(
  mask: number,
  hiddenMask: number,
  colors: Readonly<Record<number, string>>,
): readonly string[] {
  const bits = visibleMaskBits(mask, hiddenMask);
  if (bits.length === 0) {
    return [];
  }

  return bits.map((bit) => {
    const style = defaultCellMaskStyle(bit);
    return cellMaskCss(colors[bit] ?? style.hex, style.alpha);
  });
}

/**
 * RLE → 展开的格子数组，**按 `runs` 的引用缓存**。
 *
 * 绘制循环每一帧都要拿格子，而解码是 O(格数)；文档只会在真改动时换掉 `runs`
 * （immer 的结构共享 + 冻结），所以拿引用当键既能命中，也不会读到旧数据。
 * 数据坏了（展开格数与网格对不上）时返回空数组：网格线照画，格子不着色，绝不让绘制循环抛错。
 */
const decodedCells = new WeakMap<readonly RleRun[], Uint8Array>();

export function decodeCellsCached(runs: readonly RleRun[], count: number): Uint8Array {
  const cached = decodedCells.get(runs);
  if (cached !== undefined) {
    return cached;
  }

  let cells: Uint8Array;
  try {
    cells = decodeRle(runs, count);
  } catch {
    cells = new Uint8Array(0);
  }

  decodedCells.set(runs, cells);
  return cells;
}

/** 预览用的两种颜色：整片画笔覆盖，以及指针下那一格（亮一点，看得出落点）。 */
const PREVIEW_COVER = "rgba(255,255,255,0.22)";
const PREVIEW_CELL = "rgba(255,255,255,0.5)";

/** 预览图层里「指针下那一格」的掩码值（渲染器只把它当作一个普通掩码丢给颜色函数）。 */
const PREVIEW_CELL_MASK = 2;

/**
 * 画笔预览：把指针下这一格、以及整个画笔会覆盖到的范围画成半透明白色。
 *
 * 做法是**复用 `SceneLayer`**（一张只有格子着色、没有图、不画网格线的「图片」）：
 * 外框取被覆盖格子的最小外接矩形，小网格里逐格打上标记，于是格子边界与地图的网格**严丝合缝**
 * （坐标全走 `@dts/grid` 的同一套换算）——不需要给渲染器加任何新概念。
 *
 * 返回 `undefined` 表示没什么可画（画笔整片都在网格外）。
 */
export function brushPreviewLayer(
  grid: GridSize,
  rect: WorldRect,
  center: GridPoint,
  brushSize: number,
): SceneLayer | undefined {
  const cells = brushCells(center, grid, brushSize);
  if (cells.length === 0) {
    return undefined;
  }

  let minX = center.x;
  let maxX = center.x;
  let minY = center.y;
  let maxY = center.y;
  for (const cell of cells) {
    minX = Math.min(minX, cell.x);
    maxX = Math.max(maxX, cell.x);
    minY = Math.min(minY, cell.y);
    maxY = Math.max(maxY, cell.y);
  }

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const mask = new Uint8Array(width * height);
  for (const cell of cells) {
    const isCenter = cell.x === center.x && cell.y === center.y;
    mask[(cell.y - minY) * width + (cell.x - minX)] = isCenter ? PREVIEW_CELL_MASK : 1;
  }

  // 外接矩形：中心 = 左下角格子的角点 + 半个外框尺寸（与地图格子同一套锚点）
  const size = cellPixelSize(grid, rect.size);
  const corner = gridCornerToWorld({ x: minX, y: minY }, grid, rect);
  return {
    rect: worldRectOf(
      { x: corner.x + (width * size.x) / 2, y: corner.y + (height * size.y) / 2 },
      { width: width * size.x, height: height * size.y },
    ),
    grid: { width, height },
    cells: mask,
    cellColors: (value) => [value === PREVIEW_CELL_MASK ? PREVIEW_CELL : PREVIEW_COVER],
  };
}

/**
 * 含任意给定位的格子数（「已标注 / 已覆盖」共用）。
 *
 * 坏数据（展开格数与网格对不上）在回调那边返回空数组，所以这里自然是 0。
 */
export function countCellsWithMask(cells: Uint8Array, mask: number): number {
  if (mask === 0) {
    return 0;
  }

  let count = 0;
  for (const value of cells) {
    if (hasMask(value, mask)) {
      count += 1;
    }
  }

  return count;
}

/**
 * 战争雾预览的雾罩颜色：RGB 取自运行时 `FogOfWar` 的 `fogColor (0.85, 0.88, 0.92)`。
 *
 * **透明度是 0.85，不是运行时的 1**：运行时靠 GPU 羽化把边缘化开，编辑器这边没有模糊
 * （2D 渲染器只画硬边格子），照搬不透明会把底图完全盖住、反而看不出自己在改哪一格。
 * 这是**预览**：要看「玩家看到的最终样子」以运行时的模糊结果为准。
 */
const FOG_PREVIEW_CSS = "rgba(217,224,235,0.85)";

/**
 * 战争雾预览图层：把「含任意已指定雾区位的格子」盖一层雾罩。
 *
 * 与标注着色是**两张图层、两套说法**，这是刻意的：
 * - **画布上的雾罩**（这里）回答「玩家会看到什么」——所有雾区一视同仁，按运行时的样子盖一层；
 * - **Mask 窗口里的按区域配色**回答「哪一格属于哪个雾区」——那是编辑视图。
 *
 * 复用 `SceneLayer`（无贴图、只有格子着色）而不是给渲染器加概念：与画笔预览同一个套路。
 * 没有指定雾区、或一个雾格都没有时返回 `undefined`（调用方直接不追加这一层）。
 */
export function fogPreviewLayer(
  rect: WorldRect,
  grid: GridSize,
  cells: Uint8Array,
  fogMask: number,
): SceneLayer | undefined {
  if (fogMask === 0) {
    return undefined;
  }

  let covered = false;
  for (const mask of cells) {
    if (hasMask(mask, fogMask)) {
      covered = true;
      break;
    }
  }

  if (!covered) {
    return undefined;
  }

  return {
    rect,
    grid,
    cells,
    cellColors: (mask) => (hasMask(mask, fogMask) ? [FOG_PREVIEW_CSS] : []),
  };
}
