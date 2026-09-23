import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { spriteCellSizeOf, spriteSettingsOfMeta, spriteSheetOfMeta, type ImageRef, type ImageSpriteRef } from "@dts/document";
import { useEditorStore } from "../state/editor-store";
import { assetImageInfoUrl, assetRawUrl, assetThumbnailUrl, listImageAssets } from "../panels/asset-picker";
import { assetDisplayName } from "../panels/asset-info";

/**
 * 「选择贴图」弹框（对齐 Unity 的 Select Sprite / Object Picker 习惯）：
 * 列出**当前项目里的全部图片**，点一张即选中，确定后写回对象。
 *
 * 编辑器**不导入**素材（素材由外部提交到 `Assets/images/`），所以这里是「从已有图片里挑」，
 * 没有图片时明确提示该把素材放到哪。
 *
 * 精灵切片在素材属性中编辑；此弹窗可选择整张图片或已有的单格精灵。
 */
interface ImagePickerDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onPick: (image: ImageRef, sprite: ImageSpriteRef | null) => void;
  /** 当前已选中的图片逻辑 ID（高亮用）。 */
  readonly currentId?: string;
  readonly currentSprite?: ImageSpriteRef;
  readonly allowSprite: boolean;
}

export function ImagePickerDialog({
  open,
  onClose,
  onPick,
  currentId,
  currentSprite,
  allowSprite,
}: ImagePickerDialogProps): React.JSX.Element {
  const tree = useEditorStore((state) => state.project.tree);
  const metas = useEditorStore((state) => state.assetMetas);
  const images = useMemo(() => listImageAssets(tree), [tree]);

  const [selectedId, setSelectedId] = useState<string | null>(currentId ?? null);
  const [selectedSprite, setSelectedSprite] = useState<ImageSpriteRef | null>(currentSprite ?? null);
  const [query, setQuery] = useState("");
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [sizeError, setSizeError] = useState("");

  const availableImages = useMemo(
    () => allowSprite
      ? images.filter((image) => spriteSettingsOfMeta(metas.byId[image.id]).type === "Sprite")
      : images,
    [allowSprite, images, metas],
  );

  // 每次打开都回到当前贴图
  useEffect(() => {
    if (open) {
      setSelectedId(currentId ?? null);
      const currentSheet = spriteSheetOfMeta(currentId === undefined ? undefined : metas.byId[currentId]);
      setSelectedSprite(
        currentSprite ??
          (allowSprite && currentSheet.columns * currentSheet.rows > 1 ? { column: 0, row: 0 } : null),
      );
      setQuery("");
      setSizeError("");
    }
  }, [open, currentId, currentSprite, allowSprite, metas]);

  const selected = availableImages.find((image) => image.id === selectedId);
  const selectedSize = selectedId === null ? undefined : sizes[selectedId];
  const sheet = spriteSheetOfMeta(selectedId === null ? undefined : metas.byId[selectedId]);
  const filteredImages = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle.length === 0
      ? availableImages
      : availableImages.filter((image) => `${image.name} ${image.path}`.toLocaleLowerCase().includes(needle));
  }, [availableImages, query]);

  useEffect(() => {
    if (!open || selectedId === null || selected === undefined || sizes[selectedId] !== undefined) return;
    const id = selectedId;
    const controller = new AbortController();
    setSizeError("");
    void fetch(assetImageInfoUrl(id), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("图片尺寸读取失败");
        return (await response.json()) as { width: number; height: number };
      })
      .then((size) => {
        if (size.width > 0 && size.height > 0) {
          setSizes((previous) => ({ ...previous, [id]: size }));
          setSizeError("");
        } else setSizeError("无法读取图片尺寸");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setSizeError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [open, selectedId, selected, sizes]);

  const confirm = (): void => {
    if (selected === undefined || selectedSize === undefined) {
      return;
    }

    const sprite = allowSprite ? selectedSprite : null;
    const size = sprite === null ? selectedSize : spriteCellSizeOf(sheet, selectedSize);
    onPick({ id: selected.id, width: size.width, height: size.height }, sprite);
  };

  const ready = selected !== undefined && selectedSize !== undefined;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid="image-picker-dialog"
          className="fixed left-1/2 top-1/2 z-50 flex h-[560px] w-[1020px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">{allowSprite ? "选择贴图 / 精灵" : "选择贴图"}</Dialog.Title>

          <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
            <div className="flex w-[38%] min-w-0 flex-none flex-col border-r border-[var(--color-editor-border)] pr-3">
              <input
                type="search"
                data-testid="image-picker-search"
                aria-label="搜索图片"
                placeholder="搜索图片"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="mb-2 h-8 flex-none rounded border border-[var(--color-editor-border)] bg-black/30 px-2 text-[12px] outline-none focus:border-[var(--color-editor-accent)]"
              />
              <div className="min-h-0 flex-1 overflow-auto" data-testid="image-picker-list">
                {availableImages.length === 0 ? (
                  <div className="py-8 text-center text-[11px] text-[var(--color-editor-text-dim)]">
                    {allowSprite ? "没有启用精灵模式的图片" : "没有图片"}
                  </div>
                ) : filteredImages.length === 0 ? (
                  <div className="py-8 text-center text-[11px] text-[var(--color-editor-text-dim)]">没有匹配的图片</div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {filteredImages.map((image) => {
                      const selectedImage = image.id === selectedId;
                      return (
                        <button
                          key={image.id}
                          type="button"
                          data-testid="image-picker-item"
                          data-asset-id={image.id}
                          data-selected={selectedImage && selectedSprite === null}
                          aria-pressed={selectedImage && selectedSprite === null}
                          className={`flex min-w-0 items-center gap-2 rounded border p-1 text-left ${selectedImage ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white" : "border-transparent hover:border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel-alt)]"}`}
                          onClick={() => {
                            setSelectedId(image.id);
                            const imageSheet = spriteSheetOfMeta(metas.byId[image.id]);
                            setSelectedSprite(allowSprite && imageSheet.columns * imageSheet.rows > 1 ? { column: 0, row: 0 } : null);
                          }}
                          onDoubleClick={() => {
                            setSelectedId(image.id);
                            setSelectedSprite(allowSprite && spriteSheetOfMeta(metas.byId[image.id]).columns * spriteSheetOfMeta(metas.byId[image.id]).rows > 1 ? { column: 0, row: 0 } : null);
                            const size = sizes[image.id];
                            if (size !== undefined) {
                              const imageSheet = spriteSheetOfMeta(metas.byId[image.id]);
                              const sprite = allowSprite && imageSheet.columns * imageSheet.rows > 1 ? { column: 0, row: 0 } : null;
                              const cellSize = sprite === null ? size : spriteCellSizeOf(imageSheet, size);
                              onPick({ id: image.id, width: cellSize.width, height: cellSize.height }, sprite);
                            }
                          }}
                        >
                          <img src={assetThumbnailUrl(image.id)} alt="" loading="lazy" className="h-10 w-10 flex-none rounded bg-black/30 object-contain" />
                          <span className="min-w-0 truncate text-[11px]">{assetDisplayName(image.name)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="flex min-w-0 flex-1 flex-col overflow-auto" data-testid="image-picker-preview">
              {selected === undefined ? (
                <div className="flex min-h-full items-center justify-center text-[11px] text-[var(--color-editor-text-dim)]">
                  {allowSprite ? "选择一张精灵图片" : "选择一张图片"}
                </div>
              ) : (
                <>
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden rounded border border-[var(--color-editor-border)] bg-black/30 p-3">
                    {allowSprite && sheet.columns * sheet.rows > 1 ? (
                      <button
                        type="button"
                        data-testid="image-picker-whole"
                        aria-pressed={selectedSprite === null}
                        className={`mb-2 flex-none rounded border px-2 py-1 text-[11px] ${selectedSprite === null ? "border-[var(--color-editor-accent)] text-white" : "border-[var(--color-editor-border)] text-[var(--color-editor-text-dim)] hover:text-white"}`}
                        onClick={() => setSelectedSprite(null)}
                      >
                        整图
                      </button>
                    ) : null}
                    {allowSprite && selectedSprite !== null && sheet.columns * sheet.rows > 1 ? (
                      <div
                        data-testid="image-picker-preview-sprite"
                        data-sprite={`${selectedSprite.column},${selectedSprite.row}`}
                        aria-label={`精灵 ${selectedSprite.row * sheet.columns + selectedSprite.column + 1}`}
                        className="max-h-full max-w-full flex-1 border border-[var(--color-editor-border)] bg-no-repeat"
                        style={{
                          aspectRatio: selectedSize === undefined
                            ? `${sheet.columns} / ${sheet.rows}`
                            : `${Math.max(1, Math.round(selectedSize.width / sheet.columns))} / ${Math.max(1, Math.round(selectedSize.height / sheet.rows))}`,
                          backgroundImage: `url(${assetRawUrl(selected.id)})`,
                          backgroundSize: `${sheet.columns * 100}% ${sheet.rows * 100}%`,
                          backgroundPosition: `${sheet.columns <= 1 ? 0 : selectedSprite.column * 100 / (sheet.columns - 1)}% ${sheet.rows <= 1 ? 0 : selectedSprite.row * 100 / (sheet.rows - 1)}%`,
                        }}
                      />
                    ) : (
                      <img
                        src={assetRawUrl(selected.id)}
                        alt={assetDisplayName(selected.name)}
                        className="max-h-full max-w-full flex-1 object-contain"
                      />
                    )}
                  </div>
                  {allowSprite && sheet.columns * sheet.rows > 1 ? (
                    <div className="mt-2 grid max-h-40 flex-none grid-cols-4 gap-2 overflow-auto sm:grid-cols-6 lg:grid-cols-8">
                      {Array.from({ length: sheet.columns * sheet.rows }, (_, index) => {
                        const sprite = { column: index % sheet.columns, row: Math.floor(index / sheet.columns) };
                        const active = selectedSprite?.column === sprite.column && selectedSprite.row === sprite.row;
                        const x = sheet.columns <= 1 ? 0 : sprite.column * 100 / (sheet.columns - 1);
                        const y = sheet.rows <= 1 ? 0 : sprite.row * 100 / (sheet.rows - 1);
                        return (
                          <button
                            key={index}
                            type="button"
                            data-testid="image-picker-sprite"
                            data-asset-id={selected.id}
                            data-sprite={`${sprite.column},${sprite.row}`}
                            aria-label={`${assetDisplayName(selected.name)} 精灵 ${index + 1}`}
                            aria-pressed={active}
                            title={`精灵 ${index + 1}`}
                            className={`aspect-square min-w-0 overflow-hidden rounded border bg-black/30 ${active ? "border-[var(--color-editor-accent)]" : "border-[var(--color-editor-border)] hover:border-[var(--color-editor-accent)]"}`}
                            onClick={() => setSelectedSprite(sprite)}
                          >
                            <span className="block h-full w-full bg-no-repeat" style={{ backgroundImage: `url(${assetThumbnailUrl(selected.id)})`, backgroundSize: `${sheet.columns * 100}% ${sheet.rows * 100}%`, backgroundPosition: `${x}% ${y}%` }} />
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>

          <div className="mt-2 flex-none text-[11px] text-[var(--color-editor-text-dim)]">
            {selected === undefined
              ? "选一张图片"
              : `已选：${assetDisplayName(selected.name)}${!allowSprite || selectedSprite === null ? "" : ` · 精灵 ${selectedSprite.row * sheet.columns + selectedSprite.column + 1}`}${selectedSize === undefined ? "" : `（${!allowSprite || selectedSprite === null ? selectedSize.width : spriteCellSizeOf(sheet, selectedSize).width} × ${!allowSprite || selectedSprite === null ? selectedSize.height : spriteCellSizeOf(sheet, selectedSize).height}）`}`}
            {sizeError ? <span role="alert" className="ml-2 text-[var(--color-editor-warn)]">{sizeError}</span> : null}
          </div>

          <div className="mt-3 flex flex-none items-center justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="image-picker-cancel"
                className="toolbar-button hover:toolbar-button-hover"
              >
                取消
              </button>
            </Dialog.Close>
            <button
              type="button"
              data-testid="image-picker-confirm"
              disabled={!ready}
              title={ready ? undefined : "正在读取图片尺寸"}
              className="rounded bg-[var(--color-editor-accent)] px-3 py-1 text-[12px] text-black disabled:opacity-40"
              onClick={confirm}
            >
              {selectedSprite === null || !allowSprite ? "使用整图" : "使用精灵"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
