/**
 * 格子类型位掩码。
 *
 * 数值与 Unity 端 `DiceTale.GridCellType` 严格一致（枚举值即掩码值，可直接 (int) 转换），
 * 以保证导出的 `.bytes` 与运行时 `GridMap.LoadData` 位精确兼容。
 * 一个格子可同时拥有多个位（例如 Obstacle | Fog1）。
 */
export const CellMask = {
  Empty: 0,
  Obstacle: 1,
  Difficult: 2,
  Water: 4,
  Fog1: 8,
  Fog2: 16,
  Fog3: 32,
  Fog4: 64,
  Fog5: 128,
} as const;

/** 可绘制的类型位（顺序与 Unity `GridMapEditorState.PaintableTypes` 一致）。 */
export const PAINTABLE_MASKS = [
  CellMask.Obstacle,
  CellMask.Difficult,
  CellMask.Water,
  CellMask.Fog1,
  CellMask.Fog2,
  CellMask.Fog3,
  CellMask.Fog4,
  CellMask.Fog5,
] as const;

/** 全部雾位（含任意雾位即为雾格子，可与障碍等位组合）。 */
export const FOG_MASK =
  CellMask.Fog1 | CellMask.Fog2 | CellMask.Fog3 | CellMask.Fog4 | CellMask.Fog5;

/** 全部已知位的并集，用于校验。 */
export const ALL_MASK = CellMask.Obstacle | CellMask.Difficult | CellMask.Water | FOG_MASK;

const MASK_LABELS: ReadonlyArray<readonly [number, string]> = [
  [CellMask.Obstacle, "障碍"],
  [CellMask.Difficult, "困难"],
  [CellMask.Water, "水"],
  [CellMask.Fog1, "雾1"],
  [CellMask.Fog2, "雾2"],
  [CellMask.Fog3, "雾3"],
  [CellMask.Fog4, "雾4"],
  [CellMask.Fog5, "雾5"],
];

/** 是否含指定位。 */
export function hasMask(mask: number, bit: number): boolean {
  return (mask & bit) !== 0;
}

/** 叠加位（按位或），并裁剪到已知位范围内。 */
export function addMask(mask: number, bit: number): number {
  return (mask | bit) & ALL_MASK;
}

/** 清除指定位。 */
export function removeMask(mask: number, bit: number): number {
  return mask & ~bit & ALL_MASK;
}

/** 是否为空格子。 */
export function isEmptyMask(mask: number): boolean {
  return mask === 0;
}

/** 是否含任意雾位。 */
export function isFogMask(mask: number): boolean {
  return (mask & FOG_MASK) !== 0;
}

/** 不可通行：含 Obstacle 位即不可通行（允许与其他位组合）。 */
export function isBlocked(mask: number): boolean {
  return hasMask(mask, CellMask.Obstacle);
}

/** 掩码的可读文本（用于 UI 与日志），例如 `Obstacle|Fog1`。 */
export function maskToLabel(mask: number): string {
  if (mask === 0) {
    return "空";
  }

  const parts = MASK_LABELS.filter(([bit]) => hasMask(mask, bit)).map(([, label]) => label);
  return parts.length > 0 ? parts.join("+") : `未知(${mask})`;
}

/** 校验掩码只含已知位（越界即视为损坏数据）。 */
export function isValidMask(mask: number): boolean {
  return Number.isInteger(mask) && mask >= 0 && (mask & ~ALL_MASK) === 0;
}
