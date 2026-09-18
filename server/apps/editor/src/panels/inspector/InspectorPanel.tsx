import { useState } from "react";
import type { ResourceTreeNode } from "../../services/project-api";
import { findResourceNode, useEditorStore } from "../../state/editor-store";
import { assetKindLabel, assetPreviewKind, formatSize } from "../asset-info";
import { EmptyState } from "../EmptyState";

/** 右侧属性面板：当前选中对象 / 场景 / **资源文件**的属性。编辑能力在 M2/M3 接入。 */
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
  const asset =
    selectedAssetId === null
      ? undefined
      : findResourceNode(tree, (node) => node.id === selectedAssetId);

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
          <AssetProperties key={asset.id} asset={asset} />
        ) : selected !== undefined ? (
          <FieldGroup title="对象">
            <Field label="名称" value={selected.name} />
            <Field label="ID" value={selected.id} mono />
            <Field label="类型" value={selected.kind} />
            <Field
              label="位置"
              value={
                selected.position === null
                  ? "未放置"
                  : `${selected.position.x.toFixed(3)}, ${selected.position.y.toFixed(3)}`
              }
              mono
            />
            <Field label="组件" value={String(selected.components.length)} />
            {selected.map !== undefined ? (
              <>
                <Field label="贴图" value={selected.map.image.id} mono />
                <Field
                  label="网格"
                  value={`${selected.map.grid.width} × ${selected.map.grid.height}`}
                  mono
                />
                <Field label="每格尺寸" value={String(selected.map.grid.cellSize)} mono />
                <Field label="行序" value={selected.map.rowOrder} mono />
              </>
            ) : null}
          </FieldGroup>
        ) : activeScene !== undefined ? (
          <FieldGroup title="场景">
            <Field label="名称" value={activeScene.name} />
            <Field label="对象" value={String(activeScene.objects.length)} />
            <Field
              label="地图对象"
              value={
                activeScene.objects.some((object) => object.kind === "Map")
                  ? `${activeScene.objects.filter((object) => object.kind === "Map").length} 个`
                  : "无（对象不依赖地图，可直接添加）"
              }
            />
          </FieldGroup>
        ) : (
          // 属性**不跟场景绑定**：打开着项目就总有东西可看（没有场景时看项目自身的属性）
          projectOpen ? <ProjectProperties /> : <EmptyState />
        )}
      </div>
    </div>
  );
}

function FieldGroup({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="mb-3">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-editor-text-dim)]">{title}</div>
      <div className="overflow-hidden rounded border border-[var(--color-editor-border)]">{children}</div>
    </section>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--color-editor-border)] px-2 py-1 last:border-b-0">
      <span className="w-20 flex-none text-[11px] text-[var(--color-editor-text-dim)]">{label}</span>
      <span className={`min-w-0 flex-1 truncate ${mono ? "font-mono text-[11px]" : ""}`}>{value}</span>
    </div>
  );
}

/**
 * 选中资源文件时的属性视图。
 *
 * 图片 / 视频 / 音频额外给预览（图片还会读出真实像素尺寸——那是贴图最有用的属性）。
 * 预览直接用后端的原始字节接口，所以「提交到目录里的素材」能立刻看到，不需要先导入。
 */
function AssetProperties({ asset }: { readonly asset: ResourceTreeNode }): React.JSX.Element {
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const preview = assetPreviewKind(asset.name);
  const src = `/api/resources/raw?id=${encodeURIComponent(asset.id)}`;

  return (
    <div data-testid="asset-properties">
      <FieldGroup title="资源">
        <Field label="名称" value={asset.name} />
        <Field label="路径" value={asset.path} mono />
        <Field label="类型" value={assetKindLabel(asset.name)} />
        {asset.size === undefined ? null : (
          <Field label="大小" value={formatSize(asset.size)} mono />
        )}
        {imageSize === null ? null : (
          <Field label="尺寸" value={`${imageSize.width} × ${imageSize.height}`} mono />
        )}
      </FieldGroup>

      {preview === "image" ? (
        <img
          src={src}
          alt={asset.name}
          data-testid="asset-preview-image"
          className="max-h-64 w-full rounded border border-[var(--color-editor-border)] bg-black/20 object-contain"
          onLoad={(event) =>
            setImageSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
        />
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
    </div>
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
      <FieldGroup title="项目">
        <Field label="名称" value={doc.name} />
        <Field label="文件夹" value={folder ?? "—"} mono />
        <Field label="场景" value={`${scenes.length} 个`} />
        <Field label="资源文件" value={`${countFiles(tree)} 个`} />
      </FieldGroup>
    </div>
  );
}
