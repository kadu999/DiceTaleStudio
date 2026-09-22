import { z } from "zod";
import { COMPONENT_TYPES, FEATURE_COMPONENT_TYPES, componentId, hasLegacyFeatureField } from "./components";
import {
  FEATURE_COMPONENT,
  LEGACY_IMAGE_COMPONENT,
  SPRITE_COMPONENT,
  carriesKind,
  componentForKind,
  featureOfComponent,
} from "./features";
import { OBJECT_KINDS, type ObjectKind } from "./kinds";
import { SPRITE_SHEET_MAX } from "./sprites";
import {
  DOCUMENT_FORMAT_VERSION,
  SOUND_LAYERS,
  type BgmSettingsDoc,
  type ProjectDoc,
  type ProjectSettingsDoc,
  type SceneDoc,
  type SceneFileDoc,
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
 * 图片引用（v20 起多了可选的 `sprite`）：资源逻辑 ID + 声明尺寸 + 「取哪一格」。
 *
 * `sprite` 只是一份**引用**：「几行几列」住在工程文件的 `spriteSheets` 里，只有那一份。
 */
export const imageRefSchema = z.object({
  id: z.string().min(1),
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
 * 战争雾（v10 起：雾区；v13 起：总开关）：**开不开**，以及哪些区域算雾区。
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
  enabled: z.boolean().default(true),
  regions: z.array(z.number().int().min(1).max(255)).default([]),
});

export const mapDataSchema = z.object({
  image: imageRefSchema,
  grid: gridSpecSchema,
  rowOrder: z.literal("bottom-up"),
  cells: cellRunsSchema,
  fog: mapFogSchema.optional(),
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
 * `names` 是「文件 → 显示名」的可选标签（缺省 = 素材文件名）：空白名字不在这里硬拒，
 * 由 `validateScene` 提醒。
 */
export const soundDataSchema = z.object({
  clips: z.array(z.string().min(1)).default([]),
  picked: z.string().min(1).optional(),
  names: z.record(z.string(), z.string()).optional(),
  layer: z.enum(SOUND_LAYERS).default("sfx"),
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
 * 播放按钮点不了）；`names` 只是给人看的标签，缺省 = 用素材文件名。
 * `enabled`（总开关）同样给默认值 `true`，理由见下面那一行。
 *
 * **不需要补壳迁移**：整个 `video` 字段是可选的，「没有它」就等于「这个对象不放视频」，
 * 所以 v13 → v14 只是版本号 +1 触发一次回写，不像 `fog.enabled` 那样要往老文件里填默认值。
 */
export const videoDataSchema = z.object({
  // v14 起，与 `map.fog.enabled` 同一个口径：老编辑器不发这一项时语义只能是「在用」
  // （`video` 只有加过视频才写出来），补成 false 会把已有的视频静默关掉
  enabled: z.boolean().default(true),
  clips: z.array(z.string().min(1)).default([]),
  picked: z.string().min(1).optional(),
  names: z.record(z.string(), z.string()).optional(),
  loop: z.boolean().default(false),
  audio: z.boolean().default(false),
});

export const conditionSchema = z.object({
  valueType: z.enum(["Bool", "String", "Number", "Integer"]),
  op: z.enum(["Equal", "NotEqual", "AtLeast", "AtMost"]),
  target: z.union([z.boolean(), z.string(), z.number()]),
});

export const actionInstanceSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  enabled: z.boolean(),
  condition: conditionSchema.optional(),
  params: z.record(z.string(), z.unknown()),
});

export const componentSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  displayName: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
  actions: z.array(actionInstanceSchema),
});

/**
 * 组件实例（v19）。
 *
 * 从对象特性提升上来的那 5 种**按各自的 schema 硬校验**（`GridMap` 的 RLE、`PlaySound` 的层级…），
 * 前端组件体系那 7 种与未知类型走宽松分支（`data` 是任意记录）——这样手写文件里的自定义组件
 * 照样读得回来，而**已知的 5 种写坏了会直接读不开**（与 v18 之前扁平字段的严格程度一致）。
 *
 * 「未知类型」分支把已知的 12 个名字排除掉：否则一个 data 坏掉的 `GridMap` 会掉进宽松分支，
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
  actions: z.array(actionInstanceSchema),
});

function componentSchemaOf<T extends z.ZodTypeAny>(
  type: string,
  data: T,
): z.ZodObject<{
  id: z.ZodString;
  type: z.ZodLiteral<string>;
  displayName: z.ZodOptional<z.ZodString>;
  data: T;
  actions: z.ZodArray<typeof actionInstanceSchema>;
}> {
  return z.object({
    id: z.string().min(1),
    type: z.literal(type),
    displayName: z.string().optional(),
    data,
    actions: z.array(actionInstanceSchema),
  });
}

export const sceneComponentSchema = z.union([
  componentSchemaOf(FEATURE_COMPONENT.map, mapDataSchema),
  // 对象自己显示的图有**两种承载**：贴图 `ImageLayer`、精灵 `SpriteLayer`（同一份 `imageRefSchema`）
  componentSchemaOf(FEATURE_COMPONENT.image, imageRefSchema),
  componentSchemaOf(SPRITE_COMPONENT, imageRefSchema),
  componentSchemaOf(FEATURE_COMPONENT.sound, soundDataSchema),
  componentSchemaOf(FEATURE_COMPONENT.teleport, teleportDataSchema),
  componentSchemaOf(FEATURE_COMPONENT.video, videoDataSchema),
  permissiveComponentSchema,
]);

export const sceneObjectSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  // 取值就是 `OBJECT_KINDS`（**单一来源**：加/改一个对象类型只动 `kinds.ts`）。
  // `SceneObject` 是抽象基类，schema 照收（它是合法类型），但编辑器不会写它、老文件由迁移换掉
  kind: z.enum(OBJECT_KINDS),
  // v7 起：是否显示 + 显示顺序。**给默认值**是有意的——v6 及更早的文件没有这两个字段，
  // 「没写」只能是「显示、顺序 0」；写成必填会让所有旧文件直接读不开。
  active: z.boolean().default(true),
  sortingOrder: z.number().int().default(0),
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
  objects: z.array(sceneObjectSchema),
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
 * 一个音频文件的标注（v17 起；v18 起标签是**整数 ID**）：显示名 + 标签 ID 列表。
 *
 * **两项都不给默认值**（与 `video` / `teleport` 同一个口径）：「没写」本身有语义——
 * 显示名空着 = 用素材文件名，标签空着 = 还没打标签。补成 `""` / `[]` 只会让
 * 「没整理过」和「整理成空」变得分不清。脏值（空名字、越界 / 重复的标签 ID）由
 * `validateProject` 报 warning。
 */
export const audioMetaEntrySchema = z.object({
  name: z.string().optional(),
  tags: z.array(z.number().int()).optional(),
});

/**
 * 项目级**标签表**（v18 起）：下标 = tag ID，值 = 名字（`null` = 已删除的洞）。
 *
 * 逐项校验只保证「是字符串或 null」；空名字 / 重名 / 文件引用越界都由 `validateProject` 报 warning
 * （读不开比标签显示不出来更糟）。
 */
export const audioTagTableSchema = z.array(z.string().nullable());

/**
 * 图片切分表的一项（v20 起）：一张图按几列几行切成网格。
 *
 * 上限 `SPRITE_SHEET_MAX`（64）挡的是「没有一格可言」的坏数据；`1×1`（= 整图）**不写这项**
 * （取值由 `setSpriteSheet` 收干净），手写文件里留了一个 1×1 的项由 `validateProject` 提醒。
 */
export const spriteSheetSchema = z.object({
  columns: z.number().int().min(1).max(SPRITE_SHEET_MAX),
  rows: z.number().int().min(1).max(SPRITE_SHEET_MAX),
});

/**
 * 工程文件：只有项目级数据，场景在 `Assets/scenes/` 下各自成文件。
 *
 * `audioMeta` / `audioTags` / `spriteSheets` **可选且不给默认值**：缺省 = 这个项目还没整理过
 * 音频 / 还没切过图（v14 的 `video` 同一条规矩：不拿空壳冒充「有这个字段」）。
 */
export const projectDocSchema = z.object({
  formatVersion: z.number().int().positive(),
  name: z.string().min(1),
  items: itemLibrarySchema,
  // v15 起：项目级全局设置（目前是音频）。**给默认值**：老 `project.json` 里没有它，
  // 语义只能是「全用缺省参数」；版本升到 15 时本来就会回写一次，磁盘上的文件从此自描述。
  settings: projectSettingsSchema.default(() => defaultProjectSettings()),
  // v17 起：音频文件标注（显示名 + 标签 ID）。纯编辑器数据，不进协议、不下发 Unity。
  audioMeta: z.record(z.string(), audioMetaEntrySchema).optional(),
  // v18 起：音频标签表（下标 = tag ID，值 = 名字）。与 audioMeta 一起构成「标签」这一套。
  audioTags: audioTagTableSchema.optional(),
  // v20 起：图片切分表（图片逻辑 ID → 列×行）。**切分只有这一份**，对象只存「引用哪张图 + 第几格」。
  spriteSheets: z.record(z.string(), spriteSheetSchema).optional(),
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
 * 给对象补上 v7 的 `active` / `sortingOrder`、v8 的 `scale`、v9 的 `locked`，
 * 并给**没有位置的地图**补上世界原点。
 *
 * - 地图是摆在世界里的对象，必须有位置才能渲染（`position: null` 的地图没有地方可画）。
 *   旧文件里确实可能是 `null`（v1→v2 升级时造的地图对象、或手写文件），补成 `(0, 0)`
 *   正好是它以前被隐式绘制的那个位置（世界原点为中心），画面不变。
 * - `active` / `sortingOrder` / `scale` / `locked` 是后来新增的**显式**字段：老文件里没有，
 *   语义只能是「显示、顺序 0、缩放 1、不锁」。补进内存后要求调用方回写一次，
 *   否则会出现「内存里已补全、磁盘上还是缺字段」的长期不一致。
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

    if (typeof filled.sortingOrder !== "number") {
      filled = { ...filled, sortingOrder: 0 };
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
    result.data.formatVersion < DOCUMENT_FORMAT_VERSION;
  const doc = migrateProjectDoc({
    ...(result.data as ProjectDoc),
    ...(needsRewrite ? { formatVersion: DOCUMENT_FORMAT_VERSION } : {}),
  });

  return { doc, migratedScenes, needsRewrite };
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
      // 走 `componentForKind`（唯一入口）而不是 `def.type`，否则老文件里的精灵会被搬进贴图的组件。
      // 特性字段名从组件名反查（`featureOfComponent`），对 `ImageLayer` / `SpriteLayer`
      // 两个名字都会回到 `image` 那一条。
      const feature = featureOfComponent(def.type);
      const component = componentForKind(feature?.field ?? "image", kindOf(rest));
      const already = components.some((item) => isRecord(item) && item.type === component);
      if (!already) {
        components.push({
          id: componentId(baseId, component),
          type: component,
          data: value,
          actions: [],
        });
      }
    }

    return { ...rest, components };
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
 * 老 kind 值 → 现行值（v22 改名）。
 *
 * 两个都是纯改名：`Texture`（贴图）→ `Image`、`SceneObject`（那时**所有**场景对象都写它，
 * 编辑器里那一个原型就是「精灵」）→ `Sprite`。
 * 表里只放**确实存在过**的老值，其余（`Portal` 这种手写文件里的怪值）**原样留着**——
 * 让 schema 去报错，而不是替它猜一个新归属。
 */
const LEGACY_KINDS: Readonly<Record<string, ObjectKind>> = {
  Texture: "Image",
  SceneObject: "Sprite",
};

/**
 * v21 → v22：把两种实体的 kind 改成现行值（贴图 `Texture` → `Image`、精灵 `SceneObject` → `Sprite`）。
 *
 * v22 起 `Sprite` / `Image` 是**基类 `SceneObject` 的子类型**（层级见 `kinds.ts`），
 * 而基类**不落进文档**——所以老文件里那些 `SceneObject` 必须落到具体类型上：
 * 编辑器那时只有「精灵」这一个原型写这个值，于是它就是精灵 `Sprite`。
 *
 * **必须排在其它迁移前面**：v21 的 `renameSpriteImageComponent` 与 v19 的
 * `migrateFeaturesToComponents` 都按 kind 选图片组件名（`componentForKind("image", kind)`）。
 * 现行路由下 `Sprite` 有自己的 `SpriteLayer`，**基类 `SceneObject` 只落到缺省的 `ImageLayer`**
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
 * v20 → v21：把旧名 `TextureRenderer` 的图片组件按 **kind 路由**换成现行名字。
 *
 * v20 及更早，「对象自己显示的图」只有一种组件（`TextureRenderer`），所有 kind 共用它。
 * v21 把它拆成两种——精灵 `SpriteLayer`（会取图集里的一格）、其余 `ImageLayer`
 * （只显示整张图）——所以老文件里的实例必须改名，否则它会带着旧组件名的形状留下来，
 * 两种形状长期共存。
 *
 * v19 时 `image` 特性的 kinds 是 `["SceneObject","Player","Item","Event"]`（旧编辑器对
 * 这些 kind 也开放渲染分组），所以**不止精灵**：Player / Item / Event 上的
 * `TextureRenderer` 同样要改名——目标名一律走 `componentForKind("image", kind)`
 * （与运行期/写盘同一条路由，见 `features.ts`），不在这里另写映射：
 * 精灵 → `SpriteLayer`，其余 → `ImageLayer`。
 * 不在 image 特性 kinds 里的 kind（地图 / 声音 / …）上的 `TextureRenderer` 不是这条特性
 * 的数据，原样留着让 schema 报错。
 *
 * **v22 起这条迁移拿到的 kind 已经是具体类型**（`renameObjectKinds` 排在它前面）：老文件里的
 * `SceneObject` 那时已经叫 `Sprite`——所以这里判「带不带 image」也必须走 `carriesKind`
 * （按层级），不能拿 kinds 名单直接 `includes`（名单里是基类 `SceneObject`）。
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
    // 「这个 kind 带不带 image」按**层级**判（`carriesKind`：`Sprite` / `Image` 继承
    // `SceneObject`），不能拿 `kinds` 名单直接 `includes`——名单里写的是基类，
    // 子类型一个都不在里面，这样判会把精灵整个漏掉
    if (!carriesKind(FEATURE_COMPONENT.image, kind)) {
      return object;
    }

    const target = componentForKind("image", kind);
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
    // v13：战争雾的总开关（`fog.enabled`）**不用单独迁移**——schema 给它默认值 `true`
    // （v10–v12 的文件里「有 fog」就等于「开着」），而版本号一升就会回写一次，
    // 于是磁盘上的文件重新变得自描述。
    // v14：地图 / 精灵上的视频列表（`video`）同样**不用补壳**——整个字段是可选的，
    // 「没有它」就是「这个对象不放视频」，版本号 +1 触发一次回写即可。
    // v21：视频那一组从精灵挪到贴图，**精灵身上的 `VideoOverlay` 不在这里删**——
    // 静默删用户数据比留一条校验警告更糟（见 `validation.ts` 那一条）。
    // v22：kind 改名（`Texture` → `Image`、`SceneObject` → `Sprite`）已在上面的 `kinds` 那一趟做完。
    // 读出来的文档一律是当前版本（v6 起网格里不再存 `cellSize`，顺手被 schema 丢掉）
    normalized = { ...features.raw, formatVersion: DOCUMENT_FORMAT_VERSION };
    needsRewrite =
      version < DOCUMENT_FORMAT_VERSION ||
      filled.changed ||
      teleport.changed ||
      layers.changed ||
      kinds.changed ||
      renamed.changed ||
      features.changed;
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
