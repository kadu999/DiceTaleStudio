import type { Draft } from "immer";
import { componentId } from "./components";
import {
  DEFAULT_SOUND_LAYER,
  DEFAULT_VIDEO_AUDIO,
  DEFAULT_VIDEO_ENABLED,
  DEFAULT_VIDEO_LOOP,
  FEATURE_COMPONENT,
  carriesKind,
  displayImageField,
} from "./features";
import type {
  ComponentDoc,
  ImageRef,
  MapDataDoc,
  SceneObjectDoc,
  SoundDataDoc,
  TeleportDataDoc,
  VideoDataDoc,
} from "./types";

/**
 * 对象特性的**唯一访问路径**。
 *
 * v19 起特性住在 `components[]` 里（`GridMap` / `TextureRenderer` / `PlaySound` /
 * `Teleport` / `VideoOverlay`），而**「数据存在哪」只有这个文件知道**：调用方一律写
 * `mapDataOf(object)` / `ensureSoundData(draft)`，不写 `object.components.find(...)`。
 * 于是「把特性从扁平字段搬进组件」这件事的改动面被压在这个文件里（迁移那一次）。
 *
 * 两类函数分工明确：
 * - `xxxOf(object)` —— **纯读**，不改数据，没有这个组件就是 `undefined`；
 * - `ensureXxx(object)` —— **写路径**，接受 immer draft，没有实例就补一个（含默认数据），
 *   对象类型不允许这个特性时返回 `undefined`（**不补、不抛**，调用方据此返回「无变更」）。
 *
 * 地图数据没有 `ensure`：格子与贴图尺寸没法凭空造，所以只有读与「整份替换」（`writeFeature`）。
 */

// ---------------------------------------------------------------- 组件级

/** 对象上某个组件的实例（同一类型最多一个）。 */
export function componentOf(object: SceneObjectDoc, component: string): ComponentDoc | undefined {
  return object.components.find((item) => item.type === component);
}

/**
 * 某个组件的数据，按调用方声明的类型返回。
 *
 * 那一次断言是**有意**的：文档里的 `data` 是 `Record<string, unknown>`（手写文件里什么都可能写），
 * 形状由 zod（`schema.ts`）在解析期把关、由 `validateScene` 在语义层把关。
 * 把它在这里一次性收窄，调用方就不必到处 `as`。
 */
export function componentDataOf<T>(object: SceneObjectDoc, component: string): T | undefined {
  const instance = componentOf(object, component);
  return instance === undefined ? undefined : (instance.data as T);
}

/** 找一个**带某个特性**的对象（给「点了要有反馈」的调用方：找不到就 `undefined`）。 */
export function hasFeature(object: SceneObjectDoc, component: string): boolean {
  return componentOf(object, component) !== undefined;
}

// ---------------------------------------------------------------- 读

/** 对象的地图数据（不是地图对象 / 没有这个组件时 `undefined`）。 */
export function mapDataOf(object: SceneObjectDoc): MapDataDoc | undefined {
  return componentDataOf<MapDataDoc>(object, FEATURE_COMPONENT.map);
}

/** 对象自己那一份图片（**不含地图贴图**；地图的贴图在 `mapDataOf(object)?.image` 里）。 */
export function imageOf(object: SceneObjectDoc): ImageRef | undefined {
  return componentDataOf<ImageRef>(object, FEATURE_COMPONENT.image);
}

/**
 * **显示用的图片**：地图类取自己的地图数据，其余取贴图组件。
 *
 * 两处形状一致（都是 `ImageRef`），所以画布绘制、换图、场景改名同步贴图都走这一个入口。
 */
export function objectImage(object: SceneObjectDoc): ImageRef | undefined {
  return displayImageField(object.kind) === "map" ? mapDataOf(object)?.image : imageOf(object);
}

/** 声音数据（音频列表 + 选中的那条 + 层级）。 */
export function soundDataOf(object: SceneObjectDoc): SoundDataDoc | undefined {
  return componentDataOf<SoundDataDoc>(object, FEATURE_COMPONENT.sound);
}

/** 传送数据（候选场景 + 选中的那一个）。 */
export function teleportDataOf(object: SceneObjectDoc): TeleportDataDoc | undefined {
  return componentDataOf<TeleportDataDoc>(object, FEATURE_COMPONENT.teleport);
}

/** 视频数据（列表 + 选中的那条 + 循环 / 声音）。 */
export function videoDataOf(object: SceneObjectDoc): VideoDataDoc | undefined {
  return componentDataOf<VideoDataDoc>(object, FEATURE_COMPONENT.video);
}

/**
 * 这个对象的视频**开着没有**（总开关）。
 *
 * 判据只有这一处，编辑器与校验都走它：没有视频组件 = 没开（也没列表）；
 * 有组件就按 `enabled` 算——`enabled` **缺省算开**（schema 会给 `true`，
 * 这里的兜底只是给内存里手写的对象用）。与 `isMapFogEnabled` 同一个口径。
 */
export function isVideoEnabled(object: SceneObjectDoc): boolean {
  const video = videoDataOf(object);
  return video !== undefined && video.enabled !== false;
}

// ---------------------------------------------------------------- 写（draft）

/**
 * 地图数据的 draft（没有这个组件就是 `undefined`——地图数据不会被凭空造出来）。
 *
 * 与 `mapDataOf` 分开只是类型上的事：命令作用在 immer draft 上，写回时要是可变的那个类型。
 */
export function mapDraftOf(object: Draft<SceneObjectDoc>): Draft<MapDataDoc> | undefined {
  return componentDataOf<MapDataDoc>(object, FEATURE_COMPONENT.map) as Draft<MapDataDoc> | undefined;
}

/**
 * 写入某个特性组件的**整份数据**（没有实例就补一个）。
 *
 * 组件实例 id 是确定性的（`<对象 id>__<组件类型>`），所以同一次编辑重复写、
 * 或者迁移跑第二遍，都不会多出第二个实例。
 */
export function writeFeature<T>(
  object: Draft<SceneObjectDoc>,
  component: string,
  data: T,
): Draft<ComponentDoc> {
  const existing = object.components.find((item) => item.type === component) as
    | Draft<ComponentDoc>
    | undefined;
  if (existing !== undefined) {
    existing.data = data as Draft<Record<string, unknown>>;
    return existing;
  }

  const created: Draft<ComponentDoc> = {
    id: componentId(object.id, component),
    type: component,
    data: data as Draft<Record<string, unknown>>,
    actions: [],
  };
  object.components.push(created);
  return created;
}

/** 摘掉某个特性组件（整个特性不存在了）。返回是否真的摘掉了一个。 */
export function removeFeature(object: Draft<SceneObjectDoc>, component: string): boolean {
  const index = object.components.findIndex((item) => item.type === component);
  if (index < 0) {
    return false;
  }

  object.components.splice(index, 1);
  return true;
}

/**
 * **不可变地**替换某个特性组件的数据，返回一个新对象（没有实例就补一个）。
 *
 * 给「手上是一份不可变文档、想造出改过的那一份」的调用方用（测试里造夹具最常需要它）；
 * draft 上请用 `writeFeature` / `ensureXxx`——那两只是原地改，交给 immer 记录补丁。
 */
export function withFeature<T>(object: SceneObjectDoc, component: string, data: T): SceneObjectDoc {
  const components = [...object.components];
  const index = components.findIndex((item) => item.type === component);
  const next: ComponentDoc = {
    id: index < 0 ? componentId(object.id, component) : (components[index] as ComponentDoc).id,
    type: component,
    data: data as Record<string, unknown>,
    actions: index < 0 ? [] : (components[index] as ComponentDoc).actions,
  };

  if (index < 0) {
    components.push(next);
  } else {
    components[index] = next;
  }

  return { ...object, components };
}

/** **不可变地**摘掉某个特性组件（返回新对象）。 */
export function withoutFeature(object: SceneObjectDoc, component: string): SceneObjectDoc {
  return { ...object, components: object.components.filter((item) => item.type !== component) };
}

/** 取某个特性组件的数据 draft；**没有实例就补一个默认的**。 */
function ensureFeatureData<T>(
  object: Draft<SceneObjectDoc>,
  component: string,
  defaultData: () => T,
): Draft<T> | undefined {
  if (!carriesKind(component, object.kind)) {
    return undefined;
  }

  const existing = object.components.find((item) => item.type === component);
  if (existing === undefined) {
    return writeFeature(object, component, defaultData()).data as Draft<T>;
  }

  return existing.data as Draft<T>;
}

/**
 * 声音数据的 draft；**缺实例就补一份默认的**。
 *
 * 手写文件里可能整个声音组件都没有（schema 里组件是可选的）：那种对象语义上就是
 * 「还没挑音频、音效层」，所以在第一次编辑时把组件补出来，而不是让编辑静默失败
 * （`validateScene` 会先把「声音对象缺声音数据」报出来，这里只是兜底修复）。
 */
export function ensureSoundData(object: Draft<SceneObjectDoc>): Draft<SoundDataDoc> | undefined {
  return ensureFeatureData<SoundDataDoc>(object, FEATURE_COMPONENT.sound, () => ({
    clips: [],
    layer: DEFAULT_SOUND_LAYER,
  }));
}

/** 传送数据的 draft；**缺实例就补一份默认的**（与 `ensureSoundData` 同一个口径）。 */
export function ensureTeleportData(object: Draft<SceneObjectDoc>): Draft<TeleportDataDoc> | undefined {
  return ensureFeatureData<TeleportDataDoc>(object, FEATURE_COMPONENT.teleport, () => ({
    targets: [],
  }));
}

/**
 * 视频数据的 draft；**缺实例就补一份默认的**。
 *
 * 不是地图 / 精灵的对象返回 `undefined`（`carriesKind`：只有这两种能带视频）。
 */
export function ensureVideoData(object: Draft<SceneObjectDoc>): Draft<VideoDataDoc> | undefined {
  return ensureFeatureData<VideoDataDoc>(object, FEATURE_COMPONENT.video, () => ({
    enabled: DEFAULT_VIDEO_ENABLED,
    clips: [],
    loop: DEFAULT_VIDEO_LOOP,
    audio: DEFAULT_VIDEO_AUDIO,
  }));
}
