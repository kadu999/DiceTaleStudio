import type { ReactNode } from "react";
import { COMPONENT_TYPE } from "@dts/protocol";
import {
  OBJECT_SPEC,
  canAddOptionalObjectComponent,
  canRepairObjectComponent,
  componentOf,
  mapDataOf,
  type ComponentType,
  type GameObjectDoc,
} from "@dts/document";
import { Field } from "./fields";
import { FogFields } from "./FogFields";
import { GridAnnotationFields } from "./GridAnnotationFields";
import { MagnifierFields } from "./MagnifierFields";
import { SoundFields } from "./SoundFields";
import { TeleportFields } from "./TeleportFields";
import { VideoFields } from "./VideoFields";
import { VideoBlendFields } from "./VideoBlendFields";
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

export interface EditorPanelDef {
  readonly group: string;
  readonly title: string;
  readonly render: (object: GameObjectDoc) => ReactNode;
}

export interface ComponentEditorDef {
  readonly type: ComponentType;
  readonly panels: readonly EditorPanelDef[];
  /**
   * **可选组件**（网格 / 视频 / 视频混合）：挂在对象上时，组头给一个「移除组件」。
   *
   * 非可移除组件（图片层 / 精灵层 / 声音 / 传送 / 战争雾）不给——需通过显式组件菜单添加。
   * 未挂上的可选组件**不出现组**，改由面板底部的「添加组件」列出（见 `addableComponentsFor`）。
   */
  readonly removable?: boolean;
}

export const OBJECT_EDITOR: EditorPanelDef = {
  group: "basic",
  title: "基础",
  render: (object) => (
    <>
      <NameField object={object} />
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

function panel(group: string, title: string, render: EditorPanelDef["render"]): EditorPanelDef {
  return { group, title, render };
}

/**
 * 组件编辑器表：**一个组件一个组**（组 slug = 组件槽位语义、标题 = 组件 displayName）。
 *
 * 「基础」组（`OBJECT_EDITOR`）是**实体属性**（不进组件）；每个组件编辑器的 `panels`
 * 只剩一个面板。**可选能力**（网格 / 视频）标 `removable`：
 * - 没挂上时**不出组**——入口在面板底部的「添加组件」（`addableComponentsFor`）；
 * - 挂上后是正式组，组头给「移除组件」。
 *
 * 尚未添加的组件统一从 InspectorPanel 底部的显式「添加组件」菜单添加。
 */
export const COMPONENT_EDITORS: readonly ComponentEditorDef[] = [
  {
    type: COMPONENT_TYPE.image,
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
    // 网格是可选的**能力组件**（v28）：挂上 = 网格地图。没挂时不出现组，
    // 改由面板底部的「添加组件」列出（可移除）。
    type: COMPONENT_TYPE.map,
    removable: true,
    panels: [
      panel("map", "网格地图", (object) => (
        <>
          <GridFields object={object} />
          <CellSizeField object={object} />
          <Field label="行序" value={mapDataOf(object)?.rowOrder ?? ""} mono />
          <GridDisplayField />
          <GridAnnotationFields object={object} />
        </>
      )),
    ],
  },
  {
    // 战争雾（v27 起是独立的 `Fog` 对象）：组件就是它的数据本体，组照常出现；
    // 缺组件（损坏的手写文件）时给显式修复入口。
    type: COMPONENT_TYPE.fog,
    panels: [
      panel("fog", "战争雾", (object) => <FogFields object={object} />),
    ],
  },
  {
    type: COMPONENT_TYPE.sound,
    panels: [
      panel("sound", "播放声音", (object) => <SoundFields object={object} />),
    ],
  },
  {
    type: COMPONENT_TYPE.teleport,
    panels: [
      panel("teleport", "传送阵", (object) => <TeleportFields object={object} />),
    ],
  },
  {
    // 放大镜（v30 的第三个动作对象）：组件就是它的数据本体（图片列表 + 当前展示的那一张），
    // 所以组照常出现；缺组件（损坏的手写文件）时给显式修复入口。与「传送阵」同一档。
    type: COMPONENT_TYPE.magnifier,
    panels: [
      panel("magnifier", "放大镜", (object) => <MagnifierFields object={object} />),
    ],
  },
  {
    // 视频是**可选能力**（像「网格」）：挂上才有这一组；没挂时不出现组，改由面板底部的
    // 「添加组件」列出。可移除（组头那枚按钮）。`enabled` 字段仍在数据里（添加时写 `true`），
    // 界面不再暴露开关。
    type: COMPONENT_TYPE.video,
    removable: true,
    panels: [panel("video", "视频", (object) => <VideoFields object={object} />)],
  },
  {
    // 视频混合也是**可选能力**：两条视频叠在同一矩形上用 Mask 混合（A 盖住、擦开露 B）。
    // 与「视频」各占一个槽位、可并存（校验会提醒）；可移除（组头那枚按钮）。
    type: COMPONENT_TYPE.videoBlend,
    removable: true,
    panels: [panel("videoBlend", "视频混合", (object) => <VideoBlendFields object={object} />)],
  },
];

/**
 * 返回该对象**该显示哪些组件组**：只展示实际挂载的组件。
 *
 * 「一个组件一个组」，每个编辑器只带一个面板。
 *
 * 缺失组件不是由 kind 推测出来的“故障”；用户可以从底部菜单显式添加所需组件。
 */
export function componentEditorsFor(object: GameObjectDoc): readonly ComponentEditorDef[] {
  return COMPONENT_EDITORS.filter((editor) => hasComponent(object, editor.type));
}

/** 「添加组件」菜单里的一项：组件类型 + 显示名。 */
export interface AddableComponentDef {
  readonly type: ComponentType;
  readonly label: string;
}

/**
 * 面板底部「添加组件」列出所有可显式添加的缺失组件；只有 `removable` 标记的组件提供移除交互。
 *
 * 返回空表示这个对象没有可添加的组件——面板就不显示那个按钮。
 */
export function addableComponentsFor(object: GameObjectDoc): readonly AddableComponentDef[] {
  return COMPONENT_EDITORS.filter(
    (editor) =>
      !hasComponent(object, editor.type) &&
      (canAddOptionalObjectComponent(object, editor.type) || canRepairObjectComponent(object, editor.type)),
  ).map((editor) => ({
    type: editor.type,
    label: editor.panels[0]?.title ?? editor.type,
  }));
}
