import {
  ALL_MASK,
  cellMaskCss,
  decodeRle,
  defaultCellMaskStyle,
  hasMask,
  visibleMaskBits,
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
 * 战争雾预览图层：把「含任意已指定雾区位的格子」按**区域颜色**盖一层。
 *
 * 配色与「网格标注」共用同一份偏好（`colors`），只是**只画已指定的雾区位**——
 * 别的区域位不是这一层的事。运行时那边雾是统一的黑色/雾色（`FogOfWar` 的 `fogColor`），
 * 但那是前端的呈现，编辑器里按区域颜色显示才看得出哪块是哪区。
 *
 * 复用 `SceneLayer`（无贴图、只有格子着色）而不是给渲染器加概念：与画笔预览同一个套路。
 * 没有指定雾区、或一个雾格都没有时返回 `undefined`（调用方直接不追加这一层）。
 */
export function fogPreviewLayer(
  rect: WorldRect,
  grid: GridSize,
  cells: Uint8Array,
  fogMask: number,
  colors: Readonly<Record<number, string>>,
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
    // 藏掉所有**没指定**的区域位：只留雾区那一层，各按自己的颜色画
    cellColors: (mask) => cellColorsOf(mask, ALL_MASK & ~fogMask, colors),
  };
}
