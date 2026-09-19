import {
  ALL_MASK,
  CellMask,
  MAX_BRUSH_SIZE,
  MIN_BRUSH_SIZE,
  PAINTABLE_MASKS,
  brushEffectiveSize,
  maskToLabel,
} from "@dts/grid";
import { useEditorStore } from "../state/editor-store";
import { countCellsWithMask, decodeCellsCached } from "../panels/scene/grid-paint";
import { CellPaintDialog } from "./CellPaintDialog";

/**
 * 「网格编辑窗口」：在贴图上**按区域**涂 / 擦格子。
 *
 * 与画布上的标注模式是**同一份数据、同一套工具状态**（画笔类型 / 大小 / 配色都取
 * `gridPaint`，也就是那套浏览器本地偏好），区别只在你说的地方：
 * 不用进标注模式、不用在地图上对准格子——窗口把这张地图装满，落笔就落在格子上。
 *
 * 与「战争雾 Mask 窗口」共用 `CellPaintDialog`（画布 / 视口 / 指针那套机器），
 * 差别在工具条与橡皮语义：
 * - 画笔是**全部 8 个区域 + 橡皮擦**（雾窗口只列已绑定的雾区）；
 * - 橡皮**整格清零**（与画布标注、Unity 的「橡皮擦 (0)」一致）；雾窗口的橡皮只擦绑定位。
 *
 * 窗口是**编辑视图**：8 个区域一律着色（不受「每类的显示开关」影响——那两个开关管的是
 * 画布怎么显示）；每个区域的名字前是它的颜色，点一下颜色即可改（与调色板同一个偏好）。
 */
interface GridEditDialogProps {
  readonly open: boolean;
  /** 正在编辑的地图对象 id；null 表示窗口没打开 */
  readonly objectId: string | null;
  readonly onClose: () => void;
}

export function GridEditDialog({
  open,
  objectId,
  onClose,
}: GridEditDialogProps): React.JSX.Element {
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const gridPaint = useEditorStore((state) => state.gridPaint);
  const setGridBrush = useEditorStore((state) => state.setGridBrush);
  const setGridBrushSize = useEditorStore((state) => state.setGridBrushSize);
  const setGridTypeColor = useEditorStore((state) => state.setGridTypeColor);
  const paintGridStroke = useEditorStore((state) => state.paintGridStroke);
  const endGridStroke = useEditorStore((state) => state.endGridStroke);
  const clearGrid = useEditorStore((state) => state.clearGrid);

  // 目标对象现查一次：已标注格数看它（对象可能已经被删掉，共用外壳会给出提示）
  const map =
    objectId === null
      ? undefined
      : scenes
          .find((scene) => scene.name === activeSceneName)
          ?.objects.find((item) => item.id === objectId)?.map;

  const annotated =
    map === undefined
      ? 0
      : countCellsWithMask(
          decodeCellsCached(map.cells.runs, map.grid.width * map.grid.height),
          ALL_MASK,
        );

  return (
    <CellPaintDialog
      open={open}
      objectId={objectId}
      onClose={onClose}
      slug="grid-editor"
      title="网格编辑"
      // 编辑视图：8 个区域都着色（画布上那两个显示开关只管画布）
      visibleMask={ALL_MASK}
      clearDisabled={annotated === 0}
      hint="左键涂抹、拖动连成一片；橡皮整格清零（与画布标注同一条规矩）"
      onClear={() => objectId !== null && clearGrid(objectId)}
      onStroke={(from, to) => {
        if (objectId === null) {
          return;
        }

        // 画笔与大小在 store 里取：与画布标注共用同一套偏好，两边随时保持一致
        paintGridStroke(objectId, from, to);
      }}
      onStrokeEnd={endGridStroke}
      toolbar={
        <div className="mb-2 flex flex-none flex-wrap items-center gap-1.5 rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] px-2 py-1 text-[11px]">
          <span className="text-[var(--color-editor-text-dim)]">画笔</span>

          {/* 橡皮擦：对齐 Unity 的「橡皮擦 (0)」——掩码 0 就是把整格清掉 */}
          <button
            type="button"
            data-testid={`grid-editor-brush-${CellMask.Empty}`}
            data-active={gridPaint.mask === CellMask.Empty}
            aria-pressed={gridPaint.mask === CellMask.Empty}
            className={`rounded border px-1.5 py-0.5 ${
              gridPaint.mask === CellMask.Empty
                ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel)]"
            }`}
            onClick={() => setGridBrush(CellMask.Empty)}
          >
            橡皮擦
          </button>

          {PAINTABLE_MASKS.map((bit) => {
            const selected = gridPaint.mask === bit;
            return (
              <span key={bit} className="flex items-center gap-1">
                <input
                  type="color"
                  data-testid={`grid-editor-color-${bit}`}
                  aria-label={`${maskToLabel(bit)}颜色`}
                  title={`${maskToLabel(bit)}的颜色（透明度由类型决定）`}
                  value={gridPaint.colors[bit] ?? "#ffffff"}
                  className="h-5 w-6 flex-none rounded border border-[var(--color-editor-border)] bg-transparent"
                  onChange={(event) => setGridTypeColor(bit, event.target.value)}
                />
                <button
                  type="button"
                  data-testid={`grid-editor-brush-${bit}`}
                  data-active={selected}
                  aria-pressed={selected}
                  className={`rounded border px-1.5 py-0.5 ${
                    selected
                      ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                      : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel)]"
                  }`}
                  onClick={() => setGridBrush(bit)}
                >
                  {maskToLabel(bit)}
                </button>
              </span>
            );
          })}

          <span className="ml-auto flex items-center gap-1.5">
            <span className="text-[var(--color-editor-text-dim)]">大小</span>
            <input
              type="range"
              data-testid="grid-editor-brush-size"
              aria-label="画笔大小"
              min={MIN_BRUSH_SIZE}
              max={MAX_BRUSH_SIZE}
              step={1}
              value={gridPaint.brushSize}
              className="w-24 accent-[var(--color-editor-accent)]"
              onChange={(event) => setGridBrushSize(Number(event.target.value))}
            />
            <span className="font-mono" data-testid="grid-editor-brush-size-label">
              {gridPaint.brushSize}（{brushEffectiveSize(gridPaint.brushSize)}×
              {brushEffectiveSize(gridPaint.brushSize)} 格）
            </span>
          </span>
        </div>
      }
    />
  );
}
