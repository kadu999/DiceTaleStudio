import { useEffect, useRef, useState } from "react";
import type { SceneObjectDoc } from "@dts/document";
import type { ResourceTreeNode } from "../../services/project-api";
import { findResourceNode, useEditorStore } from "../../state/editor-store";
import { assetDisplayPath, findAssetById } from "../asset-picker";
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
          // 对象视图只列**人要用它做决定**的字段：内部标识（id）与组件数量不显示——
          // id 是一串机器 id、组件数现在恒为 0，两者都只会占地方。
          <div data-testid="object-properties">
            <FieldGroup title="对象">
              <NameField object={selected} />
              <Field label="类型" value={selected.kind} />
              <PositionFields object={selected} />
              {selected.map !== undefined ? (
                <>
                  <TextureField object={selected} />
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
          </div>
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
    <FieldRow label={label}>
      <span className={`min-w-0 flex-1 truncate ${mono ? "font-mono text-[11px]" : ""}`}>{value}</span>
    </FieldRow>
  );
}

/** 属性行：标签 + 任意内容（只读值或输入框共用同一套排布）。 */
function FieldRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--color-editor-border)] px-2 py-1 last:border-b-0">
      <span className="w-20 flex-none text-[11px] text-[var(--color-editor-text-dim)]">{label}</span>
      {children}
    </div>
  );
}

/** 对象名称：就地改名（Enter / 失焦提交，Esc 还原）。 */
function NameField({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  const renameObject = useEditorStore((state) => state.renameObject);
  const [draft, setDraft] = useState(object.name);

  // 选中的对象换了、或名字在别处被改（例如列表内联改名），输入框跟着走
  useEffect(() => {
    setDraft(object.name);
  }, [object.id, object.name]);

  const commit = (): void => {
    if (draft.trim() === object.name) {
      return;
    }

    if (!renameObject(object.id, draft)) {
      // 名字非法（空）：退回原值，不要留下一个会被拒绝的输入
      setDraft(object.name);
    }
  };

  return (
    <FieldRow label="名称">
      <input
        value={draft}
        data-testid="inspector-object-name"
        className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 text-[11px] outline-none"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(object.name);
          }
        }}
      />
    </FieldRow>
  );
}

/**
 * 地图对象的贴图：显示**项目内相对路径**（`images/Map001.png`），后面跟一个「选择」按钮。
 *
 * 按钮唤出的是「选择贴图」弹框（对齐 Unity 的 Object Picker）——素材由外部提交到
 * `Assets/images/`，编辑器不导入，所以这里只负责从已有图片里挑。
 */
function TextureField({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  const tree = useEditorStore((state) => state.project.tree);
  const openImagePicker = useEditorStore((state) => state.openImagePicker);
  const image = object.map?.image;
  if (image === undefined) {
    return (
      <FieldRow label="贴图">
        <span className="flex-1 text-[11px] text-[var(--color-editor-text-dim)]">（无贴图数据）</span>
      </FieldRow>
    );
  }

  // 引用的文件不在项目里（素材没提交 / 改名了）：直接把这件事写出来
  const missing = findAssetById(tree, image.id) === undefined;

  return (
    <FieldRow label="贴图">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={image.id}>
        {assetDisplayPath(image.id)}
      </span>
      {missing ? (
        <span
          data-testid="texture-missing"
          className="flex-none text-[10px] text-[var(--color-editor-warn)]"
          title="项目里找不到这个文件：素材要提交到 Assets/images/ 下，或在这里换一张"
        >
          找不到
        </span>
      ) : null}
      <button
        type="button"
        data-testid="pick-texture"
        className="toolbar-button flex-none hover:toolbar-button-hover"
        onClick={() => openImagePicker(object.id)}
      >
        选择
      </button>
    </FieldRow>
  );
}

/**
 * 对象位置：**世界坐标**（场景中心为原点，x 向右、y 向上，单位像素）。
 *
 * 这是**精确**摆放的入口；粗略摆放直接拖画布上的标记点。
 *
 * 两条容易踩的坑，这里都避开了：
 * 1. **各自提交各自的字段**，另一个轴取对象当前值——不能用兄弟输入框的 state，
 *    否则「改完 x 再去改 y」时，x 的失焦提交会带上还没敲完的 y；
 * 2. **正在输入的框不被 store 回灌**，否则提交后触发的同步会把用户刚敲的值冲掉。
 *    留空或非法值按世界原点（场景正中）处理（手写文件里 `position: null` 的对象也能一键落位）。
 */
function PositionFields({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  const moveObject = useEditorStore((state) => state.moveObject);
  const xRef = useRef<HTMLInputElement>(null);
  const yRef = useRef<HTMLInputElement>(null);
  const [x, setX] = useState(formatCoordinate(object.position?.x));
  const [y, setY] = useState(formatCoordinate(object.position?.y));

  useEffect(() => {
    if (document.activeElement !== xRef.current) {
      setX(formatCoordinate(object.position?.x));
    }

    if (document.activeElement !== yRef.current) {
      setY(formatCoordinate(object.position?.y));
    }
  }, [object.id, object.position]);

  const commitX = (): void => {
    moveObject(object.id, {
      x: parseCoordinate(x),
      y: object.position?.y ?? WORLD_ORIGIN_FALLBACK,
    });
  };

  const commitY = (): void => {
    moveObject(object.id, {
      x: object.position?.x ?? WORLD_ORIGIN_FALLBACK,
      y: parseCoordinate(y),
    });
  };

  const onKeyDown = (commit: () => void) => (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      commit();
      event.currentTarget.blur();
    }
  };

  return (
    <FieldRow label="世界坐标">
      <input
        ref={xRef}
        value={x}
        data-testid="inspector-object-x"
        inputMode="decimal"
        type="number"
        step="1"
        placeholder={String(WORLD_ORIGIN_FALLBACK)}
        className="w-16 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 font-mono text-[11px] outline-none"
        onChange={(event) => setX(event.target.value)}
        onBlur={commitX}
        onKeyDown={onKeyDown(commitX)}
      />
      <input
        ref={yRef}
        value={y}
        data-testid="inspector-object-y"
        inputMode="decimal"
        type="number"
        step="1"
        placeholder={String(WORLD_ORIGIN_FALLBACK)}
        className="w-16 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 font-mono text-[11px] outline-none"
        onChange={(event) => setY(event.target.value)}
        onBlur={commitY}
        onKeyDown={onKeyDown(commitY)}
      />
      <span className="flex-none text-[10px] text-[var(--color-editor-text-dim)]">px</span>
    </FieldRow>
  );
}

/** 位置留空 / 非法时的落点：世界原点（= 场景正中）。 */
const WORLD_ORIGIN_FALLBACK = 0;

/** 位置输入框里的文本：没有位置时留空（提交时按世界原点处理）。 */
function formatCoordinate(value: number | undefined): string {
  return value === undefined ? "" : String(Math.round(value * 100) / 100);
}

/** 位置输入：留空或非法都按世界原点。 */
function parseCoordinate(raw: string): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : WORLD_ORIGIN_FALLBACK;
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
