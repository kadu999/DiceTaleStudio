import type { ReactNode } from "react";
import { COMPONENT_TYPE } from "@dts/protocol";
import {
  OBJECT_SPEC,
  componentOf,
  canRepairObjectComponent,
  hasComponentKindMismatch,
  mapDataOf,
  supportsFog,
  supportsObjectComponent,
  supportsVideo,
  type ComponentType,
  type GameObjectDoc,
} from "@dts/document";
import { Field, FieldRow } from "./fields";
import { FogFields } from "./FogFields";
import { GridAnnotationFields } from "./GridAnnotationFields";
import { SoundFields } from "./SoundFields";
import { TeleportFields } from "./TeleportFields";
import { VideoFields } from "./VideoFields";
import {
  ActiveField,
  CellSizeField,
  GridDisplayField,
  GridFields,
  LockedField,
  NameField,
  PositionFields,
  RotationField,
  ScaleField,
  SortingOrderField,
  TextureField,
} from "./object-fields";
import { descriptorRows, objectFields, sortInspectorRows } from "./DescriptorRows";
import { useEditorStore } from "../../state/editor-store";

export interface EditorPanelDef {
  readonly group: string;
  readonly title: string;
  readonly render: (object: GameObjectDoc) => ReactNode;
}

export interface ComponentEditorDef {
  readonly type: ComponentType;
  readonly panels: readonly EditorPanelDef[];
  readonly availableWithoutComponent: (object: GameObjectDoc) => boolean;
}

export const OBJECT_EDITOR: EditorPanelDef = {
  group: "basic",
  title: "基础",
  render: (object) => (
    <>
      <NameField object={object} />
      <Field label="类型" value={object.kind} />
      <ActiveField object={object} />
      <LockedField object={object} />
      {sortInspectorRows(descriptorRows(object, OBJECT_SPEC, objectFields)).map((row) => row.node)}
      <PositionFields object={object} />
      <ScaleField object={object} />
      <RotationField object={object} />
    </>
  ),
};

const hasComponent = (object: GameObjectDoc, type: ComponentType): boolean =>
  componentOf(object, type) !== undefined;

/**
 * 缺图片组件时是否给「图片层 / 精灵层」能力入口。
 *
 * 判据就是「这个对象能不能显式修复出这个组件」：精灵 / 贴图 / 玩家 / 道具 / 事件都在各自的
 * `repairKinds` 里。已经挂着图片组件的对象不走这里（组由 `hasComponent` 直接命中）。
 */
function imageFallback(object: GameObjectDoc, type: ComponentType): boolean {
  return canRepairObjectComponent(object, type);
}

function panel(group: string, title: string, render: EditorPanelDef["render"]): EditorPanelDef {
  return { group, title, render };
}

function ComponentRepairAction({
  object,
  type,
}: {
  readonly object: GameObjectDoc;
  readonly type: "PlaySound" | "Teleport" | "FogOfWar";
}): React.JSX.Element {
  const repair = useEditorStore((state) => state.repairObjectComponent);
  const name = type === "PlaySound" ? "声音" : type === "Teleport" ? "传送" : "战争雾";
  return (
    <div className="flex items-center gap-2 px-2 py-2">
      <span className="min-w-0 flex-1 text-[11px] text-[var(--color-editor-warn)]">组件数据缺失</span>
      <button
        type="button"
        data-testid={`repair-component-${type}`}
        className="flex-none rounded border border-[var(--color-editor-border)] px-2 py-1 text-[11px] hover:bg-[var(--color-editor-panel-alt)]"
        onClick={() => repair(object.id, type)}
      >
        修复{name}组件
      </button>
    </div>
  );
}

/**
 * 「网格」是 v28 起的**可选能力**（像「视频」）：没加时给一个「添加网格」入口，
 * 加完它就是「网格地图」（贴图 + 网格数据，没有独立的对象类型）。
 */
function AddGridAction({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
  const addGrid = useEditorStore((state) => state.addObjectGridMap);
  return (
    <div className="flex items-center gap-2 px-2 py-2">
      <span className="min-w-0 flex-1 text-[11px] text-[var(--color-editor-text-dim)]">
        还没有网格
      </span>
      <button
        type="button"
        data-testid="add-grid-map"
        title="按这张贴图的尺寸建一份网格；加完就能在网格编辑窗口里涂格子"
        className="flex-none rounded bg-[var(--color-editor-accent)] px-2 py-0.5 text-[11px] text-black hover:opacity-90"
        onClick={() => addGrid(object.id)}
      >
        添加网格
      </button>
    </div>
  );
}

/** 把贴图上的网格摘掉（对象回到普通贴图）。 */
function RemoveGridAction({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
  const removeGrid = useEditorStore((state) => state.removeObjectGridMap);
  return (
    <FieldRow label="网格">
      <button
        type="button"
        data-testid="remove-grid-map"
        title="移除网格数据（对象回到普通贴图）；格子数据会一起删掉"
        className="flex-none rounded border border-[var(--color-editor-border)] px-2 py-0.5 text-[11px] hover:bg-[var(--color-editor-panel-alt)]"
        onClick={() => removeGrid(object.id)}
      >
        移除网格
      </button>
    </FieldRow>
  );
}

/**
 * 组件编辑器表：**一个组件一个组**（组 slug = 组件槽位语义、标题 = 组件 displayName）。
 *
 * 「基础」组（`OBJECT_EDITOR`）是**实体属性**（不进组件）；每个组件编辑器的 `panels`
 * 只剩一个面板。`availableWithoutComponent` 命中的组是**能力入口**（未添加时的开关 /
 * 选图 / 添加 / 修复），InspectorPanel 会给它们挂「未添加」角标。
 */
export const COMPONENT_EDITORS: readonly ComponentEditorDef[] = [
  {
    type: COMPONENT_TYPE.image,
    availableWithoutComponent: (object) => imageFallback(object, COMPONENT_TYPE.image),
    panels: [
      panel("image", "图片层", (object) => (
        <>
          <TextureField object={object} />
          <SortingOrderField object={object} />
        </>
      )),
    ],
  },
  {
    type: COMPONENT_TYPE.sprite,
    availableWithoutComponent: (object) => imageFallback(object, COMPONENT_TYPE.sprite),
    panels: [
      panel("sprite", "精灵层", (object) => (
        <>
          <TextureField object={object} />
          <SortingOrderField object={object} />
        </>
      )),
    ],
  },
  {
    type: COMPONENT_TYPE.map,
    availableWithoutComponent: (object) => supportsObjectComponent(object, COMPONENT_TYPE.map),
    panels: [
      panel("map", "网格地图", (object) =>
        mapDataOf(object) === undefined ? (
          // 网格是可选能力（v28）：没加时只给「添加网格」入口
          <AddGridAction object={object} />
        ) : (
          <>
            <GridFields object={object} />
            <CellSizeField object={object} />
            <Field label="行序" value={mapDataOf(object)?.rowOrder ?? ""} mono />
            <GridDisplayField />
            <GridAnnotationFields object={object} />
            <RemoveGridAction object={object} />
          </>
        ),
      ),
    ],
  },
  {
    // 战争雾（v27 起是独立的 `Fog` 对象）：组件就是它的数据本体，组照常出现；
    // 缺组件（损坏的手写文件）时给显式修复入口。
    type: COMPONENT_TYPE.fog,
    availableWithoutComponent: (object) => supportsFog(object),
    panels: [
      panel("fog", "战争雾", (object) =>
        componentOf(object, COMPONENT_TYPE.fog) === undefined ? (
          <ComponentRepairAction object={object} type="FogOfWar" />
        ) : (
          <FogFields object={object} />
        ),
      ),
    ],
  },
  {
    type: COMPONENT_TYPE.sound,
    availableWithoutComponent: (object) =>
      supportsObjectComponent(object, COMPONENT_TYPE.sound) ||
      canRepairObjectComponent(object, COMPONENT_TYPE.sound),
    panels: [
      panel("sound", "播放声音", (object) =>
        componentOf(object, COMPONENT_TYPE.sound) === undefined ? (
          <ComponentRepairAction object={object} type="PlaySound" />
        ) : (
          <SoundFields object={object} />
        ),
      ),
    ],
  },
  {
    type: COMPONENT_TYPE.teleport,
    availableWithoutComponent: (object) =>
      supportsObjectComponent(object, COMPONENT_TYPE.teleport) ||
      canRepairObjectComponent(object, COMPONENT_TYPE.teleport),
    panels: [
      panel("teleport", "传送阵", (object) =>
        componentOf(object, COMPONENT_TYPE.teleport) === undefined ? (
          <ComponentRepairAction object={object} type="Teleport" />
        ) : (
          <TeleportFields object={object} />
        ),
      ),
    ],
  },
  {
    type: COMPONENT_TYPE.video,
    availableWithoutComponent: (object) => supportsVideo(object),
    panels: [panel("video", "视频", (object) => <VideoFields object={object} />)],
  },
];

/**
 * Attached components drive editing; explicit repair and optional capability paths expose missing-instance entry points.
 *
 * 返回的每个编辑器只带**一个**面板（「一个组件一个组」）；组件缺失时的过滤只看
 * 「实例在不在 / 准入允不允许」。v28 起带网格的贴图也用图片层，所以不再为它屏蔽图片组
 * （精灵组对它本来就不会命中：`SpriteLayer.repairKinds` 里没有 `Image`）。
 */
export function componentEditorsFor(object: GameObjectDoc): readonly ComponentEditorDef[] {
  const missingComponentEntryAllowed = !hasComponentKindMismatch(object);
  return COMPONENT_EDITORS.filter(
    (editor) =>
      hasComponent(object, editor.type) ||
      (missingComponentEntryAllowed && editor.availableWithoutComponent(object)),
  );
}
