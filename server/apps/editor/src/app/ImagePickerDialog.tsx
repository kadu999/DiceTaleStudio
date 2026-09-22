import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  spriteCellSizeOf,
  spriteSheetOf,
  type ImageRef,
  type ImageSpriteRef,
} from "@dts/document";
import { useEditorStore } from "../state/editor-store";
import { assetDisplayPath, assetRawUrl, listImageAssets } from "../panels/asset-picker";
import { assetDisplayName } from "../panels/asset-info";
import { SpriteSheetPanel } from "./SpriteSheetPanel";

/**
 * 「选择贴图」弹框（对齐 Unity 的 Select Sprite / Object Picker 习惯）：
 * 列出**当前项目里的全部图片**，点一张即选中，确定后写回对象。
 *
 * 编辑器**不导入**素材（素材由外部提交到 `Assets/images/`），所以这里是「从已有图片里挑」，
 * 没有图片时明确提示该把素材放到哪。
 *
 * **v20 起右边多一块「切分」（精灵）**：把这张图按「列 × 行」切成格子，点预览图上的某一格
 * 即选中它——`allowSprite` 为 false（地图对象：贴图住在 `GridMap` 里、格子按整张贴图算）
 * 时右边整块不出现，行为与以前一模一样（只有左边那份挑图列表）。
 *
 * 两件事落在**不同轨道**上，所以窗口的取消语义也不同（有意为之）：
 * - **切分**是项目级数据（工程文件里的 `spriteSheets`），在右侧面板里改就立刻生效、取消窗口不回退；
 * - **选哪一格 / 换哪张图**是对象自己的数据（场景文件），要按下面两个按钮才写进对象。
 */
interface ImagePickerDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /**
   * 确定时回调：图片引用（宽高已按「整图 / 一格」算好）+ 选中的格子（`null` = 整图）。
   *
   * 外面把它一次写进对象（图 + 格子是同一条撤销记录），所以这里不分成两次回调。
   */
  readonly onPick: (image: ImageRef, sprite: ImageSpriteRef | null) => void;
  /** 当前已选中的图片逻辑 ID（高亮用）。 */
  readonly currentId?: string;
  /** 当前对象的子图格子（打开时高亮那一格；`undefined` = 整图）。 */
  readonly currentSprite?: ImageSpriteRef;
  /** 这个对象能不能用子图（地图不行）。 */
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
  const assetMetas = useEditorStore((state) => state.assetMetas);
  const images = listImageAssets(tree);

  const [selectedId, setSelectedId] = useState<string | null>(currentId ?? null);
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [cell, setCell] = useState<ImageSpriteRef | null>(currentSprite ?? null);

  // 每次打开都回到当前贴图 / 当前那一格
  useEffect(() => {
    if (open) {
      setSelectedId(currentId ?? null);
      setCell(currentSprite ?? null);
    }
  }, [open, currentId, currentSprite]);

  const selected = images.find((image) => image.id === selectedId);
  const selectedSize = selectedId === null ? undefined : sizes[selectedId];
  const sheet = spriteSheetOf(assetMetas, selectedId === null ? undefined : { id: selectedId });

  /**
   * 确定：`sprite` 为 `null` = 用整张图。
   *
   * 声明尺寸**从素材本身读出来**（缩略图加载时记下的真实像素），保证与磁盘上的图一致：
   * 整图 = 图片宽高；子图 = 那一格的宽高（`spriteCellSizeOf`，与画布、与前端同一套除法）。
   * **尺寸没读到就不让点**（按钮禁用）：宁可等一下，也不往文档里写一个猜出来的数字
   * ——「对象多大」全靠这个声明值。
   */
  const confirm = (sprite: ImageSpriteRef | null): void => {
    if (selected === undefined || selectedSize === undefined) {
      return;
    }

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
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">
            {allowSprite ? "选择贴图 / 精灵" : "选择贴图"}
          </Dialog.Title>

          <div className="flex min-h-0 flex-1">
            <div className="min-h-0 flex-1 overflow-auto" data-testid="image-picker-list">
              {images.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]">
                  <span>项目里还没有图片素材</span>
                  <span className="font-mono">把图片放到 Assets/images/ 下即可在这里选到</span>
                </div>
              ) : (
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                  {images.map((image) => (
                    <button
                      key={image.id}
                      type="button"
                      data-testid="image-picker-item"
                      data-asset-id={image.id}
                      data-selected={image.id === selectedId}
                      aria-pressed={image.id === selectedId}
                      className={`flex flex-col gap-1 rounded border p-1 text-left ${
                        image.id === selectedId
                          ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                          : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel-alt)]"
                      }`}
                      onClick={() => {
                        setSelectedId(image.id);
                        // 换图就把格子清掉：那一格说的是上一张图的位置（与文档命令同一条口径）
                        setCell(null);
                      }}
                      onDoubleClick={() => {
                        // 双击 = 直接用**整张图**（尺寸还没读到就只选中，别写坏数字）
                        setSelectedId(image.id);
                        setCell(null);
                        const size = sizes[image.id];
                        if (size !== undefined) {
                          onPick({ id: image.id, width: size.width, height: size.height }, null);
                        }
                      }}
                    >
                      <img
                        src={assetRawUrl(image.id)}
                        alt={image.name}
                        className="h-20 w-full rounded bg-black/30 object-contain"
                        onLoad={(event) => {
                          // 先把尺寸读出来：React 会回收合成事件，异步回调里再碰
                          // `event.currentTarget` 会拿到 null（本项目踩过一次，整个界面白屏）
                          const { naturalWidth, naturalHeight } = event.currentTarget;
                          setSizes((previous) => ({
                            ...previous,
                            [image.id]: { width: naturalWidth, height: naturalHeight },
                          }));
                        }}
                      />
                      <span className="truncate text-[11px]" title={assetDisplayPath(image.id)}>
                        {assetDisplayName(image.name)}
                      </span>
                      <span className="truncate font-mono text-[10px] text-[var(--color-editor-text-dim)]">
                        {assetDisplayPath(image.id)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 切分面板：只有「自己拥有贴图特性」的对象才给（地图的贴图不在这套里） */}
            {allowSprite && selected !== undefined ? (
              <SpriteSheetPanel
                imageId={selected.id}
                imageSize={selectedSize}
                cell={cell}
                onCellChange={setCell}
              />
            ) : null}
          </div>

          <div className="mt-2 flex-none text-[11px] text-[var(--color-editor-text-dim)]">
            {selected === undefined
              ? "选一张图片"
              : `已选：${assetDisplayPath(selected.id)}${
                  selectedSize === undefined ? "" : `（图片 ${selectedSize.width} × ${selectedSize.height}）`
                }`}
            {allowSprite ? null : (
              <span data-testid="sprite-unsupported-note" className="ml-1">
                · 地图的贴图按整张用（不支持切成子图：格子的行序会被当成贴图里的一块）
              </span>
            )}
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
            {allowSprite ? (
              <button
                type="button"
                data-testid="image-picker-whole"
                disabled={!ready}
                title={ready ? "用整张图（不取子图）" : "等这张图加载出来（要读它的真实像素）"}
                className="toolbar-button hover:toolbar-button-hover disabled:opacity-40"
                onClick={() => confirm(null)}
              >
                使用整图
              </button>
            ) : null}
            <button
              type="button"
              data-testid="image-picker-confirm"
              disabled={!ready}
              title={ready ? undefined : "等这张图加载出来（要读它的真实像素）"}
              className="rounded bg-[var(--color-editor-accent)] px-3 py-1 text-[12px] text-black disabled:opacity-40"
              onClick={() => confirm(allowSprite ? cell : null)}
            >
              {allowSprite && cell !== null
                ? `使用第${cell.row + 1}行第${cell.column + 1}列`
                : "使用这张贴图"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
