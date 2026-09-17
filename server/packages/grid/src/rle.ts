/**
 * 网格掩码的游程编码（RLE）。
 *
 * 地图文档里格子以 RLE 存储：可读、diff 友好，且 64x36 这类地图通常只有少量游程。
 * `.bytes` 是导出产物，不是编辑态。
 */

/** 单个游程：`[掩码, 连续格数]`。 */
export type RleRun = readonly [mask: number, count: number];

/** 编码为游程数组（行主序展开，跨行连续相同掩码会合并为一个游程）。 */
export function encodeRle(cells: Uint8Array): RleRun[] {
  const runs: RleRun[] = [];
  let currentMask = -1;
  let count = 0;

  for (const mask of cells) {
    if (mask === currentMask) {
      count += 1;
      continue;
    }

    if (count > 0 && currentMask >= 0) {
      runs.push([currentMask, count]);
    }

    currentMask = mask;
    count = 1;
  }

  if (count > 0 && currentMask >= 0) {
    runs.push([currentMask, count]);
  }

  return runs;
}

/**
 * 解码游程数组。
 * `expectedCount` 给定时校验展开后的总格数（不匹配即抛错，避免损坏的文档被静默接受）。
 */
export function decodeRle(runs: readonly RleRun[], expectedCount?: number): Uint8Array {
  let total = 0;
  for (const [, count] of runs) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`RLE 游程长度非法: ${count}`);
    }

    total += count;
  }

  if (expectedCount !== undefined && total !== expectedCount) {
    throw new Error(`RLE 展开格数 ${total} 与期望 ${expectedCount} 不匹配`);
  }

  const cells = new Uint8Array(total);
  let cursor = 0;
  for (const [mask, count] of runs) {
    cells.fill(mask, cursor, cursor + count);
    cursor += count;
  }

  return cells;
}
