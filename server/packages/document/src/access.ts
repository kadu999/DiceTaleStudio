import type { Draft } from "immer";
import {
  componentId,
  componentKindMismatchOf,
  findComponentType,
  SLOT_COMPONENT_TYPES,
} from "./components";
import { defaultDataOf } from "./component-specs";
import { DEFAULT_SLOT_COMPONENT, DEFAULT_SOUND_LAYER } from "./presets";
import type { ComponentSlot } from "./presets";
import type {
  ComponentDoc,
  ImageRef,
  MapDataDoc,
  GameObjectDoc,
  SoundDataDoc,
  TeleportDataDoc,
  VideoDataDoc,
} from "./types";

/**
 * 对象特性的**唯一访问路径**。
 *
 * v19 起特性住在 `components[]` 里（`GridMap` / `ImageLayer` / `SpriteLayer` / `PlaySound` /
 * `Teleport` / `VideoOverlay`），而**「数据存在哪」只有这个文件知道**：调用方一律写
 * `mapDataOf(object)` / `ensureSoundData(draft)`，不写 `object.components.find(...)`。
 * 于是「把特性从扁平字段搬进组件」这件事的改动面被压在这个文件里（迁移那一次）。
 *
 * v22 层级移除后，查找一律按**能力槽位**（`ComponentSlot`）走：组件定义自报 `slot`，
 * 这里按 slot 在对象的组件列表上找第一个自报该槽位的组件，**不看 kind**；实例缺失时，
 * 创建模板路由与缺组件修复 fallback 分别读取组件定义中的元数据。
 *
 * 两类函数分工明确：
 * - `xxxOf(object)` —— **纯读**，不改数据，没有这个组件就是 `undefined`；
 * - `ensureXxx(object)` —— **写路径**，接受 immer draft，没有实例时仅为兼容旧对象补默认值。
 *
 * 地图数据没有 `ensure`：格子与贴图尺寸没法凭空造，所以只有读与「整份替换」（`writeFeature`）。
 */

// ---------------------------------------------------------------- 组件级

/** 对象上某个组件的实例（同一类型最多一个）。 */
export function componentOf(object: GameObjectDoc, component: string): ComponentDoc | undefined {
  return object.components.find((item) => item.type === component);
}

/**
 * 对象上**承担某个能力槽位**的组件实例（v22 层级移除后按 slot 直接找）。
 *
 * 组件定义自报 `slot`（`components.ts`），这里找第一个自报该槽位的组件——
 * 精灵的图在 `SpriteLayer`、贴图的图在 `ImageLayer`，对调用方是同一个问题（`image` 槽位），
 * 不需要知道「这个对象是精灵还是贴图」。
 */
export function componentOfSlot(object: GameObjectDoc, slot: ComponentSlot): ComponentDoc | undefined {
  return object.components.find((item) => findComponentType(item.type)?.slot === slot);
}

/** Get the attached component type, using a repair fallback only when no instance exists. */
export function componentTypeForObjectSlot(
  object: GameObjectDoc,
  slot: ComponentSlot,
): string | undefined {
  const attached = componentOfSlot(object, slot);
  if (attached !== undefined) return attached.type;
  if (object.components.some((component) => findComponentType(component.type)?.slot === slot)) return undefined;
  if (hasComponentKindMismatch(object)) return undefined;
  return SLOT_COMPONENT_TYPES.find(
    (definition) => definition.slot === slot && definition.repairFallbackKinds?.includes(object.kind) === true,
  )?.type;
}

/** Component instances declare image behavior; kind is only a fallback for old objects without image components. */
export function objectImageSlot(object: GameObjectDoc): "map" | "image" {
  if (componentOfSlot(object, "map") !== undefined) return "map";
  if (componentOfSlot(object, "image") !== undefined) return "image";
  if (hasComponentKindMismatch(object)) return "image";
  return findComponentType(DEFAULT_SLOT_COMPONENT.map)?.templateKinds?.includes(object.kind) === true
    ? "map"
    : "image";
}

/** Whether an edit may recreate this missing required component to repair the object. */
export function canDefaultObjectComponent(object: GameObjectDoc, type: string): boolean {
  const definition = findComponentType(type);
  if (definition?.slot === undefined || definition.repairFallbackKinds?.includes(object.kind) !== true) return false;
  if (hasComponentKindMismatch(object)) return false;
  return !object.components.some((component) => findComponentType(component.type)?.slot === definition.slot);
}

/** Whether the editor can offer an explicit repair for a missing required component. */
export function canRepairObjectComponent(object: GameObjectDoc, type: string): boolean {
  const definition = findComponentType(type);
  return (
    definition?.slot !== undefined &&
    definition.repairKinds?.includes(object.kind) === true &&
    !hasComponentKindMismatch(object) &&
    !object.components.some((component) => findComponentType(component.type)?.slot === definition.slot)
  );
}

/** Whether this kind may add an optional component that is not attached yet. */
export function canAddOptionalObjectComponent(object: GameObjectDoc, type: string): boolean {
  const definition = findComponentType(type);
  return (
    definition?.slot !== undefined &&
    definition.optionalKinds?.includes(object.kind) === true &&
    !hasComponentKindMismatch(object) &&
    !object.components.some((component) => findComponentType(component.type)?.slot === definition.slot)
  );
}

/** Whether attached known components agree with their legacy kind templates. */
export function hasComponentKindMismatch(object: GameObjectDoc): boolean {
  return componentKindMismatchOf(object.components, object.kind);
}

export function supportsObjectComponent(object: GameObjectDoc, type: string): boolean {
  return (
    object.components.some((component) => component.type === type) ||
    canDefaultObjectComponent(object, type) ||
    canAddOptionalObjectComponent(object, type)
  );
}

export function objectSupportsSpriteSheet(object: GameObjectDoc): boolean {
  if (componentOfSlot(object, "map") !== undefined) return false;
  const imageComponent = componentOfSlot(object, "image")?.type;
  if (imageComponent !== undefined) return imageComponent === "SpriteLayer";
  if (hasComponentKindMismatch(object)) return false;
  return findComponentType("SpriteLayer")?.templateKinds?.includes(object.kind) === true;
}

/**
 * 某个组件的数据，按调用方声明的类型返回。
 *
 * 那一次断言是**有意**的：文档里的 `data` 是 `Record<string, unknown>`（手写文件里什么都可能写），
 * 形状由 zod（`schema.ts`）在解析期把关、由 `validateScene` 在语义层把关。
 * 把它在这里一次性收窄，调用方就不必到处 `as`。
 */
export function componentDataOf<T>(object: GameObjectDoc, component: string): T | undefined {
  const instance = componentOf(object, component);
  return instance === undefined ? undefined : (instance.data as T);
}

/** 某个能力槽位的组件数据，按调用方声明的类型返回（断言理由同 `componentDataOf`）。 */
export function componentDataOfSlot<T>(object: GameObjectDoc, slot: ComponentSlot): T | undefined {
  const instance = componentOfSlot(object, slot);
  return instance === undefined ? undefined : (instance.data as T);
}

/** 对象的地图数据（不是地图对象 / 没有这个组件时 `undefined`）。 */
export function mapDataOf(object: GameObjectDoc): MapDataDoc | undefined {
  return componentDataOfSlot<MapDataDoc>(object, "map");
}

/**
 * 对象自己那一份图片（**不含地图贴图**；地图的贴图在 `mapDataOf(object)?.image` 里）。
 *
 * 按 `image` 槽位直接找：精灵的图在 `SpriteLayer`、贴图的图在 `ImageLayer`，
 * 两种组件自报同一个 slot，这里一次查到——v22 层级移除前这要靠遍历两种组件名。
 */
export function imageOf(object: GameObjectDoc): ImageRef | undefined {
  return componentDataOfSlot<ImageRef>(object, "image");
}

/**
 * **显示用的图片**：地图类取自己的地图数据，其余取贴图组件。
 *
 * 两处形状一致（都是 `ImageRef`），所以画布绘制、换图、场景改名同步贴图都走这一个入口。
 */
export function objectImage(object: GameObjectDoc): ImageRef | undefined {
  return objectImageSlot(object) === "map" ? mapDataOf(object)?.image : imageOf(object);
}

/** 声音数据（音频列表 + 选中的那条 + 层级）。 */
export function soundDataOf(object: GameObjectDoc): SoundDataDoc | undefined {
  return componentDataOfSlot<SoundDataDoc>(object, "sound");
}

/** 传送数据（候选场景 + 选中的那一个）。 */
export function teleportDataOf(object: GameObjectDoc): TeleportDataDoc | undefined {
  return componentDataOfSlot<TeleportDataDoc>(object, "teleport");
}

/** 视频数据（列表 + 选中的那条 + 循环 / 声音）。 */
export function videoDataOf(object: GameObjectDoc): VideoDataDoc | undefined {
  return componentDataOfSlot<VideoDataDoc>(object, "video");
}

/**
 * 这个对象的视频**开着没有**（总开关）。
 *
 * 判据只有这一处，编辑器与校验都走它：没有视频组件 = 没开（也没列表）；
 * 有组件就按 `enabled` 算——`enabled` **缺省算开**（schema 会给 `true`，
 * 这里的兜底只是给内存里手写的对象用）。与 `isMapFogEnabled` 同一个口径。
 */
export function isVideoEnabled(object: GameObjectDoc): boolean {
  const video = videoDataOf(object);
  return video !== undefined && video.enabled !== false;
}

// ---------------------------------------------------------------- 写（draft）

/**
 * 地图数据的 draft（没有这个组件就是 `undefined`——地图数据不会被凭空造出来）。
 *
 * 与 `mapDataOf` 分开只是类型上的事：命令作用在 immer draft 上，写回时要是可变的那个类型。
 */
export function mapDraftOf(object: Draft<GameObjectDoc>): Draft<MapDataDoc> | undefined {
  return componentDataOfSlot<MapDataDoc>(object, "map") as Draft<MapDataDoc> | undefined;
}

/**
 * 写入某个特性组件的**整份数据**（没有实例就补一个）。
 *
 * 组件实例 id 是确定性的（`<对象 id>__<组件类型>`），所以同一次编辑重复写、
 * 或者迁移跑第二遍，都不会多出第二个实例。
 */
export function writeFeature<T>(
  object: Draft<GameObjectDoc>,
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
  };
  object.components.push(created);
  return created;
}

/** 摘掉某个特性组件（整个特性不存在了）。返回是否真的摘掉了一个。 */
export function removeFeature(object: Draft<GameObjectDoc>, component: string): boolean {
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
export function withFeature<T>(object: GameObjectDoc, component: string, data: T): GameObjectDoc {
  const components = [...object.components];
  const index = components.findIndex((item) => item.type === component);
  const next: ComponentDoc = {
    id: index < 0 ? componentId(object.id, component) : (components[index] as ComponentDoc).id,
    type: component,
    data: data as Record<string, unknown>,
  };

  if (index < 0) {
    components.push(next);
  } else {
    components[index] = next;
  }

  return { ...object, components };
}

/**
 * 取必需能力槽位的组件数据 draft；**兼容 fallback 允许、但没有实例就补一个默认的**。
 *
 * 修复准入判据集中在组件定义的 `repairFallbackKinds`；可选组件使用单独的准入路径。
 * 已挂载实例不受 kind 影响。
 *
 * 导出是为了让**泛型写入**（`commands/component.ts`）复用同一份准入判据——
 * 那条路必须遵守相同的组件准入规则，避免出现「面板给了入口、命令却拒了」的半套状态。
 */
export function ensureSlotData<T>(
  object: Draft<GameObjectDoc>,
  slot: ComponentSlot,
  defaultData: () => T,
): Draft<T> | undefined {
  const component = componentTypeForObjectSlot(object, slot);
  if (component === undefined) {
    return undefined;
  }

  const existing = object.components.find((item) => item.type === component);
  if (existing === undefined) {
    return writeFeature(object, component, defaultData()).data as Draft<T>;
  }

  return existing.data as Draft<T>;
}

/**
 * 按**组件类型**（而不是槽位）取数据 draft；只有已挂载、必需修复 fallback 或可选准入时才创建实例。
 *
 * 与 `ensureSlotData` 同一套判据，多一道「这个槽位确实由**这个**组件承载」的核对：
 * `image` 槽位在精灵上是 `SpriteLayer`、在贴图上是 `ImageLayer`，只按槽位找会拿错那一份。
 * 核对不过（未知组件 / 这个 kind 不允许 / 该槽位由别的组件承载）返回 `undefined`，
 * 调用方据此返回「无变更」——**不补、不抛**。
 */
export function ensureComponentData(
  object: Draft<GameObjectDoc>,
  type: string,
): Draft<Record<string, unknown>> | undefined {
  const slot = findComponentType(type)?.slot;
  if (slot === undefined) {
    return undefined;
  }

  const attached = object.components.find((component) => component.type === type);
  if (attached !== undefined) {
    return attached.data as Draft<Record<string, unknown>>;
  }

  if (!supportsObjectComponent(object, type)) {
    return undefined;
  }

  return writeFeature(object, type, defaultDataOf(type)).data as Draft<Record<string, unknown>>;
}

/**
 * 声音数据的 draft；仅允许已挂载组件或注册的修复 fallback。
 *
 * 缺失的 `PlaySound` 组件现在必须先通过显式修复操作恢复；普通字段命令不会按 kind 补建。
 */
export function ensureSoundData(object: Draft<GameObjectDoc>): Draft<SoundDataDoc> | undefined {
  return ensureSlotData<SoundDataDoc>(object, "sound", () => ({
    clips: [],
    layer: DEFAULT_SOUND_LAYER,
  }));
}

/** 传送数据的 draft；缺失组件须先通过显式修复操作恢复。 */
export function ensureTeleportData(object: Draft<GameObjectDoc>): Draft<TeleportDataDoc> | undefined {
  return ensureSlotData<TeleportDataDoc>(object, "teleport", () => ({
    targets: [],
  }));
}

/**
 * 视频数据的 draft；**缺实例就补一份默认的**。
 *
 * 不是地图 / 贴图的对象返回 `undefined`（预设表 `OBJECT_PRESETS`：只有这两种预设声明了 video 槽位）。
 * 补壳用的那份形状住在 `component-specs/video.ts`（与属性面板、泛型写入同一份规格）。
 */
export function ensureVideoData(object: Draft<GameObjectDoc>): Draft<VideoDataDoc> | undefined {
  const component = componentOfSlot(object, "video");
  if (component !== undefined) return component.data as Draft<VideoDataDoc>;
  if (!canAddOptionalObjectComponent(object, DEFAULT_SLOT_COMPONENT.video)) return undefined;
  return writeFeature(
    object,
    DEFAULT_SLOT_COMPONENT.video,
    defaultDataOf(DEFAULT_SLOT_COMPONENT.video) as unknown as VideoDataDoc,
  ).data as Draft<VideoDataDoc>;
}
