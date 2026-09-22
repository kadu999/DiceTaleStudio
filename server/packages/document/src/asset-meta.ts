import { z } from "zod";
import {
  DEFAULT_SPRITE_SHEET,
  SPRITE_SHEET_MAX,
  isTrivialSpriteSheet,
  normalizeSpriteSheet,
} from "./sprites";
import type { SpriteImportSettingsDoc, SpriteSheetDoc } from "./types";

/**
 * **素材的元数据**（`<素材>.meta`，v23 起）：稳定身份 + 导入设置 + 切分。
 *
 * 为什么要有它：这三份数据原来都以**文件名 / 路径为键**（切分与导入设置住在工程文件里、
 * 场景里那份引用写着路径 ID），外部改一次文件名就三份一起失联（见
 * `docs/specs/2026-09-23-asset-meta.md` 里记的真实案例）。改完 **GUID 才是身份**，
 * 路径只是「它现在在哪」——素材与它的 `.meta` 成对改名 / 移动，引用照样指得对
 * （对齐 Unity 的资产身份）。
 *
 * 这一版**只有图片**（`importer: "texture"`）：音频 / 视频 / 场景沿用现状，以后按同一套扩。
 *
 * 本文件是 meta 的**全部知识**：形状、schema、解析、序列化、GUID 生成，以及
 * 「meta ↔ 文档词汇」的访问器与两个纯函数写入。工程文件一侧由 `schema.ts` 的
 * v22 → v23 迁移调用这里（`withMetaSpriteSettings` / `withMetaSpriteSheet`），
 * 于是一份数据只有一套写入口径。
 */

export const ASSET_META_FORMAT_VERSION = 1;

/** 素材的切分与导入设置（住在 meta 里；`sprite` 整个缺省 = `Default` 普通图片）。 */
export interface AssetMetaSpriteDoc {
  /** 缺省 `Single`（不切网格的单张精灵）。 */
  readonly mode?: "Single" | "Multiple";
  /** 几列几行。**1×1 = 整图，不写**（与「不留空壳」同一条口径）。 */
  readonly sheet?: SpriteSheetDoc;
}

/** 一份素材的元数据：`<素材>.meta` 里的内容。 */
export interface AssetMetaDoc {
  readonly formatVersion: number;
  /** 32 位小写十六进制；**生成一次永不变**，素材改名 / 移动都靠它认。 */
  readonly guid: string;
  /** 导入器：本次只有图片这一档（音频 / 视频以后加各自的）。 */
  readonly importer: "texture";
  /** 缺省 = `Default`（普通图片）：开过又关掉的空壳不再写进文件。 */
  readonly sprite?: AssetMetaSpriteDoc;
}

/** 读一份 meta 的结果：`needsRewrite` 表示补过东西，调用方要回写一次。 */
export interface AssetMetaFileLoad {
  readonly doc: AssetMetaDoc;
  readonly needsRewrite: boolean;
}

/**
 * 32 位十六进制（**只认小写**）：GUID 只有这一种写法。
 *
 * 大小写各算一个身份的话，同一份 `.meta` 抄一遍就成了两个素材——身份必须是**唯一一种拼法**，
 * 与「生成端只写小写」一起守住这一点。
 */
const ASSET_GUID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * 生成一个新的素材 GUID（128 位随机数，32 位十六进制）。
 *
 * 走 `crypto.getRandomValues` 而不是 `Math.random`：这是**资产的长期身份**，
 * 撞一次就是两个素材共用一份 meta（改名兜底、推送换算全指向错的图），
 * 而 `Math.random` 的取值空间与序列质量都不是为这个准备的。
 */
export function newAssetGuid(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 一份新素材的 meta：新 GUID + 图片导入器（还没切、还没开精灵，所以没有 `sprite`）。 */
export function createAssetMeta(): AssetMetaDoc {
  return {
    formatVersion: ASSET_META_FORMAT_VERSION,
    guid: newAssetGuid(),
    importer: "texture",
  };
}

const assetMetaSheetSchema = z.object({
  columns: z.number().int().min(1).max(SPRITE_SHEET_MAX),
  rows: z.number().int().min(1).max(SPRITE_SHEET_MAX),
});

const assetMetaSpriteSchema = z.object({
  mode: z.enum(["Single", "Multiple"]).optional(),
  sheet: assetMetaSheetSchema.optional(),
});

/**
 * `<素材>.meta` 的形状。
 *
 * `guid` 与 `importer` 必填：缺 `guid` 的那一种由 `parseAssetMetaFile` 补（它是一次迁移，
 * 不是容错），认不出的 `importer` 说明这份 meta 不是这一版写的——报错比按图片硬读安全。
 * `sprite` **可选且不给默认值**：「没有它」就是 `Default`（普通图片），
 * 补一个空壳正是旧工程文件里堆积的那种噪声。
 */
export const assetMetaSchema = z.object({
  formatVersion: z.number().int().positive(),
  guid: z.string().regex(ASSET_GUID_PATTERN),
  importer: z.literal("texture"),
  sprite: assetMetaSpriteSchema.optional(),
});

/** 校验失败时把 zod 的问题列表拼成「字段路径: 消息」（与工程 / 场景文件同一个写法）。 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * 读一份 `<素材>.meta`。
 *
 * 唯一的容错是**缺 `guid` 就补一个**（手写的、以及更早的编辑器留下的 meta）：
 * 内容照旧读得出来，只是要调用方按 `needsRewrite` 回写一次——与「补过就回写」同一条规矩。
 * 其余坏数据一律抛错：读不懂的 meta 拿去渲染，只会让人以为「切分怎么不见了」。
 */
export function parseAssetMetaFile(raw: unknown): AssetMetaFileLoad {
  const missingGuid =
    isRecord(raw) && (typeof raw.guid !== "string" || raw.guid.length === 0);
  const filled = missingGuid ? { ...(raw as Record<string, unknown>), guid: newAssetGuid() } : raw;

  const result = assetMetaSchema.safeParse(filled);
  if (!result.success) {
    throw new Error(`素材 meta 校验失败: ${describeIssues(result.error)}`);
  }

  // 高版本明确拒绝（与工程 / 场景文件同一条纪律）：读不懂的字段被静默丢掉再回存 = 毁数据
  if (result.data.formatVersion > ASSET_META_FORMAT_VERSION) {
    throw new Error(
      `素材 meta 校验失败: formatVersion=${result.data.formatVersion} 高于本编辑器支持的 ${ASSET_META_FORMAT_VERSION}，请升级编辑器`,
    );
  }

  return { doc: result.data as AssetMetaDoc, needsRewrite: missingGuid };
}

/** 序列化一份 meta（写法与工程文件一致：缩进 2、末尾一个换行）。 */
export function serializeAssetMetaFile(doc: AssetMetaDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// ---------------------------------------------------------------- meta ↔ 文档词汇的访问器

/** 这份 meta 是不是「精灵」（设了导入设置或切了网格）；缺省 / 没有 meta = 普通图片。 */
export function isSpriteMeta(meta: AssetMetaDoc | undefined): boolean {
  return meta?.sprite !== undefined;
}

/**
 * 反向翻译成**导入设置**：没有 `sprite` = `Default`；有 = `Sprite`（`mode` 缺省 `Single`）。
 *
 * 属性面板按这一份显示，所以「开过又关掉」必须回到 `Default`——它读的就是这里，
 * 而不是文件里有没有一个 `{ type: "Default" }` 的空壳。
 */
export function spriteSettingsOfMeta(meta: AssetMetaDoc | undefined): SpriteImportSettingsDoc {
  const sprite = meta?.sprite;
  return sprite === undefined ? { type: "Default" } : { type: "Sprite", mode: sprite.mode ?? "Single" };
}

/**
 * 这张图的切分（**没有 meta / 没开精灵 / `sheet` 没写时就是整图**）。
 *
 * 「没有表项 = 1×1」这条语义只在这里判：调用方一律拿一份合法的 `SpriteSheetDoc`。
 */
export function spriteSheetOfMeta(meta: AssetMetaDoc | undefined): SpriteSheetDoc {
  const sheet = meta?.sprite?.sheet;
  return sheet === undefined ? DEFAULT_SPRITE_SHEET : normalizeSpriteSheet(sheet);
}

// ---------------------------------------------------------------- 纯函数写入

/**
 * 组一份 `sprite` 节点：值为 `undefined` 的项**不写**（JSON 里不留 `"mode": undefined` 这种脏东西；
 * 两项都空 = 整个节点不存在 = `Default`）。
 */
function spriteNode(
  mode: AssetMetaSpriteDoc["mode"],
  sheet: SpriteSheetDoc | undefined,
): AssetMetaSpriteDoc | undefined {
  if (mode === undefined && sheet === undefined) {
    return undefined;
  }

  return {
    ...(mode === undefined ? {} : { mode }),
    ...(sheet === undefined ? {} : { sheet }),
  };
}

/** 换掉 / 摘掉 `sprite` 节点，返回新 meta（摘掉时**删键**，不留 `sprite: undefined`）。 */
function withSpriteNode(meta: AssetMetaDoc, sprite: AssetMetaSpriteDoc | undefined): AssetMetaDoc {
  if (sprite === undefined) {
    return { formatVersion: meta.formatVersion, guid: meta.guid, importer: meta.importer };
  }

  return { ...meta, sprite };
}

function sameSheet(left: SpriteSheetDoc | undefined, right: SpriteSheetDoc | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return left.columns === right.columns && left.rows === right.rows;
}

function sameSpriteNode(
  left: AssetMetaSpriteDoc | undefined,
  right: AssetMetaSpriteDoc | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return left.mode === right.mode && sameSheet(left.sheet, right.sheet);
}

/**
 * 改导入设置（`null` 与 `Default` 都是「普通图片」）；语义与旧命令 `setSpriteImportSettings` 一致。
 *
 * 三条口径：
 * - **`Default` 就摘掉整个 `sprite`**（文件里不留空壳，这是这一版要消掉的噪声）；
 * - `Sprite` 的 `mode` 缺省 `Single`；
 * - **`Single` 不用网格切分**：顺手把旧 `sheet` 摘掉——留着会让「导入设置说整图、
 *   渲染却按切分画」两份口径分叉（旧命令也是这么清的）。
 *
 * 值没变时**返回原对象**（引用不变）：调用方靠它判断「这次编辑什么都不用记」，
 * 与旧命令返回 `false` 是同一条语义。
 */
export function withMetaSpriteSettings(
  meta: AssetMetaDoc,
  settings: SpriteImportSettingsDoc | null,
): AssetMetaDoc {
  if (settings === null || settings.type === "Default") {
    return meta.sprite === undefined ? meta : withSpriteNode(meta, undefined);
  }

  const mode = settings.mode ?? "Single";
  const sheet = mode === "Multiple" ? meta.sprite?.sheet : undefined;
  const next = spriteNode(mode, sheet);
  if (sameSpriteNode(meta.sprite, next)) {
    return meta;
  }

  return withSpriteNode(meta, next);
}

/**
 * 改一张图的切分（`null` = 恢复整图）；语义与旧命令 `setSpriteSheet` 一致。
 *
 * - 取整 + 夹到 `1..SPRITE_SHEET_MAX`（坏数字不该让整张图集画不出来）；
 * - **`1×1` = 整图**，与 `null` 一样把 `sheet` 摘掉（只剩 `mode` 时保留 `mode`：
 *   「Multiple 但没切」是合法状态，与旧文件里「有设置、没切分表」一致）；
 * - `mode` 一个字节都不碰：改切分不改导入设置（两个面板各管各的）。
 *
 * 值没变时返回原对象（理由同 `withMetaSpriteSettings`）。
 */
export function withMetaSpriteSheet(meta: AssetMetaDoc, sheet: SpriteSheetDoc | null): AssetMetaDoc {
  const next = sheet === null ? null : normalizeSpriteSheet(sheet);
  // 1×1 = 整图：与 null 一样按「把这一项摘掉」处理
  const removing = next === null || isTrivialSpriteSheet(next);
  const current = meta.sprite?.sheet;

  if (removing) {
    // 本来就按整图算（没这项）：什么都没变
    return current === undefined ? meta : withSpriteNode(meta, spriteNode(meta.sprite?.mode, undefined));
  }

  if (sameSheet(current, next)) {
    return meta;
  }

  return withSpriteNode(meta, spriteNode(meta.sprite?.mode, next));
}

// ---------------------------------------------------------------- 编辑器读盘后建一次的索引

/**
 * 素材 meta 的索引：**guid 与路径 ID 两个方向查得到同一份 meta**。
 *
 * 编辑器打开项目 / 写到新 meta 时重建一次，之后画布、属性面板、资源面板、校验、推送
 * 一律经它解析（路径只做显示）。两个方向指向**同一份对象**，所以「按 guid 查到的那一份」
 * 与「按路径查到的那一份」永远是同一份。
 */
export interface AssetMetas {
  readonly byGuid: Readonly<Record<string, AssetMetaDoc>>;
  readonly byId: Readonly<Record<string, AssetMetaDoc>>;
}

/** 空索引（还没读到任何 meta：没打开项目、或这个项目一张图都没有 meta）。 */
export function emptyAssetMetas(): AssetMetas {
  return { byGuid: {}, byId: {} };
}

/**
 * 建索引：`byId` 的键就是**素材的路径 ID**（调用方从资源树 / 后端那份 `metas` 拿到的键）。
 *
 * 两个素材写着同一个 guid（复制文件时把 `.meta` 一起抄了一份）时**先到的赢**：
 * 那本来就是需要人去纠正的重复身份，索引能稳定地查出一份，比两份互相覆盖好。
 */
export function createAssetMetas(
  entries: ReadonlyArray<{ readonly id: string; readonly meta: AssetMetaDoc }>,
): AssetMetas {
  const byGuid: Record<string, AssetMetaDoc> = {};
  const byId: Record<string, AssetMetaDoc> = {};

  for (const entry of entries) {
    byId[entry.id] = entry.meta;
    if (byGuid[entry.meta.guid] === undefined) {
      byGuid[entry.meta.guid] = entry.meta;
    }
  }

  return { byGuid, byId };
}

/**
 * 按引用取 meta：**先 guid、再 id**。
 *
 * guid 是身份、路径只是「上次见到的位置」：素材与 `.meta` 成对改名之后引用上的
 * `id` 已经过期，但 guid 还是对的。老文件（只有路径）按 id 兜底；两边都没有 = 这张图
 * 没有 meta（普通图片），返回 `undefined` 让调用方按缺省处理。
 */
export function metaOfImage(
  metas: AssetMetas,
  image: { readonly guid?: string; readonly id?: string } | undefined,
): AssetMetaDoc | undefined {
  if (image === undefined) {
    return undefined;
  }

  const byGuid = image.guid === undefined ? undefined : metas.byGuid[image.guid];
  if (byGuid !== undefined) {
    return byGuid;
  }

  return image.id === undefined ? undefined : metas.byId[image.id];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
