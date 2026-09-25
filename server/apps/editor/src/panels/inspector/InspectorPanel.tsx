import { useEffect, useState } from "react";
import {
  DEFAULT_SLOT_COMPONENT,
  assetTagsOfMeta,
  audioNameOfMeta,
  supportsObjectComponent,
  isSpriteMeta,
  metaOfImage,
  spriteCellSizeOf,
  spriteSettingsOfMeta,
  spriteSheetOfMeta,
} from "@dts/document";
import { PROJECT_FOLDERS, PROJECT_SCENE_FILE_EXTENSION } from "@dts/resources";
import type { ResourceTreeNode } from "../../services/project-api";
import { findResourceNode, useEditorStore } from "../../state/editor-store";
import { tagsOfClip, type AudioTagRef } from "../audio-catalog";
import { assetKindLabel, assetPreviewKind, formatSize } from "../asset-info";
import { assetRawUrl, parseSpriteAssetId } from "../asset-picker";
import { EmptyState } from "../EmptyState";
import { AudioTagDialog } from "../../app/AudioTagDialog";
import { SpriteEditorDialog } from "../../app/SpriteEditorDialog";
import { Field, FieldGroup, FieldRow } from "./fields";
import { OBJECT_EDITOR, componentEditorsFor } from "./registry";

/**
 * 右侧属性面板：当前选中对象 / 场景 / **资源文件**的属性。
 *
 * 这个文件只回答「**现在该显示哪一屏**」（资源 > 对象 > 场景 > 项目，按优先级）
 * 以及「资源 / 项目」那两屏本身。**对象那一屏的分组在 `registry.tsx`**、
 * 每个字段控件在 `object-fields.tsx`——加一个对象特性不需要回到这里。
 */
export function InspectorPanel(): React.JSX.Element {
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const selection = useEditorStore((state) => state.selectedObjectIds);
  const selectedAssetId = useEditorStore((state) => state.selectedAssetId);
  const tree = useEditorStore((state) => state.project.tree);
  const projectOpen = useEditorStore((state) => state.project.current !== null);

  const activeScene = scenes.find((scene) => scene.name === activeSceneName);
  const selected =
    activeScene === undefined
      ? undefined
      : activeScene.objects.find((object) => object.id === selection[0]);
  // 选中的资源可能在刷新后没了，所以按 id 现查一次
  const selectedSprite = selectedAssetId === null ? undefined : parseSpriteAssetId(selectedAssetId);
  const asset =
    selectedAssetId === null
      ? undefined
      : findResourceNode(tree, (node) => node.id === (selectedSprite?.imageId ?? selectedAssetId));

  return (
    <div className="flex h-full min-h-0 flex-col panel border-l">
      <div className="panel-header">
        <span>属性</span>
        <span className="text-[10px]">
          {asset !== undefined
            ? "资源"
            : selected !== undefined
              ? "对象"
              : activeScene !== undefined
                ? "场景"
                : projectOpen
                  ? "项目"
                  : "空"}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2 text-[12px]">
        {asset !== undefined ? (
          <AssetProperties key={asset.id} asset={asset} spriteIndex={selectedSprite?.index} />
        ) : selected !== undefined ? (
          // 对象视图只列**人要用它做决定**的字段：内部标识（id）与组件数量不显示——
          // id 是一串机器 id、组件数现在恒为 0，两者都只会占地方。
          // `key` = 对象 id：**换对象时分组回到展开**（折叠状态是组件本地的，参考实现也在
          // 切换对象时重置，免得「上一个对象收起的分组」跟着跑到下一个对象身上）
          //
          // 显示哪几组、组里是什么，全在 `registry.tsx` 的 `OBJECT_GROUPS` 里——
          // 这里只负责「按顺序渲染适用的那些组」。
          <div key={selected.id} data-testid="object-properties">
            <FieldGroup title={OBJECT_EDITOR.title} group={OBJECT_EDITOR.group}>
              {OBJECT_EDITOR.render(selected)}
            </FieldGroup>
            {componentEditorsFor(selected).flatMap((editor) =>
              editor.panels.map((panel) => (
                <FieldGroup key={`${editor.type}:${panel.group}`} title={panel.title} group={panel.group}>
                  {panel.render(selected)}
                </FieldGroup>
              )),
            )}
          </div>
        ) : activeScene !== undefined ? (
          <FieldGroup title="场景" group="scene">
            <Field label="名称" value={activeScene.name} />
            <Field label="对象" value={String(activeScene.objects.length)} />
            <Field
              label="地图对象"
              value={
                activeScene.objects.some((object) => supportsObjectComponent(object, DEFAULT_SLOT_COMPONENT.map))
                  ? `${activeScene.objects.filter((object) => supportsObjectComponent(object, DEFAULT_SLOT_COMPONENT.map)).length} 个`
                  : "无（对象不依赖地图，可直接添加）"
              }
            />
            {/* 场景也是一个文件：告诉人它在盘上的哪儿（打开它交给资源面板的「打开目录」） */}
            <Field label="文件" value={`${PROJECT_FOLDERS.scenes}/${activeScene.name}${PROJECT_SCENE_FILE_EXTENSION}`} mono />
          </FieldGroup>
        ) : (
          // 属性**不跟场景绑定**：打开着项目就总有东西可看（没有场景时看项目自身的属性）
          projectOpen ? <ProjectProperties /> : <EmptyState />
        )}
      </div>
    </div>
  );
}


/**
 * 选中资源文件时的属性视图。
 *
 * 图片 / 视频 / 音频额外给预览（图片还会读出真实像素尺寸——那是贴图最有用的属性）。
 * 预览直接用后端的原始字节接口，所以「提交到目录里的素材」能立刻看到，不需要先导入。
 *
 * **音频在这里**就地改**显示名**（v17 起）与**标签**（v18 起：tag 是整数、名字住在标签表里）——
 * 曾经另有一个「音频文件」列表窗口做这件事，但「选中哪个就改哪个」本来就是这个面板的用法，
 * 多一个窗口只是让人多跳一次（v18 删掉）。「名称」那一行始终是**真实文件名**：
 * 这个面板同时也在回答「这到底是盘上的哪个文件」。
 */
function AssetProperties({
  asset,
  spriteIndex,
}: {
  readonly asset: ResourceTreeNode;
  readonly spriteIndex?: number;
}): React.JSX.Element {
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [spriteEditorOpen, setSpriteEditorOpen] = useState(false);
  // 音频文件的显示名与标签住在**那个文件自己的 `.meta`** 里（v24 起），标签名仍在工程文件的表里；
  // 标签**任何素材**都能打（图 / 声 / 视频）：读统一走 `assetTagsOfMeta`
  const metaTable = useEditorStore((state) => state.assetMetaTable);
  // 精灵相关的三件事（类型 / 模式 / 切分）全在**这个素材自己的 `.meta`** 里（v23 起）
  const assetMetas = useEditorStore((state) => state.assetMetas);
  const setSpriteImportSettings = useEditorStore((state) => state.setSpriteImportSettings);
  const table = useEditorStore((state) => state.doc.audioTags);
  const preview = assetPreviewKind(asset.name);
  const src = `/api/resources/raw?id=${encodeURIComponent(asset.id)}`;
  const fileMeta = preview === null ? undefined : metaTable[asset.id];
  // 标签在文档里是**整数 ID**（tag 是整数、名字住在标签表里），界面上一律按名字显示
  const tags = tagsOfClip(table, assetTagsOfMeta(fileMeta));
  const assetMeta = metaOfImage(assetMetas, { id: asset.id });
  const sheet = spriteSheetOfMeta(assetMeta);
  const isSprite = isSpriteMeta(assetMeta);
  /**
   * 面板上的模式：meta 里 `mode` 与 `sheet` 是两个独立字段（`withMetaSpriteSheet` 明确
   * 「改切分不碰导入设置」），所以**有非 1×1 的切分就按 Multiple 显示**——否则在挑图窗口里
   * 切好的图集在这块面板上会退回 Single、「编辑」入口跟着消失（老编辑器里「只切了、没开精灵」
   * 也是按 Multiple 显示的）。1×1 不是切分（那是整图），照旧看 `mode`。
   */
  const spriteMode: "Single" | "Multiple" =
    spriteSettingsOfMeta(assetMeta).mode === "Multiple" || sheet.columns * sheet.rows > 1
      ? "Multiple"
      : "Single";
  const isMultipleSprite = isSprite && spriteMode === "Multiple";
  const spriteSheet = spriteIndex === undefined ? undefined : sheet;
  const spriteCellSize =
    spriteSheet === undefined || imageSize === null ? undefined : spriteCellSizeOf(spriteSheet, imageSize);

  return (
    <div data-testid="asset-properties">
      <FieldGroup title="资源" group="asset">
        <Field label="名称" value={spriteIndex === undefined ? asset.name : String(spriteIndex + 1)} />
        <Field label="路径" value={asset.path} mono />
        <Field label="类型" value={assetKindLabel(asset.name)} />
        {asset.size === undefined ? null : (
          <Field label="大小" value={formatSize(asset.size)} mono />
        )}
        {imageSize === null ? null : (
          <Field label="尺寸" value={`${imageSize.width} × ${imageSize.height}`} mono />
        )}
        {preview === null ? null : (
          <AudioTagsField assetId={asset.id} tags={tags} />
        )}
        {preview !== "audio" ? null : (
          <AudioDisplayNameField assetId={asset.id} fileName={asset.name} storedName={audioNameOfMeta(fileMeta) ?? ""} />
        )}
        {preview === "image" ? (
          <>
            <FieldRow label="精灵类型">
              <span className="min-w-0 flex-1 truncate text-[11px]">
                {isSprite ? "Sprite" : "按普通图片导入"}
              </span>
              <input
                type="checkbox"
                data-testid="sprite-type-toggle"
                checked={isSprite}
                aria-label="启用精灵"
                title={isSprite ? "按精灵导入" : "按普通图片导入"}
                className="h-3.5 w-3.5 flex-none accent-[var(--color-editor-accent)]"
                onChange={(event) => {
                  setSpriteImportSettings(
                    asset.id,
                    event.target.checked
                      ? { type: "Sprite", mode: spriteMode }
                      : null,
                  );
                }}
              />
            </FieldRow>
            {isSprite ? (
            <>
              <FieldRow label="模式">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <select
                    data-testid="sprite-import-mode"
                    value={spriteMode}
                    aria-label="精灵模式"
                    className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 text-[11px]"
                    onChange={(event) =>
                      setSpriteImportSettings(asset.id, {
                        type: "Sprite",
                        mode: event.target.value as "Single" | "Multiple",
                      })
                    }
                  >
                    <option value="Single">Single</option>
                    <option value="Multiple">Multiple</option>
                  </select>
                  {isMultipleSprite ? (
                    <button
                      type="button"
                      data-testid="sprite-edit"
                      className="toolbar-button flex-none hover:toolbar-button-hover"
                      onClick={() => setSpriteEditorOpen(true)}
                    >
                      编辑
                    </button>
                  ) : null}
                </div>
              </FieldRow>
              <div className="px-2 pb-1 pl-[5.5rem] text-[10px] leading-4 text-[var(--color-editor-text-dim)]">
                {spriteMode === "Single" ? "整张图片作为一个精灵" : "按网格切分为多个精灵"}
              </div>
            </>
            ) : null}
          </>
        ) : null}
      </FieldGroup>

      {preview === "image" ? (
        <>
          {spriteIndex === undefined || spriteSheet === undefined ? (
            <img
              src={src}
              alt={asset.name}
              data-testid="asset-preview-image"
              className="max-h-40 w-full rounded border border-[var(--color-editor-border)] bg-black/20 object-contain"
              onLoad={(event) =>
                setImageSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
            />
          ) : (
            <>
              <img
                src={src}
                alt=""
                className="hidden"
                onLoad={(event) =>
                  setImageSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
              />
              <div
                data-testid="sprite-asset-preview"
                aria-label={`精灵 ${spriteIndex + 1}`}
                className="w-full rounded border border-[var(--color-editor-border)] bg-black/20 bg-no-repeat"
                style={{
                  aspectRatio:
                    spriteCellSize === undefined
                      ? `${spriteSheet.columns} / ${spriteSheet.rows}`
                      : `${spriteCellSize.width} / ${spriteCellSize.height}`,
                  backgroundImage: `url(${assetRawUrl(asset.id)})`,
                  backgroundSize: `${spriteSheet.columns * 100}% ${spriteSheet.rows * 100}%`,
                  backgroundPosition: spriteBackgroundPosition(spriteIndex, spriteSheet.columns, spriteSheet.rows),
                }}
              />
            </>
          )}
        </>
      ) : null}

      {preview === "video" ? (
        <video
          src={src}
          controls
          data-testid="asset-preview-video"
          className="w-full rounded border border-[var(--color-editor-border)]"
        />
      ) : null}

      {preview === "audio" ? (
        <audio src={src} controls data-testid="asset-preview-audio" className="w-full" />
      ) : null}
      {preview === "image" ? (
        <SpriteEditorDialog
          open={spriteEditorOpen}
          imageId={asset.id}
          imageSize={imageSize ?? undefined}
          onClose={() => setSpriteEditorOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** 音频的**显示名**：就地改（Enter / 失焦提交、Esc 还原）；留空 = 退回素材文件名。 */
function spriteBackgroundPosition(index: number, columns: number, rows: number): string {
  const column = index % columns;
  const row = Math.floor(index / columns);
  const x = columns <= 1 ? 0 : (column * 100) / (columns - 1);
  const y = rows <= 1 ? 0 : (row * 100) / (rows - 1);
  return `${x}% ${y}%`;
}

function AudioDisplayNameField({
  assetId,
  fileName,
  storedName,
}: {
  readonly assetId: string;
  readonly fileName: string;
  readonly storedName: string;
}): React.JSX.Element {
  const setAudioName = useEditorStore((state) => state.setAudioName);
  const [draft, setDraft] = useState(storedName);

  useEffect(() => {
    setDraft(storedName);
  }, [assetId, storedName]);

  const commit = (): void => {
    if (draft.trim() === storedName.trim()) {
      setDraft(storedName);
      return;
    }

    setAudioName(assetId, draft);
  };

  return (
    <FieldRow label="显示名">
      <input
        data-testid="asset-audio-name"
        value={draft}
        placeholder={fileName}
        aria-label="音频显示名"
        title="给这个音频文件起个好认的名字（留空 = 用素材文件名）；只是编辑器里给人看 / 找的"
        className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 text-[11px] outline-none placeholder:text-[var(--color-editor-text-dim)]"
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
    </FieldRow>
  );
}

/**
 * 素材的**标签**（任何文件都能打）：已勾的按名字列成 chip（`×` = 只从这个文件上摘掉），
 * 「＋」打开**选择标签**框（给这个文件勾 / 去、也能现建一个），
 * 「标签…」打开**标签表**（新建 / 改名 / 删除——改名字只改表）。
 */
function AudioTagsField({
  assetId,
  tags,
}: {
  readonly assetId: string;
  readonly tags: readonly AudioTagRef[];
}): React.JSX.Element {
  const setAssetTags = useEditorStore((state) => state.setAssetTags);
  const openAudioTags = useEditorStore((state) => state.openAudioTags);
  const [picking, setPicking] = useState(false);

  return (
    <>
      <FieldRow label="标签">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" data-testid="asset-audio-tags">
          {tags.length === 0 ? (
            <span className="text-[11px] text-[var(--color-editor-text-dim)]">（没有标签）</span>
          ) : null}

          {tags.map((tag) => (
            <span
              key={tag.id}
              data-testid="asset-audio-tag"
              data-id={tag.id}
              data-tag={tag.name}
              className="flex flex-none items-center gap-1 rounded-full border border-[var(--color-editor-border)] px-1.5 py-0.5 text-[10px]"
            >
              <span title={`tag ID = ${tag.id}`}>{tag.name}</span>
              <button
                type="button"
                data-testid="asset-audio-tag-remove"
                data-id={tag.id}
                aria-label={`从这个文件上摘掉标签 ${tag.name}`}
                title={`摘掉「${tag.name}」`}
                className="text-[var(--color-editor-text-dim)] hover:text-[var(--color-editor-danger)]"
                onClick={() =>
                  setAssetTags(
                    assetId,
                    tags.filter((item) => item.id !== tag.id).map((item) => item.id),
                  )
                }
              >
                ×
              </button>
            </span>
          ))}

          {/*
            只放一个「＋」，但**画大一点**：这里就是个入口，旁边那一串 chip 已经说明了
            「这是标签」；小号的 ＋ 在平板上很难点准。无文字，所以补上 aria-label。
          */}
          <button
            type="button"
            data-testid="asset-audio-add-tag"
            aria-label="加标签"
            title="加标签"
            className="flex h-6 w-6 flex-none items-center justify-center rounded border border-dashed border-[var(--color-editor-border)] text-[15px] leading-none text-[var(--color-editor-text-dim)] hover:border-[var(--color-editor-accent)] hover:text-[var(--color-editor-text)]"
            onClick={() => setPicking(true)}
          >
            ＋
          </button>
        </div>
      </FieldRow>

      <FieldRow label="">
        <button
          type="button"
          data-testid="asset-audio-open-tags"
          title="标签表"
          className="toolbar-button flex-none hover:toolbar-button-hover"
          onClick={() => openAudioTags(true)}
        >
          标签…
        </button>
      </FieldRow>

      {/* 选择标签：挂在这个面板上（`AssetProperties` 按资源 id 挂了 key，换文件时自动收起） */}
      <AudioTagDialog assetId={picking ? assetId : null} onClose={() => setPicking(false)} />
    </>
  );
}

/** 资源树里的文件数（项目属性用）。 */
function countFiles(nodes: readonly ResourceTreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.type === "file") {
      total += 1;
    } else {
      total += countFiles(node.children ?? []);
    }
  }

  return total;
}

/**
 * 没选任何东西时的项目属性。
 *
 * 属性面板**不跟场景绑定**：只要打开着项目就有内容可看，没有场景也不该是空白。
 */
function ProjectProperties(): React.JSX.Element {
  const doc = useEditorStore((state) => state.doc);
  const folder = useEditorStore((state) => state.project.current);
  const scenes = useEditorStore((state) => state.scenes);
  const tree = useEditorStore((state) => state.project.tree);

  return (
    <div data-testid="project-properties">
      <FieldGroup title="项目" group="project">
        <Field label="名称" value={doc.name} />
        <Field label="文件夹" value={folder ?? "—"} mono />
        <Field label="场景" value={`${scenes.length} 个`} />
        <Field label="资源文件" value={`${countFiles(tree)} 个`} />
      </FieldGroup>
    </div>
  );
}
