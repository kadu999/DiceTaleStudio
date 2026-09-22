import type { ReactNode } from "react";
import {
  FEATURE_COMPONENT,
  carriesKind,
  mapDataOf,
  supportsVideo,
  type SceneObjectDoc,
} from "@dts/document";
import { badgeIconOf } from "../object-kinds";
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
  SortingOrderField,
  TextureField,
} from "./object-fields";

/**
 * **对象属性面板的分组注册表**。
 *
 * 面板本身（`InspectorPanel`）只剩「选谁 + 按这张表渲染」，每一组「什么时候出现、里面是什么」
 * 都在这里。于是**加一个对象特性 = 在这里加一行 + 写一个字段组件**，而不是回到面板 JSX 里
 * 插一个 `kind === …` 判断。
 *
 * 两件事由 `object-fields.tsx` 的字段控件与 `@dts/document` 的访问器回答：
 * - `applies`：这一组要不要显示。判据一律走**组件与特性表**（`carriesKind` / `mapDataOf`），
 *   不看 `kind` 字面量——「有地图数据就显示区域与战争雾」比「是 Map 就显示」更贴近事实；
 * - `render`：这一组的内容（**不含** `FieldGroup` 外壳，外壳由面板统一包，
 *   这样组的标题、`data-group`、折叠行为都只有一处实现）。
 *
 * **顺序就是界面上的顺序**（e2e 的 `inspector-groups.spec.ts` 断言 `[data-group]` 的顺序）：
 * 基础 → 渲染 → 声音 → 传送 → 区域 → 战争雾 → 视频。
 * 「视频」排在最后是有意的：它是**运行时要用的东西**（与战争雾同一档），摆场景时用不到。
 */
export interface ObjectGroupDef {
  /** `data-group` 的 slug（测试与调试用；沿用历史值，改标题不改它）。 */
  readonly group: string;
  readonly title: string;
  readonly applies: (object: SceneObjectDoc) => boolean;
  readonly render: (object: SceneObjectDoc) => ReactNode;
}

const hasMapData = (object: SceneObjectDoc): boolean => mapDataOf(object) !== undefined;

export const OBJECT_GROUPS: readonly ObjectGroupDef[] = [
  {
    group: "basic",
    title: "基础",
    applies: () => true,
    render: (object) => (
      <>
        <NameField object={object} />
        <Field label="类型" value={object.kind} />
        <ActiveField object={object} />
        <LockedField object={object} />
        <SortingOrderField object={object} />
        <PositionFields object={object} />
        <ScaleField object={object} />
        <RotationField object={object} />
      </>
    ),
  },
  {
    // 「渲染」= **这个对象画出来是什么样**：现在只有「贴图」一行（每个对象都能显示一张图片，
    // 精灵就是靠它显示图片的；地图的贴图也是同一个字段，只是存在 `GridMap` 组件里）。
    // **动作对象没有这一组**（`badgeIconOf`）：它们画的是**固定的内置徽标**（音频图标 /
    // 传送徽标），不给换贴图——留一个换贴图的入口只会让人以为它管用。
    group: "render",
    title: "渲染",
    applies: (object) => badgeIconOf(object.kind) === undefined,
    render: (object) => <TextureField object={object} />,
  },
  {
    // 「声音」只对声音对象出现：音频列表 + 层级就是它自己那点东西（基础属性照旧）
    group: "sound",
    title: "声音",
    applies: (object) => carriesKind(FEATURE_COMPONENT.sound, object.kind),
    render: (object) => <SoundFields object={object} />,
  },
  {
    // 「传送」只对传送阵出现：目标场景 + 一个「传送」按钮。触发它就是**切换当前场景**
    // （DM 的「换台」），画布上双击那枚徽标是同一件事。
    group: "teleport",
    title: "传送",
    applies: (object) => carriesKind(FEATURE_COMPONENT.teleport, object.kind),
    render: (object) => <TeleportFields object={object} />,
  },
  {
    // 「区域」只对**有地图数据**的对象出现：格子是地图独有的东西。网格规格（列 · 行 / 每格 / 行序）
    // 也归这一组——「对象是什么」（名称 / 位置 / 缩放）与「它的格子长什么样」是两件事。
    // slug 沿用 `edit`：它只是测试与调试用的标识，改的是给人看的标题。
    group: "edit",
    title: "区域",
    applies: hasMapData,
    render: (object) => (
      <>
        <GridFields object={object} />
        <CellSizeField object={object} />
        <Field label="行序" value={mapDataOf(object)?.rowOrder ?? ""} mono />
        {/* 网格线 / 网格标注两个总开关：不进任何窗口也能用（想看清贴图就关掉） */}
        <GridDisplayField />
        <GridAnnotationFields object={object} />
      </>
    ),
  },
  {
    // 「战争雾」也只对**有地图数据**的对象出现：8 个区域位是中性的，哪些算雾区要在这里手动指定，
    // 真正的编辑在 Mask 窗口里做。
    group: "fog",
    title: "战争雾",
    applies: hasMapData,
    render: (object) => <FogFields object={object} />,
  },
  {
    // 「视频」只对**地图与精灵**出现（`supportsVideo`）：视频画面盖在对象自己的矩形上，
    // 所以它属于那个对象；在窗口里加一组视频，运行时在这里选一条放。
    group: "video",
    title: "视频",
    applies: (object) => supportsVideo(object.kind),
    render: (object) => <VideoFields object={object} />,
  },
];
