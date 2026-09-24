import type { ReactNode } from "react";
import { COMPONENT_TYPE } from "@dts/protocol";
import {
  OBJECT_SPEC,
  carriesComponent,
  componentForSlot,
  componentOf,
  mapDataOf,
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

export interface EditorPanelDef {
  readonly group: string;
  readonly title: string;
  readonly render: (object: GameObjectDoc) => ReactNode;
}

export interface ComponentEditorDef {
  readonly type: ComponentType;
  readonly panels: readonly EditorPanelDef[];
  readonly legacyFallback: (object: GameObjectDoc) => boolean;
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
  return (
    mapDataOf(object) === undefined &&
    carriesComponent(type, object.kind) &&
    componentForSlot("image", object.kind) === type
  );
}

function legacyFallbackAllowed(object: GameObjectDoc): boolean {
  return object.components.every((component) => {
    const editor = COMPONENT_EDITORS.find((candidate) => candidate.type === component.type);
    return editor === undefined || carriesComponent(editor.type, object.kind);
  });
}

function panel(group: string, title: string, render: EditorPanelDef["render"]): EditorPanelDef {
  return { group, title, render };
}

export const COMPONENT_EDITORS: readonly ComponentEditorDef[] = [
  {
    type: COMPONENT_TYPE.image,
    legacyFallback: (object) => imageFallback(object, COMPONENT_TYPE.image),
    panels: [panel("render", "渲染", (object) => <TextureField object={object} />)],
  },
  {
    type: COMPONENT_TYPE.sprite,
    legacyFallback: (object) => imageFallback(object, COMPONENT_TYPE.sprite),
    panels: [panel("render", "渲染", (object) => <TextureField object={object} />)],
  },
  {
    type: COMPONENT_TYPE.map,
    legacyFallback: (object) => mapDataOf(object) !== undefined || carriesComponent(COMPONENT_TYPE.map, object.kind),
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
    legacyFallback: (object) => carriesComponent(COMPONENT_TYPE.sound, object.kind),
    panels: [panel("sound", "声音", (object) => <SoundFields object={object} />)],
  },
  {
    type: COMPONENT_TYPE.teleport,
    legacyFallback: (object) => carriesComponent(COMPONENT_TYPE.teleport, object.kind),
    panels: [panel("teleport", "传送", (object) => <TeleportFields object={object} />)],
  },
  {
    type: COMPONENT_TYPE.video,
    legacyFallback: (object) => supportsVideo(object.kind),
    panels: [panel("video", "视频", (object) => <VideoFields object={object} />)],
  },
];

/** Actual component instances drive editing; kind is only a temporary fallback for missing legacy data. */
export function componentEditorsFor(object: GameObjectDoc): readonly ComponentEditorDef[] {
  const allowLegacyFallback = legacyFallbackAllowed(object);
  return COMPONENT_EDITORS.filter(
    (editor) => hasComponent(object, editor.type) || (allowLegacyFallback && editor.legacyFallback(object)),
  );
}
