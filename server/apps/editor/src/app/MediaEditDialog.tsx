import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { assetNameOfMeta, soundDataOf, videoDataOf, type GameObjectDoc } from "@dts/document";
import { useEditorStore } from "../state/editor-store";
import { assetDisplayName } from "../panels/asset-info";
import {
  assetDisplayPath,
  assetRawUrl,
  findAssetByReference,
  listAudioAssets,
  listVideoAssets,
} from "../panels/asset-picker";
import { AssetFileIcon } from "../panels/assets/AssetIcon";
import { useSceneObject } from "./map-dialog-shell";
import { ResourcePickerDialog } from "./ResourcePickerDialog";

/**
 * 「编辑媒体清单」窗口的**通用实现**（「编辑声音」与「编辑视频」合并后的同一扇窗，
 * 按 `kind` 调整）。布局对齐「选择贴图」：左边文件清单、右边播放预览。
 *
 * 为什么要有窗口：属性面板上只放得下「一排小方块」（选哪条要播 / 放），而加素材、
 * 看路径这些事**必须挨着路径做**——面板太窄，看不到路径就不知道源文件是哪个。
 * 所以两边的分工是：
 *
 * - **这里**：`＋ 添加`（弹 `ResourcePickerDialog`）把素材加进来、`移出` 拿掉、
 *   点一条在右边**试听 / 预览**；
 * - **属性面板**：把加进来的全列成小方块，点一下决定**播 / 放哪一条**。
 *
 * **显示名不在这里改**：显示名是**文件自己的属性**（住在那份 `.meta` 的顶层 `name`），
 * 统一在资源面板的文件属性上改（「选中谁就改谁」）；这里的行只显示解析后的名字
 * （显示名 → 素材文件名）。
 *
 * **testid 由 `prefix` 派生**（`sound` / `video`），测试钉住的
 * `${prefix}-edit-dialog` / `-edit-body` / `-edit-list` / `-edit-row` / `-edit-path` /
 * `-edit-close` / `${prefix}-add` / `${prefix}-remove` 一枚不改。
 */

export interface MediaEditDialogProps {
  readonly open: boolean;
  readonly kind: "audio" | "video";
  readonly objectId: string | null;
  readonly onClose: () => void;
}

/** 行尾徽标（视频 = webm 提醒；声音没有就不传）。「找不到」由行按 `missing` 统一渲染。 */
interface MediaEditBadge {
  readonly label: string;
  readonly title: string;
  readonly testid?: string;
}

interface MediaEditRow {
  readonly id: string;
  /** 行里显示的名字：素材 meta 里的**显示名**（任何素材都能起），没有 = 素材文件名。 */
  readonly displayName: string;
  /** 移出按钮 aria 的称呼（= displayName）。 */
  readonly fileName: string;
  readonly path: string;
  readonly pathTitle: string;
  readonly missing: boolean;
  readonly badge: MediaEditBadge | undefined;
  /** 预览用：按 guid 解析后的当前素材 id（素材被删 / 手写文件时退回原 id）。 */
  readonly currentId: string;
}

/** 两个 kind 只差单词的文案与清单读取。 */
const MEDIA_EDIT_TEXTS: Record<
  "audio" | "video",
  {
    /** testid 前缀：`${prefix}-edit-*` / `${prefix}-add` / `${prefix}-remove`。 */
    readonly prefix: string;
    /** 「编辑声音」/「编辑视频」的宾语。 */
    readonly noun: string;
    /** 对象被删后的占位（声音多说一个「声」）。 */
    readonly gone: string;
    /** 素材类名：音频 / 视频（计数、添加按钮、空态提示里用）。 */
    readonly media: string;
    /** 移出按钮 title 里的宿主称呼：这条声音对象 / 这个对象。 */
    readonly scope: string;
    readonly footerHint: string;
  }
> = {
  audio: {
    prefix: "sound",
    noun: "声音",
    gone: "这个声音对象已经不在了",
    media: "音频",
    scope: "这条声音对象",
    footerHint: "播哪条在属性面板上点小方块选；这里管加 / 删 / 试听。显示名在文件属性上改。",
  },
  video: {
    prefix: "video",
    noun: "视频",
    gone: "这个对象已经不在了",
    media: "视频",
    scope: "这个对象",
    footerHint: "放哪条在属性面板上点小方块选；这里管加 / 删 / 预览。显示名在文件属性上改。",
  },
};

/** 素材文件名（去掉扩展名）——没有任何标注时的兜底称呼。 */
function fileNameOf(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

function dataOf(
  kind: "audio" | "video",
  object: GameObjectDoc,
): { readonly clips?: readonly string[] } | undefined {
  const data = kind === "audio" ? soundDataOf(object) : videoDataOf(object);
  return data === undefined ? undefined : { clips: data.clips };
}

export function MediaEditDialog({ open, kind, objectId, onClose }: MediaEditDialogProps): React.JSX.Element {
  const tree = useEditorStore((state) => state.project.tree);
  const assetMetas = useEditorStore((state) => state.assetMetas);
  const metaTable = useEditorStore((state) => state.assetMetaTable);
  const addSoundClip = useEditorStore((state) => state.addSoundClip);
  const removeSoundClip = useEditorStore((state) => state.removeSoundClip);
  const addVideoClip = useEditorStore((state) => state.addVideoClip);
  const removeVideoClip = useEditorStore((state) => state.removeVideoClip);
  const object = useSceneObject(objectId);
  const texts = MEDIA_EDIT_TEXTS[kind];

  /** 「选择素材」弹框开着没有（换个对象就收起来）。 */
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    setPicking(false);
  }, [objectId]);

  /** 右边预览的是清单里哪一条（null = 还没选）。 */
  const [previewId, setPreviewId] = useState<string | null>(null);

  const data = object === undefined ? undefined : dataOf(kind, object);
  const clips = data?.clips ?? [];
  const assetIds = new Set(
    (kind === "audio" ? listAudioAssets(tree) : listVideoAssets(tree)).map((asset) => asset.id),
  );

  // 加进来的素材：能找到的用素材名（显示名 → 文件名，显示名在文件属性上改），
  // 找不到的（素材被删 / 手写文件）也留一行，否则「加过的东西看不见、也移不掉」
  const rows: MediaEditRow[] = clips.map((id) => {
    const asset = findAssetByReference(tree, id, assetMetas);
    const currentId = asset?.id ?? id;
    // 显示名 = 素材 meta 顶层 `name`（任何素材都能起；音频旧数据在 `audio.name`），
    // 没有 = 素材文件名去掉扩展名——这里只读，改在资源面板的文件属性上
    const customName = assetNameOfMeta(metaTable[currentId])?.trim() ?? "";
    const displayName =
      customName.length > 0 ? customName : assetDisplayName(asset?.name ?? fileNameOf(currentId));
    if (kind === "audio") {
      return {
        id,
        displayName,
        fileName: displayName,
        path: assetDisplayPath(currentId),
        pathTitle: id,
        missing: asset === undefined || !assetIds.has(asset.id),
        badge: undefined,
        currentId,
      };
    }

    const formatHint = id.toLowerCase().endsWith(".webm")
      ? "WebM：Windows 上多半解不了，建议改用 H.264 的 .mp4"
      : undefined;
    return {
      id,
      displayName,
      fileName: displayName,
      path: assetDisplayPath(currentId),
      pathTitle: [id, formatHint].filter((line) => line !== undefined).join("\n"),
      missing: asset === undefined || !assetIds.has(asset.id),
      badge:
        formatHint === undefined
          ? undefined
          : { label: "webm?", title: formatHint, testid: `${texts.prefix}-edit-warning` },
      currentId,
    };
  });
  const previewRow = previewId === null ? undefined : rows.find((row) => row.id === previewId);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid={`${texts.prefix}-edit-dialog`}
          className="fixed left-1/2 top-1/2 z-50 flex h-[560px] w-[920px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">
            编辑{texts.noun}
            {object === undefined ? "" : `：${object.name}`}
          </Dialog.Title>

          {object === undefined ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-[11px] text-[var(--color-editor-text-dim)]">
              {texts.gone}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 gap-3 overflow-hidden" data-testid={`${texts.prefix}-edit-body`}>
              {/* 左：文件清单（缩略图 / 图标 + 显示名 + 路径 + 移出；显示名在文件属性上改） */}
              <div className="flex w-[46%] min-w-0 flex-none flex-col border-r border-[var(--color-editor-border)] pr-3">
                <div className="mb-2 flex flex-none items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold">
                    {texts.media}（{clips.length} 条）
                  </span>
                  <button
                    type="button"
                    data-testid={`${texts.prefix}-add`}
                    title={`从项目里的${texts.media}素材里挑（可以连着加几条）`}
                    className="toolbar-button hover:toolbar-button-hover"
                    onClick={() => setPicking(true)}
                  >
                    ＋ 添加{texts.media}
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-auto" data-testid={`${texts.prefix}-edit-list`}>
                  {rows.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]">
                      <span>还没加{texts.media}</span>
                      <span>
                        点右上角「＋ 添加{texts.media}」，从项目里的{texts.media}素材里挑
                      </span>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {rows.map((row) => (
                        <MediaEditRow
                          key={row.id}
                          kind={kind}
                          prefix={texts.prefix}
                          texts={texts}
                          row={row}
                          selected={previewId === row.id}
                          onSelect={() => setPreviewId(row.id)}
                          onRemove={() => {
                            if (kind === "audio") {
                              removeSoundClip(object.id, row.id);
                            } else {
                              removeVideoClip(object.id, row.id);
                            }
                            if (previewId === row.id) {
                              setPreviewId(null);
                            }
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* 右：播放预览（点左边一条就在这里播） */}
              <div
                className="flex min-w-0 flex-1 flex-col overflow-auto"
                data-testid={`${texts.prefix}-edit-preview`}
              >
                {previewRow === undefined ? (
                  <div className="flex min-h-full items-center justify-center text-[11px] text-[var(--color-editor-text-dim)]">
                    点左边一条开始{kind === "audio" ? "试听" : "预览"}
                  </div>
                ) : previewRow.missing ? (
                  <div className="flex min-h-full items-center justify-center text-[11px] text-[var(--color-editor-warn)]">
                    项目里找不到这个文件：素材被删了，或这条是手写文件里的（在左边「移出」这一行就清掉了）
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-hidden rounded border border-[var(--color-editor-border)] bg-black/30 p-3">
                    {kind === "audio" ? (
                      <>
                        <AssetFileIcon kind="audio" size="h-16 w-16 flex-none" />
                        {/* key = 素材 id：换一条就重挂元素，上一条的播放状态不带过去 */}
                        <audio
                          key={previewRow.currentId}
                          controls
                          preload="metadata"
                          src={assetRawUrl(previewRow.currentId)}
                          aria-label={`试听 ${previewRow.fileName}`}
                          className="w-full flex-none"
                        />
                      </>
                    ) : (
                      <video
                        key={previewRow.currentId}
                        controls
                        preload="metadata"
                        src={assetRawUrl(previewRow.currentId)}
                        aria-label={`预览 ${previewRow.fileName}`}
                        className="max-h-full max-w-full flex-1 rounded object-contain"
                      />
                    )}
                  </div>
                )}
              </div>

              <ResourcePickerDialog
                kind={kind}
                open={picking}
                added={clips}
                onPick={(id) => {
                  if (kind === "audio") {
                    addSoundClip(object.id, id);
                  } else {
                    addVideoClip(object.id, id);
                  }
                }}
                onClose={() => setPicking(false)}
              />
            </div>
          )}

          <div className="mt-2 flex flex-none items-center justify-between gap-2 text-[11px] text-[var(--color-editor-text-dim)]">
            <span>{texts.footerHint}</span>
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid={`${texts.prefix}-edit-close`}
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

/**
 * 清单里的一行：缩略图（视频 = **首帧**，浏览器 `preload="metadata"` 直接出第一帧；
 * 音频 = 公用文件图标）+ 显示名（只读：显示名在**文件属性**上改，这里跟着变）+ 路径 +
 * 徽标 + 移出。点行任意处 = 选中它到右边预览。
 */
function MediaEditRow({
  kind,
  prefix,
  texts,
  row,
  selected,
  onSelect,
  onRemove,
}: {
  readonly kind: "audio" | "video";
  readonly prefix: string;
  readonly texts: (typeof MEDIA_EDIT_TEXTS)["audio"];
  readonly row: MediaEditRow;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onRemove: () => void;
}): React.JSX.Element {
  return (
    <div
      data-testid={`${prefix}-edit-row`}
      data-clip={row.id}
      data-selected={selected}
      className={`flex items-center gap-2 rounded border px-1.5 py-1 ${
        selected
          ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)]"
          : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel-alt)]"
      }`}
      onClick={onSelect}
    >
      {kind === "video" && !row.missing ? (
        /* 视频首帧当图标（object-cover 裁齐行高；muted + preload=metadata 只为出帧，不播） */
        <video
          src={assetRawUrl(row.currentId)}
          preload="metadata"
          muted
          aria-hidden="true"
          className="h-10 w-14 flex-none rounded bg-black/40 object-cover"
        />
      ) : (
        <span className="flex h-10 w-14 flex-none items-center justify-center rounded bg-black/40">
          <AssetFileIcon kind={kind} size="h-8 w-8 flex-none" />
        </span>
      )}

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className="min-w-0 truncate text-[11px]"
          title={`显示名在文件属性上改（${row.fileName}）`}
        >
          {row.displayName}
        </span>
        <span className="flex min-w-0 items-center gap-2">
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
        </span>
      </span>

      <button
        type="button"
        data-testid={`${prefix}-remove`}
        data-clip={row.id}
        aria-label={`移出 ${row.fileName}`}
        title={`从${texts.scope}里移出（${texts.media}素材文件不会被删）`}
        className="flex-none rounded border border-[var(--color-editor-border)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-editor-panel-alt)]"
        onClick={onRemove}
      >
        移出
      </button>
    </div>
  );
}
