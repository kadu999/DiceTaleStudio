import type { ReactNode } from "react";
import { COMPONENT_TYPE } from "@dts/protocol";
import {
  OBJECT_SPEC,
  DEFAULT_SLOT_COMPONENT,
  componentOf,
  canRepairObjectComponent,
  hasComponentKindMismatch,
  mapDataOf,
  objectImageSlot,
  supportsFog,
  supportsObjectComponent,
  supportsVideo,
  type ComponentType,
  type GameObjectDoc,
} from "@dts/document";
import { Field } from "./fields";
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

function imageFallback(object: GameObjectDoc, type: ComponentType): boolean {
  return objectImageSlot(object) !== "map" && mapDataOf(object) === undefined &&
    canRepairObjectComponent(object, type);
}

function panel(group: string, title: string, render: EditorPanelDef["render"]): EditorPanelDef {
  return { group, title, render };
}

function ComponentRepairAction({
  object,
  type,
}: {
  readonly object: GameObjectDoc;
  readonly type: "PlaySound" | "Teleport";
}): React.JSX.Element {
  const repair = useEditorStore((state) => state.repairObjectComponent);
  const name = type === "PlaySound" ? "声音" : "传送";
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
 * 组件编辑器表：**一个组件一个组**（组 slug = 组件槽位语义、标题 = 组件 displayName）。
 *
 * 「基础」组（`OBJECT_EDITOR`）是**实体属性**（不进组件）；每个组件编辑器的 `panels`
 * 只剩一个面板——分组声明里不再出现一个组件拆多组（GridMap 的渲染/区域已合并，
 * 战争雾 v25 起是独立的 `FogOfWar` 组件）。`availableWithoutComponent` 命中的组是
 * **能力入口**（未添加时的开关 / 选图 / 修复），InspectorPanel 会给它们挂「未添加」角标。
 */
export const COMPONENT_EDITORS: readonly ComponentEditorDef[] = [
  {
    type: COMPONENT_TYPE.image,
    availableWithoutComponent: (object) => imageFallback(object, COMPONENT_TYPE.image),
    panels: [panel("image", "图片层", (object) => <TextureField object={object} />)],
  },
  {
    type: COMPONENT_TYPE.sprite,
    availableWithoutComponent: (object) => imageFallback(object, COMPONENT_TYPE.sprite),
    panels: [panel("sprite", "精灵层", (object) => <TextureField object={object} />)],
  },
  {
    type: COMPONENT_TYPE.map,
    availableWithoutComponent: (object) =>
      mapDataOf(object) !== undefined || canRepairObjectComponent(object, COMPONENT_TYPE.map),
    panels: [
      panel("map", "网格地图", (object) =>
        mapDataOf(object) === undefined ? (
          // 地图数据缺失但可修复：只给换贴图那一行（与旧「只留渲染组」同一口径）；
          // 网格规格那些行对着 undefined 的地图数据渲染没有意义
          <TextureField object={object} />
        ) : (
          <>
            <TextureField object={object} />
            <GridFields object={object} />
            <CellSizeField object={object} />
            <Field label="行序" value={mapDataOf(object)?.rowOrder ?? ""} mono />
            <GridDisplayField />
            <GridAnnotationFields object={object} />
          </>
        ),
      ),
    ],
  },
  {
    // 战争雾（v25 起是独立的 `FogOfWar` 组件，从属 `GridMap`）：没开过时组件不存在，
    // 组照常出现（与「视频」组同一交互），打开开关才建组件。
    type: COMPONENT_TYPE.fog,
    availableWithoutComponent: (object) => supportsFog(object) && mapDataOf(object) !== undefined,
    panels: [panel("fog", "战争雾", (object) => <FogFields object={object} />)],
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
 * 「实例在不在 / 准入允不允许」，不再按面板裁减。
 */
export function componentEditorsFor(object: GameObjectDoc): readonly ComponentEditorDef[] {
  const hasMap = componentOf(object, DEFAULT_SLOT_COMPONENT.map) !== undefined;
  const canRepairMap = canRepairObjectComponent(object, DEFAULT_SLOT_COMPONENT.map);
  const missingComponentEntryAllowed = !hasComponentKindMismatch(object);
  return COMPONENT_EDITORS.filter((editor) => {
    if ((hasMap || canRepairMap) && (editor.type === COMPONENT_TYPE.image || editor.type === COMPONENT_TYPE.sprite)) return false;
    return hasComponent(object, editor.type) || (missingComponentEntryAllowed && editor.availableWithoutComponent(object));
  });
}
