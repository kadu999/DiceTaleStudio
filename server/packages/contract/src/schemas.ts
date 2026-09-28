import { z } from "zod";

/**
 * **共享数据形状的唯一来源**（中性包：不依赖 document、也不依赖 protocol）。
 *
 * `document`（磁盘）与 `protocol`（wire）各自 `extend` 出变体——已知的差异只有两处：
 * - 磁盘专有 `guid`（素材身份，推送时由 `resolveSceneSprites` 剥掉）；
 * - wire 专有 `spriteGrid`（推送时按素材 meta 解析出来，落盘不写）。
 *
 * 于是「一个字段只写一遍」；两侧一致与否由 `pnpm check:contract` 逐路径结构比对盯着。
 * 详见 `server/docs/PLAN-降低改动面.md` 阶段 2 与 `PLAN-单一数据源与codegen.md`。
 */

// ---------------------------------------------------------------- 常量（唯一来源）

/** 声音层级：固定三档（同层同时只响一条）。`bgm` 只作声道名 / 老文件兼容，界面不再给对象选。 */
export const SOUND_LAYERS = ["bgm", "sfx", "voice"] as const;
export type SoundLayer = (typeof SOUND_LAYERS)[number];
export const DEFAULT_SOUND_LAYER: SoundLayer = "sfx";

/** 放大镜媒体动画预设。 */
export const MAGNIFIER_TWEENS = ["none", "shake", "breathe", "float", "sway"] as const;
export type MagnifierTween = (typeof MAGNIFIER_TWEENS)[number];
export const DEFAULT_MAGNIFIER_VIDEO_LOOP = true;
export const DEFAULT_MAGNIFIER_VIDEO_AUDIO = false;

/** 视频混合：每路的素材种类 + 声音来源。 */
export const VIDEO_BLEND_KINDS = ["image", "video"] as const;
export type VideoBlendKind = (typeof VIDEO_BLEND_KINDS)[number];
export const VIDEO_BLEND_AUDIO = ["none", "a", "b"] as const;
export type VideoBlendAudio = (typeof VIDEO_BLEND_AUDIO)[number];
export const DEFAULT_VIDEO_BLEND_KIND: VideoBlendKind = "video";
export const DEFAULT_VIDEO_BLEND_AUDIO: VideoBlendAudio = "none";

/** 视频组件四个开关的缺省（`enabled` 缺省开：字段在 = 在用）。 */
export const DEFAULT_VIDEO_ENABLED = true;
export const DEFAULT_VIDEO_AUTO_PLAY = false;
export const DEFAULT_VIDEO_LOOP = false;
export const DEFAULT_VIDEO_AUDIO = false;

/** 图集切分格数上限。 */
export const SPRITE_SHEET_MAX = 64;

/** 雾层显示顺序缺省：最前面（`short.MaxValue`）。 */
export const FOG_DEFAULT_SORTING_ORDER = 32767;

/** 三档音量缺省（`0..1`）。 */
export const DEFAULT_BGM_VOLUME = 0.6;
export const DEFAULT_SFX_VOLUME = 0.8;
export const DEFAULT_VOICE_VOLUME = 1;

// ---------------------------------------------------------------- 叶子形状

/** 世界坐标点（x 右、y 上、像素）。 */
export const worldPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

/**
 * 「图集里的第几格」：`column` 从左数、`row` 从最上数（0 起）。
 * 只保证「是非负整数」：越界不算解析错误（切分改小后老对象会暂时越界，由渲染 / 推送夹取、`validateScene` 报 warning）。
 */
export const imageSpriteRefSchema = z.object({
  column: z.number().int().nonnegative(),
  row: z.number().int().nonnegative(),
});

/** 一张图的切分（几列几行）。`1×1` = 整图。wire 专有（磁盘上没有 `spriteGrid`）。 */
export const spriteGridSchema = z.object({
  columns: z.number().int().min(1).max(SPRITE_SHEET_MAX),
  rows: z.number().int().min(1).max(SPRITE_SHEET_MAX),
});

/**
 * 图片引用的**公共部分**：磁盘侧 `extend({ guid })`、wire 侧 `extend({ spriteGrid })`。
 * 两个变体都从这一份长出来，所以「id / width / height / sprite」只写一遍。
 */
export const imageRefBaseSchema = z.object({
  id: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sprite: imageSpriteRefSchema.optional(),
});

/** RLE 一段：`[掩码 0–255, 连续格数 ≥0]`。 */
export const rleRunSchema = z.tuple([z.number().int().min(0).max(255), z.number().int().nonnegative()]);

export const gridSpecSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const cellRunsSchema = z.object({
  encoding: z.literal("rle"),
  runs: z.array(rleRunSchema),
});

// ---------------------------------------------------------------- 组件数据（两侧逐字一致）

/** 战争雾：引用哪张地图 + 总开关 + 雾区。缺省给值（老文件少写一项时语义唯一）。 */
export const mapFogSchema = z.object({
  mapId: z.string().default(""),
  enabled: z.boolean().default(true),
  regions: z.array(z.number().int().min(1).max(255)).default([]),
  sortingOrder: z.number().int().default(FOG_DEFAULT_SORTING_ORDER),
});

/** `GridMap` 组件的网格数据（`rowOrder` 固定 bottom-up）。 */
export const mapDataSchema = z.object({
  grid: gridSpecSchema,
  rowOrder: z.literal("bottom-up"),
  cells: cellRunsSchema,
});

export const soundLayerSchema = z.enum(SOUND_LAYERS);

/** 播放声音：音频列表 + 选中的那条 + 层级。 */
export const soundDataSchema = z.object({
  clips: z.array(z.string().min(1)).default([]),
  picked: z.string().min(1).optional(),
  layer: soundLayerSchema.default(DEFAULT_SOUND_LAYER),
});

/** 传送阵：候选目标场景 + 选中的那一个。 */
export const teleportDataSchema = z.object({
  targets: z.array(z.string().min(1)).default([]),
  picked: z.string().min(1).optional(),
});

/** 视频列表（对象自己的矩形上放视频）。 */
export const videoDataSchema = z.object({
  enabled: z.boolean().default(DEFAULT_VIDEO_ENABLED),
  autoPlay: z.boolean().default(DEFAULT_VIDEO_AUTO_PLAY),
  clips: z.array(z.string().min(1)).default([]),
  picked: z.string().min(1).optional(),
  loop: z.boolean().default(DEFAULT_VIDEO_LOOP),
  audio: z.boolean().default(DEFAULT_VIDEO_AUDIO),
});

const videoBlendChannelSchema = z.object({
  kind: z.enum(VIDEO_BLEND_KINDS).default(DEFAULT_VIDEO_BLEND_KIND),
  id: z.string().min(1).optional(),
});

/** 视频混合：两路素材（A 盖住 / B 擦开）+ 循环 + 自动播放 + 声音来源。 */
export const videoBlendDataSchema = z.object({
  a: videoBlendChannelSchema.default(() => ({ kind: DEFAULT_VIDEO_BLEND_KIND })),
  b: videoBlendChannelSchema.default(() => ({ kind: DEFAULT_VIDEO_BLEND_KIND })),
  loop: z.boolean().default(DEFAULT_VIDEO_LOOP),
  autoPlay: z.boolean().default(DEFAULT_VIDEO_AUTO_PLAY),
  audio: z.enum(VIDEO_BLEND_AUDIO).default(DEFAULT_VIDEO_BLEND_AUDIO),
});

// ---------------------------------------------------------------- 图片层 / 放大镜（含图片引用，参数化）

/**
 * 图片层组件的数据：一份图片引用 + 显示顺序。
 * **参数化**：磁盘 / wire 各自传入自己的图片引用变体（带 `guid` / 带 `spriteGrid`）。
 */
export function imageLayerDataSchemaWith(imageRef: z.ZodObject<z.ZodRawShape>) {
  return imageRef.extend({
    sortingOrder: z.number().int().default(0),
  });
}

/** 放大镜里一个状态：标题 + 媒体（图或视频）+ 文字 + 三个显示开关。`imageRef` 由两侧各自传入。 */
export function magnifierStateSchemaWith<T extends z.ZodTypeAny>(imageRef: T) {
  return z.object({
    showTitle: z.boolean().optional(),
    showMedia: z.boolean().optional(),
    showText: z.boolean().optional(),
    title: z.string().optional(),
    image: imageRef.optional(),
    video: z
      .object({
        id: z.string().min(1),
        loop: z.boolean().default(DEFAULT_MAGNIFIER_VIDEO_LOOP),
        audio: z.boolean().default(DEFAULT_MAGNIFIER_VIDEO_AUDIO),
      })
      .optional(),
    tween: z.enum(MAGNIFIER_TWEENS).optional(),
    text: z.string().optional(),
  });
}

/** 放大镜的数据：状态列表 + 当前展示的下标（`stateSchema` 由两侧各自传入，因为里面嵌了图片引用）。 */
export function magnifierDataSchemaWith<T extends z.ZodTypeAny>(stateSchema: T) {
  return z.object({
    states: z.array(stateSchema).default([]),
    picked: z.number().int().nonnegative().optional(),
  });
}

// ---------------------------------------------------------------- 项目级设置（两侧逐字一致）

/** 缺省的背景音乐通道：只有音量。 */
export function defaultBgmSettings(): { volume: number } {
  return { volume: DEFAULT_BGM_VOLUME };
}

/** 缺省的音频设置（三档音量）。 */
export function defaultAudioSettings(): {
  bgm: { volume: number };
  sfx: { volume: number };
  voice: { volume: number };
} {
  return {
    bgm: defaultBgmSettings(),
    sfx: { volume: DEFAULT_SFX_VOLUME },
    voice: { volume: DEFAULT_VOICE_VOLUME },
  };
}

/** 缺省的项目级全局设置。 */
export function defaultProjectSettings(): { audio: ReturnType<typeof defaultAudioSettings> } {
  return { audio: defaultAudioSettings() };
}

/** 三档音量共用的形状：只有一个 `volume`（越界由调用方夹取 / `validateProject` 报 warning）。 */
export const channelVolumeSchema = z.object({
  volume: z.number(),
});

/** 项目级全局设置（目前只有音频）。每一档都给默认值。 */
export const projectSettingsSchema = z.object({
  audio: z
    .object({
      bgm: channelVolumeSchema.default(() => defaultBgmSettings()),
      sfx: channelVolumeSchema.default(() => ({ volume: DEFAULT_SFX_VOLUME })),
      voice: channelVolumeSchema.default(() => ({ volume: DEFAULT_VOICE_VOLUME })),
    })
    .default(() => defaultAudioSettings()),
});
