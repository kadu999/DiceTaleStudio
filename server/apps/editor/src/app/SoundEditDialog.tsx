import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { soundDataOf, type SceneObjectDoc } from "@dts/document";
import { useEditorStore } from "../state/editor-store";
import { audioNameOf } from "../panels/audio-catalog";
import { assetDisplayName } from "../panels/asset-info";
import { assetDisplayPath, findAssetByReference, listAudioAssets } from "../panels/asset-picker";
import { AudioPickerDialog } from "./AudioPickerDialog";

/**
 * 「编辑声音」窗口：给这条声音对象**加 / 删音频**，并给每个文件起个显示名。
 *
 * 为什么要有窗口：属性面板上只放得下「一排小方块」（选哪条要播），而加素材、改名这些事
 * **必须挨着路径做**——面板太窄，看不到路径就不知道源文件是哪个。所以两边的分工是：
 *
 * - **这里**：`＋ 添加音频`（弹「选择音频」）把素材加进来、`移出` 拿掉、名字就地改；
 * - **属性面板**：把加进来的音频全列成小方块，点一下决定**播哪一条**。
 *
 * 所以窗口里**没有「选中」这一套**：选哪条是面板上的事，这里改的是清单本身。
 * 两条约定：名字按文件存（`sound.names[文件]`，留空 = 用素材文件名），名字只是编辑器里
 * 给人看的标签，不参与播放、不进协议；加进来才播得出来（面板只在清单里选）。
 */

/** 窗口里的一行：一条**已经加进来**的音频（可能已经不在项目里了）。 */
interface SoundRow {
  readonly id: string;
  /** 素材文件名（去掉扩展名）——没有任何标注时的兜底。 */
  readonly fileName: string;
  /** 留空时显示成什么：**音频文件自己的显示名**，没有才用文件名（输入框的占位）。 */
  readonly fallbackName: string;
  /** 项目内相对路径（`audio/step1.mp3`）；找不到的素材显示它自己的逻辑 ID。 */
  readonly path: string;
  readonly missing: boolean;
}

function fileNameOf(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

interface SoundEditDialogProps {
  readonly open: boolean;
  readonly objectId: string | null;
  readonly onClose: () => void;
}

export function SoundEditDialog({ open, objectId, onClose }: SoundEditDialogProps): React.JSX.Element {
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
          data-testid="sound-edit-dialog"
          className="fixed left-1/2 top-1/2 z-50 flex h-[520px] w-[680px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">
            编辑声音{object === undefined ? "" : `：${object.name}`}
          </Dialog.Title>

          {object === undefined ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-[11px] text-[var(--color-editor-text-dim)]">
              这个声音对象已经不在了
            </div>
          ) : (
            <SoundEditBody object={object} tree={tree} />
          )}

          <div className="mt-2 flex flex-none items-center justify-between gap-2 text-[11px] text-[var(--color-editor-text-dim)]">
            <span>播哪条在属性面板上点小方块选；这里只管加 / 删 / 起名字（留空 = 用文件名）。</span>
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="sound-edit-close"
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

function SoundEditBody({
  object,
  tree,
}: {
  readonly object: SceneObjectDoc;
  readonly tree: ReturnType<typeof useEditorStore.getState>["project"]["tree"];
}): React.JSX.Element {
  const setSoundClipName = useEditorStore((state) => state.setSoundClipName);
  const addSoundClip = useEditorStore((state) => state.addSoundClip);
  const removeSoundClip = useEditorStore((state) => state.removeSoundClip);
  const audioMetas = useEditorStore((state) => state.assetMetaTable);
  const assetMetas = useEditorStore((state) => state.assetMetas);

  /** 「选择音频」弹框开着没有（换个对象就收起来）。 */
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    setPicking(false);
  }, [object.id]);

  const sound = soundDataOf(object);
  const clips = sound?.clips ?? [];
  const assetIds = new Set(listAudioAssets(tree).map((asset) => asset.id));

  // 加进来的音频：能找到素材的用素材名，找不到的（素材被删 / 手写文件）也留一行，
  // 否则「加过的东西看不见、也移不掉」
  const rows: SoundRow[] = clips.map((id) => {
    const asset = findAssetByReference(tree, id, assetMetas);
    const currentId = asset?.id ?? id;
    return {
      id,
      fileName: assetDisplayName(asset?.name ?? fileNameOf(currentId)),
      // 输入框的占位 = **跟随的那一层**（音频文件自己的名字，没有才用文件名）：
      // 留空时这一条会显示成它，作者一眼看得出「不改就是这个名字」
      fallbackName: audioNameOf(audioMetas, currentId) ?? assetDisplayName(asset?.name ?? fileNameOf(currentId)),
      path: assetDisplayPath(currentId),
      missing: asset === undefined || !assetIds.has(asset.id),
    };
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="sound-edit-body">
      <div className="flex min-h-0 flex-1 flex-col rounded border border-[var(--color-editor-border)]">
        <div className="flex flex-none items-center justify-between gap-2 border-b border-[var(--color-editor-border)] bg-[var(--color-editor-bar)] px-2 py-1">
          <span className="text-[11px] font-semibold">音频（{clips.length} 条）</span>
          <button
            type="button"
            data-testid="sound-add"
            title="从项目里的音频素材里挑（可以连着加几条）"
            className="toolbar-button hover:toolbar-button-hover"
            onClick={() => setPicking(true)}
          >
            ＋ 添加音频
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-1.5" data-testid="sound-edit-list">
          {rows.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]">
              <span>还没加音频</span>
              <span>点右上角「＋ 添加音频」，从项目里的音频素材里挑</span>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {rows.map((row) => (
                <SoundEditRow
                  key={row.id}
                  row={row}
                  storedName={sound?.names?.[row.id] ?? ""}
                  onRename={(name) => setSoundClipName(object.id, row.id, name)}
                  onRemove={() => removeSoundClip(object.id, row.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <AudioPickerDialog
        open={picking}
        added={clips}
        onPick={(id) => addSoundClip(object.id, id)}
        onClose={() => setPicking(false)}
      />
    </div>
  );
}

/** 一行：名字输入框 + 路径 + 移出。名字是**就地改**（Enter / 失焦提交，Esc 还原）。 */
function SoundEditRow({
  row,
  storedName,
  onRename,
  onRemove,
}: {
  readonly row: SoundRow;
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
      data-testid="sound-edit-row"
      data-clip={row.id}
      className="flex items-center gap-2 rounded border border-[var(--color-editor-border)] px-1.5 py-1 hover:bg-[var(--color-editor-panel-alt)]"
    >
      <input
        data-testid="sound-edit-name"
        data-clip={row.id}
        value={draft}
        placeholder={row.fallbackName}
        aria-label={`${row.fileName} 的名字`}
        title="只给这一条声音对象改名（覆盖）；留空 = 跟随音频文件自己的名字（在「音频文件」窗口里改）"
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
        data-testid="sound-edit-path"
        className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--color-editor-text-dim)]"
        title={row.id}
      >
        {row.path}
      </span>

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
        data-testid="sound-remove"
        data-clip={row.id}
        aria-label={`移出 ${row.fileName}`}
        title="从这条声音对象里移出（音频素材文件不会被删）"
        className="flex-none rounded border border-[var(--color-editor-border)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-editor-panel-alt)]"
        onClick={onRemove}
      >
        移出
      </button>
    </div>
  );
}
