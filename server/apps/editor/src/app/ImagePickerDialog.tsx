import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useEditorStore } from "../state/editor-store";
import { assetDisplayPath, assetRawUrl, listImageAssets } from "../panels/asset-picker";
import { assetDisplayName } from "../panels/asset-info";

/**
 * 「选择贴图」弹框（对齐 Unity 的 Select Sprite / Object Picker 习惯）：
 * 列出**当前项目里的全部图片**，点一张即选中，确定后写回地图对象。
 *
 * 编辑器**不导入**素材（素材由外部提交到 `Assets/images/`），所以这里是「从已有图片里挑」，
 * 没有图片时明确提示该把素材放到哪。
 */

interface ImagePickerDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onPick: (image: { id: string; width: number; height: number }) => void;
  /** 当前已选中的图片逻辑 ID（高亮用）。 */
  readonly currentId?: string;
}

export function ImagePickerDialog({
  open,
  onClose,
  onPick,
  currentId,
}: ImagePickerDialogProps): React.JSX.Element {
  const tree = useEditorStore((state) => state.project.tree);
  const images = listImageAssets(tree);

  const [selectedId, setSelectedId] = useState<string | null>(currentId ?? null);
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});

  // 每次打开都回到当前贴图
  useEffect(() => {
    if (open) {
      setSelectedId(currentId ?? null);
    }
  }, [open, currentId]);

  const selected = images.find((image) => image.id === selectedId);
  const selectedSize = selectedId === null ? undefined : sizes[selectedId];

  const confirm = (): void => {
    if (selected === undefined) {
      return;
    }

    // 宽高**从素材本身读出来**（缩略图加载时记下的真实像素），保证与磁盘上的图一致
    const size = sizes[selected.id] ?? { width: 1920, height: 1080 };
    onPick({ id: selected.id, width: size.width, height: size.height });
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid="image-picker-dialog"
          className="fixed left-1/2 top-1/2 z-50 flex h-[520px] w-[760px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">选择贴图</Dialog.Title>

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
                    onClick={() => setSelectedId(image.id)}
                    onDoubleClick={() => {
                      setSelectedId(image.id);
                      const size = sizes[image.id] ?? { width: 1920, height: 1080 };
                      onPick({ id: image.id, width: size.width, height: size.height });
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

          <div className="mt-2 flex-none text-[11px] text-[var(--color-editor-text-dim)]">
            {selected === undefined
              ? "选一张图片作为地图贴图"
              : `已选：${assetDisplayPath(selected.id)}${
                  selectedSize === undefined ? "" : `（${selectedSize.width} × ${selectedSize.height}）`
                }`}
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
              disabled={selected === undefined}
              className="rounded bg-[var(--color-editor-accent)] px-3 py-1 text-[12px] text-black disabled:opacity-40"
              onClick={confirm}
            >
              使用这张贴图
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
