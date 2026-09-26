import { z } from "zod";
import {
  createAssetMeta,
  withMetaAudioName,
  withMetaAudioTags,
  withMetaSpriteSettings,
  withMetaSpriteSheet,
} from "./asset-meta";
import type { AssetMetaDoc } from "./asset-meta";
import { COMPONENT_TYPES, FEATURE_COMPONENT_TYPES, componentId, findComponentType, hasLegacyFeatureField } from "./components";
import {
  DEFAULT_SLOT_COMPONENT,
  DEFAULT_SOUND_LAYER,
  DEFAULT_VIDEO_AUDIO,
  DEFAULT_VIDEO_AUTO_PLAY,
  DEFAULT_VIDEO_BLEND_AUDIO,
  DEFAULT_VIDEO_ENABLED,
  DEFAULT_VIDEO_LOOP,
  SPRITE_COMPONENT,
  componentForSlot,
  presetOf,
} from "./presets";
import { OBJECT_KINDS, type ObjectKind } from "./presets";
import {
  DOCUMENT_FORMAT_VERSION,
  SOUND_LAYERS,
  VIDEO_BLEND_AUDIO,
  type BgmSettingsDoc,
  type ProjectDoc,
  type ProjectSettingsDoc,
  type SceneDoc,
  type SceneFileDoc,
  type SpriteImportSettingsDoc,
  type SpriteSheetDoc,
} from "./types";

/**
 * 文档 zod 校验。
 *
 * 加载任何文件都必须先过这里：不合法就报错，**不静默丢字段**。
 * 工程文件（`project.json`）与场景文件（`Assets/scenes/<场景名>.json`）各有一套 schema；
 * 旧版本（v1：地图即场景；v2：场景内联在工程文件里；v4 及更早：位置是归一化坐标）
 * 由 `upgradeRawDocument` / `migrateScenePositions` 先升级结构，再走 schema。
 */

export const worldPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

/**
 * 「图集里的第几格」（v20 起）：`column` 从左数（0 起）、`row` **从最上数**（0 起），
 * 对齐 Unity 的 Sprite Editor 的格子编号。
 *
 * 这里只保证「是非负整数」：越界（`column >= columns`）**不算解析错误**——切分被改小之后
 * 老对象的格子会暂时越界，读不开文件比读出来再提示更糟；它由渲染与推送统一夹到最后一格
 * （`sprites.ts` 的 `clampSpriteCell`），`validateScene` 报 warning。
 */
export const imageSpriteRefSchema = z.object({
  column: z.number().int().nonnegative(),
  row: z.number().int().nonnegative(),
});

/**
 * 图片引用（v20 起多了可选的 `sprite`；v23 起多了可选的 `guid`）：资源逻辑 ID + 声明尺寸 + 「取哪一格」。
 *
 * `sprite` 只是一份**引用**：「几行几列」住在素材自己的 `.meta` 里，只有那一份。
 * `guid` 是素材的**稳定身份**（有它就以它为准，`id` 只是「上次见到的路径」）——这里只要求
 * 「非空字符串」：认不出的 guid 顶多查不到 meta、退回按 `id` 解析，读不开文件比画不出来更糟。
 */
export const imageRefSchema = z.object({
  id: z.string().min(1),
  guid: z.string().min(1).optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sprite: imageSpriteRefSchema.optional(),
});

export const gridSpecSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const cellRunsSchema = z.object({
  encoding: z.literal("rle"),
  runs: z.array(z.tuple([z.number().int().min(0).max(255), z.number().int().nonnegative()])),
});

/**
 * 战争雾（v10 起：雾区；v13 起：总开关；v25 起：独立 `FogOfWar` 组件的 data，形状不变）：
 * **开不开**，以及哪些区域算雾区。
 *
 * `regions` 给默认值 `[]` 是有意的（与 v7 的 `active` 同理）：**字段在、内容空**和
 * 「字段整个不在」在语义上是一回事（没指定任何雾区），给默认值省掉一处三元判断。
 * 位值范围只挡到 1–255（与格子掩码同一个口径）；「必须是已知的可绘制位」属于语义校验，
 * 由 `validateScene` 报 warning——手写文件里的越界位要在界面上看得见，而不是读不开文件。
 *
 * `enabled` 同样**给默认值 `true`**：v10–v12 的文件里没有这一项，而那时候写下 `fog`
 * 就等于「这张地图有雾」——补成 `false` 会把老场景的雾静默关掉。读出旧文件时补进内存，
 * 并随迁移回写一次（版本升到 13 时本来就要回写）。
 */
export const mapFogSchema = z.object({
  // v27 起雾是独立对象：引用哪张地图（对象 id）。缺省空串（损坏 / 手写文件），校验报 error
  mapId: z.string().default(""),
  enabled: z.boolean().default(true),
  regions: z.array(z.number().int().min(1).max(255)).default([]),
});

/** `GridMap` 组件携带的**网格数据**（v28 起只到这里；`rowOrder` 固定 bottom-up）。贴图与显示顺序住在 `ImageLayer` 里，战争雾在独立的 `FogOfWar` 组件里。 */
export const mapDataSchema = z.object({
  grid: gridSpecSchema,
  rowOrder: z.literal("bottom-up"),
  cells: cellRunsSchema,
});

/**
 * 图片层组件（`ImageLayer` / `SpriteLayer`）的数据：一份图片引用 + v26 起的显示顺序。
 *
 * 刻意**不**把 `sortingOrder` 加进 `imageRefSchema`：那个形状是「只存引用」的共享形状，
 * 多一项会污染它。这里扩一份只给图片层用。
 *
 * v28 起**带网格的贴图也用它承载贴图与显示顺序**：`mapDataSchema` 不再有 `image`。
 */
export const imageLayerDataSchema = imageRefSchema.extend({
  sortingOrder: z.number().int().default(0),
});

/**
 * 播放声音（动作对象）的数据：加进来的音频列表 + 选中的那条（可选）+ 每个文件的显示名（可选）+ 层级。
 *
 * `clips` 给默认值 `[]`、`layer` 给默认值 `"sfx"`：手写文件里少写一项时，
 * 语义只能是「还没加音频」「音效这一层」，给默认值省掉一处三元判断。
 * 层级只认三档（`SOUND_LAYERS` = `bgm` / `sfx` / `voice`）：写了别的值说明数据不是这份编辑器写的，
 * 报错比猜更安全。`bgm` 虽然还认（老文件里对象可能写着它），但**界面不再给对象选**
 * （背景音乐是项目级全局设置，见 `OBJECT_SOUND_LAYERS` 与 `validateScene` 的警告）。
 * `picked` 缺省 = 还没选（播放按钮点不了）：它必须落在 `clips` 里，越界不算解析错误
 * （`validateScene` 会把「选中的那条不在列表里」提醒出来并按没选处理）。
 * 显示名**不在场景里**：「文件 → 显示名」住在素材自己的 `.meta`（顶层 `name`），
 * 任何地方都只在文件属性上改（旧版本按对象记的 `names` 已退役，读到时随回写清掉）。
 */
export const soundDataSchema = z.object({
  clips: z.array(z.string().min(1)).default([]),
  picked: z.string().min(1).optional(),
  layer: z.enum(SOUND_LAYERS).default(DEFAULT_SOUND_LAYER),
});

/**
 * 传送阵（动作对象）的数据：候选目标场景 + 选中的那一个（可选）。
 *
 * `targets` 给默认值 `[]`（与 `sound.clips` 同一个口径）：手写文件里少写一项时，
 * 语义只能是「还没加任何目标」。
 * `picked` **不给默认值**：它的「没写」有明确语义——还没选要传送哪一个（按钮点不了）。
 * 选中的那条必须落在 `targets` 里，越界不算解析错误（`validateScene` 会提醒并按没选处理）。
 */
export const teleportDataSchema = z.object({
  targets: z.array(z.string().min(1)).default([]),
  picked: z.string().min(1).optional(),
});

/**
 * 视频列表（v14 起，可选）：地图 / 精灵上的「一组视频 + 选中哪条 + 循环 / 声音」。
 *
 * 与 `soundDataSchema` 同一套口径：`clips` / `loop` / `audio` **给默认值**（手写文件里少写一项时，
 * 语义只能是「还没加视频、不循环、静音」），`picked` **不给**——「没写」本身有意义（还没选，
 * 播放按钮点不了）。显示名住在素材 `.meta`（与 `sound` 同一套，见那里）。
 * `enabled`（总开关）同样给默认值 `true`，理由见下面那一行。
 *
 * **不需要补壳迁移**：整个 `video` 字段是可选的，「没有它」就等于「这个对象不放视频」，
 * 所以 v13 → v14 只是版本号 +1 触发一次回写，不像 `fog.enabled` 那样要往老文件里填默认值。
 */
export const videoDataSchema = z.object({
  // v14 起，与 `map.fog.enabled` 同一个口径：老编辑器不发这一项时语义只能是「在用」
  // （`video` 只有加过视频才写出来），补成 false 会把已有的视频静默关掉
  enabled: z.boolean().default(DEFAULT_VIDEO_ENABLED),
  autoPlay: z.boolean().default(DEFAULT_VIDEO_AUTO_PLAY),
  clips: z.array(z.string().min(1)).default([]),
  picked: z.string().min(1).optional(),
  loop: z.boolean().default(DEFAULT_VIDEO_LOOP),
  audio: z.boolean().default(DEFAULT_VIDEO_AUDIO),
});

/**
 * 视频混合（可选，只有贴图能带）：两条视频通道（A 盖住 / B 擦开露出）+ 循环 + 声音来源。
 *
 * 与 `soundDataSchema` 同一套口径：两条通道各自是 `{ clips, picked? }`——列表给默认值
 * （手写文件少写一项时语义只能是「还没加视频」），`picked` **不给**（「没写」= 还没选，
 * 播放按钮点不了）。**遮罩不在这里**：它是纯运行态（`erase_video_mask` 命令驱动），
 * 不落盘，所以组件数据里没有任何遮罩字段。
 *
 * **组件在 = 在用**（与 `GridMap` 同一条口径）：不像 `videoDataSchema` 那样有个兼容性的
 * `enabled`——那是 v19 迁移留下来的；新组件由属性面板底部的 Add Component 添加、组头移除。
 */
const videoBlendChannelSchema = z.object({
  clips: z.array(z.string().min(1)).default([]),
  picked: z.string().min(1).optional(),
});

export const videoBlendDataSchema = z.object({
  a: videoBlendChannelSchema.default(() => ({ clips: [] })),
  b: videoBlendChannelSchema.default(() => ({ clips: [] })),
  loop: z.boolean().default(DEFAULT_VIDEO_LOOP),
  audio: z.enum(VIDEO_BLEND_AUDIO).default(DEFAULT_VIDEO_BLEND_AUDIO),
});

/**
 * 组件实例（v19）。
 *
 * 从对象特性提升上来的那 8 种**按各自的 schema 硬校验**（`GridMap` 的 RLE、`PlaySound` 的层级…），
 * 未知类型走宽松分支（`data` 是任意记录）——这样手写文件里的自定义组件
 * 照样读得回来，而**已知的 8 种写坏了会直接读不开**（与 v18 之前扁平字段的严格程度一致）。
 *
 * 「未知类型」分支把已知的 8 个名字排除掉：否则一个 data 坏掉的 `GridMap` 会掉进宽松分支，
 * 严格校验就形同虚设。
 */
const KNOWN_COMPONENT_TYPE_NAMES: readonly string[] = COMPONENT_TYPES.map((def) => def.type);

const permissiveComponentSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1).refine((type) => !KNOWN_COMPONENT_TYPE_NAMES.includes(type), {
    message: "已知组件类型的 data 不符合它的 schema",
  }),
  displayName: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});

function componentSchemaOf<T extends z.ZodTypeAny>(
  type: string,
  data: T,
): z.ZodObject<{
  id: z.ZodString;
  type: z.ZodLiteral<string>;
  displayName: z.ZodOptional<z.ZodString>;
  data: T;
}> {
  return z.object({
    id: z.string().min(1),
    type: z.literal(type),
    displayName: z.string().optional(),
    data,
  });
}

export const sceneComponentSchema = z.union([
  componentSchemaOf(DEFAULT_SLOT_COMPONENT.map, mapDataSchema),
  // 战争雾（v25 起）从 GridMap 拆出来：形状不变，还是 `mapFogSchema`
  componentSchemaOf(DEFAULT_SLOT_COMPONENT.fog, mapFogSchema),
  // 对象自己显示的图有**两种承载**：贴图 `ImageLayer`、精灵 `SpriteLayer`（同一份数据；
  // v26 起比 `imageRefSchema` 多一项显示顺序）
  componentSchemaOf(DEFAULT_SLOT_COMPONENT.image, imageLayerDataSchema),
  componentSchemaOf(SPRITE_COMPONENT, imageLayerDataSchema),
  componentSchemaOf(DEFAULT_SLOT_COMPONENT.sound, soundDataSchema),
  componentSchemaOf(DEFAULT_SLOT_COMPONENT.teleport, teleportDataSchema),
  componentSchemaOf(DEFAULT_SLOT_COMPONENT.video, videoDataSchema),
  componentSchemaOf(DEFAULT_SLOT_COMPONENT.videoBlend, videoBlendDataSchema),
  permissiveComponentSchema,
]);

export const gameObjectSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  // 取值就是 `OBJECT_KINDS`（**单一来源**：加/改一个对象类型只动 `presets.ts`）。
  // `GameObject` 是抽象基类，schema 照收（它是合法类型），但编辑器不会写它、老文件由迁移换掉
  kind: z.enum(OBJECT_KINDS),
  // v7 起：是否显示。**给默认值**是有意的——v6 及更早的文件没有这个字段，
  // 「没写」只能是「显示」；写成必填会让所有旧文件直接读不开。
  // （`sortingOrder` 也是 v7 加的，但 v26 起搬进了渲染组件，见 `mapDataSchema` /
  // `imageLayerDataSchema` 与 `migrateSortingOrderToRenderComponents`。）
  active: z.boolean().default(true),
  // v9 起：是否锁定（不能被移动）。同样是「老文件里没有 = 默认值」，默认不锁
  locked: z.boolean().default(false),
  position: worldPositionSchema.nullable(),
  rotation: z.number(),
  // v8 起：等比缩放。同样给默认值（v7 及更早的文件没有它，语义只能是 1 = 原始尺寸）；
  // 0 / 负数 / NaN 这类坏值不在这里硬拒（读不开比画不出来更糟），由 `validateScene` 报错
  scale: z.number().default(1),
  // v11 起：单轴缩放（可选）。存在时覆盖 `scale` 在对应轴上的值；**不给默认值**是有意的
  // ——「没写」的语义是「用 `scale`」，补成 1 会把等比对象悄悄变成非等比。
  // 取值与坏值处理同 `scale`（见 `@dts/document` 的 `effectiveScaleX` / `validateScene`）
  scaleX: z.number().optional(),
  scaleY: z.number().optional(),
  components: z.array(sceneComponentSchema),
});

/** 场景文件内容：**不含场景名**——名字就是文件名，重复存名字迟早会和磁盘上的名字不一致。 */
export const sceneFileSchema = z.object({
  formatVersion: z.number().int().positive(),
  objects: z.array(gameObjectSchema),
});

export const itemDefSchema = z.object({
  name: z.string().min(1),
  price: z.number().nullable(),
  category: z.string(),
  identify: z.string(),
  usage: z.string(),
});

export const itemLibrarySchema = z.object({
  source: z.string(),
  updatedAt: z.string(),
  count: z.number().int().nonnegative(),
  items: z.array(itemDefSchema),
});

/**
 * 三档音量的缺省值（`0..1`）：背景音乐略低（别盖住说话）、音效其次、旁白最清（必须听清）。
 *
 * 放在这里而不是散在各处，是因为它们既是 schema 的默认值，也是「新建项目」的初值
 * （`createEmptyProject` 与 `defaultProjectSettings()` 共用同一份）。
 */
export const DEFAULT_BGM_VOLUME = 0.6;
export const DEFAULT_SFX_VOLUME = 0.8;
export const DEFAULT_VOICE_VOLUME = 1;

/** 缺省的背景音乐通道：只有音量（歌单在编辑器弹框里，不进文档）。 */
export function defaultBgmSettings(): BgmSettingsDoc {
  return { volume: DEFAULT_BGM_VOLUME };
}

/** 缺省的音频设置（背景音乐 + 音效 + 旁白三档音量）。 */
export function defaultAudioSettings(): ProjectSettingsDoc["audio"] {
  return {
    bgm: defaultBgmSettings(),
    sfx: { volume: DEFAULT_SFX_VOLUME },
    voice: { volume: DEFAULT_VOICE_VOLUME },
  };
}

/** 缺省的项目级全局设置（新建项目、老文件缺项补齐都用它）。 */
export function defaultProjectSettings(): ProjectSettingsDoc {
  return { audio: defaultAudioSettings() };
}

/**
 * 三档音量共用的形状：**只有一个 `volume`**。
 *
 * v16 起背景音乐也用它（v15 的歌单 / 默认曲 / 循环已从文档里拿掉）。
 * 越界不在这里硬拒（与 `scale` 同一个口径：读不开比听不清更糟）：`validateProject` 报 warning、
 * 编辑命令按 `0..1` 夹一次，前端收到也按 `0..1` 用。
 */
export const channelVolumeSchema = z.object({
  volume: z.number(),
});

/**
 * 项目级全局设置（v15 起，v16 起背景音乐只剩音量）。
 *
 * 每一档都**给默认值**：老 `project.json`（以及手写缺项的文件）读出来就是一份可用的设置，
 * 不必在调用方到处写三元判断。音效音量比旁白低一档是常听的配比（音效多半是点缀，
 * 旁白是「必须听清」的那一档）。
 */
export const projectSettingsSchema = z.object({
  audio: z
    .object({
      bgm: channelVolumeSchema.default(() => defaultBgmSettings()),
      sfx: channelVolumeSchema.default(() => ({ volume: DEFAULT_SFX_VOLUME })),
      voice: channelVolumeSchema.default(() => ({ volume: DEFAULT_VOICE_VOLUME })),
    })
    .default(() => defaultAudioSettings()),
});

/**
 * 项目级**标签表**（v18 起）：下标 = tag ID，值 = 名字（`null` = 已删除的洞）。
 *
 * 逐项校验只保证「是字符串或 null」；空名字 / 重名 / 文件引用越界都由 `validateProject`
 * 与 `validateAssetMetas` 报 warning（读不开比标签显示不出来更糟）。
 */
export const audioTagTableSchema = z.array(z.string().nullable());

/**
 * 工程文件：只有项目级数据，场景在 `Assets/scenes/` 下各自成文件。
 *
 * `audioTags` **可选且不给默认值**：缺省 = 这个项目根本没有标签
 * （v14 的 `video` 同一条规矩：不拿空壳冒充「有这个字段」）。
 *
 * v23 起这里**没有**图片的切分与导入设置，v24 起也**没有**音频文件的标注：
 * 两者都搬到了**素材自己的 `.meta`** 里（`asset-meta.ts`），由 `parseProjectFile` 的
 * 迁移按路径合并出来交给调用方落盘。**每个素材旁边的 `.meta` 才是素材级数据的家**。
 */
export const projectDocSchema = z.object({
  formatVersion: z.number().int().positive(),
  name: z.string().min(1),
  items: itemLibrarySchema,
  // v15 起：项目级全局设置（目前是音频）。**给默认值**：老 `project.json` 里没有它，
  // 语义只能是「全用缺省参数」；版本升到 15 时本来就会回写一次，磁盘上的文件从此自描述。
  settings: projectSettingsSchema.default(() => defaultProjectSettings()),
  // v18 起：音频标签表（下标 = tag ID，值 = 名字）。**项目级**，所以留在这里。
  audioTags: audioTagTableSchema.optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验失败时把 zod 的问题列表拼成「字段路径: 消息」的可读形式。 */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * v1 → v2 结构升级。
 *
 * v1 把地图当成场景本身（`map.image/grid/cells/objects`）；v2 里场景是容器，
 * 地图降级为场景里的一个普通对象（`kind: "Map"`，数据挂在 `object.map` 上）。
 * 升级时把原来的地图数据原样搬到一个新建的地图对象上，其余对象保持不动。
 */
function upgradeV1Document(raw: Record<string, unknown>): Record<string, unknown> {
  const maps = Array.isArray(raw.maps) ? raw.maps : [];

  const scenes = maps.filter(isRecord).map((map) => {
    const id = typeof map.id === "string" ? map.id : `scene_${Math.random().toString(36).slice(2, 8)}`;
    const name = typeof map.name === "string" ? map.name : id;
    const objects = Array.isArray(map.objects) ? map.objects.filter(isRecord) : [];

    const mapObject = {
      id: `${id}__map`,
      name: `${name} 地图`,
      kind: "Map",
      position: null,
      rotation: 0,
      components: [],
      map: {
        image: map.image,
        grid: map.grid,
        rowOrder: map.rowOrder,
        cells: map.cells,
      },
    };

    return {
      id,
      name,
      objects: [mapObject, ...objects],
    };
  });

  const upgraded: Record<string, unknown> = { ...raw, formatVersion: 2, scenes };
  delete upgraded.maps;
  return upgraded;
}

/** 按 `formatVersion` 把旧结构升级到当前结构（只做结构搬运，不做字段补全）。 */
export function upgradeRawDocument(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return raw;
  }

  const version = typeof raw.formatVersion === "number" ? raw.formatVersion : 1;
  if (version <= 1 && Array.isArray(raw.maps)) {
    return upgradeV1Document(raw);
  }

  return raw;
}

/**
 * 场景范围的兜底尺寸（旧文件里没写尺寸、调用方也拿不到时用）。
 *
 * 与编辑器新建地图对象的默认贴图尺寸一致（1920×1080 → 64×36 格）。
 */
const FALLBACK_SCENE_SIZE = { width: 1920, height: 1080 } as const;

/** 位置迁移用到的场景尺寸：优先用调用方给的（地图贴图尺寸），否则兜底。 */
export interface SceneSizeHint {
  readonly width: number;
  readonly height: number;
}

/**
 * 给对象补上 v7 的 `active`、v8 的 `scale`、v9 的 `locked`，
 * 并给**没有位置的地图**补上世界原点。
 *
 * - 地图是摆在世界里的对象，必须有位置才能渲染（`position: null` 的地图没有地方可画）。
 *   旧文件里确实可能是 `null`（v1→v2 升级时造的地图对象、或手写文件），补成 `(0, 0)`
 *   正好是它以前被隐式绘制的那个位置（世界原点为中心），画面不变。
 * - `active` / `scale` / `locked` 是后来新增的**显式**字段：老文件里没有，
 *   语义只能是「显示、缩放 1、不锁」。补进内存后要求调用方回写一次，
 *   否则会出现「内存里已补全、磁盘上还是缺字段」的长期不一致。
 * - `sortingOrder` 自 v26 起**不在这里补**：它搬进了渲染组件（缺渲染层的对象本就不该有），
 *   由 `migrateSortingOrderToRenderComponents` 从对象级搬到组件、组件里缺项由 schema 的
 *   默认值补 0。
 * - v11 的 `scaleX` / `scaleY` **刻意不在这里补**：它们是**可选**的，「没写」本身就是合法
 *   且有意义的（= 用等比 `scale`）。补成 1 会把等比对象悄悄变成非等比，那才是改坏数据。
 *
 * 返回是否补过：补了就要求调用方回写一次文件。
 */
function withFilledObjectFields(raw: Record<string, unknown>): {
  readonly raw: Record<string, unknown>;
  readonly changed: boolean;
} {
  const objects = Array.isArray(raw.objects) ? raw.objects : [];
  let changed = false;

  const next = objects.map((object) => {
    if (!isRecord(object)) {
      return object;
    }

    let filled = object;
    if (typeof filled.active !== "boolean") {
      filled = { ...filled, active: true };
      changed = true;
    }

    if (typeof filled.scale !== "number") {
      filled = { ...filled, scale: 1 };
      changed = true;
    }

    if (typeof filled.locked !== "boolean") {
      filled = { ...filled, locked: false };
      changed = true;
    }

    if (filled.kind === "Map" && (filled.position === null || filled.position === undefined)) {
      filled = { ...filled, position: { x: 0, y: 0 } };
      changed = true;
    }

    return filled;
  });

  return changed ? { raw: { ...raw, objects: next }, changed } : { raw, changed };
}

/**
 * v4 → v5：位置从**归一化坐标 `[0,1]`（y 向下）**换算成**世界坐标（x 向右，y 向上）**。
 *
 * 换算与 `@dts/grid` 的 `world.ts` 一致，这里手写一遍是为了**不引入依赖**（document 只依赖 grid
 * 的字节与掩码工具，坐标换算在迁移里只出现这一次）。旧值越界（不在 `[0,1]`）时**原样保留**，
 * 宁可让它在画布上偏出去，也不静默夹到边界——那会把错误数据伪装成正确数据。
 *
 * 地图对象的位置**照常换算**：地图是摆在世界里的对象，位置就是它的贴图中心。
 */
function migrateScenePositions(
  raw: Record<string, unknown>,
  size: SceneSizeHint,
): Record<string, unknown> {
  const objects = Array.isArray(raw.objects) ? raw.objects : [];

  return {
    ...raw,
    formatVersion: DOCUMENT_FORMAT_VERSION,
    objects: objects.map((object) => {
      if (!isRecord(object) || !isRecord(object.position)) {
        return object;
      }

      const { x, y } = object.position;
      if (typeof x !== "number" || typeof y !== "number") {
        return object;
      }

      if (x < 0 || x > 1 || y < 0 || y > 1) {
        return object;
      }

      return {
        ...object,
        position: {
          x: x * size.width - size.width / 2,
          y: size.height / 2 - y * size.height,
        },
      };
    }),
  };
}

/**
 * v12 之前那一版：传送阵只有**一个目标**（`teleport: { target: "地图2" }`）。
 *
 * schema 不认 `target`（`z.object` 会把没见过的字段静默丢掉），直接读会变成「还没加目标」——
 * 文件明明写着目标却点不动「传送」，所以在这里搬一次：挪进候选清单，并顺手选中它。
 * 只认得出旧形状才动；新形状（已经有 `targets`）或没写 `teleport` 的原样返回。
 */
function migrateTeleportTarget(raw: Record<string, unknown>): {
  readonly raw: Record<string, unknown>;
  readonly changed: boolean;
} {
  const objects = Array.isArray(raw.objects) ? raw.objects : [];
  let changed = false;

  const next = objects.map((object) => {
    if (!isRecord(object) || !isRecord(object.teleport)) {
      return object;
    }

    const teleport = object.teleport;
    const legacy = teleport.target;
    if (
      typeof legacy !== "string" ||
      legacy.trim().length === 0 ||
      Array.isArray(teleport.targets)
    ) {
      return object;
    }

    changed = true;
    const rest: Record<string, unknown> = { ...teleport };
    delete rest.target;
    return { ...object, teleport: { ...rest, targets: [legacy], picked: legacy } };
  });

  return changed ? { raw: { ...raw, objects: next }, changed } : { raw, changed };
}

/**
 * v15：声音层级从四档收敛成三档，原来的「环境音 `ambient`」并进 **`bgm`**。
 *
 * 为什么是并进 `bgm` 而不是 `sfx`：环境音就是「一直在响的底噪」，与背景音乐同属
 * 「一条持续着的氛围声」，只是分工不同；并进音效会把它变成一次性动作，语义差得远。
 * 只认得出 `ambient` 才动（写别的值由 schema 报错，不在这里猜）。
 */
function migrateSoundLayers(raw: Record<string, unknown>): {
  readonly raw: Record<string, unknown>;
  readonly changed: boolean;
} {
  const objects = Array.isArray(raw.objects) ? raw.objects : [];
  let changed = false;

  const next = objects.map((object) => {
    if (!isRecord(object) || !isRecord(object.sound)) {
      return object;
    }

    if (object.sound.layer !== "ambient") {
      return object;
    }

    changed = true;
    return { ...object, sound: { ...object.sound, layer: "bgm" } };
  });

  return changed ? { raw: { ...raw, objects: next }, changed } : { raw, changed };
}

/**
 * v16：把 `settings.audio.bgm` 上的**歌单 / 默认曲 / 名字 / 循环**删掉，只留 `volume`。
 *
 * 为什么显式删而不是靠 zod 的「丢掉不认识的键」：静默丢弃正是数据损坏的来源——
 * 这里要说清「这四项是**故意**去掉的」（背景音乐改成弹框里点项目音频，播放不再需要声明），
 * 顺带把 `changed` 报出来，让调用方把新形状回写一次。
 *
 * 缺 `volume`（或整份不是对象）就补默认值；`settings` 本身没有时不在这里补
 * （`projectDocSchema` 会给整份默认值，`settingsFilled` 那条回写规矩管它）。
 */
function migrateBgmSettings(raw: Record<string, unknown>): {
  readonly raw: Record<string, unknown>;
  readonly changed: boolean;
} {
  const settings = raw.settings;
  if (!isRecord(settings)) {
    return { raw, changed: false };
  }

  const audio = settings.audio;
  if (!isRecord(audio)) {
    return { raw, changed: false };
  }

  const bgmRecord = isRecord(audio.bgm) ? audio.bgm : undefined;
  const hadLegacy =
    bgmRecord !== undefined &&
    (bgmRecord.clips !== undefined ||
      bgmRecord.picked !== undefined ||
      bgmRecord.names !== undefined ||
      bgmRecord.loop !== undefined);
  const volume =
    typeof bgmRecord?.volume === "number" ? (bgmRecord.volume as number) : DEFAULT_BGM_VOLUME;

  if (!hadLegacy && bgmRecord !== undefined && bgmRecord.volume === volume) {
    return { raw, changed: false };
  }

  return {
    raw: { ...raw, settings: { ...settings, audio: { ...audio, bgm: { volume } } } },
    changed: true,
  };
}

/**
 * v18：把音频标签从**字符串**改成**整数 ID + 项目级标签表**（`audioTags`）。
 *
 * v17 的 `audioMeta[clip].tags` 是 `["战斗", "紧张"]` 这样的字符串数组；现在文件里只记
 * `[0, 1]`（下标 = tag ID），名字住在 `audioTags` 里——这是「改标签名只改一处」的前提。
 *
 * 迁移规则（都按**出现顺序**，保证同一份文件每次迁出来的 ID 一样）：
 * - 逐个文件、逐个标签地看：trim 后非空的名字，已经在表里就用那个 ID，没有就追加；
 * - 每个文件的标签换成 ID 列表（去重、升序），空列表就把 `tags` 删掉；
 * - 改名后既没名字也没标签的 entry 收掉（与命令层「不留空壳」同一条规矩）；
 * - 表是空的（没有任何标签）就不写 `audioTags`。
 *
 * 已经有了 `audioTags`（不该出现在 v17，防御性判断）就整段不动。
 */
function migrateAudioTags(raw: Record<string, unknown>): {
  readonly raw: Record<string, unknown>;
  readonly changed: boolean;
} {
  const meta = raw.audioMeta;
  if (!isRecord(meta) || Array.isArray(raw.audioTags)) {
    return { raw, changed: false };
  }

  const table: string[] = [];
  const idOf = (name: string): number => {
    const existing = table.indexOf(name);
    if (existing >= 0) {
      return existing;
    }

    table.push(name);
    return table.length - 1;
  };

  let changed = false;
  const nextMeta: Record<string, unknown> = {};

  for (const [clipId, entry] of Object.entries(meta)) {
    if (!isRecord(entry)) {
      nextMeta[clipId] = entry;
      continue;
    }

    const legacy = entry.tags;
    if (!Array.isArray(legacy)) {
      nextMeta[clipId] = entry;
      continue;
    }

    changed = true;
    const ids = new Set<number>();
    for (const tag of legacy) {
      if (typeof tag !== "string") {
        continue;
      }

      const trimmed = tag.trim();
      if (trimmed.length === 0) {
        continue;
      }

      ids.add(idOf(trimmed));
    }

    const nextEntry: Record<string, unknown> = { ...entry };
    if (ids.size === 0) {
      delete nextEntry.tags;
    } else {
      nextEntry.tags = [...ids].sort((a, b) => a - b);
    }

    // 名字与标签都没了：这一条整个收掉（与 `pruneAudioMeta` 同一个口径）
    if (nextEntry.name === undefined && nextEntry.tags === undefined) {
      continue;
    }

    nextMeta[clipId] = nextEntry;
  }

  if (!changed) {
    return { raw, changed: false };
  }

  const next: Record<string, unknown> = { ...raw };
  if (Object.keys(nextMeta).length === 0) {
    delete next.audioMeta;
  } else {
    next.audioMeta = nextMeta;
  }

  if (table.length > 0) {
    next.audioTags = table;
  }

  return { raw: next, changed: true };
}

/**
 * 老切分表的一项；认不出形状就当没有（这种坏值在 v22 的 schema 那一层本来就会被拒）。
 *
 * 不在这里取整 / 夹取：那是 `withMetaSpriteSheet` 的活（唯一的写入口径），
 * 这里只把「读得懂的部分」原样交出去。
 */
function legacySheetOf(value: unknown): SpriteSheetDoc | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { columns, rows } = value;
  if (typeof columns !== "number" || typeof rows !== "number") {
    return undefined;
  }

  return { columns, rows };
}

/** 老导入设置的一项；`type` 认不出时当没写（与「不替它猜」同一条）。 */
function legacySettingsOf(value: unknown): SpriteImportSettingsDoc | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.type === "Default") {
    return { type: "Default" };
  }

  if (value.type !== "Sprite") {
    return undefined;
  }

  return value.mode === "Single" || value.mode === "Multiple"
    ? { type: "Sprite", mode: value.mode }
    : { type: "Sprite" };
}

/**
 * 老导入设置说了算：**没写 / `Multiple` 才保留切分**。
 *
 * `Default` 与 `Single` 都不要网格切分——留着会变成「面板说是普通图片、渲染却按切分画」，
 * 这正是 `withMetaSpriteSettings` 写路径上要摘掉的那种分叉，迁移没理由把它搬过来。
 */
function legacyKeepsSheet(settings: SpriteImportSettingsDoc | undefined): boolean {
  return (
    settings === undefined || (settings.type === "Sprite" && (settings.mode ?? "Single") === "Multiple")
  );
}

/**
 * v22 → v23：把工程文件里的 `spriteSheets`（路径 ID → 列×行）与 `spriteSettings`
 * （路径 ID → 导入设置）按**同一个路径 ID** 合并成一份 meta，交给调用方写进各自素材的 `.meta`。
 *
 * 四条口径：
 * - **合并只按路径 ID**：老文件里这两项是两份表、键是同一个东西（图片逻辑 ID），
 *   所以「两张表取键的并集，每个键一份 meta」；
 * - **导入设置说了算**（`legacyKeepsSheet`）：见那里；
 * - **guid 现生成**：老文件里没有任何稳定身份可言——这正是要迁移的原因；
 * - **不判断素材还在不在**：文档层没有资源树，改名留下的孤儿键照旧交给调用方按资源树过滤
 *   （见 README 的已知不一致）。
 *
 * 写入复用 `withMetaSpriteSettings` / `withMetaSpriteSheet`（唯一一套写入口径），于是
 * 「1×1 不收」「Default 不留空壳」这些规矩在迁移与日常编辑里是同一份代码。
 */
function migrateSpriteMetas(raw: Record<string, unknown>): {
  readonly metas: Array<{ readonly id: string; readonly meta: AssetMetaDoc }>;
  readonly changed: boolean;
} {
  const sheets = isRecord(raw.spriteSheets) ? raw.spriteSheets : {};
  const settings = isRecord(raw.spriteSettings) ? raw.spriteSettings : {};
  // 两项都在时字段照样要删掉：`changed` 说的是「有东西从工程文件里搬走了」
  const changed = raw.spriteSheets !== undefined || raw.spriteSettings !== undefined;

  const metas: Array<{ readonly id: string; readonly meta: AssetMetaDoc }> = [];
  for (const id of new Set([...Object.keys(sheets), ...Object.keys(settings)])) {
    // 空路径 ID 不可能是素材（手写文件的噪声）：跳过，不为它造一份没有归属的 meta
    if (id.trim().length === 0) {
      continue;
    }

    const sheet = legacySheetOf(sheets[id]);
    const importSettings = legacySettingsOf(settings[id]);
    let meta = createAssetMeta("texture");
    if (importSettings !== undefined) {
      meta = withMetaSpriteSettings(meta, importSettings);
    }

    if (sheet !== undefined && legacyKeepsSheet(importSettings)) {
      meta = withMetaSpriteSheet(meta, sheet);
    }

    metas.push({ id, meta });
  }

  return { metas, changed };
}

/**
 * v23 → v24：把工程文件里的 `audioMeta`（路径 ID → `{ 显示名, 标签 ID }`）按路径搬进
 * 各自音频文件的 `.meta` 的 `audio` 段，交给调用方写进那一份 `.meta`。
 *
 * 四条口径：
 * - **标签 ID 要过表**：越界 / 指向已删的洞 / 重复的 ID 由 `withMetaAudioTags` 丢掉
 *   （与界面上的写路径共用同一份归一化），落盘的 meta 天生干净；
 * - **空壳不搬**：不是对象的项、以及搬完既没名字也没标签的项（旧版本留下的 `{}`）**不为它造 meta**
 *   ——素材自己那份 meta 由调用方按「每个素材一份」统一补（`loadAssetMetas`），
 *   这里不替它写一份只有 GUID 的空壳（那是这次要消掉的噪声）；
 * - **`audioTags` 留在工程文件里**：它是项目级数据，不是某一个文件的属性（见 `types.ts` 的 v24）；
 * - **不判断素材还在不在**：与 `migrateSpriteMetas` 同一条——孤儿键交给调用方按资源树丢弃并报 warning。
 */
function migrateAudioMetas(
  raw: Record<string, unknown>,
  table: readonly (string | null)[],
): {
  readonly metas: Array<{ readonly id: string; readonly meta: AssetMetaDoc }>;
  readonly changed: boolean;
} {
  const legacy = raw.audioMeta;
  const changed = legacy !== undefined;
  if (!isRecord(legacy)) {
    return { metas: [], changed };
  }

  const metas: Array<{ readonly id: string; readonly meta: AssetMetaDoc }> = [];
  for (const [id, entry] of Object.entries(legacy)) {
    // 空路径 ID 不可能是素材（手写文件的噪声）：跳过，不为它造一份没有归属的 meta
    if (id.trim().length === 0 || !isRecord(entry)) {
      continue;
    }

    const name = typeof entry.name === "string" ? entry.name : undefined;
    const tags = Array.isArray(entry.tags)
      ? entry.tags.filter((tag): tag is number => typeof tag === "number")
      : undefined;

    let meta = createAssetMeta("audio");
    if (name !== undefined) {
      meta = withMetaAudioName(meta, name);
    }

    if (tags !== undefined) {
      meta = withMetaAudioTags(meta, tags, table);
    }

    // 搬完什么都不剩（空壳 / 名字全空白 / 标签全越界）：不为它造 meta
    if (meta.audio === undefined) {
      continue;
    }

    metas.push({ id, meta });
  }

  return { metas, changed };
}

/**
 * 合并两次迁移搬出来的 meta（v23 的图片 + v24 的音频），**同一个键先到的赢**。
 *
 * 路径带扩展名，所以同一个键不可能既是图片又是这些数据；真撞上（手写文件）时先到的赢，
 * 与 `createAssetMetas` 面对重复 guid 时同一条取舍：稳定地写出一份，比两份互相覆盖好。
 */
function mergeMigratedMetas(
  ...groups: ReadonlyArray<ReadonlyArray<{ readonly id: string; readonly meta: AssetMetaDoc }>>
): Array<{ readonly id: string; readonly meta: AssetMetaDoc }> {
  const byId = new Map<string, AssetMetaDoc>();
  for (const group of groups) {
    for (const entry of group) {
      if (!byId.has(entry.id)) {
        byId.set(entry.id, entry.meta);
      }
    }
  }

  return [...byId].map(([id, meta]) => ({ id, meta }));
}

/**
 * 文件里写的 `formatVersion`（没写就按 v1 算）。
 *
 * **判断迁移不能拿它跟 `DOCUMENT_FORMAT_VERSION` 比**：版本号一涨，所有旧文件都会被
 * 判成「需要做位置换算」，那会把已经是世界坐标的 v5 文件再换算一次（(0,0) 变成 (-960, …)）。
 * 每一步迁移只认它自己那个版本线（见 `WORLD_POSITION_VERSION`）。
 */
function formatVersionOf(raw: Record<string, unknown>): number {
  return typeof raw.formatVersion === "number" ? raw.formatVersion : 1;
}

/** v5 起位置是世界坐标；更早的是归一化坐标 `[0,1]`（y 向下）。 */
const WORLD_POSITION_VERSION = 5;

/**
 * 版本迁移。遇到高于本编辑器支持的版本明确拒绝
 * （避免高版本字段被静默丢弃后回存造成数据损坏）。
 */
export function migrateProjectDoc(doc: ProjectDoc): ProjectDoc {
  if (doc.formatVersion > DOCUMENT_FORMAT_VERSION) {
    throw new Error(
      `项目文档 formatVersion=${doc.formatVersion} 高于本编辑器支持的 ${DOCUMENT_FORMAT_VERSION}，请升级编辑器`,
    );
  }

  return doc;
}

/** 场景文件的内部形状（内存里用），加载出来后再补上「场景名 = 文件名」。 */
export interface ProjectFileLoad {
  readonly doc: ProjectDoc;
  /** 旧版工程文件里内联的场景：调用方需要把它们写成 scenes/ 下的独立文件。 */
  readonly migratedScenes: readonly SceneDoc[];
  /**
   * 迁移从工程文件里搬出来的素材 meta（`id` = 素材的路径 ID）：调用方要把每一份写进
   * `<素材>.meta`（没有就新建）。两条迁移都走这里——v22 → v23 的图片切分 / 导入设置，
   * 以及 v23 → v24 的音频标注。**文档层不判断素材还在不在**——孤儿键由调用方按资源树过滤。
   */
  readonly migratedMetas: ReadonlyArray<{ readonly id: string; readonly meta: AssetMetaDoc }>;
  /** 工程文件是旧版本，需要按新格式回写。 */
  readonly needsRewrite: boolean;
}

/**
 * 读取工程文件。
 *
 * v1/v2 的工程文件里场景是内联的，这里只把它们**拆出来**交给调用方落盘——
 * document 包不碰文件系统，写不写、写到哪由调用方决定；
 * 迁移后的 `doc.formatVersion` 一律提升到当前版本，回写时不会再把旧版本号写回磁盘。
 */
export function parseProjectFile(raw: unknown): ProjectFileLoad {
  const upgraded = upgradeRawDocument(raw);
  // v16：背景音乐的歌单 / 默认曲 / 名字 / 循环从工程文件里拿掉（只留音量）。
  // 先显式删再交给 schema：schema 的「丢掉不认识的键」是静默的，这里要留下 changed。
  const bgm = isRecord(upgraded)
    ? migrateBgmSettings(upgraded)
    : { raw: upgraded, changed: false };
  // v18：音频标签从字符串换成整数 ID + `audioTags` 标签表（同样要留下 changed）
  const tags = isRecord(bgm.raw)
    ? migrateAudioTags(bgm.raw)
    : { raw: bgm.raw, changed: false };
  // v23：图片的切分 / 导入设置搬进素材自己的 `.meta`（同样要留下搬走了什么）
  const spriteMetas = isRecord(tags.raw)
    ? migrateSpriteMetas(tags.raw)
    : { metas: [], changed: false };
  // v24：音频文件的标注（显示名 + 标签 ID）搬进各自音频文件的 `.meta`。
  // 标签 ID 要按**工程文件里那张表**归一化，所以这里先把表取出来（迁移 v18 已经建好了）
  const audioTable =
    isRecord(tags.raw) && Array.isArray(tags.raw.audioTags)
      ? (tags.raw.audioTags as (string | null)[])
      : [];
  const audioMetas = isRecord(tags.raw)
    ? migrateAudioMetas(tags.raw, audioTable)
    : { metas: [], changed: false };
  const result = projectDocSchema.safeParse(tags.raw);
  if (!result.success) {
    throw new Error(`项目文档校验失败: ${formatIssues(result.error)}`);
  }

  // v2（以及经 v1 升级后的 v2）的工程文件里还有内联场景；v3 起没有
  const scenes = isRecord(tags.raw) && Array.isArray(tags.raw.scenes) ? tags.raw.scenes : [];
  const migratedScenes: SceneDoc[] = scenes.map((scene) => {
    const file = parseSceneFile(scene).file;
    return { name: scene.name, objects: file.objects };
  });

  // v15：老工程文件里没有 `settings`——schema 补一份缺省的，但**磁盘上还是缺**，
  // 所以也要标记回写一次（与场景那边「补过就回写」同一条规矩：不留「内存里有、文件里没有」）
  const settingsFilled = isRecord(tags.raw) && !isRecord(tags.raw.settings);
  const needsRewrite =
    migratedScenes.length > 0 ||
    settingsFilled ||
    bgm.changed ||
    tags.changed ||
    spriteMetas.changed ||
    audioMetas.changed ||
    result.data.formatVersion < DOCUMENT_FORMAT_VERSION;
  const doc = migrateProjectDoc({
    ...(result.data as ProjectDoc),
    ...(needsRewrite ? { formatVersion: DOCUMENT_FORMAT_VERSION } : {}),
  });

  return {
    doc,
    migratedScenes,
    migratedMetas: mergeMigratedMetas(spriteMetas.metas, audioMetas.metas),
    needsRewrite,
  };
}

/** 读工程文件，只要项目级数据（调用方不关心迁移时用它）。 */
export function parseProjectDoc(raw: unknown): ProjectDoc {
  return parseProjectFile(raw).doc;
}

/**
 * v18 → v19：把对象上的 5 个**特性扁平字段**搬成组件实例。
 *
 * 只搬键、不解释内容（内容由各自的 schema 校验）：
 * - 处理顺序 = 注册表顺序（`GridMap` → `ImageLayer` → `SpriteLayer` → `PlaySound` →
 *   `Teleport` → `VideoOverlay`），于是写盘顺序稳定、属性面板的分组顺序也稳定；
 * - 组件 id 用 `<对象 id>__<组件类型>`；对象没有合法 id 时退化成 `obj<下标>__<类型>`
 *   （手写文件里 id 可能是空的，但组件 id 必须非空且唯一）；
 * - **幂等**：目标对象上已经有同类型组件时不再追加（只把老字段删掉）——
 *   于是「迁移过一次的文件再打开」不会多出第二个实例；
 * - **不猜**：老字段不是对象就原样留着（由 schema 报错），`kind` 一个字节都不动
 *   （只搬字段，不改原型标签，否则画布色点与列表归类会跟着变）。
 */
function migrateFeaturesToComponents(raw: Record<string, unknown>): {
  readonly raw: Record<string, unknown>;
  readonly changed: boolean;
} {
  const objects = Array.isArray(raw.objects) ? raw.objects : [];
  let changed = false;

  const next = objects.map((object, index) => {
    if (!isRecord(object)) {
      return object;
    }

    if (!hasLegacyFeatureField(object)) {
      return object;
    }

    const baseId =
      typeof object.id === "string" && object.id.length > 0 ? object.id : `obj${index}`;
    const components = Array.isArray(object.components) ? [...object.components] : [];
    const rest: Record<string, unknown> = { ...object };

    for (const def of FEATURE_COMPONENT_TYPES) {
      const field = def.legacyField as string;
      const value = rest[field];
      if (!isRecord(value)) {
        continue;
      }

      delete rest[field];
      changed = true;

      // **按 kind 取组件名**：v20 及更早一个对象只有一种图片组件，v21 起精灵与贴图各一种。
      // 走 `componentForSlot`（唯一入口）而不是 `def.type`，否则老文件里的精灵会被搬进贴图的组件。
      // 槽位从组件定义自报的 `slot` 反查（`findComponentType`），对 `ImageLayer` / `SpriteLayer`
      // 两个名字都会回到 `image` 那一个槽位。
      const component = componentForSlot(findComponentType(def.type)?.slot ?? "image", kindOf(rest));
      const already = components.some((item) => isRecord(item) && item.type === component);
      if (!already) {
        components.push({
          id: componentId(baseId, component),
          type: component,
          data: value,
        });
      }
    }

    return { ...rest, components };
  });

  return changed ? { raw: { ...raw, objects: next }, changed } : { raw, changed };
}

/**
 * v24 → v25：战争雾从 `GridMap` 的 data 里搬成独立的 `FogOfWar` 组件。
 *
 * 入口判据：对象挂了 `GridMap` 组件、且其 data 里还有 `fog` 字段。搬法与
 * `migrateFeaturesToComponents` 同一套规矩：
 * - 组件实例 id 是**确定性的**（`<对象 id>__FogOfWar`），重复跑不会多出第二个实例；
 * - 对象上**已有** `FogOfWar` 组件时**不覆盖**（手写文件两份并存，保留先出现的那份——
 *   静默删用户数据比留一条校验警告更糟）；
 * - `fog` 字段整个不在的对象什么都不做——「组件不在 = 没开雾」的语义原样保留，
 *   于是「从没开过雾的地图」迁移后身上一个 `FogOfWar` 组件都没有。
 *
 * 幂等：搬过的文件 data 里不再有 `fog`，这一趟什么都不做。
 */
function migrateMapFogToComponent(raw: Record<string, unknown>): {
  readonly raw: Record<string, unknown>;
  readonly changed: boolean;
} {
  const objects = Array.isArray(raw.objects) ? raw.objects : [];
  let changed = false;

  const next = objects.map((object, index) => {
    if (!isRecord(object) || !Array.isArray(object.components)) {
      return object;
    }

    let objectChanged = false;
    const pendingFog: unknown[] = [];
    const components = object.components.map((component) => {
      if (
        !isRecord(component) ||
        component.type !== DEFAULT_SLOT_COMPONENT.map ||
        !isRecord(component.data) ||
        component.data.fog === undefined
      ) {
        return component;
      }

      const { fog, ...restData } = component.data;
      objectChanged = true;
      pendingFog.push(fog);
      return { ...component, data: restData };
    });

    if (!objectChanged) {
      return object;
    }

    changed = true;
    const baseId =
      typeof object.id === "string" && object.id.length > 0 ? object.id : `obj${index}`;
    const withFog = [...components];
    for (const fog of pendingFog) {
      // 已有 `FogOfWar` 组件（手写文件两份并存）不覆盖，保留先出现的那份
      if (withFog.some((item) => isRecord(item) && item.type === DEFAULT_SLOT_COMPONENT.fog)) {
        continue;
      }

      withFog.push({
        id: componentId(baseId, DEFAULT_SLOT_COMPONENT.fog),
        type: DEFAULT_SLOT_COMPONENT.fog,
        data: fog,
      });
    }

    return { ...object, components: withFog };
  });

  return changed ? { raw: { ...raw, objects: next }, changed } : { raw, changed };
}

/**
 * v25 → v26：把**对象级** `sortingOrder` 搬进渲染组件。
 *
 * 「显示顺序」只对**会渲染**的对象有意义，所以 v26 起它住在渲染组件的 data 里：
 * - 有 `GridMap` 对象 → 进地图数据；否则有图片层（`ImageLayer` / `SpriteLayer`）→ 进那一份；
 * - 都没有（动作对象 `PlaySound` / `Teleport`、还没挑图的空实体）→ **丢弃**：
 *   它们不渲染，旧值留下也没有任何消费者。
 *
 * 路由**先地图、后图片层**（对齐「地图的贴图住在 GridMap 里」那条口径）；组件实例的
 * `data` 原样展开再补一项，不动其余字段。
 *
 * 幂等：搬过的对象不再有对象级 `sortingOrder`，这一趟什么都不做；组件里缺 `sortingOrder`
 * 由 schema 的默认值补 0（老文件 `withFilledObjectFields` 也不再补对象级的那一项）。
 */
function migrateSortingOrderToRenderComponents(raw: Record<string, unknown>): {
  readonly raw: Record<string, unknown>;
  readonly changed: boolean;
} {
  const objects = Array.isArray(raw.objects) ? raw.objects : [];
  let changed = false;

  const next = objects.map((object) => {
    if (!isRecord(object) || typeof object.sortingOrder !== "number") {
      return object;
    }

    changed = true;
    const { sortingOrder, ...rest } = object;
    const components = Array.isArray(rest.components) ? rest.components : [];

    // 先找地图组件，再退回图片层组件（两种图片组件共用一个槽位，形状相同）
    const mapIndex = components.findIndex(
      (component) => isRecord(component) && component.type === DEFAULT_SLOT_COMPONENT.map,
    );
    const targetIndex =
      mapIndex >= 0
        ? mapIndex
        : components.findIndex(
            (component) =>
              isRecord(component) &&
              (component.type === DEFAULT_SLOT_COMPONENT.image ||
                component.type === SPRITE_COMPONENT),
          );

    if (targetIndex < 0) {
      // 没有渲染组件：这个参数没有意义，随对象级字段一起丢弃
      return { ...rest, components };
    }

    const target = components[targetIndex];
    if (!isRecord(target)) {
      return { ...rest, components };
    }

    const data = isRecord(target.data) ? target.data : {};
    const nextComponents = [...components];
    nextComponents[targetIndex] = { ...target, data: { ...data, sortingOrder } };
    return { ...rest, components: nextComponents };
  });

  return changed ? { raw: { ...raw, objects: next }, changed } : { raw, changed };
}

/**
 * v26 → v27：把地图对象上的 `FogOfWar` 组件搬成**独立的战争雾对象**（kind `Fog`）。
 *
 * 每个带 `FogOfWar` 组件的对象生成一个新的 `Fog` 对象：
 * - id 确定性 `<对象 id>__Fog`（幂等，重复跑不会多出第二个）；
 * - `mapId` = 原对象 id（正常就是地图；没有 `GridMap` 的手写文件也搬，`mapId` 仍写原 id，
 *   由 `validateScene` 报「引用的不是地图」）；
 * - `position` / `rotation` / `scale`（含单轴）取原对象现值——**保证看下去和迁移前完全一致**；
 * - `enabled` / `regions` 原样搬进组件 data（原 data 里没有就按 schema 缺省：开、空）；
 * - 雾对象插在原对象**之后**（顺序稳定，且不会排到地图前面）。
 *
 * 原对象上移除 `FogOfWar` 组件。幂等：搬过的对象不再有该组件。
 */
function migrateFogToSceneObject(raw: Record<string, unknown>): {
  readonly raw: Record<string, unknown>;
  readonly changed: boolean;
} {
  const objects = Array.isArray(raw.objects) ? raw.objects : [];
  let changed = false;
  const next: unknown[] = [];

  for (const object of objects) {
    if (
      !isRecord(object) ||
      // 已经是雾对象（kind `Fog`）的不能再搬——否则「再解析一遍」会把它的组件又搬成一个新对象
      object.kind === "Fog" ||
      !Array.isArray(object.components) ||
      !object.components.some(
        (component) => isRecord(component) && component.type === DEFAULT_SLOT_COMPONENT.fog,
      )
    ) {
      next.push(object);
      continue;
    }

    changed = true;
    const baseId =
      typeof object.id === "string" && object.id.length > 0 ? object.id : `obj${next.length}`;
    const fogComponent = object.components.find(
      (component) => isRecord(component) && component.type === DEFAULT_SLOT_COMPONENT.fog,
    );
    const fogData = isRecord(fogComponent) && isRecord(fogComponent.data) ? fogComponent.data : {};

    // 原对象：摘掉战争雾组件，其余原样
    next.push({
      ...object,
      components: object.components.filter(
        (component) => !(isRecord(component) && component.type === DEFAULT_SLOT_COMPONENT.fog),
      ),
    });

    // 新雾对象：摆放在地图当前位置（迁移前雾层就是跟着地图走的）
    const name = typeof object.name === "string" && object.name.length > 0 ? object.name : "地图";
    next.push({
      id: `${baseId}__Fog`,
      name: `${name} 战争雾`,
      kind: "Fog",
      active: typeof object.active === "boolean" ? object.active : true,
      locked: typeof object.locked === "boolean" ? object.locked : false,
      position: object.position ?? null,
      rotation: typeof object.rotation === "number" ? object.rotation : 0,
      scale: typeof object.scale === "number" ? object.scale : 1,
      ...(typeof object.scaleX === "number" ? { scaleX: object.scaleX } : {}),
      ...(typeof object.scaleY === "number" ? { scaleY: object.scaleY } : {}),
      components: [
        {
          id: `${baseId}__Fog__FogOfWar`,
          type: DEFAULT_SLOT_COMPONENT.fog,
          data: {
            mapId: baseId,
            enabled: typeof fogData.enabled === "boolean" ? fogData.enabled : true,
            regions: Array.isArray(fogData.regions) ? fogData.regions : [],
          },
        },
      ],
    });
  }

  return changed ? { raw: { ...raw, objects: next }, changed } : { raw, changed };
}

/**
 * v27 → v28：把**带网格对象**（老地图）的贴图与显示顺序从 `GridMap` 的 data 搬进它自己的
 * `ImageLayer` 组件（`Map` kind 已在 `renameObjectKinds` 里落到 `Image`）。
 *
 * 每个带 `GridMap` 组件的对象：
 * - `GridMap.data` 里有 `image` 时，把它（+ `sortingOrder`）搬进（没有则新建）`ImageLayer` 组件；
 * - 从 `GridMap.data` 里删掉 `image` 与 `sortingOrder`，只留网格数据。
 *
 * 已有图片层的对象以**地图数据里的那份**为准（迁移前渲染用的就是它），组件 id 保持不变。
 * 幂等：搬过的 `GridMap` 不再有这两项，再跑什么都不做。不带网格的对象不受影响。
 */
function migrateGridMapImageToLayer(raw: Record<string, unknown>): {
  readonly raw: Record<string, unknown>;
  readonly changed: boolean;
} {
  const objects = Array.isArray(raw.objects) ? raw.objects : [];
  let changed = false;
  const next = objects.map((object) => {
    if (!isRecord(object) || !Array.isArray(object.components)) {
      return object;
    }

    const gridMap = object.components.find(
      (component) => isRecord(component) && component.type === DEFAULT_SLOT_COMPONENT.map,
    );
    if (gridMap === undefined || !isRecord(gridMap.data)) {
      return object;
    }

    const data = gridMap.data;
    const image = isRecord(data.image) ? data.image : undefined;
    if (image === undefined && !("sortingOrder" in data)) {
      return object;
    }

    changed = true;
    const sortingOrder = typeof data.sortingOrder === "number" ? data.sortingOrder : 0;

    // GridMap：只留网格数据
    const gridData = { ...data };
    delete gridData.image;
    delete gridData.sortingOrder;

    const components: unknown[] = object.components.map((component) =>
      component === gridMap
        ? { ...(component as Record<string, unknown>), data: gridData }
        : component,
    );

    if (image !== undefined) {
      const payload = { ...image, sortingOrder };
      const existingIndex = components.findIndex(
        (component) => isRecord(component) && component.type === DEFAULT_SLOT_COMPONENT.image,
      );
      if (existingIndex >= 0) {
        const existing = components[existingIndex] as Record<string, unknown>;
        components[existingIndex] = { ...existing, data: payload };
      } else {
        const objectId = typeof object.id === "string" && object.id.length > 0 ? object.id : "obj";
        components.push({
          id: `${objectId}__${DEFAULT_SLOT_COMPONENT.image}`,
          type: DEFAULT_SLOT_COMPONENT.image,
          data: payload,
        });
      }
    }

    return { ...object, components };
  });

  return changed ? { raw: { ...raw, objects: next }, changed } : { raw, changed };
}

/**
 * 读一个（还没过 schema 的）对象的 `kind`；认不出来时按**精灵** `Sprite` 算
 * （`MirrorObject` 同一个兜底）。
 *
 * 兜底只影响**迁移怎么路由**（老文件里的扁平 `image` 字段搬进哪个组件）：认不出 kind 的
 * 文件本来就过不了 schema（`kind` 是必填枚举），所以这里挑的是「最像它原来那个样子」的
 * 一个值——v21 及更早这个兜底就是 `SceneObject`，而那时它路由到精灵的 `SpriteLayer`。
 */
function kindOf(raw: Record<string, unknown>): ObjectKind {
  const kind = raw.kind;
  return typeof kind === "string" ? (kind as ObjectKind) : "Sprite";
}

/**
 * 不该留在现行文档里的 kind 值 → 现行值。
 *
 * 两类：
 * - v22 改名的老值（`Texture`（贴图）→ `Image`、`SceneObject`（那时**所有**场景对象都写它，
 *   编辑器里那一个原型就是「精灵」）→ `Sprite`）；
 * - **抽象基类** `GameObject`：它不落进文档，手写文件真写了就规范化到 `Sprite`
 *   （与上面老值同一个口径——基类只表达层级归属，对象必须落具体类型）。
 *
 * 表里只放**确实有来由**的值，其余（`Portal` 这种手写文件里的怪值）**原样留着**——
 * 让 schema 去报错，而不是替它猜一个新归属。
 */
const LEGACY_KINDS: Readonly<Record<string, ObjectKind>> = {
  Texture: "Image",
  SceneObject: "Sprite",
  GameObject: "Sprite",
  // v28：`Map` 不再是对象类型——「网格地图」= 贴图 + `GridMap` 组件。老文件里的地图先落到 `Image`，
  // 再由 `migrateGridMapImageToLayer` 把贴图从 `GridMap` 搬进图片层
  Map: "Image",
};

/**
 * v21 → v22：把两种实体的 kind 改成现行值（贴图 `Texture` → `Image`、精灵 `SceneObject` → `Sprite`）。
 *
 * v22 起 `Sprite` / `Image` 是**基类 `GameObject` 的子类型**（层级见 `kinds.ts`），
 * 而基类**不落进文档**——所以老文件里那些 `SceneObject` 必须落到具体类型上：
 * 编辑器那时只有「精灵」这一个原型写这个值，于是它就是精灵 `Sprite`。
 *
 * **必须排在其它迁移前面**：v21 的 `renameSpriteImageComponent` 与 v19 的
 * `migrateFeaturesToComponents` 都按 kind 选图片组件名（`componentForKind("image", kind)`）。
 * 现行路由下 `Sprite` 有自己的 `SpriteLayer`，**基类 `GameObject` 只落到缺省的 `ImageLayer`**
 * ——老文件里的精灵一旦没先改名，子图能力就静默消失（图还在，取不到格子）。
 *
 * 幂等：改名成现行值之后表里再也查不到，这一趟什么都不做。
 */
function renameObjectKinds(raw: Record<string, unknown>): {
  readonly raw: Record<string, unknown>;
  readonly changed: boolean;
} {
  const objects = Array.isArray(raw.objects) ? raw.objects : [];
  let changed = false;

  const next = objects.map((object) => {
    if (!isRecord(object) || typeof object.kind !== "string") {
      return object;
    }

    const renamed = LEGACY_KINDS[object.kind];
    if (renamed === undefined) {
      return object;
    }

    changed = true;
    return { ...object, kind: renamed };
  });

  return changed ? { raw: { ...raw, objects: next }, changed } : { raw, changed };
}

/**
 * 上一个格式版本里承载 `image` 的组件名（v20 及更早）。
 *
 * 老文件里的精灵与贴图**都**写的是 `TextureRenderer`；v21 起拆成
 * `SpriteLayer`（精灵）/ `ImageLayer`（贴图），旧名只在迁移里认一次。
 * （住在本文件而不是 `presets.ts`：它是纯迁移知识，现行结构里没有它的位置。）
 */
const LEGACY_IMAGE_COMPONENT: string = "TextureRenderer";

/**
 * v20 → v21：把旧名 `TextureRenderer` 的图片组件按 **kind 路由**换成现行名字。
 *
 * v20 及更早，「对象自己显示的图」只有一种组件（`TextureRenderer`），所有 kind 共用它。
 * v21 把它拆成两种——精灵 `SpriteLayer`（会取图集里的一格）、其余 `ImageLayer`
 * （只显示整张图）——所以老文件里的实例必须改名，否则它会带着旧组件名的形状留下来，
 * 两种形状长期共存。
 *
 * v19 时 `image` 特性只开放给 `["SceneObject","Player","Item","Event"]`（旧编辑器对
 * 这些 kind 也开放渲染分组），所以**不止精灵**：Player / Item / Event 上的
 * `TextureRenderer` 同样要改名——目标名一律走 `componentForSlot("image", kind)`
 * （与运行期/写盘同一条路由，见 `presets.ts`），不在这里另写映射：
 * 精灵 → `SpriteLayer`，其余 → `ImageLayer`。
 * 没声明 image 槽位的 kind（地图 / 声音 / …）上的 `TextureRenderer` 不是这份数据，
 * 原样留着让 schema 报错。
 *
 * **v22 起这条迁移拿到的 kind 已经是具体类型**（`renameObjectKinds` 排在它前面）：老文件里的
 * `SceneObject` 那时已经叫 `Sprite`——所以这里判「带不带 image」看预设表
 * （`presetOf(kind)?.slots.image`），认不出的 kind 没槽位、一律不碰。
 *
 * 幂等：改名目标是现行名字之后，对象上不再有 `TextureRenderer`，这一趟什么都不做。
 */
function renameSpriteImageComponent(raw: Record<string, unknown>): {
  readonly raw: Record<string, unknown>;
  readonly changed: boolean;
} {
  const objects = Array.isArray(raw.objects) ? raw.objects : [];
  let changed = false;

  const next = objects.map((object, index) => {
    if (!isRecord(object)) {
      return object;
    }

    const kind = kindOf(object);
    // 「这个 kind 带不带 image」查预设表的 image 槽位（`presetOf`），不能在这里
    // 另写 kind 名单，否则新增预设时迁移容易漏掉
    if (presetOf(kind)?.slots.image === undefined) {
      return object;
    }

    const target = componentForSlot("image", kind);
    if (target === LEGACY_IMAGE_COMPONENT) {
      return object;
    }

    const components = Array.isArray(object.components) ? object.components : [];
    if (!components.some((item) => isRecord(item) && item.type === LEGACY_IMAGE_COMPONENT)) {
      return object;
    }

    const baseId =
      typeof object.id === "string" && object.id.length > 0 ? object.id : `obj${index}`;

    changed = true;
    return {
      ...object,
      components: components.map((item) =>
        isRecord(item) && item.type === LEGACY_IMAGE_COMPONENT
          ? {
              ...item,
              type: target,
              // **id 也要跟着改**：组件 id 的规范是 `<对象 id>__<组件类型>`
              // （`componentId`）。只改类型不改 id 的话，编辑器下一次写这个组件时
              // 按新名字找不到旧实例、于是**多补一个**，对象上就挂了两份图。
              id: componentId(baseId, target),
            }
          : item,
      ),
    };
  });

  return changed ? { raw: { ...raw, objects: next }, changed } : { raw, changed };
}

/** 场景文件加载结果。 */
export interface SceneFileLoad {
  readonly file: SceneFileDoc;
  /** 文件需要按新格式回写一次（旧版本升级，或补上了缺失的字段）。 */
  readonly needsRewrite: boolean;
}

/**
 * 读场景文件；场景名由调用方从文件名得到。
 *
 * `size` 是场景（地图贴图）尺寸，旧格式的归一化位置靠它换算成世界坐标；
 * 拿不到时用兜底尺寸（1920×1080）。
 */
export function parseSceneFile(raw: unknown, size?: SceneSizeHint): SceneFileLoad {
  const upgraded = upgradeRawDocument(raw);
  let normalized = upgraded;
  let needsRewrite = false;

  if (isRecord(upgraded)) {
    const version = formatVersionOf(upgraded);
    // 高版本文件明确拒绝：读不懂的字段被静默丢掉再回存，等于把数据毁掉
    if (version > DOCUMENT_FORMAT_VERSION) {
      throw new Error(
        `场景文件 formatVersion=${version} 高于本编辑器支持的 ${DOCUMENT_FORMAT_VERSION}，请升级编辑器`,
      );
    }

    // 归一化坐标（v4 及更早）先换算成世界坐标；地图的位置照常换算，它也是摆在世界里的对象
    const migrated =
      version < WORLD_POSITION_VERSION
        ? migrateScenePositions(upgraded, size ?? FALLBACK_SCENE_SIZE)
        : upgraded;
    // 再补上 v7 的显式字段（active / sortingOrder）与「没有位置的地图」
    const filled = withFilledObjectFields(migrated);
    // v12：传送阵的「单目标」搬成「候选清单 + 选中的那一个」（中间那一版写下的文件要读得回来）
    const teleport = migrateTeleportTarget(filled.raw);
    // v15：声音层级四档 → 三档（环境音并进背景音乐）
    const layers = migrateSoundLayers(teleport.raw);
    // v22：两种实体的 kind 改名（`Texture` → `Image`、`SceneObject` → `Sprite`）。
    // **必须最先做**：后面那两条迁移都按 kind 选图片组件名，路由只认现行值
    // （见 `renameObjectKinds` 的说明）
    const kinds = renameObjectKinds(layers.raw);
    // v19：对象特性搬进组件（`map` / `image` / `sound` / `teleport` / `video`）。
    // v21：图片组件在精灵身上叫 `SpriteLayer`——所以**先改名、再搬字段**
    // （老文件里精灵的图已经是 `TextureRenderer` 组件，那时 `features` 那一趟什么都不用做）
    const renamed = renameSpriteImageComponent(kinds.raw);
    const features = migrateFeaturesToComponents(renamed.raw);
    // v25：战争雾从 `GridMap` 拆成独立的 `FogOfWar` 组件（fog 字段 → 组件实例）。
    // 必须排在 `features` 后面：只有 v19 迁移把地图数据搬进 `GridMap` 组件之后，
    // `fog` 才住在组件 data 里，这一趟才找得到它
    const fogSplit = migrateMapFogToComponent(features.raw);
    // v26：显示顺序从对象级搬进渲染组件（GridMap / 图片层）。必须排在 `features` 之后：
    // 只有对象特性搬进组件之后，才找得到承载显示顺序的那个渲染组件
    const sorting = migrateSortingOrderToRenderComponents(fogSplit.raw);
    // v27：战争雾从「地图上的 FogOfWar 组件」搬成独立的 `Fog` 对象。必须排在 `fogSplit`
    // 之后（那时雾才在组件里）、并在最后（新对象要按现在的摆放复制地图的位置）
    const fogObjects = migrateFogToSceneObject(sorting.raw);
    // v28：把带网格对象（老地图）的贴图与显示顺序从 `GridMap` 搬进 `ImageLayer`（`Map` kind 已在
    // `kinds` 那一趟落到 `Image`）。排在 `sorting` 之后（那时显示顺序才在 GridMap 里）
    const gridImage = migrateGridMapImageToLayer(fogObjects.raw);
    // v13：战争雾的总开关（`fog.enabled`）**不用单独迁移**——schema 给它默认值 `true`
    // （v10–v12 的文件里「有 fog」就等于「开着」），而版本号一升就会回写一次，
    // 于是磁盘上的文件重新变得自描述。
    // v14：地图 / 精灵上的视频列表（`video`）同样**不用补壳**——整个字段是可选的，
    // 「没有它」就是「这个对象不放视频」，版本号 +1 触发一次回写即可。
    // v21：视频那一组从精灵挪到贴图，**精灵身上的 `VideoOverlay` 不在这里删**——
    // 静默删用户数据比留一条校验警告更糟（见 `validation.ts` 那一条）。
    // v22：kind 改名（`Texture` → `Image`、`SceneObject` → `Sprite`）已在上面的 `kinds` 那一趟做完。
    // v25：战争雾从 `GridMap` 拆成独立的 `FogOfWar` 组件，已在上面的 `fogSplit` 那一趟做完
    // （排在 `features` 后面：先 v19 搬组件、再拆雾）。
    // v26：显示顺序从对象级搬进渲染组件，已在上面的 `sorting` 那一趟做完
    // （同样排在 `features` 后面：先搬组件，才找得到承载它的渲染组件）。
    // v27：战争雾从地图搬成独立的 `Fog` 对象，已在上面的 `fogObjects` 那一趟做完。
    // v28：`Map` kind 落到 `Image`（`kinds` 那一趟）、贴图从 `GridMap` 搬进 `ImageLayer`
    // （`gridImage` 那一趟）。读出来的文档一律是当前版本（v6 起网格里不再存 `cellSize`，顺手被 schema 丢掉）
    normalized = { ...gridImage.raw, formatVersion: DOCUMENT_FORMAT_VERSION };
    needsRewrite =
      version < DOCUMENT_FORMAT_VERSION ||
      filled.changed ||
      teleport.changed ||
      layers.changed ||
      kinds.changed ||
      renamed.changed ||
      features.changed ||
      fogSplit.changed ||
      sorting.changed ||
      fogObjects.changed ||
      gridImage.changed;
  }

  const result = sceneFileSchema.safeParse(normalized);
  if (!result.success) {
    throw new Error(`场景文件校验失败: ${formatIssues(result.error)}`);
  }

  return {
    file: result.data as SceneFileDoc,
    needsRewrite,
  };
}
