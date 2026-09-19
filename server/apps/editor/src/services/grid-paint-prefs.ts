import {
  ALL_MASK,
  CellMask,
  PAINTABLE_MASKS,
  clampBrushSize,
  defaultCellMaskColors,
  isHexColor,
} from "@dts/grid";

/**
 * 网格标注的**编辑器偏好**（浏览器本地）。
 *
 * 这里存的是「怎么看、怎么画」，不是「画了什么」：画笔类型 / 画笔大小 / 每个类型的显示开关与颜色，
 * 以及画布上**网格线**、**网格标注**与**战争雾预览**三个总开关（都是所有地图一起生效的纯显示项）。
 * 它们**不进文档**——对齐 Unity：那几项存在 `GridMapEditorWindow` 的序列化字段里
 * （每个编辑窗口自己记着），而地图数据（格子掩码）才进 `.bytes` / 场景文件。
 * 所以换个项目、甚至重开浏览器，显示方式与配色都还在。
 *
 * 读写一律吞掉异常：隐私模式 / 禁用站点存储时，记不住也不该让编辑器打不开（同 `session.ts`）。
 */

export interface GridPaintPrefs {
  /** 画笔类型位；`CellMask.Empty`(=0) 表示橡皮擦。 */
  readonly mask: number;
  readonly brushSize: number;
  /** 隐藏的类型位（只影响绘制）。 */
  readonly hiddenMask: number;
  /** 类型位 → `#rrggbb`（透明度跟类型绑定，不在这里存）。 */
  readonly colors: Readonly<Record<number, string>>;
  /** 画布上是否画网格线（所有地图；纯显示，不影响数据）。 */
  readonly showGridLines: boolean;
  /** 画布上是否给格子着色（所有地图；纯显示，不影响数据）。 */
  readonly showAnnotations: boolean;
  /**
   * 画布上是否按运行时的样子预览**战争雾**（所有地图；纯显示，不影响数据）。
   *
   * 默认 **false**：这是后来才加的预览，没开之前画布的样子与以前一致
   * （雾位本来就会按区域配色显示出来，只是不像运行时那样盖一层雾罩）。
   */
  readonly showFog: boolean;
}

const GRID_PAINT_KEY = "dts.editor.gridPaint";

/** 默认偏好：区域1 画笔、1 号画笔、全部显示、Unity 的默认配色；网格线与标注都画、战争雾预览关着。 */
export function defaultGridPaintPrefs(): GridPaintPrefs {
  return {
    // 与 Unity `GridMapEditorState.selectedType` 的初值一致
    mask: CellMask.Obstacle,
    brushSize: 1,
    hiddenMask: 0,
    colors: defaultCellMaskColors(),
    showGridLines: true,
    showAnnotations: true,
    showFog: false,
  };
}

/** 读偏好；没有记录、内容损坏或存储不可用时退回默认值（不抛错）。 */
export function readGridPaintPrefs(): GridPaintPrefs {
  try {
    const raw = window.localStorage.getItem(GRID_PAINT_KEY);
    if (raw === null || raw.length === 0) {
      return defaultGridPaintPrefs();
    }

    return parseGridPaintPrefs(JSON.parse(raw) as unknown);
  } catch {
    return defaultGridPaintPrefs();
  }
}

/** 记住这次的选择。 */
export function writeGridPaintPrefs(prefs: GridPaintPrefs): void {
  try {
    window.localStorage.setItem(GRID_PAINT_KEY, JSON.stringify(prefs));
  } catch {
    // 存储不可用：本次会话照常工作，只是下次回到默认值
  }
}

/**
 * 解析并**逐项规范化**存储里的内容。
 *
 * 存储是用户能改的（也能被旧版本写坏），所以每一项都自己兜底：只认可绘制的位、
 * 画笔夹到合法范围、颜色必须是 `#rrggbb`。宁可退回默认，也不要把脏值放进画笔状态。
 */
export function parseGridPaintPrefs(raw: unknown): GridPaintPrefs {
  const fallback = defaultGridPaintPrefs();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fallback;
  }

  const record = raw as Record<string, unknown>;
  const colors: Record<number, string> = {};
  const stored = typeof record.colors === "object" && record.colors !== null ? (record.colors as Record<string, unknown>) : {};

  for (const bit of PAINTABLE_MASKS) {
    const value = stored[bit];
    colors[bit] = typeof value === "string" && isHexColor(value) ? value : fallback.colors[bit] ?? "#ffffff";
  }

  const mask = record.mask;
  const brushSize = record.brushSize;
  const hiddenMask = record.hiddenMask;
  const isPaintable = (value: unknown): value is number =>
    typeof value === "number" && PAINTABLE_MASKS.some((bit) => bit === value);

  return {
    mask: mask === CellMask.Empty || isPaintable(mask) ? mask : fallback.mask,
    brushSize: typeof brushSize === "number" ? clampBrushSize(brushSize) : fallback.brushSize,
    hiddenMask:
      typeof hiddenMask === "number" && Number.isFinite(hiddenMask)
        ? hiddenMask & ALL_MASK
        : fallback.hiddenMask,
    colors,
    // 旧版本（还没这两个开关时）写下的记录里没有它们 → 默认「都显示」
    showGridLines: typeof record.showGridLines === "boolean" ? record.showGridLines : fallback.showGridLines,
    showAnnotations:
      typeof record.showAnnotations === "boolean" ? record.showAnnotations : fallback.showAnnotations,
    // 战争雾预览是更后来的：没有记录 → 默认关闭（画布保持原样）
    showFog: typeof record.showFog === "boolean" ? record.showFog : fallback.showFog,
  };
}
