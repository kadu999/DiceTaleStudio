import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { SceneObjectDoc } from "@dts/document";
import { useEditorStore } from "../state/editor-store";
import { assetDisplayName } from "../panels/asset-info";
import { assetDisplayPath, listVideoAssets } from "../panels/asset-picker";
import { VideoPickerDialog } from "./VideoPickerDialog";

/**
 * 「编辑视频」窗口：给这个地图 / 精灵**加 / 删视频**，并给每个文件起个显示名。
 *
 * 为什么要有窗口：属性面板上只放得下「一排小方块」（决定放哪条），而加素材、改名这些事
 * **必须挨着路径做**——面板太窄，看不到路径就不知道源文件是哪个。所以两边的分工是：
 *
 * - **这里**：`＋ 添加视频`（弹「选择视频」）把素材加进来、`移出` 拿掉、名字就地改；
 * - **属性面板**：把加进来的视频全列成小方块，点一下决定**放哪一条**，另有循环 / 声音两个开关。
 *
 * 所以窗口里**没有「选中」这一套**：放哪条是面板上的事，这里改的是清单本身。
 * 两条约定（照「编辑声音」）：名字按文件存（`video.names[文件]`，留空 = 用素材文件名），
 * 名字只是编辑器里给人看的标签，不参与播放、不进协议；加进来才放得出来（面板只在清单里选）。
 */

/** 窗口里的一行：一条**已经加进来**的视频（可能已经不在项目里了）。 */
interface VideoRow {
  readonly id: string;
  /** 素材文件名（去掉扩展名）——名字输入框的占位。 */
  readonly fileName: string;
  /** 项目内相对路径（`video/opening.mp4`）；找不到的素材显示它自己的逻辑 ID。 */
  readonly path: string;
  readonly missing: boolean;
  /** `.webm` 的提醒（Unity 在 Windows 上多半解不了）。 */
  readonly formatHint: string | undefined;
}

function fileNameOf(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

interface VideoEditDialogProps {
  readonly open: boolean;
  readonly objectId: string | null;
  readonly onClose: () => void;
}

export function VideoEditDialog({ open, objectId, onClose }: VideoEditDialogProps): React.JSX.Element {
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const tree = useEditorStore((state) => state.project.tree);

  const object =
    objectId === null
      ? undefined
      : scenes
          .find((scene) => scene.name === activeSceneName)
          ?.objects.find((item) => item.id === objectId);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid="video-edit-dialog"
          className="fixed left-1/2 top-1/2 z-50 flex h-[520px] w-[680px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">
            编辑视频{object === undefined ? "" : `：${object.name}`}
          </Dialog.Title>

          {object === undefined ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-[11px] text-[var(--color-editor-text-dim)]">
              这个对象已经不在了
            </div>
          ) : (
            <VideoEditBody object={object} tree={tree} />
          )}

          <div className="mt-2 flex flex-none items-center justify-between gap-2 text-[11px] text-[var(--color-editor-text-dim)]">
            <span>放哪条在属性面板上点小方块选；这里只管加 / 删 / 起名字（留空 = 用文件名）。</span>
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="video-edit-close"
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

function VideoEditBody({
  object,
  tree,
}: {
  readonly object: SceneObjectDoc;
  readonly tree: ReturnType<typeof useEditorStore.getState>["project"]["tree"];
}): React.JSX.Element {
  const setVideoClipName = useEditorStore((state) => state.setVideoClipName);
  const addVideoClip = useEditorStore((state) => state.addVideoClip);
  const removeVideoClip = useEditorStore((state) => state.removeVideoClip);

  /** 「选择视频」弹框开着没有（换个对象就收起来）。 */
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    setPicking(false);
  }, [object.id]);

  const video = object.video;
  const clips = video?.clips ?? [];

  // 加进来的视频：能找到素材的用素材名，找不到的（素材被删 / 手写文件）也留一行，
  // 否则「加过的东西看不见、也移不掉」
  const assets = listVideoAssets(tree);
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const rows: VideoRow[] = clips.map((id) => {
    const asset = byId.get(id);
    return {
      id,
      fileName: assetDisplayName(asset?.name ?? fileNameOf(id)),
      path: assetDisplayPath(id),
      missing: asset === undefined,
      formatHint: id.toLowerCase().endsWith(".webm")
        ? "WebM：Windows 上多半解不了，建议改用 H.264 的 .mp4"
        : undefined,
    };
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="video-edit-body">
      <div className="flex min-h-0 flex-1 flex-col rounded border border-[var(--color-editor-border)]">
        <div className="flex flex-none items-center justify-between gap-2 border-b border-[var(--color-editor-border)] bg-[var(--color-editor-bar)] px-2 py-1">
          <span className="text-[11px] font-semibold">视频（{clips.length} 条）</span>
          <button
            type="button"
            data-testid="video-add"
            title="从项目里的视频素材里挑（可以连着加几条）"
            className="toolbar-button hover:toolbar-button-hover"
            onClick={() => setPicking(true)}
          >
            ＋ 添加视频
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-1.5" data-testid="video-edit-list">
          {rows.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]">
              <span>还没加视频</span>
              <span>点右上角「＋ 添加视频」，从项目里的视频素材里挑</span>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {rows.map((row) => (
                <VideoEditRow
                  key={row.id}
                  row={row}
                  storedName={video?.names?.[row.id] ?? ""}
                  onRename={(name) => setVideoClipName(object.id, row.id, name)}
                  onRemove={() => removeVideoClip(object.id, row.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <VideoPickerDialog
        open={picking}
        added={clips}
        onPick={(id) => addVideoClip(object.id, id)}
        onClose={() => setPicking(false)}
      />
    </div>
  );
}

/** 一行：名字输入框 + 路径 + 移出。名字是**就地改**（Enter / 失焦提交，Esc 还原）。 */
function VideoEditRow({
  row,
  storedName,
  onRename,
  onRemove,
}: {
  readonly row: VideoRow;
  readonly storedName: string;
  readonly onRename: (name: string) => void;
  readonly onRemove: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(storedName);

  useEffect(() => {
    setDraft(storedName);
  }, [row.id, storedName]);

  const commit = (): void => {
    if (draft.trim() === storedName) {
      return;
    }

    onRename(draft);
  };

  return (
    <div
      data-testid="video-edit-row"
      data-clip={row.id}
      className="flex items-center gap-2 rounded border border-[var(--color-editor-border)] px-1.5 py-1 hover:bg-[var(--color-editor-panel-alt)]"
    >
      <input
        data-testid="video-edit-name"
        data-clip={row.id}
        value={draft}
        placeholder={row.fileName}
        aria-label={`${row.fileName} 的名字`}
        title="给这个视频文件起个好认的名字（留空 = 用文件名）"
        className="w-44 flex-none rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 text-[11px] outline-none placeholder:text-[var(--color-editor-text-dim)]"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(storedName);
          }
        }}
      />

      <span
        data-testid="video-edit-path"
        className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--color-editor-text-dim)]"
        title={[row.id, row.formatHint].filter((line) => line !== undefined).join("\n")}
      >
        {row.path}
      </span>

      {row.formatHint === undefined ? null : (
        <span
          data-testid="video-edit-warning"
          className="flex-none text-[10px] text-[var(--color-editor-warn)]"
          title={row.formatHint}
        >
          webm?
        </span>
      )}

      {row.missing ? (
        <span
          className="flex-none text-[10px] text-[var(--color-editor-warn)]"
          title="项目里找不到这个文件：素材被删了，或这条是手写文件里的（移出这一行就清掉了）"
        >
          找不到
        </span>
      ) : null}

      <button
        type="button"
        data-testid="video-remove"
        data-clip={row.id}
        aria-label={`移出 ${row.fileName}`}
        title="从这个对象里移出（视频素材文件不会被删）"
        className="flex-none rounded border border-[var(--color-editor-border)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-editor-panel-alt)]"
        onClick={onRemove}
      >
        移出
      </button>
    </div>
  );
}
