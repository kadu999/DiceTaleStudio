import type { ObjectKind, SoundLayer } from "./types";

/**
 * 对象身上的**可插拔特性**：一个特性 = 一份数据 + 一组允许携带它的对象类型。
 *
 * 这张表是「**哪个 kind 带哪个字段**」这条知识的**唯一归属地**。在此之前它散在
 * `commands.ts` / `validation.ts` / `schema.ts` / 编辑器的 store 与面板里各写一遍
 * （十几处 `kind === "PlaySound"` 之类的判断），加一个对象特性要翻遍全项目。
 *
 * **v19 起每个特性都由一个组件承载**（`component` 就是那个组件类型名）：那时字段名只
 * 出现在迁移函数里，运行期一律走 `./access` 的访问器 + 这张表的
 * `carriesKind` / `kindsCarrying`。三处（迁移、协议、Unity 客户端解析）用的组件名
 * **必须完全一致**，由 `apps/backend/test/protocol-document-contract.test.ts` 兜住。
 */
export type ObjectFeatureField = "map" | "image" | "sound" | "teleport" | "video";

/** 特性字段名 → 承载它的组件类型名（迁移 / 协议 / 客户端共用的契约）。 */
export const FEATURE_COMPONENT = {
  map: "GridMap",
  image: "TextureRenderer",
  sound: "PlaySound",
  teleport: "Teleport",
  video: "VideoOverlay",
} as const;

export interface ObjectFeatureDef {
  /** 文档里的字段名（v19 之前数据就住在这里；迁移之后只作为历史名字存在）。 */
  readonly field: ObjectFeatureField;
  /** 承载它的组件类型名。 */
  readonly component: string;
  /** 允许携带它的对象类型；**空数组 = 任何类型都允许**。 */
  readonly kinds: readonly ObjectKind[];
}

/**
 * 全部对象特性，顺序**就是组件在对象上的规范顺序**（新建与迁移都按它 append，
 * 于是写盘 diff 稳定、属性面板的分组顺序也稳定）。
 */
export const OBJECT_FEATURES: readonly ObjectFeatureDef[] = [
  // 地图的贴图与网格都在这份数据里（`map.image`），所以它不吃 `image` 那一份
  { field: "map", component: FEATURE_COMPONENT.map, kinds: ["Map"] },
  // 「对象自己显示的图」：精灵就是靠它显示图片的
  {
    field: "image",
    component: FEATURE_COMPONENT.image,
    kinds: ["SceneObject", "Player", "Item", "Event"],
  },
  // 动作对象：只声明「告诉前端播什么」，编辑器自己不播放
  { field: "sound", component: FEATURE_COMPONENT.sound, kinds: ["PlaySound"] },
  // 动作对象：触发它 = 切换当前场景（不需要新协议命令）
  { field: "teleport", component: FEATURE_COMPONENT.teleport, kinds: ["Teleport"] },
  // 视频画面盖在对象自己的矩形上，所以只有画得出来的对象能带
  { field: "video", component: FEATURE_COMPONENT.video, kinds: ["Map", "SceneObject"] },
];

const BY_FIELD = new Map(OBJECT_FEATURES.map((def) => [def.field, def]));
const BY_COMPONENT = new Map(OBJECT_FEATURES.map((def) => [def.component, def]));

/** 按字段名查特性定义。 */
export function featureOfField(field: ObjectFeatureField): ObjectFeatureDef | undefined {
  return BY_FIELD.get(field);
}

/** 按组件类型名查特性定义。 */
export function featureOfComponent(component: string): ObjectFeatureDef | undefined {
  return BY_COMPONENT.get(component);
}

/** 能携带某个组件的对象类型（组件名不认识时返回空数组）。 */
export function kindsCarrying(component: string): readonly ObjectKind[] {
  return featureOfComponent(component)?.kinds ?? [];
}

/**
 * 这个对象类型能不能携带某个组件。
 *
 * **「空 kinds = 任何类型都允许」在实现里**，调用方不必自己判空。
 */
export function carriesKind(component: string, kind: ObjectKind): boolean {
  const def = featureOfComponent(component);
  if (def === undefined) {
    return false;
  }

  return def.kinds.length === 0 || def.kinds.includes(kind);
}

/**
 * 哪些对象能带视频列表：**地图与精灵**。
 *
 * 只有这一处判据（面板显示哪一组、文档命令认不认、校验报不报都走它）——
 * 加新种类时只改 `OBJECT_FEATURES` 里那一行，不会出现「面板给了入口、命令却拒了」的半套状态。
 */
export function supportsVideo(kind: ObjectKind): boolean {
  return carriesKind(FEATURE_COMPONENT.video, kind);
}

/**
 * **显示用的图片**从哪个特性取：地图类取它自己的地图数据（`map.image`），
 * 其余对象取 `image` 那一份。
 *
 * 两处形状完全一致（都是 `ImageRef`），所以显示、换图、改名同步都走 `objectImage` 一个入口，
 * 不必到处判 `kind`。
 */
export function displayImageField(kind: ObjectKind): "map" | "image" {
  return carriesKind(FEATURE_COMPONENT.map, kind) ? "map" : "image";
}

// ---------------------------------------------------------------- 特性缺省值

/**
 * 声音对象的默认层级：**音效**（最常见的一档）。
 *
 * 层级是「声道分组」：同层同时只响一条，后来的顶掉先前的；想要两件事同时响就得
 * 分到两层。三档的取值与中文名见 `types.ts` 的 `SOUND_LAYERS` / `SOUND_LAYER_LABELS`；
 * 对象界面上只给 `OBJECT_SOUND_LAYERS`（音效 / 旁白）——背景音乐是项目级全局设置。
 */
export const DEFAULT_SOUND_LAYER: SoundLayer = "sfx";

/**
 * 视频的默认开关（v14 起）：**开着、不循环、静音**。
 *
 * 开着 = 加过视频就默认会用（`video` 字段本身就是「在用」的意思）；
 * 不循环 = 过场视频放一遍停在最后一帧（要循环的背景视频在面板上打开）；
 * 静音 = 现场跑团时「不小心点开视频就轰一声」比听不到更糟。
 */
export const DEFAULT_VIDEO_ENABLED = true;
export const DEFAULT_VIDEO_LOOP = false;
export const DEFAULT_VIDEO_AUDIO = false;
