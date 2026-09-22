import { CONCRETE_KINDS, kindIsA, kindLineage } from "./kinds";
import type { ObjectKind } from "./kinds";
import type { SoundLayer } from "./types";

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
 *
 * **v21 起「一个字段两种组件」是允许的**：`image` 有两种承载——
 * 贴图对象用 `ImageLayer`（只显示整张图）、精灵对象用 `SpriteLayer`（显示图集里的一格）。
 * `componentsByKind` 就是这条路由，取组件名的入口统一是 `componentForKind()`，
 * 别在调用处自己判 kind。
 *
 * **v22 起 `kinds` 里的名字可以是基类**：`Sprite` / `Image` 继承 `SceneObject`
 * （层级住在 `./kinds`），所以 `image` 那条只写基类 + 几个根类型，
 * 判据一律走 `kindIsA`——**`kinds.includes(kind)` 会把子类型漏掉**。
 */
export type ObjectFeatureField = "map" | "image" | "sound" | "teleport" | "video";

/**
 * 特性字段名 → 承载它的组件类型名（迁移 / 协议 / 客户端共用的契约）。
 *
 * `image` 那一项是**缺省承载**（除精灵 `Sprite` 之外的对象用它）；精灵走 `componentsByKind`。
 */
export const FEATURE_COMPONENT = {
  map: "GridMap",
  image: "ImageLayer",
  sound: "PlaySound",
  teleport: "Teleport",
  video: "VideoOverlay",
} as const;

/** 精灵对象显示的图住在它自己的组件里（与贴图的 `ImageLayer` 分开，见 `OBJECT_FEATURES.image`）。 */
export const SPRITE_COMPONENT = "SpriteLayer";

/**
 * 上一个格式版本里承载 `image` 的组件名（v20 及更早）。
 *
 * 老文件里的精灵与贴图**都**写的是 `TextureRenderer`；v21 起拆成
 * `SpriteLayer`（精灵）/ `ImageLayer`（贴图），旧名只在迁移里认一次。
 */
export const LEGACY_IMAGE_COMPONENT = "TextureRenderer";

export interface ObjectFeatureDef {
  /** 文档里的字段名（v19 之前数据就住在这里；迁移之后只作为历史名字存在）。 */
  readonly field: ObjectFeatureField;
  /** 承载它的组件类型名（缺省；被 `componentsByKind` 覆盖的那些 kind 除外）。 */
  readonly component: string;
  /** 允许携带它的对象类型；**空数组 = 任何类型都允许**。 */
  readonly kinds: readonly ObjectKind[];
  /**
   * 某些 kind 用**另一个组件**承载（可选）。
   *
   * 现在只有 `image` 用它：精灵的图住在 `SpriteLayer` 里。没列到的 kind 走 `component`。
   */
  readonly componentsByKind?: Readonly<Partial<Record<ObjectKind, string>>>;
}

/**
 * 全部对象特性，顺序**就是组件在对象上的规范顺序**（新建与迁移都按它 append，
 * 于是写盘 diff 稳定、属性面板的分组顺序也稳定）。
 */
export const OBJECT_FEATURES: readonly ObjectFeatureDef[] = [
  // 地图的贴图与网格都在这份数据里（`map.image`），所以它不吃 `image` 那一份
  { field: "map", component: FEATURE_COMPONENT.map, kinds: ["Map"] },
  // 「对象自己显示的图」：**凡是场景对象都靠它显示图片**——所以声明写在基类 `SceneObject` 上，
  // 精灵 `Sprite` 与贴图 `Image` 继承它（Player / Item / Event 与它平级，得单独列）。
  // **两种组件**：精灵 = SpriteLayer（会取图集里的一格），其余 = ImageLayer（只显示整张图）
  {
    field: "image",
    component: FEATURE_COMPONENT.image,
    kinds: ["SceneObject", "Player", "Item", "Event"],
    componentsByKind: { Sprite: SPRITE_COMPONENT },
  },
  // 动作对象：只声明「告诉前端播什么」，编辑器自己不播放
  { field: "sound", component: FEATURE_COMPONENT.sound, kinds: ["PlaySound"] },
  // 动作对象：触发它 = 切换当前场景（不需要新协议命令）
  { field: "teleport", component: FEATURE_COMPONENT.teleport, kinds: ["Teleport"] },
  // 视频画面盖在对象自己的矩形上，所以只有画得出来的对象能带。
  // **贴图 `Image` 而不是精灵 `Sprite`**：视频是「盖住这个对象那块矩形的一条片」，
  // 贴图（只显示整张图）才是它的用法；精灵显示的是图集里的一格，它的渲染选项归「渲染」那一组。
  // 这里**不能**写基类 `SceneObject`——那会让精灵也继承到视频。
  { field: "video", component: FEATURE_COMPONENT.video, kinds: ["Map", "Image"] },
];

/**
 * 全部特性组件名（含 `componentsByKind` 里那些）。
 *
 * 迁移、协议严格校验、访问器都要遍历"可能出现在对象上的特性组件"，
 * 只取 `component` 会漏掉 `SpriteLayer`——所以统一从这里拿。
 */
export const FEATURE_COMPONENTS: readonly string[] = [
  ...new Set(
    OBJECT_FEATURES.flatMap((def) => [def.component, ...Object.values(def.componentsByKind ?? {})]),
  ),
];

const BY_FIELD = new Map(OBJECT_FEATURES.map((def) => [def.field, def]));
const BY_COMPONENT = new Map(
  OBJECT_FEATURES.flatMap((def) => [
    [def.component, def] as const,
    ...Object.entries(def.componentsByKind ?? {}).map(
      ([, component]) => [component, def] as const,
    ),
  ]),
);

/** 按字段名查特性定义。 */
export function featureOfField(field: ObjectFeatureField): ObjectFeatureDef | undefined {
  return BY_FIELD.get(field);
}

/** 按组件类型名查特性定义（`componentsByKind` 里的名字也查得到）。 */
export function featureOfComponent(component: string): ObjectFeatureDef | undefined {
  return BY_COMPONENT.get(component);
}

/**
 * 某个特性的**所有**组件类型名（`componentsByKind` 的不同名字都算）。
 *
 * 用途：找"这个对象显示了哪张图"时，精灵与贴图的组件名不同，但语义是同一个特性。
 */
export function componentsOfField(field: ObjectFeatureField): readonly string[] {
  const def = BY_FIELD.get(field);
  if (def === undefined) {
    return [];
  }

  return [def.component, ...Object.values(def.componentsByKind ?? {})];
}

/**
 * 这个 kind 上，某个特性由**哪个组件**承载。
 *
 * **取组件名只有这一个入口**（迁移、写盘、访问器都走它）：`image` 在精灵上是
 * `SpriteLayer`、在其余上是 `ImageLayer`，调用处不该自己判 kind。
 *
 * 查法是**沿基类往上**（`kindLineage`）：先看自己那一份 `componentsByKind`、再退到基类。
 * 于是 `Image` 没写自己的路由，就落到基类那一份缺省承载上；将来加一个
 * 「`Sprite` 的子类型但换一种图片组件」，只在自己的定义里写一条即可。
 */
export function componentForKind(field: ObjectFeatureField, kind: ObjectKind): string {
  const def = BY_FIELD.get(field);
  if (def === undefined) {
    return "";
  }

  for (const candidate of kindLineage(kind)) {
    const routed = def.componentsByKind?.[candidate];
    if (routed !== undefined) {
      return routed;
    }
  }

  return def.component;
}

/**
 * 这个组件名是**承载某个特性的组件之一**吗（`componentsByKind` 里的名字也算）。
 *
 * `image` 有两种载法（精灵 `SpriteLayer` / 贴图 `ImageLayer`），所以「哪一个组件里装着
 * 对象自己那张图」不能用 `=== FEATURE_COMPONENT.image` 判——用这个。
 */
export function carriesFeatureComponent(field: ObjectFeatureField, component: string): boolean {
  return componentsOfField(field).includes(component);
}

/**
 * 能携带某个组件的**具体对象类型**（抽象基类不算——它不落进文档）。
 *
 * 判据是**算出来的**、不是另抄一份名单：先把 `kinds` 里声明过的类型连同它们的子类型
 * 收进来（`Sprite` / `Image` 就是这么从基类 `SceneObject` 进来的），
 * 再按「这个组件最终归谁」（`componentForKind`）筛一遍——于是
 * `ImageLayer` 的 kinds 里**没有** `Sprite`（它的图住在 `SpriteLayer`）。
 */
export function kindsCarrying(component: string): readonly ObjectKind[] {
  const def = featureOfComponent(component);
  if (def === undefined) {
    return [];
  }

  return CONCRETE_KINDS.filter(
    (kind) => carriesKind(component, kind) && componentForKind(def.field, kind) === component,
  );
}

/**
 * 这个对象类型能不能携带某个组件。
 *
 * **「空 kinds = 任何类型都允许」在实现里**，调用方不必自己判空；
 * 命中判据是**层级**（`kindIsA`：`Sprite` / `Image` 继承 `SceneObject`），
 * 不是 `kinds.includes(kind)`——后者会把子类型漏掉。
 */
export function carriesKind(component: string, kind: ObjectKind): boolean {
  const def = featureOfComponent(component);
  if (def === undefined) {
    return false;
  }

  return def.kinds.length === 0 || def.kinds.some((base) => kindIsA(kind, base));
}

/**
 * 哪些对象能带视频列表：**地图与贴图**（精灵不能——见 `OBJECT_FEATURES` 里那一行）。
 *
 * 只有这一处判据（面板显示哪一组、文档命令认不认、校验报不报都走它）——
 * 加新种类时只改 `OBJECT_FEATURES` 里那一行，不会出现「面板给了入口、命令却拒了」的半套状态。
 */
export function supportsVideo(kind: ObjectKind): boolean {
  return carriesKind(FEATURE_COMPONENT.video, kind);
}

/**
 * 这种对象的图**能不能取图集里的一格**（子图）——即精灵 `Sprite` 与其余场景对象的分界。
 *
 * 判据是**图片用哪个组件**（精灵 `SpriteLayer`、其余 `ImageLayer`），不是另写一份 kind 名单：
 * 于是「选择图片弹框给不给右侧切分面板」「渲染那一组给不给选格子」两处永远一致。
 * 基类 `SceneObject` 与地图返回 `false`（地图的贴图住在 `GridMap` 里，格子按整张贴图算；
 * 基类那份缺省承载就是整图）。
 */
export function supportsSpriteSheet(kind: ObjectKind): boolean {
  return (
    componentForKind("image", kind) === SPRITE_COMPONENT &&
    carriesKind(SPRITE_COMPONENT, kind)
  );
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
