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

/**
 * 一个类型位的默认外观：`#rrggbb` + 固定透明度。
 *
 * 数值与 Unity `GridMapEditorState.GetDefaultColor` 严格一致（那里是 `Color(r, g, b, a)`）。
 * 分开存是因为两条约束不同：
 * - **RGB 可改**（面板上的取色器），
 * - **透明度不给改**（Unity 的 `ColorField` 把 showAlpha 关掉了），所以它跟类型绑定。
 */
export interface CellMaskStyle {
  readonly hex: string;
  readonly alpha: number;
}

const MASK_STYLES: ReadonlyArray<readonly [number, CellMaskStyle]> = [
  [CellMask.Obstacle, { hex: "#ff0000", alpha: 0.6 }],
  [CellMask.Difficult, { hex: "#ff8000", alpha: 0.6 }],
  [CellMask.Water, { hex: "#0080ff", alpha: 0.6 }],
  [CellMask.Fog1, { hex: "#d9d9d9", alpha: 0.55 }],
  [CellMask.Fog2, { hex: "#4dcce6", alpha: 0.6 }],
  [CellMask.Fog3, { hex: "#a666e6", alpha: 0.65 }],
  [CellMask.Fog4, { hex: "#ffa626", alpha: 0.7 }],
  [CellMask.Fog5, { hex: "#f24d4d", alpha: 0.75 }],
];

/** 未知位退回不透明白色（对齐 Unity `GetDefaultColor` 的 default 分支）。 */
const UNKNOWN_STYLE: CellMaskStyle = { hex: "#ffffff", alpha: 1 };

/** 取类型位的默认外观。 */
export function defaultCellMaskStyle(bit: number): CellMaskStyle {
  return MASK_STYLES.find(([value]) => value === bit)?.[1] ?? UNKNOWN_STYLE;
}

/** 全部类型位的默认颜色表（`bit → #rrggbb`），画笔面板的取色器初值。 */
export function defaultCellMaskColors(): Record<number, string> {
  const colors: Record<number, string> = {};
  for (const [bit, style] of MASK_STYLES) {
    colors[bit] = style.hex;
  }

  return colors;
}

/**
 * `#rrggbb` + 透明度 → canvas 认的 CSS 颜色。
 *
 * 颜色串只在这里拼一次：绘制端（`@dts/renderer`）拿到的就是最终颜色，
 * 它不需要知道「掩码那套东西还有透明度」。
 */
export function cellMaskCss(hex: string, alpha: number): string {
  const normalized = normalizeHex(hex);
  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  return `rgba(${red},${green},${blue},${alpha})`;
}

/** 是否为合法的 `#rrggbb`（取色器与偏好持久化都靠它挡脏数据）。 */
export function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function normalizeHex(hex: string): string {
  return isHexColor(hex) ? hex.toLowerCase() : UNKNOWN_STYLE.hex;
}

/**
 * 一个格子里**要画的类型位**，按绘制顺序排（先画的在前）。
 *
 * 与 Unity `GridMapEditorRenderer.DrawCells` 一致：遍历 `PaintableTypes` **从高位到低位**，
 * 于是低位最后画、**显示在最上层**；一个格子含多个位时各类型的半透明色逐层叠加。
 * `hiddenMask` 里的位被跳过——那是「显示开关」，只影响这一层绘制，不改变数据。
 */
export function visibleMaskBits(mask: number, hiddenMask = 0): number[] {
  const bits: number[] = [];
  for (let index = PAINTABLE_MASKS.length - 1; index >= 0; index -= 1) {
    const bit = PAINTABLE_MASKS[index];
    if (bit === undefined || !hasMask(mask, bit) || hasMask(hiddenMask, bit)) {
      continue;
    }

    bits.push(bit);
  }

  return bits;
}

/** 校验掩码只含已知位（越界即视为损坏数据）。 */
export function isValidMask(mask: number): boolean {
  return Number.isInteger(mask) && mask >= 0 && (mask & ~ALL_MASK) === 0;
}
