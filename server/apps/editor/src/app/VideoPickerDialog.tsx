import * as Dialog from "@radix-ui/react-dialog";
import { useEditorStore } from "../state/editor-store";
import { assetDisplayName } from "../panels/asset-info";
import { assetDisplayPath, listVideoAssets } from "../panels/asset-picker";

/**
 * 「选择视频」弹框（与「选择音频」同一个习惯）：列出**当前项目里的全部视频**，
 * **点一条就加进这个对象**，可以连着点几条；已经加过的标出来、不再重复加。
 *
 * 它只负责「从已有素材里挑」——编辑器**不导入素材**（素材由外部提交到 `Assets/video/`），
 * 也**不播放**：这里没有预览播放器、不碰视频解码。
 *
 * `.webm` 那一条会多一句提醒：Unity 在 **Windows 上多半解不了 WebM**（它走系统的解码器），
 * 建议用 H.264 的 `.mp4`——这句话放在这里最省事，选中之前就看得见。
 */

interface VideoPickerDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 已经加进来的视频（这些行标「已加入」、点不动）。 */
  readonly added: readonly string[];
  readonly onPick: (id: string) => void;
}

/** `.webm` 的提醒（选择器与面板共用一句话）。 */
function webmHint(id: string): string | undefined {
  return id.toLowerCase().endsWith(".webm")
    ? "WebM：Windows 上多半解不了，建议改用 H.264 的 .mp4"
    : undefined;
}

export function VideoPickerDialog({
  open,
  onClose,
  added,
  onPick,
}: VideoPickerDialogProps): React.JSX.Element {
  const tree = useEditorStore((state) => state.project.tree);
  const videos = listVideoAssets(tree);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        {/* 比「编辑视频」窗口再高一层：两层模态叠着，关掉这层回到那个窗口 */}
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <Dialog.Content
          data-testid="video-picker-dialog"
          className="fixed left-1/2 top-1/2 z-[70] flex h-[460px] w-[560px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">选择视频</Dialog.Title>

          <div className="min-h-0 flex-1 overflow-auto" data-testid="video-picker-list">
            {videos.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]">
                <span>项目里还没有视频素材</span>
                <span className="font-mono">把 mp4 放到 Assets/video/ 下即可在这里选到</span>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {videos.map((asset) => {
                  const isAdded = added.includes(asset.id);
                  const hint = webmHint(asset.id);
                  return (
                    <button
                      key={asset.id}
                      type="button"
                      data-testid="video-picker-item"
                      data-asset-id={asset.id}
                      data-added={isAdded}
                      data-warning={hint === undefined ? undefined : "webm"}
                      disabled={isAdded}
                      title={[isAdded ? "已经加进来了" : `加进来：${assetDisplayPath(asset.id)}`, hint]
                        .filter((line) => line !== undefined)
                        .join("\n")}
                      className={`flex items-center gap-2 rounded border px-1.5 py-1 text-left ${
                        isAdded
                          ? "border-[var(--color-editor-border)] opacity-50"
                          : "border-[var(--color-editor-border)] hover:border-[var(--color-editor-accent)] hover:bg-[var(--color-editor-panel-alt)]"
                      }`}
                      onClick={() => onPick(asset.id)}
                    >
                      <span className="w-44 flex-none truncate text-[11px]">
                        {assetDisplayName(asset.name)}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--color-editor-text-dim)]">
                        {assetDisplayPath(asset.id)}
                      </span>
                      {hint === undefined ? null : (
                        <span
                          data-testid="video-picker-warning"
                          className="flex-none text-[10px] text-[var(--color-editor-warn)]"
                        >
                          webm?
                        </span>
                      )}
                      <span
                        className={`flex-none text-[10px] ${
                          isAdded
                            ? "text-[var(--color-editor-text-dim)]"
                            : "text-[var(--color-editor-accent)]"
                        }`}
                      >
                        {isAdded ? "已加入" : "＋"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-2 flex flex-none items-center justify-between gap-2 text-[11px] text-[var(--color-editor-text-dim)]">
            <span>点一条就加进来（可以连着加几条）；视频素材本身不会被改动</span>
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="video-picker-close"
                className="toolbar-button hover:toolbar-button-hover"
              >
                关闭
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
