import type { ReactNode } from "react";
import { COMPONENT_TYPE } from "@dts/protocol";
import {
  OBJECT_SPEC,
  DEFAULT_SLOT_COMPONENT,
  componentOf,
  canRepairObjectComponent,
  hasComponentKindMismatch,
  mapDataOf,
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
  return mapDataOf(object) === undefined && supportsObjectComponent(object, type);
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

export const COMPONENT_EDITORS: readonly ComponentEditorDef[] = [
  {
    type: COMPONENT_TYPE.image,
    availableWithoutComponent: (object) => imageFallback(object, COMPONENT_TYPE.image),
    panels: [panel("render", "渲染", (object) => <TextureField object={object} />)],
  },
  {
    type: COMPONENT_TYPE.sprite,
    availableWithoutComponent: (object) => imageFallback(object, COMPONENT_TYPE.sprite),
    panels: [panel("render", "渲染", (object) => <TextureField object={object} />)],
  },
  {
    type: COMPONENT_TYPE.map,
    availableWithoutComponent: (object) => mapDataOf(object) !== undefined || supportsObjectComponent(object, COMPONENT_TYPE.map),
    panels: [
      panel("render", "渲染", (object) => <TextureField object={object} />),
      panel("edit", "区域", (object) => (
        <>
          <GridFields object={object} />
          <CellSizeField object={object} />
          <Field label="行序" value={mapDataOf(object)?.rowOrder ?? ""} mono />
          <GridDisplayField />
          <GridAnnotationFields object={object} />
        </>
      )),
      panel("fog", "战争雾", (object) => <FogFields object={object} />),
    ],
  },
  {
    type: COMPONENT_TYPE.sound,
    availableWithoutComponent: (object) =>
      supportsObjectComponent(object, COMPONENT_TYPE.sound) ||
      canRepairObjectComponent(object, COMPONENT_TYPE.sound),
    panels: [
      panel("sound", "声音", (object) =>
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
      panel("teleport", "传送", (object) =>
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

/** Attached components drive editing; explicit repair and optional capability paths expose missing-instance entry points. */
export function componentEditorsFor(object: GameObjectDoc): readonly ComponentEditorDef[] {
  const hasMap = componentOf(object, DEFAULT_SLOT_COMPONENT.map) !== undefined;
  const missingComponentEntryAllowed = !hasComponentKindMismatch(object);
  return COMPONENT_EDITORS.filter((editor) => {
    if (hasMap && (editor.type === COMPONENT_TYPE.image || editor.type === COMPONENT_TYPE.sprite)) return false;
    return hasComponent(object, editor.type) || (missingComponentEntryAllowed && editor.availableWithoutComponent(object));
  });
}
