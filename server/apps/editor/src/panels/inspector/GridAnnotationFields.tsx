import {
  ALL_MASK,
  CellMask,
  MAX_BRUSH_SIZE,
  MIN_BRUSH_SIZE,
  PAINTABLE_MASKS,
  brushEffectiveSize,
  hasMask,
  maskToLabel,
} from "@dts/grid";
import type { SceneObjectDoc } from "@dts/document";
import { useEditorStore } from "../../state/editor-store";
import { countCellsWithMask, decodeCellsCached } from "../scene/grid-paint";
import { FieldRow } from "./fields";

/**
 * 网格标注的**编辑区**：放进属性面板的「编辑」分组里（分组标题由外面给，这里只出行）。
 *
 * 对照 Unity 的 `GridMapEditorWindow` 右侧面板：
 * | Unity | 这里 |
 * |---|---|
 * | 网格大小 | 「基础」里的「网格」行（已可编辑） |
 * | 画笔大小 IntSlider(1..5) | 「画笔大小」滑杆 |
 * | 「橡皮擦 (0)」+ 8 行类型（显示开关 / 名字 / 颜色） | 「画笔类型」列表 |
 * | Save / Load `.bytes` | **没有**：格子存进场景文件，自动存 + 撤销栈即保存 |
 *
 * 几件事是刻意的：
 * - **显示开关只影响绘制**：关掉某类后它不画，但数据还在、画笔也照样能画它（同 Unity）；
 * - **颜色只能改 RGB**：透明度跟类型绑定（Unity 的 `ColorField` 也把 alpha 关掉了）；
 * - **进入 / 退出是一个显式开关**：避免「选中地图就开始乱画」。
 */
export function GridAnnotationFields({
  object,
}: {
  readonly object: SceneObjectDoc;
}): React.JSX.Element {
  const gridPaint = useEditorStore((state) => state.gridPaint);
  const enterGridPaint = useEditorStore((state) => state.enterGridPaint);
  const exitGridPaint = useEditorStore((state) => state.exitGridPaint);
  const openGridEditor = useEditorStore((state) => state.openGridEditor);
  const setGridBrush = useEditorStore((state) => state.setGridBrush);
  const setGridBrushSize = useEditorStore((state) => state.setGridBrushSize);
  const toggleGridTypeVisible = useEditorStore((state) => state.toggleGridTypeVisible);
  const setGridTypeColor = useEditorStore((state) => state.setGridTypeColor);
  const clearGrid = useEditorStore((state) => state.clearGrid);

  const map = object.map;
  if (map === undefined) {
    return <></>;
  }

  const editing = gridPaint.active && gridPaint.mapObjectId === object.id;

  if (!editing) {
    // 不能标注的两种情况都写出来：隐身的图与没落位的图在画布上根本点不到
    // （编辑窗口不看这两件事：它自带视口，不靠拾取）
    const blocked = !object.active
      ? "对象已隐藏：画布上标注要先激活它（编辑窗口不受影响）"
      : object.position === null
        ? "地图未放置：画布上标注要先给它一个世界坐标（编辑窗口不受影响）"
        : "画布上左键涂抹、中键平移；Esc 退出";

    return (
      <>
        <FieldRow label="网格标注">
          <button
            type="button"
            data-testid="grid-paint-enter"
            disabled={!object.active || object.position === null}
            className="toolbar-button flex-none hover:toolbar-button-hover disabled:opacity-40"
            onClick={() => enterGridPaint(object.id)}
          >
            开始标注
          </button>
          {/* 不想在画布上对准格子时走这条：贴图铺满窗口，落笔就是格子 */}
          <button
            type="button"
            data-testid="grid-editor-open"
            title="在贴图上按区域涂 / 擦（不用先进入标注模式，也不用在地图上对准格子）"
            className="toolbar-button min-w-0 flex-1 truncate hover:toolbar-button-hover"
            onClick={() => openGridEditor(object.id)}
          >
            打开编辑窗口…
          </button>
        </FieldRow>
        <div className="px-2 pb-1 text-[10px] text-[var(--color-editor-text-dim)]">{blocked}</div>
      </>
    );
  }

  const annotated = annotatedCellCount(object);

  return (
    <>
      <FieldRow label="画笔大小">
        <input
          type="range"
          data-testid="grid-brush-size"
          aria-label="画笔大小"
          min={MIN_BRUSH_SIZE}
          max={MAX_BRUSH_SIZE}
          step={1}
          value={gridPaint.brushSize}
          className="min-w-0 flex-1 accent-[var(--color-editor-accent)]"
          onChange={(event) => setGridBrushSize(Number(event.target.value))}
        />
        <span className="flex-none font-mono text-[11px]" data-testid="grid-brush-size-label">
          {gridPaint.brushSize}（{brushEffectiveSize(gridPaint.brushSize)}×
          {brushEffectiveSize(gridPaint.brushSize)} 格）
        </span>
      </FieldRow>

      <FieldRow label="已标注">
        <span className="min-w-0 flex-1 font-mono text-[11px]" data-testid="grid-annotated-count">
          {annotated} 格
        </span>
        <button
          type="button"
          data-testid="grid-clear"
          title="清空整张网格（可撤销）"
          className="toolbar-button flex-none hover:toolbar-button-hover disabled:opacity-40"
          disabled={annotated === 0}
          onClick={() => clearGrid(object.id)}
        >
          清空
        </button>
        <button
          type="button"
          data-testid="grid-paint-exit-panel"
          className="toolbar-button flex-none hover:toolbar-button-hover"
          onClick={() => exitGridPaint()}
        >
          退出标注
        </button>
      </FieldRow>

      {/* 画笔类型：子标题 + 9 行（橡皮擦 + 8 种类型）；子标题没有分隔线，用留白分组 */}
      <div className="px-2 pb-1 pt-2 text-[10px] text-[var(--color-editor-text-dim)]">
        画笔类型：点击名字选画笔；左边的开关只影响显示（数据不动）
      </div>

      {/* 橡皮擦：对齐 Unity 的「橡皮擦 (0)」——掩码 0 就是把整格清掉 */}
      <TypeRow
        bit={CellMask.Empty}
        label="橡皮擦"
        selected={gridPaint.mask === CellMask.Empty}
        visible
        color="#999999"
        showVisibleToggle={false}
        onSelect={() => setGridBrush(CellMask.Empty)}
      />

      {PAINTABLE_MASKS.map((bit) => (
        <TypeRow
          key={bit}
          bit={bit}
          label={maskToLabel(bit)}
          selected={gridPaint.mask === bit}
          visible={!hasMask(gridPaint.hiddenMask, bit)}
          color={gridPaint.colors[bit] ?? "#ffffff"}
          showVisibleToggle
          onSelect={() => setGridBrush(bit)}
          onToggleVisible={() => toggleGridTypeVisible(bit)}
          onColor={(hex) => setGridTypeColor(bit, hex)}
        />
      ))}
    </>
  );
}

interface TypeRowProps {
  readonly bit: number;
  readonly label: string;
  readonly selected: boolean;
  readonly visible: boolean;
  readonly color: string;
  readonly showVisibleToggle: boolean;
  readonly onSelect: () => void;
  readonly onToggleVisible?: () => void;
  readonly onColor?: (hex: string) => void;
}

/**
 * 类型行：显示开关 + 名字（点它选画笔）+ 颜色。
 *
 * 名字后带上掩码值（`区域1 (1)`），与 Unity 的 `Obstacle (1)` 同一个写法——
 * 掩码值是要和前端 / `.bytes` 对齐的那个数，而名字只是**按顺序的占位编号**：
 * 两个一起给才不会看错（只写「区域1」容易让人以为它的位值也是 1，其实是 1/2/4/8…）。
 *
 * **没有行分隔线**：9 行靠勾选框 / 色块自身的节奏分开，选中的那一行整行高亮；
 * 没有线以后 hover 也要看得见（否则不知道鼠标在哪一行）。
 */
function TypeRow({
  bit,
  label,
  selected,
  visible,
  color,
  showVisibleToggle,
  onSelect,
  onToggleVisible,
  onColor,
}: TypeRowProps): React.JSX.Element {
  return (
    <div
      data-testid={`grid-type-row-${bit}`}
      data-selected={selected}
      className={`flex items-center gap-1.5 px-2 py-1 hover:bg-[var(--color-editor-panel-alt)] ${
        selected ? "bg-[var(--color-editor-accent-dim)]" : ""
      }`}
    >
      {showVisibleToggle ? (
        <input
          type="checkbox"
          data-testid={`grid-type-visible-${bit}`}
          aria-label={`显示${label}`}
          title={visible ? `不再显示${label}（数据保留）` : `显示${label}`}
          checked={visible}
          className="h-3.5 w-3.5 flex-none accent-[var(--color-editor-accent)]"
          onChange={onToggleVisible}
        />
      ) : (
        // 撑出与开关同宽的位置，让「橡皮擦」与下面 8 行的名字对齐
        <span aria-hidden="true" className="h-3.5 w-3.5 flex-none" />
      )}

      <button
        type="button"
        data-testid={`grid-type-${bit}`}
        data-active={selected}
        aria-pressed={selected}
        className={`min-w-0 flex-1 truncate text-left text-[11px] ${
          visible ? "" : "text-[var(--color-editor-text-dim)]"
        } ${selected ? "font-semibold" : ""}`}
        onClick={onSelect}
      >
        {label} ({bit})
      </button>

      {onColor === undefined ? (
        // 橡皮擦没有颜色可调（它就是把整格清掉）；这里画一块灰底当占位，与色块对齐
        <span
          aria-hidden="true"
          className="h-5 w-8 flex-none rounded border border-[var(--color-editor-border)] bg-[#999999]"
        />
      ) : (
        <input
          type="color"
          data-testid={`grid-type-color-${bit}`}
          aria-label={`${label}颜色`}
          title={`${label}的颜色（透明度由类型决定）`}
          value={color}
          className="h-5 w-8 flex-none rounded border border-[var(--color-editor-border)] bg-transparent"
          onChange={(event) => onColor(event.target.value)}
        />
      )}
    </div>
  );
}

/**
 * 已标注的格子数：解码 RLE 后数非零格。
 *
 * 属性面板本来就随文档重渲染（涂抹也一样），几千格的解码可以忽略不计；
 * 解码走的是带缓存、坏数据返回空数组的那个入口，所以这里不必再兜错。
 */
function annotatedCellCount(object: SceneObjectDoc): number {
  const map = object.map;
  if (map === undefined) {
    return 0;
  }

  const cells = decodeCellsCached(map.cells.runs, map.grid.width * map.grid.height);
  return countCellsWithMask(cells, ALL_MASK);
}
