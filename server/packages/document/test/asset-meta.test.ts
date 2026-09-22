import { describe, expect, it } from "vitest";
import {
  ASSET_META_FORMAT_VERSION,
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
  withMetaSpriteSettings,
  withMetaSpriteSheet,
  type AssetMetaDoc,
} from "../src/asset-meta";
import { setObjectImage, createSceneObject } from "../src/commands";
import { createEmptyProject, createEmptyScene } from "../src/factory";
import { parseProjectFile } from "../src/schema";
import { resolveSceneSprites } from "../src/sprites";
import { DOCUMENT_FORMAT_VERSION, type SceneDoc, type SpriteSheetDoc } from "../src/types";

/**
 * **素材的元数据**（`<素材>.meta`，v23 起）：稳定 GUID + 导入设置 + 切分。
 *
 * 这一份盯住四件事：
 * 1. **形状与容错**：写出去读回来是同一份；缺 `guid` 补一个并要回写；坏数据读不开；
 * 2. **写入口径**：`Default` 不留空壳、`1×1` 不写 `sheet`——旧工程文件里堆积的那两种噪声；
 * 3. **索引**：guid 与路径两个方向指向同一份，改名之后按 guid 照样查得到；
 * 4. **v22 → v23 迁移**：两份老表按路径 ID 合并成 meta，工程文件里那两项消失。
 */

const IMAGE_ID = "project:P/Assets/images/hero.png";
const OTHER_ID = "project:P/Assets/images/tiles.png";
const MISSING_ID = "project:P/Assets/images/已经改名了.png";
const GUID = "1f".repeat(16);

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

/** 迁移结果里按路径 ID 取那一份（找不到就抛，省得断言里到处写 `!.`）。 */
function metaOfId(
  metas: ReadonlyArray<{ readonly id: string; readonly meta: AssetMetaDoc }>,
  id: string,
): AssetMetaDoc {
  const found = metas.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`迁移结果里没有 ${id}`);
  }

  return found.meta;
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

  it("缺 guid 就补一个，并要调用方回写一次", () => {
    const missing = parseAssetMetaFile({ formatVersion: 1, importer: "texture" });
    expect(missing.doc.guid).toMatch(/^[0-9a-f]{32}$/);
    expect(missing.needsRewrite).toBe(true);

    // 空字符串也是「缺」：手写文件里常见
    const blank = parseAssetMetaFile({ formatVersion: 1, guid: "", importer: "texture" });
    expect(blank.doc.guid).toMatch(/^[0-9a-f]{32}$/);
    expect(blank.needsRewrite).toBe(true);
  });

  it("坏数据抛出「素材 meta 校验失败: …」，且带得上字段路径", () => {
    const bad: readonly unknown[] = [
      "不是对象",
      { guid: GUID, importer: "texture" }, // 缺 formatVersion
      { formatVersion: 1, guid: "A".repeat(32), importer: "texture" }, // 大写不是这一种写法
      { formatVersion: 1, guid: "abc", importer: "texture" },
      { formatVersion: 1, guid: GUID, importer: "audio" }, // 本次只有图片这一档
      { formatVersion: 1, guid: GUID, importer: "texture", sprite: { mode: "Many" } },
      { formatVersion: 1, guid: GUID, importer: "texture", sprite: { sheet: sheetOf(0, 1) } },
      { formatVersion: 1, guid: GUID, importer: "texture", sprite: { sheet: sheetOf(65, 1) } },
    ];

    for (const raw of bad) {
      expect(() => parseAssetMetaFile(raw)).toThrow(/素材 meta 校验失败/);
    }

    expect(() =>
      parseAssetMetaFile({ formatVersion: 1, guid: GUID, importer: "texture", sprite: { sheet: sheetOf(0, 1) } }),
    ).toThrow(/sprite\.sheet\.columns/);
  });

  it("高版本明确拒绝（读不懂的字段不能静默丢掉再回存）", () => {
    expect(() =>
      parseAssetMetaFile({ formatVersion: 2, guid: GUID, importer: "texture" }),
    ).toThrow(/高于本编辑器支持/);
  });

  it("新 meta：新 guid + 图片导入器；Default 不会写出 sprite 空壳", () => {
    const created = createAssetMeta();
    expect(created.formatVersion).toBe(ASSET_META_FORMAT_VERSION);
    expect(created.importer).toBe("texture");
    expect(created.guid).toMatch(/^[0-9a-f]{32}$/);
    expect(isSpriteMeta(created)).toBe(false);

    expect(serializeAssetMetaFile(created)).not.toMatch(/sprite/);
    // 生成一次永不变：两把 guid 不该撞（撞了就是两个素材共用一份 meta）
    expect(newAssetGuid()).not.toBe(newAssetGuid());
  });

  it("重复 guid 的索引：先到的赢（复制文件时把 meta 一起抄了的那种）", () => {
    const first = createAssetMeta();
    const second = { ...createAssetMeta(), guid: first.guid };
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
    for (const meta of [undefined, createAssetMeta()]) {
      expect(isSpriteMeta(meta)).toBe(false);
      expect(spriteSettingsOfMeta(meta)).toEqual({ type: "Default" });
      expect(spriteSheetOfMeta(meta)).toEqual(sheetOf(1, 1));
    }
  });

  it("有 sprite：导入设置是 Sprite（mode 缺省 Single）；切分按 sheet 收干净", () => {
    const single: AssetMetaDoc = { ...createAssetMeta(), sprite: { mode: "Single" } };
    expect(isSpriteMeta(single)).toBe(true);
    expect(spriteSettingsOfMeta(single)).toEqual({ type: "Sprite", mode: "Single" });

    // mode 不写 = Single（缺省），切分照旧按 sheet 用
    const bare: AssetMetaDoc = { ...createAssetMeta(), sprite: { sheet: sheetOf(4, 4) } };
    expect(spriteSettingsOfMeta(bare)).toEqual({ type: "Sprite", mode: "Single" });
    expect(spriteSheetOfMeta(bare)).toEqual(sheetOf(4, 4));

    // 坏数字收干净：取整 + 夹到 1..64
    const wild: AssetMetaDoc = { ...createAssetMeta(), sprite: { sheet: { columns: 999, rows: 0 } } };
    expect(spriteSheetOfMeta(wild)).toEqual(sheetOf(64, 1));
  });
});

describe("纯函数写入（旧 setSpriteSheet / setSpriteImportSettings 的口径）", () => {
  it("写切分 / 改回来：1×1 与 null 都摘掉 sheet，值没变返回同一份", () => {
    const blank = createAssetMeta();

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
    const multiple = withMetaSpriteSettings(createAssetMeta(), { type: "Sprite", mode: "Multiple" });
    expect(multiple.sprite).toEqual({ mode: "Multiple" });

    const withSheet = withMetaSpriteSheet(multiple, sheetOf(2, 2));
    expect(withSheet.sprite).toEqual({ mode: "Multiple", sheet: sheetOf(2, 2) });

    // 恢复整图：mode 留着（Multiple 仍然是导入设置），sheet 摘掉
    const cleared = withMetaSpriteSheet(withSheet, null);
    expect(cleared.sprite).toEqual({ mode: "Multiple" });
  });

  it("Default / null 摘掉整个 sprite；Single 顺手清掉旧切分", () => {
    const multiple = withMetaSpriteSheet(
      withMetaSpriteSettings(createAssetMeta(), { type: "Sprite", mode: "Multiple" }),
      sheetOf(2, 2),
    );

    // Single 不用网格切分：留着会让「面板说整图、渲染按切分画」两份口径分叉
    const single = withMetaSpriteSettings(multiple, { type: "Sprite", mode: "Single" });
    expect(single.sprite).toEqual({ mode: "Single" });

    // 缺省 mode = Single
    expect(withMetaSpriteSettings(createAssetMeta(), { type: "Sprite" }).sprite).toEqual({
      mode: "Single",
    });

    const cleared = withMetaSpriteSettings(multiple, null);
    expect(cleared.sprite).toBeUndefined();
    expect(withMetaSpriteSettings(multiple, { type: "Default" }).sprite).toBeUndefined();

    // 值没变（含「本来就是 Default」）返回同一份
    expect(withMetaSpriteSettings(single, { type: "Sprite", mode: "Single" })).toBe(single);
    const blank = createAssetMeta();
    expect(withMetaSpriteSettings(blank, null)).toBe(blank);
    expect(withMetaSpriteSettings(blank, { type: "Default" })).toBe(blank);

    // 摘掉 sprite 时只删键，不留 `sprite: undefined`（JSON 里一个字节都不多）
    expect(serializeAssetMetaFile(cleared)).not.toMatch(/sprite/);
    expect(Object.keys(cleared).sort()).toEqual(["formatVersion", "guid", "importer"]);
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
      withMetaSpriteSettings(createAssetMeta(), { type: "Sprite", mode: "Multiple" }),
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
});

describe("推送载荷：形状与 v22 及更早一模一样", () => {
  it("只多 spriteGrid、只少 guid（路径换算由 sprites.ts 负责）", () => {
    const scene: SceneDoc = {
      ...createEmptyScene("Map001"),
      objects: [createSceneObject({ id: "sprite-1", name: "精灵" })],
    };
    setObjectImage(scene, "sprite-1", {
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

    expect(Object.keys(data).sort()).toEqual(["height", "id", "sprite", "spriteGrid", "width"]);
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
