import { z } from "zod";
import {
  DEFAULT_SPRITE_SHEET,
  SPRITE_SHEET_MAX,
  isTrivialSpriteSheet,
  normalizeSpriteSheet,
} from "./sprites";
import type { SpriteImportSettingsDoc, SpriteSheetDoc } from "./types";

/**
 * **素材的元数据**（`<素材>.meta`，v23 起；v24 起覆盖**每一种素材**）：稳定身份 + 各导入器自己的设置。
 *
 * 为什么要有它：这些数据原来都以**文件名 / 路径为键**（切分与导入设置住在工程文件里、
 * 音频的显示名与标签住在工程文件的 `audioMeta` 里、场景里那份引用写着路径 ID），
 * 外部改一次文件名就一起失联（见 `docs/specs/2026-09-23-asset-meta.md` 里记的真实案例）。
 * 改完 **GUID 才是身份**，路径只是「它现在在哪」——素材与它的 `.meta` 成对改名 / 移动，
 * 引用照样指得对（对齐 Unity 的资产身份）。
 *
 * 两条口径（v24 起）：
 * - **每个素材旁边必有一份 `<素材>.meta`**：编辑器打开项目 / 刷新资源树时，缺的那几份按素材
 *   种类现建（`importer` 由调用方按路径判定，见 `createAssetMeta`）；
 * - **按文件记的数据一律住在它自己的 meta 里**：图片是 `sprite`（导入设置 + 切分），
 *   音频是 `audio`（显示名 + 标签 ID 列表，v24 从工程文件的 `audioMeta` 搬来），
 *   视频与场景暂时只有身份（`importer`），以后按同一套加各自的段。
 *
 * **`audioTags`（标签表）仍住在工程文件里**：它是**项目级**数据（下标 = tag ID），
 * 不是某一个文件的属性；文件里只记 `[0, 2]` 这样的 ID（与 Unity 的 TagManager 一致）。
 *
 * 本文件是 meta 的**全部知识**：形状、schema、解析、序列化、GUID 生成，以及
 * 「meta ↔ 文档词汇」的访问器与纯函数写入。工程文件一侧由 `schema.ts` 的迁移调用这里
 * （v22 → v23 的 `withMetaSpriteSettings` / `withMetaSpriteSheet`、v23 → v24 的
 * `withMetaAudioName` / `withMetaAudioTags`），于是一份数据只有一套写入口径。
 */

export const ASSET_META_FORMAT_VERSION = 1;

/**
 * 素材的种类（meta 的 `importer`）。
 *
 * 与 Unity 的「每种资产一个 Importer」同一个意思：**每一档可以有自己的一段设置**
 * （图片是 `sprite`、音频是 `audio`），解析、校验、界面都按它路由。
 * 叫 `importer` 而不是 `kind`：它描述的是「这份素材是怎么被导入 / 整理的」，
 * 而不是「它是哪一类文件」——以后同类素材也可能有不同导入方式。
 */
export const ASSET_IMPORTERS = ["texture", "audio", "video", "scene", "prefab"] as const;

export type AssetImporter = (typeof ASSET_IMPORTERS)[number];

/** 素材的切分与导入设置（住在 meta 里；`sprite` 整个缺省 = `Default` 普通图片）。 */
export interface AssetMetaSpriteDoc {
  /** 缺省 `Single`（不切网格的单张精灵）。 */
  readonly mode?: "Single" | "Multiple";
  /** 几列几行。**1×1 = 整图，不写**（与「不留空壳」同一条口径）。 */
  readonly sheet?: SpriteSheetDoc;
}

/**
 * 音频文件自己的数据（v24 起从工程文件的 `audioMeta` 搬来）：显示名 + 标签 ID 列表。
 *
 * **两项都不给默认值**（与 `video` / `teleport` 同一个口径）：「没写」本身有语义——
 * 显示名空着 = 用素材文件名，标签空着 = 还没打标签。补成 `""` / `[]` 只会让
 * 「没整理过」和「整理成空」变得分不清。
 */
export interface AssetMetaAudioDoc {
  /** 显示名（纯编辑器数据，不进协议）；缺省 = 用素材文件名。 */
  readonly name?: string;
  /** 标签 ID 列表——ID 是**工程文件 `audioTags` 的下标**（对齐 Unity：tag 是个整数）。 */
  readonly tags?: number[];
}

/** 一份素材的元数据：`<素材>.meta` 里的内容。 */
export interface AssetMetaDoc {
  readonly formatVersion: number;
  /** 32 位小写十六进制；**生成一次永不变**，素材改名 / 移动都靠它认。 */
  readonly guid: string;
  /** 这一份是哪种素材的 meta（决定哪个设置段有意义）。 */
  readonly importer: AssetImporter;
  /** 图片的导入设置与切分（`importer: "texture"`）；缺省 = `Default`（普通图片）。 */
  readonly sprite?: AssetMetaSpriteDoc;
  /** 音频的显示名与标签（`importer: "audio"`）；缺省 = 还没整理过这个文件。 */
  readonly audio?: AssetMetaAudioDoc;
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

/**
 * 一份新素材的 meta：新 GUID + 指定的导入器（还没有任何设置段）。
 *
 * `importer` **没有默认值**是有意的（v24 起每个素材都要有一份 meta，种类是必须说清的信息）：
 * 调用方按素材种类显式传 `"texture"` / `"audio"` / …，读代码的人一眼看得出这一份在给谁建。
 */
export function createAssetMeta(importer: AssetImporter): AssetMetaDoc {
  return {
    formatVersion: ASSET_META_FORMAT_VERSION,
    guid: newAssetGuid(),
    importer,
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
 * 音频那一段：显示名 + 标签 ID 列表。
 *
 * 只保证「是字符串 / 是整数数组」：空名字、越界 / 指向已删标签 / 重复的 ID、空列表
 * 都由 `validateAssetMetas` 报 warning（读不开比显示不出来更糟）——与 `audioTags` 那条同一条规矩。
 */
const assetMetaAudioSchema = z.object({
  name: z.string().optional(),
  tags: z.array(z.number().int()).optional(),
});

/**
 * `<素材>.meta` 的形状。
 *
 * `guid` 与 `importer` 必填：缺 `guid` 的那一种由 `parseAssetMetaFile` 补（它是一次迁移，
 * 不是容错），认不出的 `importer` 说明这份 meta 不是这一版写的——报错比按图片硬读安全。
 *
 * 两个设置段**都可选、都不给默认值**：「没有它」本身就是语义（图片 = `Default`、音频 = 没整理过），
 * 补一个空壳正是旧工程文件里堆积的那种噪声。段与 `importer` **不互查**：手写一份
 * `importer: "audio"` 却带着 `sprite` 的 meta 读得回来（只是那个段没人用），
 * 比整份读不开、被当成「这个素材没有 meta」强。
 */
export const assetMetaSchema = z.object({
  formatVersion: z.number().int().positive(),
  guid: z.string().regex(ASSET_GUID_PATTERN),
  importer: z.enum(ASSET_IMPORTERS),
  sprite: assetMetaSpriteSchema.optional(),
  audio: assetMetaAudioSchema.optional(),
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
  return sprite === undefined ? withoutKey(meta, "sprite") : { ...meta, sprite };
}

/**
 * 摘掉一个键（不留下 `key: undefined`），其余字段一个都不动。
 *
 * 必须是「按剩余的键重建」而不是「挑出已知的键重建」：v24 起一份 meta 里可能同时有
 * `sprite` 与别的段，挑着重建会把没列到的段**静默丢掉**（改切分时把音频标注抹掉，谁也想不到）。
 */
function withoutKey<T extends object, K extends keyof T>(value: T, key: K): T {
  const next = { ...value };
  delete next[key];
  return next;
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

// ---------------------------------------------------------------- 音频那段：显示名 + 标签（v24 从工程文件搬来）

/** 这个文件的显示名（没整理过就是 `undefined`，显示时退回素材文件名）。 */
export function audioNameOfMeta(meta: AssetMetaDoc | undefined): string | undefined {
  return meta?.audio?.name;
}

/**
 * 这个文件的标签 ID 列表（**没整理过 / 没写这一项时是空表**）。
 *
 * 「没有这一项 = 还没打标签」这条语义只在这里判：调用方一律拿一份数组，不用到处写三元判断。
 * ID 是否还在表里（有没有越界 / 指向已删的洞）由 `validateAssetMetas` 提醒、界面自行忽略。
 */
export function audioTagsOfMeta(meta: AssetMetaDoc | undefined): readonly number[] {
  return meta?.audio?.tags ?? [];
}

/**
 * 归一化一组标签 ID：丢掉越界的、指向已删（`null`）槽的、重复的，再升序。
 *
 * 升序是有意的：ID 是**身份**（不是顺序），排一下让「同一组标签」在文件里长得一样，
 * 「值没变」的判断也就成了逐项比较。这条归一化是**唯一一份**（写路径与迁移共用）。
 */
function normalizeTagIds(
  tags: readonly number[],
  table: readonly (string | null)[],
): number[] {
  const seen = new Set<number>();
  for (const raw of tags) {
    if (!Number.isInteger(raw) || raw < 0 || raw >= table.length || table[raw] === null) {
      continue;
    }

    seen.add(raw);
  }

  return [...seen].sort((a, b) => a - b);
}

/**
 * 组一份 `audio` 节点：值为 `undefined` 的项**不写**（两项都空 = 整个节点不存在 =
 * 「这个文件还没整理过」）。
 *
 * 标签数组**拷一份**：文档里的数组是「值」，外面传进来的可能是别处正在用的数组
 * （`withMetaAudioName` 会把当前这一份原样传回来），拷一次就不会出现两份 meta 共用同一个数组。
 */
function audioNode(
  name: string | undefined,
  tags: readonly number[] | undefined,
): AssetMetaAudioDoc | undefined {
  if (name === undefined && tags === undefined) {
    return undefined;
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(tags === undefined ? {} : { tags: [...tags] }),
  };
}

/** 换掉 / 摘掉 `audio` 节点，返回新 meta（摘掉时删键，与 `withSpriteNode` 同一套）。 */
function withAudioNode(meta: AssetMetaDoc, audio: AssetMetaAudioDoc | undefined): AssetMetaDoc {
  return audio === undefined ? withoutKey(meta, "audio") : { ...meta, audio };
}

/**
 * 给一个音频文件起**显示名**（`""` = 退回素材文件名）；语义与旧命令 `setAudioMetaName` 一致。
 *
 * 名字只是编辑器里给人看的（找不到素材时也靠它认），**不进协议、不参与播放**。
 * 值没变时**返回原对象**（引用不变）：调用方靠它判断「这次编辑什么都不用记」。
 */
export function withMetaAudioName(meta: AssetMetaDoc, name: string): AssetMetaDoc {
  const trimmed = name.trim();
  if (trimmed === (meta.audio?.name ?? "")) {
    return meta;
  }

  const next = audioNode(trimmed.length === 0 ? undefined : trimmed, meta.audio?.tags);
  return withAudioNode(meta, next);
}

/**
 * 替换一个音频文件的**整份标签 ID 清单**（与 `setTeleportTargets` 同一个口径：
 * 界面那边只看得到「现在勾了哪些」，传整份最直接）；语义与旧命令 `setAudioMetaTags` 一致。
 *
 * `table` 就是工程文件里的 `audioTags`（下标 = ID）：归一化要按它丢掉越界 / 已删 / 重复的 ID。
 * 清空 = 摘掉 `tags`；值没变时返回原对象。
 */
export function withMetaAudioTags(
  meta: AssetMetaDoc,
  tags: readonly number[],
  table: readonly (string | null)[],
): AssetMetaDoc {
  const next = normalizeTagIds(tags, table);
  const current = meta.audio?.tags ?? [];
  if (next.length === current.length && next.every((tag, index) => tag === current[index])) {
    return meta;
  }

  return withAudioNode(meta, audioNode(meta.audio?.name, next.length === 0 ? undefined : next));
}

/**
 * 从一个文件的 meta 上摘掉某个标签 ID（**删标签**时用：ID 是身份，别的文件一个字节都不动）。
 *
 * 工程文件里的 `audioTags` 是项目级的，所以「删标签」天然跨两条轨道：表在工程文件那边、
 * 引用在各文件的 meta 这边——这条纯函数负责后半截，调用方（编辑器 / 工具）把两条合起来做。
 * 这个 ID 本来就没挂在这个文件上时返回原对象。
 */
export function withoutMetaAudioTag(meta: AssetMetaDoc, tagId: number): AssetMetaDoc {
  const tags = meta.audio?.tags;
  if (tags === undefined || !tags.includes(tagId)) {
    return meta;
  }

  const next = tags.filter((tag) => tag !== tagId);
  return withAudioNode(meta, audioNode(meta.audio?.name, next.length === 0 ? undefined : next));
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

/** Resolve a stable asset GUID to its current logical resource ID. */
export function assetIdOfGuid(metas: AssetMetas, guid: string): string | undefined {
  for (const [id, meta] of Object.entries(metas.byId)) {
    if (meta.guid === guid) {
      return id;
    }
  }

  return undefined;
}

/** Resolve a current logical resource ID to the GUID persisted in its sidecar. */
export function assetGuidOfId(metas: AssetMetas, id: string): string | undefined {
  return metas.byId[id]?.guid;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
