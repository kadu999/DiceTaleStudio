import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import {
  createAssetMeta,
  withMetaAudioName,
  withMetaAudioTags,
  withoutMetaAudioTag,
  type AssetMetaDoc,
} from "../src/asset-meta";
import {
  addAudioTag,
  deleteAudioTag,
  renameAudioTag,
  setAudioTagName,
} from "../src/commands";
import { createEmptyProject } from "../src/factory";
import { parseProjectFile } from "../src/schema";
import { validateProject } from "../src/validation";
import { DOCUMENT_FORMAT_VERSION, type AudioTagTableDoc, type ProjectDoc } from "../src/types";

/**
 * **音频标注 + 标签表**（v17 起；v24 起标注住在各素材的 `.meta` 里）。
 *
 * 标签学 Unity：**tag 是个整数**（就是 `audioTags` 的下标），名字只是它的显示文本；
 * 音频文件那一份 meta 里只记 ID（`[0, 2]`）。于是数据分成两条轨道，这一份盯住它们各自的口径：
 * - **项目轨**（工程文件里的 `audioTags`，`commands/project.ts`）：新建 / 改名 / 按序号命名 / 删除；
 *   **删除只留一个洞**（下标不位移），**不再去摘各个文件上的引用**——引用住在素材 meta 里，
 *   由 `withoutMetaAudioTag` 一个一个文件地摘（v24 起，见 `asset-meta.test.ts`）；
 * - **素材轨**（音频自己的 `.meta` 的 `audio` 段，`asset-meta.ts` 的纯函数）：
 *   显示名 trim、空串摘掉；标签按表归一化（去重 + 升序，越界 / 指向洞的丢掉）；
 *   **不留空壳**：两项都空 → 摘掉整个 `audio` 段；
 * - **迁移**：v17 的字符串标签由 `migrateAudioTags` 按出现顺序建成表并换成 ID，
 *   v24 起紧接着把整条 `audioMeta` 搬进各自 meta（`migratedMetas`），工程文件里不再有它。
 *
 * 命令层（`addAudioTag` 等）拿 `Draft<ProjectDoc>`、靠返回值判断「要不要进撤销栈」；
 * 纯函数拿一份 meta、**值没变就返回同一个引用**——两者是同一条「不留无谓变更」的口径。
 */

const CLIP_A = "project:C/Assets/audio/theme.mp3";
const CLIP_B = "project:C/Assets/audio/battle.wav";

/** 标签表（下标 = tag ID）：`战斗=0`、`紧张=1`，`#2` 是删过的洞。 */
const TAG_TABLE: AudioTagTableDoc = ["战斗", "紧张", null];

/** 起一个「战斗 = 0、紧张 = 1」的表，并给出一份挂着这两个标签的音频 meta。 */
function taggedProject(): ProjectDoc {
  return produce(createEmptyProject("测试项目"), (draft) => {
    addAudioTag(draft, "战斗");
    addAudioTag(draft, "紧张");
  });
}

/** 一份挂着 `[0, 1]` 的音频 meta（与 `taggedProject` 的表配套）。 */
function taggedMeta(): AssetMetaDoc {
  return withMetaAudioTags(createAssetMeta("audio"), [0, 1], TAG_TABLE);
}

function projectWith(recipe: (draft: Draft<ProjectDoc>) => void): ProjectDoc {
  return produce(createEmptyProject("测试项目"), recipe);
}

describe("素材轨：显示名（旧 setAudioMetaName 的口径）", () => {
  it("起名 / 改名：去首尾空白，写进 meta 的 audio.name", () => {
    const named = withMetaAudioName(createAssetMeta("audio"), "  开场曲  ");
    expect(named.audio).toEqual({ name: "开场曲" });
  });

  it("留空 = 退回素材文件名：摘掉 name，没有标签时整个 audio 段一起摘掉", () => {
    const named = withMetaAudioName(createAssetMeta("audio"), "开场曲");
    expect(withMetaAudioName(named, "   ").audio).toBeUndefined();

    // 标签是另一项：摘名字不碰它
    const both = withMetaAudioTags(named, [0, 1], TAG_TABLE);
    expect(withMetaAudioName(both, "").audio).toEqual({ tags: [0, 1] });
  });

  it("值没变返回**同一个引用**（调用方靠它判断这次编辑什么都不用记）", () => {
    const named = withMetaAudioName(createAssetMeta("audio"), "开场曲");

    expect(withMetaAudioName(named, "开场曲")).toBe(named);
    expect(withMetaAudioName(named, " 开场曲 ")).toBe(named);

    // 本来就没名字：再留空（或留白）也是同一份
    const blank = createAssetMeta("audio");
    expect(withMetaAudioName(blank, "")).toBe(blank);
    expect(withMetaAudioName(blank, "   ")).toBe(blank);
  });
});

describe("素材轨：文件上的标签（ID 列表，旧 setAudioMetaTags 的口径）", () => {
  it("规范化：去重、升序，越界与指向洞的 ID 丢掉", () => {
    // 表是 战斗 / 紧张 / 洞：#2 指向已删的标签、#9 越界、重复的 #1 只算一次
    const written = withMetaAudioTags(createAssetMeta("audio"), [1, 0, 1, 2, 9, -1, 0], TAG_TABLE);
    expect(written.audio).toEqual({ tags: [0, 1] });

    // 表给空（项目里还没有标签）：什么 ID 都留不下
    expect(withMetaAudioTags(createAssetMeta("audio"), [0, 1], []).audio).toBeUndefined();
  });

  it("清空 = 摘掉 tags 字段（没名字时整个 audio 段一起摘掉）；值没变返回同一引用", () => {
    const both = withMetaAudioTags(withMetaAudioName(createAssetMeta("audio"), "开场曲"), [0], TAG_TABLE);

    const cleared = withMetaAudioTags(both, [], TAG_TABLE);
    expect(cleared.audio).toEqual({ name: "开场曲" });
    expect("tags" in (cleared.audio ?? {})).toBe(false);

    // 清空且没名字：整个段收掉（不留空壳）
    const bare = withMetaAudioTags(createAssetMeta("audio"), [0], TAG_TABLE);
    expect(withMetaAudioTags(bare, [], TAG_TABLE).audio).toBeUndefined();

    // 顺序不同但归一化后一样：不算变更（返回原对象）
    expect(withMetaAudioTags(both, [0, 0], TAG_TABLE)).toBe(both);

    // 本来就空：清空 / 全是脏值，都是同一份
    const blank = createAssetMeta("audio");
    expect(withMetaAudioTags(blank, [], TAG_TABLE)).toBe(blank);
    expect(withMetaAudioTags(blank, [2, 9], TAG_TABLE)).toBe(blank);
  });

  it("名字与标签互不覆盖（两项在同一份 meta 的同一个 audio 段里）", () => {
    const both = withMetaAudioTags(withMetaAudioName(createAssetMeta("audio"), "开场曲"), [0], TAG_TABLE);
    expect(both.audio).toEqual({ name: "开场曲", tags: [0] });

    // 改名字不动标签、改标签不动名字
    expect(withMetaAudioName(both, "新名字").audio).toEqual({ name: "新名字", tags: [0] });
    expect(withMetaAudioTags(both, [0, 1], TAG_TABLE).audio).toEqual({
      name: "开场曲",
      tags: [0, 1],
    });
  });

  it("从一个文件上摘掉一个标签：`withoutMetaAudioTag`（删标签的后半截）", () => {
    const meta = withMetaAudioTags(createAssetMeta("audio"), [0, 1], TAG_TABLE);

    const removed = withoutMetaAudioTag(meta, 0);
    expect(removed.audio).toEqual({ tags: [1] });

    // 摘空：连 tags 一起摘掉；本来就没挂着 = 同一份引用
    expect(withoutMetaAudioTag(withoutMetaAudioTag(meta, 0), 1).audio).toBeUndefined();
    expect(withoutMetaAudioTag(meta, 2)).toBe(meta);
  });
});

describe("项目轨：标签表的新建 / 改名", () => {
  it("新建：下标就是 ID，依次往后发", () => {
    const project = projectWith((draft) => {
      expect(addAudioTag(draft, "战斗")).toBe(0);
      expect(addAudioTag(draft, "紧张")).toBe(1);
      expect(addAudioTag(draft, "  环境  ")).toBe(2);
    });

    expect(project.audioTags).toEqual(["战斗", "紧张", "环境"]);
  });

  it("同名（trim 后）返回已有那个 ID，不新建第二个", () => {
    const project = projectWith((draft) => {
      addAudioTag(draft, "战斗");
      expect(addAudioTag(draft, "  战斗 ")).toBe(0);
    });

    expect(project.audioTags).toEqual(["战斗"]);
  });

  it("空名字 / 纯空白：不新建，返回 null", () => {
    const project = projectWith((draft) => {
      expect(addAudioTag(draft, "   ")).toBeNull();
    });

    expect(project.audioTags).toBeUndefined();
  });

  it("删过之后新建：**优先复用那个洞**，ID 往后发不位移", () => {
    const removed = produce(taggedProject(), (draft) => {
      deleteAudioTag(draft, 0);
    });

    const refilled = produce(removed, (draft) => {
      expect(addAudioTag(draft, "追击")).toBe(0);
    });

    expect(refilled.audioTags).toEqual(["追击", "紧张"]);
    // 文件那一侧的引用是另一条轨道：原来指向 #1（紧张）的 ID 一个字节都不动
    expect(taggedMeta().audio?.tags).toEqual([0, 1]);
  });

  it("改名：**只改表**，文件里的 ID 一个字节不动", () => {
    const start = taggedProject();
    const renamed = produce(start, (draft) => {
      expect(renameAudioTag(draft, 0, " 交战 ")).toBe(true);
    });

    expect(renamed.audioTags).toEqual(["交战", "紧张"]);
    // 素材 meta 那一句「用 #0 这个标签」不需要跟着改：按新表读出来就是新名字
    const ids = taggedMeta().audio?.tags;
    expect(withinTable(renamed.audioTags, ids)).toEqual(["交战", "紧张"]);

    // 空名字 / 越界 / 指向洞 / 名字没变：都不产生变更
    const same = produce(renamed, (draft) => {
      expect(renameAudioTag(draft, 0, "  ")).toBe(false);
      expect(renameAudioTag(draft, 9, "x")).toBe(false);
      expect(renameAudioTag(draft, -1, "x")).toBe(false);
      expect(renameAudioTag(draft, 0, "交战")).toBe(false);
    });

    expect(same).toBe(renamed);
  });

  it("改名允许重名（与 Unity 一致），由校验报一条 warning", () => {
    const renamed = produce(taggedProject(), (draft) => {
      expect(renameAudioTag(draft, 1, "战斗")).toBe(true);
    });

    expect(renamed.audioTags).toEqual(["战斗", "战斗"]);
    expect(validateProject(renamed).map((issue) => issue.path)).toContain("audioTags/1");
  });
});

describe("项目轨：按序号命名（序号预先定好，只填名字）", () => {
  it("序号越界时把中间的空槽补出来（空名字 = 还没起名字，不是洞）", () => {
    const named = produce(createEmptyProject("测试项目"), (draft) => {
      expect(setAudioTagName(draft, 2, "环境")).toBe(true);
    });

    expect(named.audioTags).toEqual(["", "", "环境"]);
    // 空名字不是脏数据：校验不该为它们报 warning
    expect(validateProject(named)).toEqual([]);
  });

  it("同一个序号再改名：只改那一格，别人的名字与文件上的引用都不动", () => {
    const two = produce(taggedProject(), (draft) => {
      setAudioTagName(draft, 1, "追击");
    });

    expect(two.audioTags).toEqual(["战斗", "追击"]);
    // 文件上挂的还是那两个 ID
    expect(taggedMeta().audio?.tags).toEqual([0, 1]);
  });

  it("名字没变 / 空名字 / 负序号：返回 false（不进撤销栈）", () => {
    const start = taggedProject();
    const after = produce(start, (draft) => {
      expect(setAudioTagName(draft, 0, "战斗")).toBe(false);
      expect(setAudioTagName(draft, 1, "   ")).toBe(false);
      expect(setAudioTagName(draft, -1, "越界")).toBe(false);
    });

    expect(after.audioTags).toEqual(["战斗", "紧张"]);
    expect(after).toBe(start);
  });

  it("序号大到离谱（1e9）：直接拒绝，不靠补空槽把内存吃光", () => {
    const start = taggedProject();
    const after = produce(start, (draft) => {
      expect(setAudioTagName(draft, 1_000_000_000, "爆炸")).toBe(false);
    });

    expect(after).toBe(start);
  });

  it("指向洞的序号不写（洞是「曾经删过」的记号，不能拿名字去顶它）", () => {
    const holed = produce(taggedProject(), (draft) => {
      deleteAudioTag(draft, 0);
    });

    const after = produce(holed, (draft) => {
      expect(setAudioTagName(draft, 0, "新名字")).toBe(false);
    });

    expect(after.audioTags).toEqual([null, "紧张"]);
  });
});

describe("项目轨：删除标签（只留洞，引用由素材 meta 负责）", () => {
  it("表里把那一格设成 null；**引用不在这里摘**（v24 起它们不在工程文件里）", () => {
    const removed = produce(taggedProject(), (draft) => {
      expect(deleteAudioTag(draft, 0)).toBe(true);
    });

    expect(removed.audioTags).toEqual([null, "紧张"]);
    // 这一条命令只拿得到工程文件：素材 meta 上的引用要由调用方在**另一条轨道**上用
    // `withoutMetaAudioTag` 一个一个文件地摘（见 asset-meta.test.ts）
    const meta = taggedMeta();
    expect(meta.audio?.tags).toEqual([0, 1]);
    expect(withoutMetaAudioTag(meta, 0).audio).toEqual({ tags: [1] });
  });

  it("表里全成了洞：audioTags 字段整个删掉（不留空壳）", () => {
    const removed = produce(taggedProject(), (draft) => {
      deleteAudioTag(draft, 0);
      deleteAudioTag(draft, 1);
    });

    expect(removed.audioTags).toBeUndefined();
  });

  it("越界 / 已经是洞 / 没有表：返回 false", () => {
    const start = taggedProject();
    const once = produce(start, (draft) => {
      deleteAudioTag(draft, 1);
    });

    const same = produce(once, (draft) => {
      expect(deleteAudioTag(draft, 9)).toBe(false);
      expect(deleteAudioTag(draft, -1)).toBe(false);
      // #1 已经删过了（现在是个洞）
      expect(deleteAudioTag(draft, 1)).toBe(false);
    });

    expect(same).toBe(once);

    const empty = createEmptyProject("测试项目");
    const untouched = produce(empty, (draft) => {
      expect(deleteAudioTag(draft, 0)).toBe(false);
    });

    expect(untouched).toBe(empty);
  });
});

describe("读写工程文件与迁移（v17 → v18 → v24）", () => {
  it("当前版本的工程文件：没有 audioMeta / audioTags 时就是「没有这一项」（不补空壳）", () => {
    const load = parseProjectFile(JSON.parse(JSON.stringify(createEmptyProject("测试项目"))) as unknown);

    expect("audioMeta" in load.doc).toBe(false);
    expect(load.doc.audioTags).toBeUndefined();
    expect(load.doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(load.needsRewrite).toBe(false);
  });

  it("v23 的工程文件：audioMeta 搬进 migratedMetas，表留在工程文件里，并要求回写", () => {
    const file = {
      ...createEmptyProject("测试项目"),
      formatVersion: 23,
      audioMeta: { [CLIP_A]: { name: "开场曲", tags: [0] } },
      audioTags: ["战斗"],
    };

    const load = parseProjectFile(file);

    expect(load.needsRewrite).toBe(true);
    expect("audioMeta" in load.doc).toBe(false);
    // 标签表是**项目级**数据：留在工程文件里，一个字节都不动
    expect(load.doc.audioTags).toEqual(["战斗"]);
    expect(load.doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);

    const migrated = load.migratedMetas.find((entry) => entry.id === CLIP_A);
    expect(migrated?.meta.importer).toBe("audio");
    expect(migrated?.meta.audio).toEqual({ name: "开场曲", tags: [0] });
  });

  it("v17 的字符串标签：按出现顺序建成表、也一路搬进 meta，并要求回写", () => {
    const legacy = {
      formatVersion: 17,
      name: "测试项目",
      items: { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] },
      settings: { audio: { bgm: { volume: 0.6 }, sfx: { volume: 0.8 }, voice: { volume: 1 } } },
      audioMeta: {
        [CLIP_A]: { name: "开场曲", tags: ["战斗", "紧张", "战斗", "  "] },
        [CLIP_B]: { tags: ["紧张", "环境"] },
      },
    };

    const load = parseProjectFile(legacy);

    expect(load.needsRewrite).toBe(true);
    expect(load.doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    // 出现的先后就是 ID：战斗=0、紧张=1、环境=2；空白与重复被归一化掉
    expect(load.doc.audioTags).toEqual(["战斗", "紧张", "环境"]);
    // 标注那一份已经搬进各素材的 meta（工程文件里不再有 audioMeta）
    expect("audioMeta" in load.doc).toBe(false);
    expect(load.migratedMetas.map((entry) => entry.id).sort()).toEqual([CLIP_A, CLIP_B].sort());
    expect(load.migratedMetas.find((entry) => entry.id === CLIP_A)?.meta.audio).toEqual({
      name: "开场曲",
      tags: [0, 1],
    });
    expect(load.migratedMetas.find((entry) => entry.id === CLIP_B)?.meta.audio).toEqual({
      tags: [1, 2],
    });
  });

  it("v17 里只有名字没有标签：照样搬进 meta，表那一项不凭空建出来", () => {
    const legacy = {
      formatVersion: 17,
      name: "测试项目",
      items: { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] },
      settings: { audio: { bgm: { volume: 0.6 }, sfx: { volume: 0.8 }, voice: { volume: 1 } } },
      audioMeta: { [CLIP_A]: { name: "开场曲" } },
    };

    const load = parseProjectFile(legacy);

    expect(load.doc.audioTags).toBeUndefined();
    expect(load.migratedMetas.map((entry) => entry.id)).toEqual([CLIP_A]);
    expect(load.migratedMetas[0]?.meta.audio).toEqual({ name: "开场曲" });
    // 版本升了，仍然要求回写一次（磁盘上的文件从此自描述）
    expect(load.needsRewrite).toBe(true);
  });

  it("v17 里的空标签列表：不为它造 meta（搬完什么都不剩）", () => {
    const legacy = {
      formatVersion: 17,
      name: "测试项目",
      items: { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] },
      settings: { audio: { bgm: { volume: 0.6 }, sfx: { volume: 0.8 }, voice: { volume: 1 } } },
      audioMeta: { [CLIP_A]: { tags: [] } },
    };

    const load = parseProjectFile(legacy);

    expect(load.migratedMetas).toEqual([]);
    expect(load.doc.audioTags).toBeUndefined();
    // 老文件仍然要回写一次（版本号 + 去掉 audioMeta）
    expect(load.needsRewrite).toBe(true);
  });

  it("老工程文件（v16，没有音频标注）：补上版本号、要求回写，不造 meta", () => {
    const legacy = {
      formatVersion: 16,
      name: "测试项目",
      items: { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] },
      settings: { audio: { bgm: { volume: 0.6 }, sfx: { volume: 0.8 }, voice: { volume: 1 } } },
    };

    const load = parseProjectFile(legacy);

    expect(load.needsRewrite).toBe(true);
    expect(load.doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(load.migratedMetas).toEqual([]);
    expect("audioMeta" in load.doc).toBe(false);
    expect(load.doc.audioTags).toBeUndefined();
  });
});

describe("校验：工程文件那一边", () => {
  it("标签表：空名字不算问题（那是还没起名字的槽位），重名报一条 warning", () => {
    const doc: ProjectDoc = {
      ...createEmptyProject("测试项目"),
      audioTags: ["战斗", "  ", "战斗", null],
    };

    const issues = validateProject(doc);
    const paths = issues.map((issue) => issue.path);

    // 空名字 = 序号预先定好、还没填名字的格子，正常；只有重名值得提醒
    expect(paths).not.toContain("audioTags/1");
    expect(paths).toContain("audioTags/2");
    expect(issues.every((issue) => issue.level === "warning")).toBe(true);
  });

  it("**不再**报 `audioMeta/...` 的路径：那些检查跟着数据搬去了 `validateAssetMetas`", () => {
    // 干净的表不该被工程文件那一侧说三道四
    const doc: ProjectDoc = {
      ...createEmptyProject("测试项目"),
      audioTags: ["战斗", null],
    };

    const paths = validateProject(doc).map((issue) => issue.path);
    expect(paths.filter((path) => path.startsWith("audioMeta"))).toEqual([]);

    // 手写文件里残留的 audioMeta 是**工程文件里不认识的字段**：`validateProject` 只拿
    // `ProjectDoc`（schema 已经把它丢了），所以这里根本无从校验——所以那些规则全在
    // `validateAssetMetas(entries, table)` 里（见 asset-meta.test.ts）
    const stray = {
      ...doc,
      audioMeta: { [CLIP_A]: { tags: [9] } },
    } as unknown as ProjectDoc;
    expect(validateProject(stray).map((issue) => issue.path)).toEqual([]);
  });

  it("干净的标注 + 标签表：工程文件那一侧不报任何问题", () => {
    expect(validateProject(taggedProject())).toEqual([]);
  });
});

/** 按标签表把一组 ID 翻成名字（界面那边走 `audio-catalog.ts`；这里只为把断言写得可读）。 */
function withinTable(
  table: AudioTagTableDoc | undefined,
  ids: readonly number[] | undefined,
): string[] {
  return (ids ?? []).map((id) => table?.[id] ?? "");
}
