import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { GameObjectDoc } from "@dts/document";
import { useEditorStore } from "../state/editor-store";
import { useSceneObject } from "./map-dialog-shell";

/**
 * 「编辑媒体清单」窗口的**通用实现**：「编辑声音」（`SoundEditDialog`）与
 * 「编辑视频」（`VideoEditDialog`）两扇窗口共用。
 *
 * 为什么要有窗口：属性面板上只放得下「一排小方块」（选哪条要播 / 放），而加素材、
 * 改名这些事**必须挨着路径做**——面板太窄，看不到路径就不知道源文件是哪个。
 * 所以两边的分工是：
 *
 * - **这里**：`＋ 添加`（弹「选择素材」）把素材加进来、`移出` 拿掉、名字就地改；
 * - **属性面板**：把加进来的全列成小方块，点一下决定**播 / 放哪一条**。
 *
 * 所以窗口里**没有「选中」这一套**：选哪条是面板上的事，这里改的是清单本身。
 * 两条约定：名字按文件存（`names[文件]`，留空 = 跟随占位名），名字只是编辑器里
 * 给人看的标签，不参与播放、不进协议；加进来才播 / 放得出来（面板只在清单里选）。
 *
 * 两个调用方的差异全部走参数：`labels`（只差几个单词的文案）、`dataOf` /
 * `listAssets` / `picker`（各自的文档读取、素材列举与选择弹框）、`buildRow`
 * （一行的展示细节：声音的占位跟随音频文件显示名、视频带 webm 提醒徽标）、
 * 三个 store 动作回调。**testid 由 `prefix` 派生**，测试钉住的
 * `${prefix}-edit-dialog` / `-edit-body` / `-edit-list` / `-edit-row` / `-edit-name` /
 * `-edit-path` / `-edit-close` / `${prefix}-add` / `${prefix}-remove` 一枚不改。
 */

/** 行尾徽标（视频 = webm 提醒；声音没有就不传）。「找不到」由外壳按 `missing` 统一渲染。 */
export interface MediaClipBadge {
  readonly label: string;
  readonly title: string;
  readonly testid?: string;
}

export interface MediaClipRow {
  readonly id: string;
  /** 素材文件名（去掉扩展名）：aria / 移出按钮的称呼。 */
  readonly fileName: string;
  /** 名字输入框的占位：留空时这一条显示成什么。 */
  readonly placeholder: string;
  readonly path: string;
  readonly pathTitle: string;
  readonly missing: boolean;
  readonly badge: MediaClipBadge | undefined;
}

/** 两个调用方只差单词的文案。 */
export interface MediaClipLabels {
  /** 「编辑声音」/「编辑视频」的宾语。 */
  readonly noun: string;
  /** 对象被删后的占位（声音多说一个「声」）。 */
  readonly gone: string;
  /** 素材类名：音频 / 视频（计数、添加按钮、空态提示里用）。 */
  readonly media: string;
  /** 移出按钮 title 里的宿主称呼：这条声音对象 / 这个对象。 */
  readonly scope: string;
  readonly footerHint: string;
  /** 名字输入框的 title。 */
  readonly nameTitle: string;
}

/** 「选择素材」弹框的公共 props（Audio / Video 两个 Picker 同形）。 */
export interface MediaPickerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 已经加进来的素材（这些行标「已加入」、点不动）。 */
  readonly added: readonly string[];
  readonly onPick: (id: string) => void;
}

type ProjectTree = ReturnType<typeof useEditorStore.getState>["project"]["tree"];
type AssetMetaTable = ReturnType<typeof useEditorStore.getState>["assetMetas"];
type AssetMetaIndex = ReturnType<typeof useEditorStore.getState>["assetMetaTable"];

/** `buildRow` 的上下文：素材树、两份 meta、项目里现有哪些此类素材。 */
export interface MediaClipRowContext {
  readonly tree: ProjectTree;
  readonly assetMetas: AssetMetaTable;
  readonly metaTable: AssetMetaIndex;
  readonly assetIds: ReadonlySet<string>;
}

export interface MediaClipListDialogProps {
  readonly open: boolean;
  readonly objectId: string | null;
  readonly onClose: () => void;
  /** testid 前缀：`${prefix}-edit-*` / `${prefix}-add` / `${prefix}-remove`。 */
  readonly prefix: string;
  readonly labels: MediaClipLabels;
  readonly dataOf: (
    object: GameObjectDoc,
  ) => { readonly clips?: readonly string[]; readonly names?: Readonly<Record<string, string>> } | undefined;
  readonly listAssets: (tree: ProjectTree) => readonly { readonly id: string }[];
  readonly buildRow: (clipId: string, context: MediaClipRowContext) => MediaClipRow;
  readonly picker: React.ComponentType<MediaPickerProps>;
  readonly onAdd: (objectId: string, clipId: string) => void;
  readonly onRename: (objectId: string, clipId: string, name: string) => void;
  readonly onRemove: (objectId: string, clipId: string) => void;
}

/** 素材文件名（去掉扩展名）——没有任何标注时的兜底称呼。 */
export function fileNameOf(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

export function MediaClipListDialog({
  open,
  objectId,
  onClose,
  prefix,
  labels,
  dataOf,
  listAssets,
  buildRow,
  picker: Picker,
  onAdd,
  onRename,
  onRemove,
}: MediaClipListDialogProps): React.JSX.Element {
  const tree = useEditorStore((state) => state.project.tree);
  const assetMetas = useEditorStore((state) => state.assetMetas);
  const metaTable = useEditorStore((state) => state.assetMetaTable);
  const object = useSceneObject(objectId);

  /** 「选择素材」弹框开着没有（换个对象就收起来）。 */
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    setPicking(false);
  }, [objectId]);

  const data = object === undefined ? undefined : dataOf(object);
  const clips = data?.clips ?? [];
  const assetIds = new Set(listAssets(tree).map((asset) => asset.id));

  // 加进来的素材：能找到的用素材名，找不到的（素材被删 / 手写文件）也留一行，
  // 否则「加过的东西看不见、也移不掉」
  const context: MediaClipRowContext = { tree, assetMetas, metaTable, assetIds };
  const rows: MediaClipRow[] = clips.map((id) => buildRow(id, context));

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid={`${prefix}-edit-dialog`}
          className="fixed left-1/2 top-1/2 z-50 flex h-[520px] w-[680px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">
            编辑{labels.noun}
            {object === undefined ? "" : `：${object.name}`}
          </Dialog.Title>

          {object === undefined ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-[11px] text-[var(--color-editor-text-dim)]">
              {labels.gone}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col" data-testid={`${prefix}-edit-body`}>
              <div className="flex min-h-0 flex-1 flex-col rounded border border-[var(--color-editor-border)]">
                <div className="flex flex-none items-center justify-between gap-2 border-b border-[var(--color-editor-border)] bg-[var(--color-editor-bar)] px-2 py-1">
                  <span className="text-[11px] font-semibold">
                    {labels.media}（{clips.length} 条）
                  </span>
                  <button
                    type="button"
                    data-testid={`${prefix}-add`}
                    title={`从项目里的${labels.media}素材里挑（可以连着加几条）`}
                    className="toolbar-button hover:toolbar-button-hover"
                    onClick={() => setPicking(true)}
                  >
                    ＋ 添加{labels.media}
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-auto p-1.5" data-testid={`${prefix}-edit-list`}>
                  {rows.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]">
                      <span>还没加{labels.media}</span>
                      <span>
                        点右上角「＋ 添加{labels.media}」，从项目里的{labels.media}素材里挑
                      </span>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {rows.map((row) => (
                        <MediaClipEditRow
                          key={row.id}
                          prefix={prefix}
                          labels={labels}
                          row={row}
                          storedName={data?.names?.[row.id] ?? ""}
                          onRename={(name) => onRename(object.id, row.id, name)}
                          onRemove={() => onRemove(object.id, row.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <Picker
                open={picking}
                added={clips}
                onPick={(id) => onAdd(object.id, id)}
                onClose={() => setPicking(false)}
              />
            </div>
          )}

          <div className="mt-2 flex flex-none items-center justify-between gap-2 text-[11px] text-[var(--color-editor-text-dim)]">
            <span>{labels.footerHint}</span>
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid={`${prefix}-edit-close`}
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

/** 一行：名字输入框 + 路径 + 徽标 + 移出。名字是**就地改**（Enter / 失焦提交，Esc 还原）。 */
function MediaClipEditRow({
  prefix,
  labels,
  row,
  storedName,
  onRename,
  onRemove,
}: {
  readonly prefix: string;
  readonly labels: MediaClipLabels;
  readonly row: MediaClipRow;
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
      data-testid={`${prefix}-edit-row`}
      data-clip={row.id}
      className="flex items-center gap-2 rounded border border-[var(--color-editor-border)] px-1.5 py-1 hover:bg-[var(--color-editor-panel-alt)]"
    >
      <input
        data-testid={`${prefix}-edit-name`}
        data-clip={row.id}
        value={draft}
        placeholder={row.placeholder}
        aria-label={`${row.fileName} 的名字`}
        title={labels.nameTitle}
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
        data-testid={`${prefix}-edit-path`}
        className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--color-editor-text-dim)]"
        title={row.pathTitle}
      >
        {row.path}
      </span>

      {row.badge === undefined ? null : (
        <span
          data-testid={row.badge.testid}
          className="flex-none text-[10px] text-[var(--color-editor-warn)]"
          title={row.badge.title}
        >
          {row.badge.label}
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
        data-testid={`${prefix}-remove`}
        data-clip={row.id}
        aria-label={`移出 ${row.fileName}`}
        title={`从${labels.scope}里移出（${labels.media}素材文件不会被删）`}
        className="flex-none rounded border border-[var(--color-editor-border)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-editor-panel-alt)]"
        onClick={onRemove}
      >
        移出
      </button>
    </div>
  );
}
