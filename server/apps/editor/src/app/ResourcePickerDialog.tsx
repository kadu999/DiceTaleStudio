import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  spriteCellSizeOf,
  spriteSettingsOfMeta,
  spriteSheetOfMeta,
  assetTagsOfMeta,
  type ImageRef,
  type ImageSpriteRef,
  type ProjectDoc,
} from "@dts/document";
import { useEditorStore } from "../state/editor-store";
import type { AssetMetaTable } from "../state/store-types";
import type { ResourceTreeNode } from "../services/project-api";
import {
  assetDisplayPath,
  assetImageInfoUrl,
  assetRawUrl,
  assetThumbnailUrl,
  listImageAssets,
  listVideoAssets,
} from "../panels/asset-picker";
import { assetDisplayName } from "../panels/asset-info";
import {
  audioCatalog,
  tagOptionsOf,
  tagsOfClip,
  type AudioTagRef,
} from "../panels/audio-catalog";

/**
 * 「从项目已有素材里挑一个」的**通用**选择弹框：三种 `kind` **同一套布局**——
 * 左边文件列表（搜索 + 标签过滤 + 图标行）、右边预览、底部状态栏 + 按钮，只是内容按 kind 换：
 *
 * - `image`：选贴图 / 精灵（选中 + 确认，预览里带精灵格网，见 `ImagePickerBody`）；
 *   确认是因为写回要带宽高，尺寸是选中后异步读的。
 * - `audio` / `video`：点一条就加进宿主对象（可连点），已加入的标「已加入」、
 *   再点只换预览不重复加；右边预览可直接**播放**（原生 controls，见 `MediaPickerBody`）。
 *
 * 行首图标：音频 = 公用音符图标（`AudioIcon`）；视频 = 后端抽的首帧缩略图
 * （`/api/resources/thumbnail` 对 mp4/webm 走 ffmpeg，失败降级成 `VideoFallbackIcon`）。
 *
 * 编辑器**不导入**素材（素材由外部提交到 `Assets/images|audio|video/`），所以这里都是
 * 「从已有素材里挑」，空态文案指向这个约定。testid 全部由 `kind` 派生（`${kind}-picker-*`），
 * e2e 钉住的 `image-picker-*` / `audio-picker-*` / `video-picker-*` 一枚不改。
 *
 * 素材清单统一来自资源树 `state.project.tree`：图片 `listImageAssets`、视频 `listVideoAssets`
 * 直取树节点；音频多一层 `audioCatalog` 组装（显示名 / 标签住在文件自己的 `.meta` 里）。
 */

/** 可选的资源类型。词汇沿用 UI 层的 `assetPreviewKind`（`texture` 在这里叫 `image`）。 */
export type ResourcePickerKind = "image" | "audio" | "video";

interface ResourcePickerBaseProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/** 选贴图 / 精灵：选中 + 确认模式，确定后一次交出「图 + 可选格子」。 */
export interface ImageResourcePickerProps extends ResourcePickerBaseProps {
  readonly kind: "image";
  readonly onPick: (image: ImageRef, sprite: ImageSpriteRef | null) => void;
  /** 当前已选中的图片逻辑 ID（高亮用）。 */
  readonly currentId?: string;
  readonly currentSprite?: ImageSpriteRef;
  /** 目标对象是否支持精灵（决定标题 / 是否可选单格）。 */
  readonly allowSprite: boolean;
}

/** 选音频 / 视频：点击即加入模式，点过的进预览可播放。 */
export interface MediaResourcePickerProps extends ResourcePickerBaseProps {
  readonly kind: "audio" | "video";
  /** 已经加进来的素材（这些行标「已加入」，点击不再重复加、只换预览）。 */
  readonly added: readonly string[];
  readonly onPick: (id: string) => void;
}

export type ResourcePickerDialogProps = ImageResourcePickerProps | MediaResourcePickerProps;

/** 三种 kind 的窗口尺寸（贴图要放预览 + 格网，最宽）。 */
const DIALOG_SIZES: Record<ResourcePickerKind, string> = {
  image: "h-[560px] w-[1020px]",
  audio: "h-[520px] w-[880px]",
  video: "h-[520px] w-[880px]",
};

const MEDIA_TITLES: Record<"audio" | "video", string> = {
  audio: "选择音频",
  video: "选择视频",
};

export function ResourcePickerDialog(props: ResourcePickerDialogProps): React.JSX.Element {
  const { kind, open, onClose } = props;
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        {/* 比「编辑声音 / 视频」窗口再高一层：两层模态叠着，关掉这层回到那个窗口 */}
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <Dialog.Content
          data-testid={`${kind}-picker-dialog`}
          className={`fixed left-1/2 top-1/2 z-[70] flex ${DIALOG_SIZES[kind]} max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl`}
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">
            {kind === "image" ? (props.allowSprite ? "选择贴图 / 精灵" : "选择贴图") : MEDIA_TITLES[kind]}
          </Dialog.Title>
          {kind === "image" ? <ImagePickerBody {...props} /> : <MediaPickerBody {...props} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── 选贴图 / 精灵 ────────────────────────────────────────────────────────────

/**
 * 贴图 / 精灵挑选（对齐 Unity 的 Select Sprite / Object Picker 习惯）：
 * 列出**当前项目里的全部图片**，点一张即选中，确定后写回对象。
 *
 * 精灵切片在素材属性中编辑；这里可选择整张图片或已有的单格精灵。
 * 与音频 / 视频那半边的差异本质：那边「点一条 = 加入」，这边要先确认
 * （图要配合尺寸读出来才能写成 `ImageRef`，还要先看清格子），所以是两套交互。
 */
function ImagePickerBody({
  open,
  onPick,
  currentId,
  currentSprite,
  allowSprite,
}: ImageResourcePickerProps): React.JSX.Element {
  const tree = useEditorStore((state) => state.project.tree);
  const metas = useEditorStore((state) => state.assetMetas);
  const table = useEditorStore((state) => state.doc.audioTags);
  const images = useMemo(() => listImageAssets(tree), [tree]);

  const [selectedId, setSelectedId] = useState<string | null>(currentId ?? null);
  const [selectedSprite, setSelectedSprite] = useState<ImageSpriteRef | null>(currentSprite ?? null);
  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [sizeError, setSizeError] = useState("");

  // 任何素材都能打标签：按标签表解析成 { id, name }（越界 / 洞 / 空名跳过）
  const tagOptions = useMemo(() => tagOptionsOf(table), [table]);

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
      setActiveTags([]);
      setSizeError("");
    }
  }, [open, currentId, currentSprite, allowSprite, metas]);

  const selected = availableImages.find((image) => image.id === selectedId);
  const selectedSize = selectedId === null ? undefined : sizes[selectedId];
  const sheet = spriteSheetOfMeta(selectedId === null ? undefined : metas.byId[selectedId]);
  const filteredImages = useMemo(() => {
    // 标签过滤（AND）+ 搜索词（名字 / 路径），两件事叠加
    const tagged = activeTags.length === 0
      ? availableImages
      : availableImages.filter((image) => {
          const names = tagsOfClip(table, assetTagsOfMeta(metas.byId[image.id])).map((tag) => tag.name);
          return activeTags.every((name) => names.includes(name));
        });
    const needle = query.trim().toLocaleLowerCase();
    return needle.length === 0
      ? tagged
      : tagged.filter((image) => `${image.name} ${image.path}`.toLocaleLowerCase().includes(needle));
  }, [availableImages, query, activeTags, table, metas]);

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
    <>
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
          <TagFilterRow
            prefix="image-picker"
            tagOptions={tagOptions}
            activeTags={activeTags}
            onToggle={(name) =>
              setActiveTags((previous) =>
                previous.includes(name) ? previous.filter((item) => item !== name) : [...previous, name],
              )
            }
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
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="min-w-0 truncate text-[11px]">{assetDisplayName(image.name)}</span>
                        {tagsOfClip(table, assetTagsOfMeta(metas.byId[image.id])).length === 0 ? null : (
                          <span className="flex flex-wrap items-center gap-1">
                            {tagsOfClip(table, assetTagsOfMeta(metas.byId[image.id])).map((tag) => (
                              <span
                                key={tag.id}
                                data-testid="image-picker-tag"
                                data-id={tag.id}
                                data-tag={tag.name}
                                className="flex-none rounded-full border border-[var(--color-editor-border)] px-1 text-[9px] text-[var(--color-editor-text-dim)]"
                              >
                                {tag.name}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
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
    </>
  );
}

// ─── 选音频 / 视频 ────────────────────────────────────────────────────────────

/** 媒体行（audio / video 统一成这一个模型，画行与筛选就一份代码）。 */
interface MediaPickerRow {
  readonly id: string;
  /** 主显示名：音频 = 显示名（`.meta` 里起的，兜底文件名）；视频 = 文件名。 */
  readonly displayName: string;
  /** 项目内相对路径（副信息）。 */
  readonly path: string;
  /** 标签 chip（音频 / 视频都从 `.meta` 顶层 `tags` 读）。 */
  readonly tags: readonly AudioTagRef[];
  /** 行尾提醒徽标（视频 = `.webm` 解不了；音频没有）。 */
  readonly warning: string | undefined;
  /** 搜索用 haystack：显示名 / 文件名 / 路径 / 标签名都搜得到。 */
  readonly searchText: string;
}

/** 音频 / 视频只差单词的文案。 */
const MEDIA_TEXTS: Record<
  "audio" | "video",
  {
    readonly searchPlaceholder: string;
    readonly searchAria: string;
    readonly emptyTitle: string;
    readonly emptyHint: string;
    readonly emptyFilter: string;
    /** 右边预览空态提示。 */
    readonly previewEmpty: string;
    readonly footer: string;
  }
> = {
  audio: {
    searchPlaceholder: "搜名字 / 标签 / 文件名 / 路径…",
    searchAria: "搜索音频",
    emptyTitle: "项目里还没有音频素材",
    emptyHint: "把音频放到 Assets/audio/ 下即可在这里选到",
    emptyFilter: "没有匹配的音频",
    previewEmpty: "点左边一条音频，在这里试听",
    footer: "点一条就加进来（可以连着加几条），右边能试听；名字 / 标签在文件属性上改",
  },
  video: {
    searchPlaceholder: "搜名字 / 路径…",
    searchAria: "搜索视频",
    emptyTitle: "项目里还没有视频素材",
    emptyHint: "把 mp4 放到 Assets/video/ 下即可在这里选到",
    emptyFilter: "没有匹配的视频",
    previewEmpty: "点左边一条视频，在这里预览",
    footer: "点一条就加进来（可以连着加几条），右边能预览；视频素材本身不会被改动",
  },
};

/** 从资源树组装清单：音频走 `audioCatalog`（显示名 / 标签在 `.meta`），视频直取树节点。 */
function mediaPickerRows(
  kind: "audio" | "video",
  tree: readonly ResourceTreeNode[],
  metas: AssetMetaTable,
  table: ProjectDoc["audioTags"],
): MediaPickerRow[] {
  if (kind === "audio") {
    return audioCatalog(tree, metas, table).map((row) => ({
      id: row.id,
      displayName: row.displayName,
      path: row.path,
      tags: row.tags,
      warning: undefined,
      searchText: [row.displayName, row.customName, row.fileName, row.path, ...row.tags.map((tag) => tag.name)].join(" "),
    }));
  }

  return listVideoAssets(tree).map((asset) => {
    const path = assetDisplayPath(asset.id);
    const displayName = assetDisplayName(asset.name);
    // 任何素材都能打标签：视频同样从 `.meta` 读（顶层 `tags`）
    const tags = tagsOfClip(table, assetTagsOfMeta(metas[asset.id]));
    return {
      id: asset.id,
      displayName,
      path,
      tags,
      // `.webm` 那一条多一句提醒：Unity 在 Windows 上多半解不了 WebM（走系统解码器），建议 H.264 的 .mp4
      warning: asset.id.toLowerCase().endsWith(".webm")
        ? "WebM：Windows 上多半解不了，建议改用 H.264 的 .mp4"
        : undefined,
      searchText: [displayName, path, ...tags.map((tag) => tag.name)].join(" "),
    };
  });
}

/**
 * 音频 / 视频挑选（同一习惯，布局与贴图那边对齐：左列表 + 右预览 + 底部状态栏）：
 * 列出**当前项目里的全部此类素材**，**点一条就加进宿主对象**（可以连着点几条），
 * 点过的同时进右边预览；已经加过的标「已加入」，再点只换预览、不再重复加。
 *
 * 右边预览直接**播放**（原生 `<audio>` / `<video>` controls）——选择器里的试听 / 试看，
 * 不出声到运行端、不碰场景数据。
 */
function MediaPickerBody({ kind, open, added, onPick }: MediaResourcePickerProps): React.JSX.Element {
  const tree = useEditorStore((state) => state.project.tree);
  const metas = useEditorStore((state) => state.assetMetaTable);
  const table = useEditorStore((state) => state.doc.audioTags);
  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const texts = MEDIA_TEXTS[kind];
  const tagOptions = useMemo(() => tagOptionsOf(table), [table]);

  // 每次打开都回到干净状态（不记住上一次的搜索 / 选中）
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveTags([]);
      setSelectedId(null);
    }
  }, [open]);

  const rows = useMemo(() => mediaPickerRows(kind, tree, metas, table), [kind, tree, metas, table]);
  const visible = useMemo(() => {
    // 标签过滤（AND）+ 搜索词，两件事叠加
    const tagged = activeTags.length === 0
      ? rows
      : rows.filter((row) => activeTags.every((name) => row.tags.some((tag) => tag.name === name)));
    const needle = query.trim().toLocaleLowerCase();
    return needle.length === 0
      ? tagged
      : tagged.filter((row) => row.searchText.toLocaleLowerCase().includes(needle));
  }, [rows, query, activeTags]);

  const selected = rows.find((row) => row.id === selectedId);

  return (
    <>
      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        <div className="flex w-[38%] min-w-0 flex-none flex-col border-r border-[var(--color-editor-border)] pr-3">
          <input
            type="search"
            data-testid={`${kind}-picker-search`}
            aria-label={texts.searchAria}
            placeholder={texts.searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="mb-2 h-8 flex-none rounded border border-[var(--color-editor-border)] bg-black/30 px-2 text-[12px] outline-none focus:border-[var(--color-editor-accent)]"
          />
          <TagFilterRow
            prefix={`${kind}-picker`}
            tagOptions={tagOptions}
            activeTags={activeTags}
            onToggle={(name) =>
              setActiveTags((previous) =>
                previous.includes(name) ? previous.filter((item) => item !== name) : [...previous, name],
              )
            }
          />
          <div className="min-h-0 flex-1 overflow-auto" data-testid={`${kind}-picker-list`}>
            {visible.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]">
                {rows.length === 0 ? (
                  <>
                    <span>{texts.emptyTitle}</span>
                    <span className="font-mono">{texts.emptyHint}</span>
                  </>
                ) : (
                  <span>{texts.emptyFilter}</span>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {visible.map((row) => {
                  const isAdded = added.includes(row.id);
                  const isSelected = row.id === selectedId;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      data-testid={`${kind}-picker-item`}
                      data-asset-id={row.id}
                      data-added={isAdded}
                      data-selected={isSelected}
                      aria-pressed={isSelected}
                      data-tags={row.tags.map((tag) => tag.name).join(",")}
                      data-warning={row.warning === undefined ? undefined : "webm"}
                      title={[isAdded ? "已经加进来了（点一下只看预览）" : `加进来：${row.path}`, row.warning]
                        .filter((line) => line !== undefined)
                        .join("\n")}
                      className={`flex min-w-0 items-center gap-2 rounded border p-1 text-left ${isSelected ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white" : "border-transparent hover:border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel-alt)]"}`}
                      onClick={() => {
                        setSelectedId(row.id);
                        if (!isAdded) onPick(row.id);
                      }}
                    >
                      {kind === "audio" ? <AudioIcon /> : <VideoThumb id={row.id} />}

                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="min-w-0 truncate text-[11px]">{row.displayName}</span>
                        {row.tags.length === 0 ? null : (
                          <span className="flex flex-wrap items-center gap-1">
                            {row.tags.map((tag) => (
                              <span
                                key={tag.id}
                                data-testid={`${kind}-picker-tag`}
                                data-id={tag.id}
                                data-tag={tag.name}
                                className="flex-none rounded-full border border-[var(--color-editor-border)] px-1 text-[9px] text-[var(--color-editor-text-dim)]"
                              >
                                {tag.name}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>

                      {row.warning === undefined ? null : (
                        <span
                          data-testid={`${kind}-picker-warning`}
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
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-auto" data-testid={`${kind}-picker-preview`}>
          {selected === undefined ? (
            <div className="flex min-h-full items-center justify-center text-[11px] text-[var(--color-editor-text-dim)]">
              {texts.previewEmpty}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-[var(--color-editor-border)] bg-black/30">
              <div className="flex flex-none items-center gap-2 border-b border-[var(--color-editor-border)] px-2 py-1">
                <span className="min-w-0 truncate text-[11px]">{selected.displayName}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--color-editor-text-dim)]">
                  {selected.path}
                </span>
              </div>
              <div className="flex min-h-0 flex-1 items-center justify-center p-3">
                {kind === "audio" ? (
                  <audio
                    key={selected.id}
                    data-testid={`${kind}-picker-player`}
                    controls
                    preload="metadata"
                    src={assetRawUrl(selected.id)}
                    className="w-full max-w-md"
                  />
                ) : (
                  <video
                    key={selected.id}
                    data-testid={`${kind}-picker-player`}
                    controls
                    preload="metadata"
                    src={assetRawUrl(selected.id)}
                    className="max-h-full max-w-full"
                  />
                )}
              </div>
              {selected.warning === undefined ? null : (
                <div role="alert" className="flex-none px-2 py-1 text-[10px] text-[var(--color-editor-warn)]">
                  {selected.warning}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-none items-center justify-between gap-2 text-[11px] text-[var(--color-editor-text-dim)]">
        <span className="min-w-0 truncate">
          {selected === undefined ? texts.footer : `已选：${selected.displayName}（${selected.path}）`}
        </span>
        <Dialog.Close asChild>
          <button
            type="button"
            data-testid={`${kind}-picker-close`}
            className="toolbar-button hover:toolbar-button-hover"
          >
            关闭
          </button>
        </Dialog.Close>
      </div>
    </>
  );
}

// ─── 行首图标（音频公用图标 / 视频首帧缩略图） ─────────────────────────────────

/**
 * 音频行首的公用音符图标：音频没有「封面」可言，所有音频文件共用这一枚。
 */
function AudioIcon(): React.JSX.Element {
  return (
    <span className="flex h-10 w-10 flex-none items-center justify-center rounded bg-black/30">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="h-5 w-5 text-[var(--color-editor-text-dim)]"
      >
        <path d="M9 18V6l10-2v11" />
        <circle cx="6.5" cy="18" r="2.5" />
        <circle cx="16.5" cy="15" r="2.5" />
      </svg>
    </span>
  );
}

/**
 * 视频行首图标：优先用后端抽的首帧缩略图（`/api/resources/thumbnail` 对视频走 ffmpeg）；
 * ffmpeg 不在 / 解码失败 → img onError 降级成公用胶片图标，行不至于空着。
 */
function VideoThumb({ id }: { readonly id: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  return (
    <span className="flex h-10 w-10 flex-none items-center justify-center overflow-hidden rounded bg-black/30">
      {failed ? (
        <VideoFallbackIcon />
      ) : (
        <img
          src={assetThumbnailUrl(id)}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
    </span>
  );
}

/** 视频缩略图不可用时的兜底图标。 */
function VideoFallbackIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5 text-[var(--color-editor-text-dim)]"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 5l2.5 4" />
      <path d="M13 5l2.5 4" />
    </svg>
  );
}

// ─── 标签过滤（image / audio / video 三种选择器共用） ──────────────────────────

/**
 * 标签过滤行（多选 = **AND**）：与「背景音乐」窗口同一套语义——列标签表里的全部标签，
 * 点一下选上、再点一下取消；标签的名字只在「标签」窗口里改，这里没有输入框。
 * testid 由 `prefix` 派生（`${prefix}-tag-filter` / `${prefix}-tag-option`）；
 * 标签表是空的就不画（没有可筛的东西）。
 */
function TagFilterRow({
  prefix,
  tagOptions,
  activeTags,
  onToggle,
}: {
  readonly prefix: string;
  readonly tagOptions: readonly AudioTagRef[];
  readonly activeTags: readonly string[];
  readonly onToggle: (name: string) => void;
}): React.JSX.Element | null {
  if (tagOptions.length === 0) {
    return null;
  }

  return (
    <div
      data-testid={`${prefix}-tag-filter`}
      className="mb-2 flex flex-none flex-wrap items-center gap-1 text-[10px]"
    >
      <span className="text-[var(--color-editor-text-dim)]">标签</span>
      {tagOptions.map((tag) => {
        const active = activeTags.includes(tag.name);
        return (
          <button
            key={tag.id}
            type="button"
            data-testid={`${prefix}-tag-option`}
            data-id={tag.id}
            data-tag={tag.name}
            data-selected={active}
            aria-pressed={active}
            title={active ? `取消「${tag.name}」` : `只看带「${tag.name}」的`}
            className={`flex-none rounded-full border px-1.5 py-0.5 ${
              active
                ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                : "border-[var(--color-editor-border)] text-[var(--color-editor-text-dim)] hover:border-[var(--color-editor-accent)] hover:text-[var(--color-editor-text)]"
            }`}
            onClick={() => onToggle(tag.name)}
          >
            {tag.name}
          </button>
        );
      })}
    </div>
  );
}
