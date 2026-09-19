import {
  cellMaskCss,
  decodeRle,
  defaultCellMaskStyle,
  hasMask,
  visibleMaskBits,
  type RleRun,
} from "@dts/grid";

/**
 * 网格标注的**绘制侧**纯工具：把「文档里的 RLE + 编辑器偏好」翻译成渲染器要的颜色与图层。
 *
 * 放在场景面板旁边而不是 store 里，是因为这些函数只被绘制循环用；
 * 它们也不依赖 store（页面每秒跑 60 次，能少一层间接就少一层）。
 *
 * **画布上只有「区域」这一套**：战争雾用的是同一份区域数据（`map.fog.regions` 只是
 * 「哪几个区域算雾」的绑定），所以这里**没有**「雾罩图层」这种东西——雾只在它自己的
 * Mask 窗口里画（见 `app/FogMaskDialog.tsx`）。
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
 * 含任意给定位的格子数（网格编辑窗口的「已标注」）。
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
