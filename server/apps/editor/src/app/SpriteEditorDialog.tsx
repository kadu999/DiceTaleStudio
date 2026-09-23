import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { SPRITE_SHEET_MAX, normalizeSpriteSheet, spriteCellSizeOf } from "@dts/document";
import { useEditorStore } from "../state/editor-store";
import { assetRawUrl } from "../panels/asset-picker";

interface SpriteEditorDialogProps {
  readonly open: boolean;
  readonly imageId: string;
  readonly imageSize?: { readonly width: number; readonly height: number };
  readonly onClose: () => void;
}

/** 独立的精灵编辑器：草稿只在弹窗内变化，应用时才写入工程文件。 */
export function SpriteEditorDialog({
  open,
  imageId,
  imageSize,
  onClose,
}: SpriteEditorDialogProps): React.JSX.Element {
  const stored = useEditorStore((state) => state.assetMetas.byId[imageId]?.sprite?.sheet);
  const setSpriteSheet = useEditorStore((state) => state.setSpriteSheet);
  const [columns, setColumns] = useState("1");
  const [rows, setRows] = useState("1");
  const [zoom, setZoom] = useState("100");
  const [selectedCell, setSelectedCell] = useState<{ column: number; row: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const sheet = normalizeSpriteSheet(stored ?? { columns: 1, rows: 1 });
    setColumns(String(sheet.columns));
    setRows(String(sheet.rows));
    setSelectedCell(null);
  }, [imageId, open, stored?.columns, stored?.rows]);

  const parsed = useMemo(
    () => normalizeSpriteSheet({ columns: Number(columns), rows: Number(rows) }),
    [columns, rows],
  );
  const aspectRatio = imageSize === undefined ? "4 / 3" : `${imageSize.width} / ${imageSize.height}`;
  const cellSize = imageSize === undefined ? undefined : spriteCellSizeOf(parsed, imageSize);
  const scale = Math.min(400, Math.max(10, Number(zoom) || 100)) / 100;

  const fitImage = (): void => {
    const viewport = viewportRef.current;
    if (viewport === null || imageSize === undefined) {
      return;
    }

    const bounds = viewport.getBoundingClientRect();
    const availableWidth = Math.max(0, bounds.width - 72);
    const availableHeight = Math.max(0, bounds.height - 72);
    const fitPercent = Math.floor(
      Math.min(availableWidth / imageSize.width, availableHeight / imageSize.height) * 100,
    );
    setZoom(String(Math.min(400, Math.max(10, fitPercent))));
  };

  useEffect(() => {
    if (!open || imageSize === undefined) {
      return;
    }

    const frame = requestAnimationFrame(fitImage);
    return () => cancelAnimationFrame(frame);
  }, [open, imageId, imageSize?.width, imageSize?.height]);

  const apply = (): void => {
    setSpriteSheet(imageId, parsed.columns === 1 && parsed.rows === 1 ? null : parsed);
    onClose();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/70" />
        <Dialog.Content
          data-testid="sprite-editor-dialog"
          className="fixed left-1/2 top-1/2 z-[80] flex h-[min(860px,94vh)] w-[min(1320px,96vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] shadow-2xl"
        >
          <div className="flex flex-none items-center justify-between border-b border-[var(--color-editor-border)] px-3 py-2">
            <Dialog.Title className="text-[13px] font-semibold">精灵编辑器</Dialog.Title>
            <div className="text-[10px] text-[var(--color-editor-text-dim)]">
              {parsed.columns} × {parsed.rows}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <div ref={viewportRef} data-testid="sprite-editor-viewport" className="relative min-h-0 flex-1 overflow-auto bg-[#111318] p-5">
              <div className="flex min-h-full min-w-full items-center justify-center">
                <div
                  data-testid="sprite-editor-stage"
                  className="relative shrink-0 overflow-hidden border border-[var(--color-editor-border)] bg-[linear-gradient(45deg,#252a31_25%,transparent_25%),linear-gradient(-45deg,#252a31_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#252a31_75%),linear-gradient(-45deg,transparent_75%,#252a31_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0px] shadow-xl"
                  style={{
                    width: imageSize === undefined ? "min(760px, 90%)" : `${imageSize.width * scale}px`,
                    aspectRatio,
                  }}
                >
                  <img
                    src={assetRawUrl(imageId)}
                    alt=""
                    draggable={false}
                    className="pointer-events-none absolute inset-0 h-full w-full object-fill"
                  />
                  <div className="absolute inset-0" style={{ display: "grid", gridTemplateColumns: `repeat(${parsed.columns}, 1fr)`, gridTemplateRows: `repeat(${parsed.rows}, 1fr)` }}>
                    {Array.from({ length: parsed.columns * parsed.rows }, (_, index) => {
                      const column = index % parsed.columns;
                      const row = Math.floor(index / parsed.columns);
                      const selected = selectedCell?.column === column && selectedCell.row === row;
                      return (
                        <button
                          key={`${column}-${row}`}
                          type="button"
                          data-testid="sprite-editor-cell"
                          data-cell={`${column},${row}`}
                          aria-label={`第 ${row + 1} 行，第 ${column + 1} 列`}
                          className={`min-h-0 min-w-0 border border-white/30 ${selected ? "bg-[var(--color-editor-accent)]/35 ring-2 ring-inset ring-[var(--color-editor-accent)]" : "hover:bg-white/10"}`}
                          onClick={() => setSelectedCell({ column, row })}
                        >
                          <span className="pointer-events-none text-[10px] text-white/80 drop-shadow">{index + 1}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            <aside className="w-full flex-none border-t border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] p-3 md:w-64 md:border-l md:border-t-0">
              <div className="mb-3 text-[11px] font-semibold">切片设置</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[10px] text-[var(--color-editor-text-dim)]">
                  列
                  <input
                    data-testid="sprite-editor-columns"
                    type="number"
                    min="1"
                    max={SPRITE_SHEET_MAX}
                    value={columns}
                    onChange={(event) => setColumns(event.target.value)}
                    className="mt-1 w-full rounded border border-[var(--color-editor-border)] bg-black/30 px-2 py-1 font-mono text-[12px] text-[var(--color-editor-text)] outline-none focus:border-[var(--color-editor-accent)]"
                  />
                </label>
                <label className="text-[10px] text-[var(--color-editor-text-dim)]">
                  行
                  <input
                    data-testid="sprite-editor-rows"
                    type="number"
                    min="1"
                    max={SPRITE_SHEET_MAX}
                    value={rows}
                    onChange={(event) => setRows(event.target.value)}
                    className="mt-1 w-full rounded border border-[var(--color-editor-border)] bg-black/30 px-2 py-1 font-mono text-[12px] text-[var(--color-editor-text)] outline-none focus:border-[var(--color-editor-accent)]"
                  />
                </label>
              </div>
              <div className="mt-4 flex items-center justify-between gap-2">
                <label className="min-w-0 flex-1 text-[10px] text-[var(--color-editor-text-dim)]">
                  缩放 {Math.round(scale * 100)}%
                  <input
                    data-testid="sprite-editor-zoom"
                    type="range"
                    min="10"
                    max="400"
                    step="1"
                    value={zoom}
                    onChange={(event) => setZoom(event.target.value)}
                    className="mt-2 w-full accent-[var(--color-editor-accent)]"
                  />
                </label>
                <button
                  type="button"
                  data-testid="sprite-editor-fit"
                  disabled={imageSize === undefined}
                  title={imageSize === undefined ? "图片尺寸读取后可自适应显示" : "缩放至完整显示图片，并保留边缘空白"}
                  className="toolbar-button mt-3 flex-none hover:toolbar-button-hover disabled:opacity-40"
                  onClick={fitImage}
                >
                  自适应
                </button>
              </div>
              {imageSize === undefined ? null : (
                <div className="mt-5 border-t border-[var(--color-editor-border)] pt-3 text-[10px] leading-4 text-[var(--color-editor-text-dim)]">
                  {imageSize.width} × {imageSize.height}
                  {cellSize === undefined ? null : ` · ${cellSize.width} × ${cellSize.height}`}
                </div>
              )}
              {selectedCell === null ? null : (
                <div className="mt-3 text-[10px] text-[var(--color-editor-text-dim)]">
                  第 {selectedCell.row + 1} 行，第 {selectedCell.column + 1} 列
                </div>
              )}
            </aside>
          </div>

          <div className="flex flex-none items-center justify-end border-t border-[var(--color-editor-border)] px-3 py-2">
            <div className="flex items-center gap-2">
              <button type="button" data-testid="sprite-editor-cancel" className="toolbar-button hover:toolbar-button-hover" onClick={onClose}>
                取消
              </button>
              <button type="button" data-testid="sprite-editor-apply" className="rounded bg-[var(--color-editor-accent)] px-3 py-1 text-[12px] text-black" onClick={apply}>
                应用
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
