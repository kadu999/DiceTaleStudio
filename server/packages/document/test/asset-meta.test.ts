import { describe, expect, it } from "vitest";
import {
  ASSET_IMPORTERS,
  ASSET_META_FORMAT_VERSION,
  audioNameOfMeta,
  audioTagsOfMeta,
  createAssetMeta,
  createAssetMetas,
  emptyAssetMetas,
  isSpriteMeta,
  metaOfImage,
  newAssetGuid,
  parseAssetMetaFile,
  serializeAssetMetaFile,
  spriteSettingsOfMeta,
  spriteSheetOfMeta,
  withMetaAudioName,
  withMetaAudioTags,
  withoutMetaAudioTag,
  withMetaSpriteSettings,
  withMetaSpriteSheet,
  type AssetMetaDoc,
} from "../src/asset-meta";
import { repairImageObjectComponent, createGameObject } from "../src/commands";
import { createEmptyProject, createEmptyScene } from "../src/factory";
import { parseProjectFile } from "../src/schema";
import { resolveSceneSprites } from "../src/sprites";
import { validateAssetMetas } from "../src/validation";
import {
  DOCUMENT_FORMAT_VERSION,
  type AudioTagTableDoc,
  type SceneDoc,
  type SpriteSheetDoc,
} from "../src/types";

/**
 * **素材的元数据**（`<素材>.meta`，v23 起；v24 起**每一种素材一份**）：
 * 稳定 GUID + 导入器 + 各导入器自己的设置段（图片 `sprite`、音频 `audio`）。
 *
 * 这一份盯住这些事：
 * 1. **形状与容错**：写出去读回来是同一份；四种导入器都认；缺 `guid` 补一个并要回写；坏数据读不开；
 * 2. **图片的写入口径**：`Default` 不留空壳、`1×1` 不写 `sheet`——旧工程文件里堆积的那两种噪声；
 * 3. **音频的写入口径**（v24 从工程文件的 `audioMeta` 搬来）：显示名 trim、空串摘掉；
 *    标签按表归一化（丢越界 / 洞 / 重复、升序）、空表摘掉；两条都「值没变 = 同一份引用」；
 * 4. **段与段互不打扰**：写 `audio` 不弄丢 `sprite`（`withoutKey` 那条实现的关键），反过来也一样；
 * 5. **索引**：guid 与路径两个方向指向同一份，改名之后按 guid 照样查得到；
 * 6. **迁移**：v22 → v23 的两份老表、v23 → v24 的 `audioMeta`，都合并成各自的 meta 交给调用方。
 */

const IMAGE_ID = "project:P/Assets/images/hero.png";
const OTHER_ID = "project:P/Assets/images/tiles.png";
const MISSING_ID = "project:P/Assets/images/已经改名了.png";
const AUDIO_ID = "project:P/Assets/audio/theme.mp3";
const AUDIO_OTHER_ID = "project:P/Assets/audio/battle.wav";
const GUID = "1f".repeat(16);

/** 标签表（下标 = tag ID）：`战斗=0`、`紧张=1`，`#2` 是删过的洞。 */
const TAG_TABLE: AudioTagTableDoc = ["战斗", "紧张", null];

/** 迁移结果的一项（`parseProjectFile` 交给调用方落盘的那份清单）。 */
type MigratedMeta = { readonly id: string; readonly meta: AssetMetaDoc };

function sheetOf(columns: number, rows: number): SpriteSheetDoc {
  return { columns, rows };
}

/** 一个 v22 形状的工程文件（那两项老表由调用方按需塞进来）。 */
function legacyProject(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(createEmptyProject("P") as unknown as Record<string, unknown>),
    formatVersion: 22,
    ...extra,
  };
}

/** 一个 v23 形状的工程文件（音频标注还住在 `audioMeta` 里的那一版）。 */
function v23Project(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(createEmptyProject("P") as unknown as Record<string, unknown>),
    formatVersion: 23,
    ...extra,
  };
}

/** 迁移结果里按路径 ID 取那一份（找不到就抛，省得断言里到处写 `!.`）。 */
function metaOfId(metas: readonly MigratedMeta[], id: string): AssetMetaDoc {
  const found = metas.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`迁移结果里没有 ${id}`);
  }

  return found.meta;
}

/**
 * 从迁移结果里读出某个音频文件那份 meta 的 `audio` 段。
 *
 * 迁移是**一次性**的：搬过去的显示名与标签此后就住在 meta 里，与工程文件一个字节的关系都没有了
 * ——所以这里断言的是「交给调用方落盘的那份 meta 说了什么」，而不是工程文件里的旧字段。
 */
function audioOf(metas: readonly MigratedMeta[], id: string): AssetMetaDoc["audio"] {
  return metaOfId(metas, id).audio;
}

describe("meta 文件：解析与序列化", () => {
  it("往返：写出去再读回来是同一份（含 sprite 与切分）", () => {
    const doc: AssetMetaDoc = {
      formatVersion: ASSET_META_FORMAT_VERSION,
      guid: GUID,
      importer: "texture",
      sprite: { mode: "Multiple", sheet: sheetOf(2, 2) },
    };

    const text = serializeAssetMetaFile(doc);
    // 与工程文件同一套写法：缩进 2 + 末尾一个换行
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "guid"');

    const loaded = parseAssetMetaFile(JSON.parse(text) as unknown);
    expect(loaded.doc).toEqual(doc);
    expect(loaded.needsRewrite).toBe(false);
  });

  it("往返：音频那一段（显示名 + 标签 ID）也在里面", () => {
    const doc = withMetaAudioTags(
      withMetaAudioName(createAssetMeta("audio"), "开场曲"),
      [0, 1],
      TAG_TABLE,
    );

    const loaded = parseAssetMetaFile(JSON.parse(serializeAssetMetaFile(doc)) as unknown);
    expect(loaded.doc).toEqual(doc);
    expect(loaded.doc.audio).toEqual({ name: "开场曲", tags: [0, 1] });
    expect(loaded.needsRewrite).toBe(false);
  });

  it("缺 guid 就补一个，并要调用方回写一次", () => {
    const missing = parseAssetMetaFile({ formatVersion: 1, importer: "texture" });
    expect(missing.doc.guid).toMatch(/^[0-9a-f]{32}$/);
    expect(missing.needsRewrite).toBe(true);

    // 空字符串也是「缺」：手写文件里常见
    const blank = parseAssetMetaFile({ formatVersion: 1, guid: "", importer: "texture" });
    expect(blank.doc.guid).toMatch(/^[0-9a-f]{32}$/);
    expect(blank.needsRewrite).toBe(true);
  });

  it("四种导入器都认：texture / audio / video / scene（v24 起每种素材一份）", () => {
    expect(ASSET_IMPORTERS).toEqual(["texture", "audio", "video", "scene", "prefab"]);

    for (const importer of ASSET_IMPORTERS) {
      const meta = createAssetMeta(importer);
      expect(meta.importer).toBe(importer);
      // 新建的 meta 只有身份与种类：没有一个凭空补出来的设置段
      expect(meta.sprite).toBeUndefined();
      expect(meta.audio).toBeUndefined();

      const loaded = parseAssetMetaFile(JSON.parse(serializeAssetMetaFile(meta)) as unknown);
      expect(loaded.doc.importer).toBe(importer);
      expect(loaded.needsRewrite).toBe(false);
    }
  });

  it("认不出的导入器仍然报错：这份 meta 不是这一版写的，按图片硬读更危险", () => {
    for (const importer of ["Texture", "sprite", "sound", ""]) {
      expect(() => parseAssetMetaFile({ formatVersion: 1, guid: GUID, importer })).toThrow(
        /素材 meta 校验失败/,
      );
    }

    // 报错要指出是 `importer` 这一项坏了，而不是笼统地说「读不开」
    expect(() => parseAssetMetaFile({ formatVersion: 1, guid: GUID, importer: "sprite" })).toThrow(
      /importer/,
    );
  });

  it("坏数据抛出「素材 meta 校验失败: …」，且带得上字段路径", () => {
    const bad: readonly unknown[] = [
      "不是对象",
      { guid: GUID, importer: "texture" }, // 缺 formatVersion
      { formatVersion: 1, guid: "A".repeat(32), importer: "texture" }, // 大写不是这一种写法
      { formatVersion: 1, guid: "abc", importer: "texture" },
      { formatVersion: 1, guid: GUID, importer: "texture", sprite: { mode: "Many" } },
      { formatVersion: 1, guid: GUID, importer: "texture", sprite: { sheet: sheetOf(0, 1) } },
      { formatVersion: 1, guid: GUID, importer: "texture", sprite: { sheet: sheetOf(65, 1) } },
      { formatVersion: 1, guid: GUID, importer: "audio", audio: { name: 42 } },
      { formatVersion: 1, guid: GUID, importer: "audio", audio: { tags: ["0"] } },
      { formatVersion: 1, guid: GUID, importer: "audio", audio: { tags: [0.5] } },
    ];

    for (const raw of bad) {
      expect(() => parseAssetMetaFile(raw)).toThrow(/素材 meta 校验失败/);
    }

    expect(() =>
      parseAssetMetaFile({ formatVersion: 1, guid: GUID, importer: "texture", sprite: { sheet: sheetOf(0, 1) } }),
    ).toThrow(/sprite\.sheet\.columns/);

    // 音频那一段的坏值同样指出是哪一项
    expect(() =>
      parseAssetMetaFile({ formatVersion: 1, guid: GUID, importer: "audio", audio: { tags: ["0"] } }),
    ).toThrow(/audio\.tags/);
  });

  it("音频那一段的「脏」值读得回来（空名字 / 空表 / 越界 ID 交给校验报 warning）", () => {
    // 读不开比显示不出来更糟：这些形状由 `validateAssetMetas` 提醒，不在这里硬拒
    const loaded = parseAssetMetaFile({
      formatVersion: 1,
      guid: GUID,
      importer: "audio",
      audio: { name: "", tags: [0, 0, 99] },
    });

    expect(loaded.doc.audio).toEqual({ name: "", tags: [0, 0, 99] });
    expect(loaded.needsRewrite).toBe(false);
  });

  it("高版本明确拒绝（读不懂的字段不能静默丢掉再回存）", () => {
    expect(() =>
      parseAssetMetaFile({ formatVersion: 2, guid: GUID, importer: "texture" }),
    ).toThrow(/高于本编辑器支持/);
  });

  it("新 meta：新 guid + 指定的导入器；Default 不会写出 sprite 空壳", () => {
    const created = createAssetMeta("texture");
    expect(created.formatVersion).toBe(ASSET_META_FORMAT_VERSION);
    expect(created.importer).toBe("texture");
    expect(created.guid).toMatch(/^[0-9a-f]{32}$/);
    expect(isSpriteMeta(created)).toBe(false);

    expect(serializeAssetMetaFile(created)).not.toMatch(/"sprite"/);
    // 新建的音频 meta 同样只有身份与种类：显示名与标签留空 = 「还没整理过」
    // （`importer` 那一项当然写着 "audio"，这里查的是有没有多出来的 `audio` **段**）
    expect(serializeAssetMetaFile(createAssetMeta("audio"))).not.toMatch(/"audio":/);
    // 生成一次永不变：两把 guid 不该撞（撞了就是两个素材共用一份 meta）
    expect(newAssetGuid()).not.toBe(newAssetGuid());
  });

  it("重复 guid 的索引：先到的赢（复制文件时把 meta 一起抄了的那种）", () => {
    const first = createAssetMeta("texture");
    const second = { ...createAssetMeta("texture"), guid: first.guid };
    const metas = createAssetMetas([
      { id: IMAGE_ID, meta: first },
      { id: OTHER_ID, meta: second },
    ]);

    expect(metas.byGuid[first.guid]).toBe(first);
    // 两个方向仍然各指各的（路径是可查的，身份是打架的）
    expect(metas.byId[OTHER_ID]).toBe(second);
  });
});

describe("访问器：meta ↔ 文档词汇", () => {
  it("没有 meta / 没有 sprite = Default 普通图片，切分是整图", () => {
    for (const meta of [undefined, createAssetMeta("texture")]) {
      expect(isSpriteMeta(meta)).toBe(false);
      expect(spriteSettingsOfMeta(meta)).toEqual({ type: "Default" });
      expect(spriteSheetOfMeta(meta)).toEqual(sheetOf(1, 1));
    }
  });

  it("有 sprite：导入设置是 Sprite（mode 缺省 Single）；切分按 sheet 收干净", () => {
    const single: AssetMetaDoc = { ...createAssetMeta("texture"), sprite: { mode: "Single" } };
    expect(isSpriteMeta(single)).toBe(true);
    expect(spriteSettingsOfMeta(single)).toEqual({ type: "Sprite", mode: "Single" });

    // mode 不写 = Single（缺省），切分照旧按 sheet 用
    const bare: AssetMetaDoc = { ...createAssetMeta("texture"), sprite: { sheet: sheetOf(4, 4) } };
    expect(spriteSettingsOfMeta(bare)).toEqual({ type: "Sprite", mode: "Single" });
    expect(spriteSheetOfMeta(bare)).toEqual(sheetOf(4, 4));

    // 坏数字收干净：取整 + 夹到 1..64
    const wild: AssetMetaDoc = { ...createAssetMeta("texture"), sprite: { sheet: { columns: 999, rows: 0 } } };
    expect(spriteSheetOfMeta(wild)).toEqual(sheetOf(64, 1));
  });

  it("音频那一段：没有 meta / 没整理过 = 没名字、没标签（不是空串、不是空表）", () => {
    for (const meta of [undefined, createAssetMeta("audio")]) {
      expect(audioNameOfMeta(meta)).toBeUndefined();
      // 调用方一律拿一份数组，不用到处写三元判断
      expect(audioTagsOfMeta(meta)).toEqual([]);
    }

    const named = withMetaAudioTags(
      withMetaAudioName(createAssetMeta("audio"), "开场曲"),
      [0, 1],
      TAG_TABLE,
    );
    expect(audioNameOfMeta(named)).toBe("开场曲");
    expect(audioTagsOfMeta(named)).toEqual([0, 1]);

    // 手写文件里指向洞 / 越界的 ID：读这一侧**原样交出去**（不替它过滤）——
    // 界面自行忽略、`validateAssetMetas` 报 warning，那是**显示**的口径；
    // 归一化只发生在写路径（`withMetaAudioTags`）上
    const stray: AssetMetaDoc = { ...createAssetMeta("audio"), audio: { tags: [2, 9] } };
    expect(audioTagsOfMeta(stray)).toEqual([2, 9]);
  });
});

describe("纯函数写入：图片（旧 setSpriteSheet / setSpriteImportSettings 的口径）", () => {
  it("写切分 / 改回来：1×1 与 null 都摘掉 sheet，值没变返回同一份", () => {
    const blank = createAssetMeta("texture");

    const written = withMetaSpriteSheet(blank, sheetOf(4, 4));
    expect(written.sprite?.sheet).toEqual(sheetOf(4, 4));
    // mode 一个字节都不碰（改切分不改导入设置）
    expect(written.sprite?.mode).toBeUndefined();

    // 同一个值再写一次：不算变更（返回原对象，调用方靠引用比较判断要不要记一笔）
    expect(withMetaSpriteSheet(written, sheetOf(4, 4))).toBe(written);

    const taller = withMetaSpriteSheet(written, sheetOf(4, 8));
    expect(taller.sprite?.sheet).toEqual(sheetOf(4, 8));

    // 1×1 = 整图：整份 sprite 都没了（Default 不留空壳）
    const cleared = withMetaSpriteSheet(taller, sheetOf(1, 1));
    expect(cleared.sprite).toBeUndefined();
    expect(serializeAssetMetaFile(cleared)).not.toMatch(/sprite/);

    // null 与 1×1 同一个效果；本来就没有 sheet 时什么都不做
    expect(withMetaSpriteSheet(taller, null).sprite).toBeUndefined();
    expect(withMetaSpriteSheet(blank, null)).toBe(blank);
    expect(withMetaSpriteSheet(blank, sheetOf(1, 1))).toBe(blank);

    // 坏数字会被收干净
    expect(withMetaSpriteSheet(blank, { columns: 3.4, rows: 0 }).sprite?.sheet).toEqual(sheetOf(3, 1));
  });

  it("Multiple 但没切过 = 留下 mode，摘掉 sheet（老文件里「有设置、没切分表」那一种）", () => {
    const multiple = withMetaSpriteSettings(createAssetMeta("texture"), { type: "Sprite", mode: "Multiple" });
    expect(multiple.sprite).toEqual({ mode: "Multiple" });

    const withSheet = withMetaSpriteSheet(multiple, sheetOf(2, 2));
    expect(withSheet.sprite).toEqual({ mode: "Multiple", sheet: sheetOf(2, 2) });

    // 恢复整图：mode 留着（Multiple 仍然是导入设置），sheet 摘掉
    const cleared = withMetaSpriteSheet(withSheet, null);
    expect(cleared.sprite).toEqual({ mode: "Multiple" });
  });

  it("Default / null 摘掉整个 sprite；Single 顺手清掉旧切分", () => {
    const multiple = withMetaSpriteSheet(
      withMetaSpriteSettings(createAssetMeta("texture"), { type: "Sprite", mode: "Multiple" }),
      sheetOf(2, 2),
    );

    // Single 不用网格切分：留着会让「面板说整图、渲染按切分画」两份口径分叉
    const single = withMetaSpriteSettings(multiple, { type: "Sprite", mode: "Single" });
    expect(single.sprite).toEqual({ mode: "Single" });

    // 缺省 mode = Single
    expect(withMetaSpriteSettings(createAssetMeta("texture"), { type: "Sprite" }).sprite).toEqual({
      mode: "Single",
    });

    const cleared = withMetaSpriteSettings(multiple, null);
    expect(cleared.sprite).toBeUndefined();
    expect(withMetaSpriteSettings(multiple, { type: "Default" }).sprite).toBeUndefined();

    // 值没变（含「本来就是 Default」）返回同一份
    expect(withMetaSpriteSettings(single, { type: "Sprite", mode: "Single" })).toBe(single);
    const blank = createAssetMeta("texture");
    expect(withMetaSpriteSettings(blank, null)).toBe(blank);
    expect(withMetaSpriteSettings(blank, { type: "Default" })).toBe(blank);

    // 摘掉 sprite 时只删键，不留 `sprite: undefined`（JSON 里一个字节都不多）
    expect(serializeAssetMetaFile(cleared)).not.toMatch(/sprite/);
    expect(Object.keys(cleared).sort()).toEqual(["formatVersion", "guid", "importer"]);
  });
});

describe("纯函数写入：音频显示名（旧 setAudioMetaName 的口径）", () => {
  it("起名 / 改名：trim 之后写进 audio.name", () => {
    const named = withMetaAudioName(createAssetMeta("audio"), "  开场曲  ");
    expect(named.audio).toEqual({ name: "开场曲" });
  });

  it("留空 = 退回素材文件名：摘掉 name（没有标签时整个 audio 段都不剩）", () => {
    const named = withMetaAudioName(createAssetMeta("audio"), "开场曲");

    for (const blank of ["", "   ", "\n"]) {
      const cleared = withMetaAudioName(named, blank);
      expect(cleared.audio).toBeUndefined();
      // 摘段是删键，不是写一个空壳（`importer` 那一项当然还写着 "audio"）
      expect(serializeAssetMetaFile(cleared)).not.toMatch(/"audio":/);
      expect(Object.keys(cleared).sort()).toEqual(["formatVersion", "guid", "importer"]);
    }

    // 有标签时只摘名字：标签一个字节都不动
    const both = withMetaAudioTags(named, [0], TAG_TABLE);
    expect(withMetaAudioName(both, "  ").audio).toEqual({ tags: [0] });
  });

  it("值没变（含 trim 后没变）= 同一份引用", () => {
    const named = withMetaAudioName(createAssetMeta("audio"), "开场曲");

    expect(withMetaAudioName(named, "开场曲")).toBe(named);
    // 「 开场曲 」trim 之后就是它：不算变更
    expect(withMetaAudioName(named, " 开场曲 ")).toBe(named);

    // 本来就没名字：再留空也是同一份
    const blank = createAssetMeta("audio");
    expect(withMetaAudioName(blank, "")).toBe(blank);
    expect(withMetaAudioName(blank, "   ")).toBe(blank);
  });
});

describe("纯函数写入：音频标签（旧 setAudioMetaTags 的口径）", () => {
  it("按标签表归一化：丢越界 / 指向洞 / 重复，再升序", () => {
    // 表是 战斗 / 紧张 / 洞：#2 指向已删的标签、#9 越界、重复的 #1 只算一次
    const written = withMetaAudioTags(createAssetMeta("audio"), [1, 0, 1, 2, 9, -1, 0], TAG_TABLE);
    expect(written.audio).toEqual({ tags: [0, 1] });

    // 表给空（项目里还没有标签）：什么 ID 都留不下 = 什么都没写上
    expect(withMetaAudioTags(createAssetMeta("audio"), [0, 1], []).audio).toBeUndefined();
  });

  it("空 = 摘掉 tags（没名字时整个 audio 段都不剩）；值没变返回同一份", () => {
    const both = withMetaAudioTags(withMetaAudioName(createAssetMeta("audio"), "开场曲"), [0], TAG_TABLE);

    const cleared = withMetaAudioTags(both, [], TAG_TABLE);
    expect(cleared.audio).toEqual({ name: "开场曲" });
    expect("tags" in (cleared.audio ?? {})).toBe(false);

    // 清空且没名字：整个段收掉
    const bare = withMetaAudioTags(createAssetMeta("audio"), [0], TAG_TABLE);
    expect(withMetaAudioTags(bare, [], TAG_TABLE).audio).toBeUndefined();

    // 重复的 ID 归一化后还是同一个集合：不算变更（返回原对象）
    expect(withMetaAudioTags(both, [0, 0], TAG_TABLE)).toBe(both);
    expect(withMetaAudioTags(bare, [0], TAG_TABLE)).toBe(bare);
    // 本来就空：清空也是同一份
    const blank = createAssetMeta("audio");
    expect(withMetaAudioTags(blank, [], TAG_TABLE)).toBe(blank);
    // 传进去的全是脏值、归一化后还是空：同样是同一份
    expect(withMetaAudioTags(blank, [7, 2], TAG_TABLE)).toBe(blank);
  });

  it("写 audio 段不弄丢已有的 sprite 段——反过来也一样（withoutKey 那条实现的关键）", () => {
    // 一份 meta 里可以同时有两个段（手写文件、或以后同一个文件有多个导入器）
    const both = withMetaAudioTags(
      withMetaSpriteSheet(createAssetMeta("texture"), sheetOf(4, 4)),
      [0],
      TAG_TABLE,
    );
    expect(both.sprite).toEqual({ sheet: sheetOf(4, 4) });
    expect(both.audio).toEqual({ tags: [0] });

    // 改音频：图片那一段必须完好（段是「按剩余的键重建」，不是「挑出认识的键重建」）
    const renamed = withMetaAudioName(both, "开场曲");
    expect(renamed.sprite).toEqual({ sheet: sheetOf(4, 4) });
    expect(renamed.audio).toEqual({ name: "开场曲", tags: [0] });

    // 摘掉音频（标签清空 + 名字清空）：sprite 仍然在
    const noAudio = withMetaAudioName(withMetaAudioTags(renamed, [], TAG_TABLE), "");
    expect(noAudio.audio).toBeUndefined();
    expect(noAudio.sprite).toEqual({ sheet: sheetOf(4, 4) });

    // 反方向：改图片时音频那一段也必须完好
    const sliced = withMetaSpriteSheet(both, sheetOf(2, 2));
    expect(sliced.audio).toEqual({ tags: [0] });
    expect(sliced.sprite).toEqual({ sheet: sheetOf(2, 2) });

    // 把 sprite 整个摘掉（Default）：audio 一个字节都不动
    const plain = withMetaSpriteSettings(sliced, { type: "Default" });
    expect(plain.sprite).toBeUndefined();
    expect(plain.audio).toEqual({ tags: [0] });
    expect(Object.keys(plain).sort()).toEqual(["audio", "formatVersion", "guid", "importer"]);
  });
});

describe("纯函数写入：从一个文件上摘掉一个标签（删标签的后半截）", () => {
  it("只摘这一个文件的这个 ID：别的标签、别的字段都留着", () => {
    const meta = withMetaAudioName(
      withMetaAudioTags(createAssetMeta("audio"), [0, 1, 3], ["战斗", "紧张", "环境", "追击"]),
      "开场曲",
    );

    const removed = withoutMetaAudioTag(meta, 1);
    expect(removed.audio).toEqual({ name: "开场曲", tags: [0, 3] });
    // 同一个 ID 在**已经摘掉它的那一份**上再摘一次：这个文件上已经没有它了，什么都没发生
    // —— 必须是**同一份引用**（与 `withMetaAudioName` / `withMetaAudioTags` / 图片那两条
    // 共用一条口径：纯函数靠引用相等告诉调用方「这次编辑什么都不用记、不用回写」）
    expect(withoutMetaAudioTag(removed, 1)).toBe(removed);
    // 从来就没挂过这个 ID：同理
    expect(withoutMetaAudioTag(meta, 2)).toBe(meta);
  });

  it("摘空 = 连 tags 一起摘掉；本来就没挂着 / 没有 audio 段 = 同一份引用", () => {
    const only = withMetaAudioTags(createAssetMeta("audio"), [0], TAG_TABLE);
    const emptied = withoutMetaAudioTag(only, 0);
    expect(emptied.audio).toBeUndefined();

    // 这个 ID 本来就不在这个文件上（别的文件挂的）：什么都没发生
    expect(withoutMetaAudioTag(only, 1)).toBe(only);
    // 本来就没有 audio 段
    const blank = createAssetMeta("audio");
    expect(withoutMetaAudioTag(blank, 0)).toBe(blank);
  });
});

describe("索引：guid 与路径两个方向", () => {
  it("空索引：两个方向都查不到", () => {
    const metas = emptyAssetMetas();
    expect(metas.byGuid).toEqual({});
    expect(metas.byId).toEqual({});
    expect(metaOfImage(metas, { id: IMAGE_ID, guid: GUID })).toBeUndefined();
    expect(metaOfImage(metas, undefined)).toBeUndefined();
  });

  it("两个方向指向同一份 meta；按引用查是 guid 优先、路径兜底", () => {
    const meta = withMetaSpriteSheet(
      withMetaSpriteSettings(createAssetMeta("texture"), { type: "Sprite", mode: "Multiple" }),
      sheetOf(2, 2),
    );
    const metas = createAssetMetas([{ id: IMAGE_ID, meta }]);

    expect(metas.byId[IMAGE_ID]).toBe(meta);
    expect(metas.byGuid[meta.guid]).toBe(meta);

    // 素材与它的 meta 成对改名：索引里的**路径**变了，身份没变
    const renamed = createAssetMetas([{ id: "project:P/Assets/images/A/B/C/moved.png", meta }]);
    expect(metaOfImage(renamed, { id: IMAGE_ID, guid: meta.guid })).toBe(meta);
    expect(metaOfImage(renamed, { id: "project:P/Assets/images/A/B/C/moved.png" })).toBe(meta);
    // 只有过期路径（老引用、索引里也没有）= 查不到：按普通图片处理
    expect(metaOfImage(renamed, { id: IMAGE_ID })).toBeUndefined();
  });

  it("音频 meta 也在同一张索引里（音频引用写的是路径，所以路径那一向必须准）", () => {
    const meta = withMetaAudioTags(createAssetMeta("audio"), [0], TAG_TABLE);
    const metas = createAssetMetas([{ id: AUDIO_ID, meta }]);

    expect(metas.byId[AUDIO_ID]).toBe(meta);
    expect(metas.byGuid[meta.guid]).toBe(meta);
  });
});

describe("推送载荷：形状与 v22 及更早只差 v14 的 sortingOrder", () => {
  it("只多 spriteGrid、只少 guid（路径换算由 sprites.ts 负责）", () => {
    const scene: SceneDoc = {
      ...createEmptyScene("Map001"),
      objects: [createGameObject({ id: "sprite-1", name: "精灵" })],
    };
    repairImageObjectComponent(scene, "sprite-1", {
      id: IMAGE_ID,
      guid: GUID,
      width: 64,
      height: 64,
      sprite: { column: 1, row: 0 },
    });

    const meta = withMetaSpriteSheet(
      { formatVersion: ASSET_META_FORMAT_VERSION, guid: GUID, importer: "texture" },
      sheetOf(4, 2),
    );
    const payload = resolveSceneSprites(scene, createAssetMetas([{ id: IMAGE_ID, meta }]));
    const data = payload.objects[0]!.components[0]!.data as Record<string, unknown>;

    // v14 起图片层数据多一项 `sortingOrder`（渲染属性），推送时原样带上
    expect(Object.keys(data).sort()).toEqual([
      "height",
      "id",
      "sortingOrder",
      "sprite",
      "spriteGrid",
      "width",
    ]);
    expect(data.spriteGrid).toEqual(sheetOf(4, 2));
    expect(data).not.toHaveProperty("guid");
  });
});

describe("v22 → v23 迁移：两份老表合并成各自的 meta", () => {
  it("按同一个路径 ID 合并：切分与导入设置各归各位，工程文件里那两项消失", () => {
    const loaded = parseProjectFile(
      legacyProject({
        spriteSheets: { [IMAGE_ID]: sheetOf(4, 4) },
        spriteSettings: { [IMAGE_ID]: { type: "Sprite", mode: "Multiple" } },
      }),
    );

    const meta = metaOfId(loaded.migratedMetas, IMAGE_ID);
    expect(meta.sprite).toEqual({ mode: "Multiple", sheet: sheetOf(4, 4) });
    expect(meta.guid).toMatch(/^[0-9a-f]{32}$/);
    expect(meta.importer).toBe("texture");
    expect(meta.formatVersion).toBe(ASSET_META_FORMAT_VERSION);

    // 工程文件里不再有这两项（搬走了，不是复制一份留着）
    expect("spriteSheets" in loaded.doc).toBe(false);
    expect("spriteSettings" in loaded.doc).toBe(false);
    expect(loaded.doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(loaded.needsRewrite).toBe(true);
  });

  it("只有切分表：sprite 里就只有 sheet（导入设置没写 = 老渲染只看切分）", () => {
    const loaded = parseProjectFile(legacyProject({ spriteSheets: { [IMAGE_ID]: sheetOf(2, 1) } }));
    expect(metaOfId(loaded.migratedMetas, IMAGE_ID).sprite).toEqual({ sheet: sheetOf(2, 1) });
  });

  it("只有导入设置：Single / Multiple / Default 三种都搬对，不凭空造切分", () => {
    const loaded = parseProjectFile(
      legacyProject({
        spriteSettings: {
          [IMAGE_ID]: { type: "Sprite", mode: "Single" },
          [OTHER_ID]: { type: "Sprite", mode: "Multiple" },
          "project:P/Assets/images/plain.png": { type: "Default" },
        },
      }),
    );

    expect(metaOfId(loaded.migratedMetas, IMAGE_ID).sprite).toEqual({ mode: "Single" });
    expect(metaOfId(loaded.migratedMetas, OTHER_ID).sprite).toEqual({ mode: "Multiple" });
    // Default = 普通图片：整个 sprite 不写（`{ type: "Default" }` 那种空壳不再进文件）
    const plain = metaOfId(loaded.migratedMetas, "project:P/Assets/images/plain.png");
    expect(plain.sprite).toBeUndefined();
    expect(new Set(loaded.migratedMetas.map((entry) => entry.meta.guid)).size).toBe(3);
  });

  it("有切分但导入设置说 Default：以设置为准（sheet 也丢掉，与渲染口径一致）", () => {
    const loaded = parseProjectFile(
      legacyProject({
        spriteSheets: { [IMAGE_ID]: sheetOf(4, 4) },
        spriteSettings: { [IMAGE_ID]: { type: "Default" } },
      }),
    );

    expect(metaOfId(loaded.migratedMetas, IMAGE_ID).sprite).toBeUndefined();
  });

  it("Single 与 1×1 的老切分都不搬（整图，不留多余的表项）", () => {
    const loaded = parseProjectFile(
      legacyProject({
        spriteSheets: { [IMAGE_ID]: sheetOf(1, 1) },
        spriteSettings: {
          [OTHER_ID]: { type: "Sprite", mode: "Single" },
        },
      }),
    );

    expect(metaOfId(loaded.migratedMetas, IMAGE_ID).sprite).toBeUndefined();
    expect(metaOfId(loaded.migratedMetas, OTHER_ID).sprite).toEqual({ mode: "Single" });
  });

  it("找不到素材的孤儿键照样给出一份 meta（不猜、不报错，由调用方按资源树过滤）", () => {
    const loaded = parseProjectFile(
      legacyProject({
        spriteSheets: { [MISSING_ID]: sheetOf(8, 8) },
        spriteSettings: { [MISSING_ID]: { type: "Sprite", mode: "Multiple" } },
      }),
    );

    // 文档层没有资源树：它只按路径 ID 合并，孤儿由调用方自己认
    expect(loaded.migratedMetas.map((entry) => entry.id)).toEqual([MISSING_ID]);
    expect(metaOfId(loaded.migratedMetas, MISSING_ID).sprite?.sheet).toEqual(sheetOf(8, 8));
  });

  it("空路径 ID 的键跳过（那不是素材）；空表不算搬走内容", () => {
    const loaded = parseProjectFile(
      legacyProject({ spriteSheets: { " ": sheetOf(2, 2) }, spriteSettings: {} }),
    );
    expect(loaded.migratedMetas).toEqual([]);
    // 字段确实存在过：要回写一次把版本与两项一起收拾干净
    expect(loaded.needsRewrite).toBe(true);
  });

  it("当前版本的工程文件：没有这两项时 migratedMetas 是空的、也不用回写", () => {
    const loaded = parseProjectFile(JSON.parse(JSON.stringify(createEmptyProject("P"))) as unknown);
    expect(loaded.migratedMetas).toEqual([]);
    expect(loaded.needsRewrite).toBe(false);
  });
});

describe("v23 → v24 迁移：audioMeta 搬进各自音频文件的 meta", () => {
  it("按路径搬出显示名 + 标签 ID，工程文件里不再有 audioMeta", () => {
    const load = parseProjectFile(
      v23Project({
        audioMeta: { [AUDIO_ID]: { name: "开场曲", tags: [1, 0] } },
        audioTags: ["战斗", "紧张"],
      }),
    );

    const meta = metaOfId(load.migratedMetas, AUDIO_ID);
    expect(meta.importer).toBe("audio");
    expect(meta.formatVersion).toBe(ASSET_META_FORMAT_VERSION);
    expect(meta.guid).toMatch(/^[0-9a-f]{32}$/);
    // 标签归一化过：升序（ID 是身份不是顺序）
    expect(meta.audio).toEqual({ name: "开场曲", tags: [0, 1] });

    // 工程文件里那一项整个消失（搬走了，不是复制一份留着）
    expect("audioMeta" in load.doc).toBe(false);
    // 标签表**留在工程文件里**：它是项目级数据，不是某一个文件的属性
    expect(load.doc.audioTags).toEqual(["战斗", "紧张"]);
    expect(load.doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(load.needsRewrite).toBe(true);
  });

  it("标签 ID 要过表：越界 / 指向已删的洞 / 重复的丢掉，别人的 ID 不位移", () => {
    const load = parseProjectFile(
      v23Project({
        audioTags: TAG_TABLE, // 战斗=0、紧张=1、#2 是洞
        audioMeta: {
          [AUDIO_ID]: { tags: [1, 1, 2, 9] },
          [AUDIO_OTHER_ID]: { name: "战歌", tags: [0] },
        },
      }),
    );

    // #2 是洞、#9 越界、重复的 #1 只算一次 ⇒ [1]
    expect(audioOf(load.migratedMetas, AUDIO_ID)).toEqual({ tags: [1] });
    // 表里 #0 还在：别的文件的标签照旧
    expect(audioOf(load.migratedMetas, AUDIO_OTHER_ID)).toEqual({ name: "战歌", tags: [0] });
  });

  it("空壳不为它造 meta：{} / 只有空白名字 / 标签全越界", () => {
    const load = parseProjectFile(
      v23Project({
        audioTags: ["战斗"],
        audioMeta: {
          "project:P/Assets/audio/empty.mp3": {},
          "project:P/Assets/audio/blank-name.mp3": { name: "   " },
          "project:P/Assets/audio/all-out-of-range.mp3": { name: "  ", tags: [9, -1] },
          "project:P/Assets/audio/no-name.mp3": { tags: [0] },
          // 空路径 ID 的键跳过（那不是素材），与图片那条同一条规矩
          " ": { name: "没有归属" },
        },
      }),
    );

    // 只有真正搬出了东西的那一条留下一份 meta
    expect(load.migratedMetas.map((entry) => entry.id)).toEqual([
      "project:P/Assets/audio/no-name.mp3",
    ]);
    expect(audioOf(load.migratedMetas, "project:P/Assets/audio/no-name.mp3")).toEqual({ tags: [0] });
    // 搬走这件事本身要回写（版本 + 去掉 audioMeta）
    expect(load.needsRewrite).toBe(true);
    expect("audioMeta" in load.doc).toBe(false);
  });

  it("名字搬走之后 trim 过：两头的空白不进 meta", () => {
    const load = parseProjectFile(v23Project({ audioMeta: { [AUDIO_ID]: { name: "  开场曲  " } } }));

    expect(audioOf(load.migratedMetas, AUDIO_ID)).toEqual({ name: "开场曲" });
  });

  it("找不到素材的孤儿键照样给出一份 meta（文档层没有资源树）", () => {
    const load = parseProjectFile(v23Project({ audioMeta: { [MISSING_ID]: { name: "已经改名了" } } }));

    expect(load.migratedMetas.map((entry) => entry.id)).toEqual([MISSING_ID]);
    expect(metaOfId(load.migratedMetas, MISSING_ID).importer).toBe("audio");
  });

  it("图片与音频两条迁移的 meta 合在一起交给调用方（各按各的路径键）", () => {
    const load = parseProjectFile(
      legacyProject({
        spriteSheets: { [IMAGE_ID]: sheetOf(2, 2) },
        audioMeta: { [AUDIO_ID]: { name: "开场曲" } },
      }),
    );

    expect(load.migratedMetas.map((entry) => entry.id).sort()).toEqual([AUDIO_ID, IMAGE_ID].sort());
    expect(metaOfId(load.migratedMetas, IMAGE_ID).importer).toBe("texture");
    expect(metaOfId(load.migratedMetas, AUDIO_ID).importer).toBe("audio");
    expect(metaOfId(load.migratedMetas, IMAGE_ID).sprite?.sheet).toEqual(sheetOf(2, 2));
    expect(audioOf(load.migratedMetas, AUDIO_ID)).toEqual({ name: "开场曲" });
  });

  it("v18 的工程文件（audioMeta 已经是整数 ID）：照样搬到 meta，也要回写", () => {
    const load = parseProjectFile({
      ...createEmptyProject("P"),
      formatVersion: 18,
      audioMeta: { [AUDIO_ID]: { name: "开场曲", tags: [0] } },
      audioTags: ["战斗"],
    });

    expect(load.needsRewrite).toBe(true);
    expect(load.doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect("audioMeta" in load.doc).toBe(false);
    expect(load.doc.audioTags).toEqual(["战斗"]);
    expect(audioOf(load.migratedMetas, AUDIO_ID)).toEqual({ name: "开场曲", tags: [0] });
  });

  it("v17 的字符串标签：先建成表、再一路搬进 meta（v24）", () => {
    const legacy = {
      formatVersion: 17,
      name: "P",
      items: { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] },
      settings: { audio: { bgm: { volume: 0.6 }, sfx: { volume: 0.8 }, voice: { volume: 1 } } },
      audioMeta: {
        [AUDIO_ID]: { name: "开场曲", tags: ["战斗", "紧张", "战斗", "  "] },
        [AUDIO_OTHER_ID]: { tags: ["紧张", "环境"] },
      },
    };

    const load = parseProjectFile(legacy);

    // 出现的先后就是 ID：战斗=0、紧张=1、环境=2；空白与重复被归一化掉
    expect(load.doc.audioTags).toEqual(["战斗", "紧张", "环境"]);
    expect(load.doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(load.needsRewrite).toBe(true);
    expect("audioMeta" in load.doc).toBe(false);
    expect(audioOf(load.migratedMetas, AUDIO_ID)).toEqual({ name: "开场曲", tags: [0, 1] });
    expect(audioOf(load.migratedMetas, AUDIO_OTHER_ID)).toEqual({ tags: [1, 2] });
    expect(load.migratedMetas.every((entry) => entry.meta.importer === "audio")).toBe(true);
  });
});

describe("素材 meta 的校验：标签引用站不站得住（只报 warning）", () => {
  /** 一份带音频段的 meta（按需要塞进脏的 ID / 空名字）。 */
  function audioMeta(guid: string, audio: AssetMetaDoc["audio"]): AssetMetaDoc {
    return { formatVersion: ASSET_META_FORMAT_VERSION, guid, importer: "audio", audio };
  }

  it("越界 / 指向洞 / 重复 / 空列表 / 空名字各报一条 warning", () => {
    const issues = validateAssetMetas(
      [
        { id: AUDIO_ID, meta: audioMeta(GUID, { tags: [0, 0, 2, 9] }) },
        { id: AUDIO_OTHER_ID, meta: audioMeta("2f".repeat(16), { tags: [] }) },
        { id: "project:P/Assets/audio/blank.mp3", meta: audioMeta("3f".repeat(16), { name: "  " }) },
      ],
      TAG_TABLE,
    );

    // 路径以**素材的路径 ID** 开头（原来那条 `audioMeta/...` 已经没有了）
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain(`${AUDIO_ID}/audio/tags/1`);
    expect(paths).toContain(`${AUDIO_ID}/audio/tags/2`);
    expect(paths).toContain(`${AUDIO_ID}/audio/tags/3`);
    expect(paths).toContain(`${AUDIO_OTHER_ID}/audio/tags`);
    expect(paths).toContain("project:P/Assets/audio/blank.mp3/audio/name");

    // 一条都不拦运行：数据对不上，作者在「标签」窗口里改一下就好
    expect(issues.every((issue) => issue.level === "warning")).toBe(true);
    // 越界 / 洞 / 重复各说各的（同一条 ID 的几次出现不是同一条消息）
    expect(new Set(issues.map((issue) => issue.message)).size).toBe(5);
  });

  it("没写标签的文件不报任何问题；没有表时越界 ID 报「不在表里」", () => {
    expect(
      validateAssetMetas([{ id: AUDIO_ID, meta: createAssetMeta("audio") }], TAG_TABLE),
    ).toEqual([]);
    // 还没整理过的音频（有名字、没标签）同样是干净的
    expect(
      validateAssetMetas(
        [{ id: AUDIO_ID, meta: withMetaAudioName(createAssetMeta("audio"), "开场曲") }],
        TAG_TABLE,
      ),
    ).toEqual([]);

    // 项目里根本没有标签表，文件上却挂着 ID
    const noTable = validateAssetMetas(
      [{ id: AUDIO_ID, meta: audioMeta(GUID, { tags: [0] }) }],
      undefined,
    );
    expect(noTable.map((issue) => issue.path)).toEqual([`${AUDIO_ID}/audio/tags/0`]);
    expect(noTable[0]?.message).toMatch(/不在标签表里/);
  });

  it("手写文件里指向已删标签：说得出「已经删掉了」，与越界分开", () => {
    const issues = validateAssetMetas([{ id: AUDIO_ID, meta: audioMeta(GUID, { tags: [2] }) }], TAG_TABLE);
    expect(issues.map((issue) => issue.path)).toEqual([`${AUDIO_ID}/audio/tags/0`]);
    // 「洞」与「越界」是两种毛病：洞说明标签被删过，越界说明 ID 根本不在表里
    expect(issues[0]?.message).toMatch(/已经被删掉/);
  });

  it("guid 重复 / 悬空引用不在这里查（已知缺口：那要看整份 meta 表）", () => {
    // 两份 meta 写着同一把 guid：索引那边「先到的赢」，校验这边**故意**不报——
    // 当前签名只看得到单项，看不出重复；README 的已知缺口写着这一条
    const issues = validateAssetMetas(
      [
        { id: AUDIO_ID, meta: audioMeta(GUID, { tags: [0] }) },
        { id: AUDIO_OTHER_ID, meta: audioMeta(GUID, { tags: [0] }) },
      ],
      TAG_TABLE,
    );
    expect(issues).toEqual([]);
  });
});
