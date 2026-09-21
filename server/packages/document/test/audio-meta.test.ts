import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import {
  addAudioTag,
  deleteAudioTag,
  renameAudioTag,
  setAudioMetaName,
  setAudioMetaTags,
  setAudioTagName,
} from "../src/commands";
import { createEmptyProject } from "../src/factory";
import { parseProjectDoc, parseProjectFile } from "../src/schema";
import { validateProject } from "../src/validation";
import { DOCUMENT_FORMAT_VERSION, type ProjectDoc } from "../src/types";

/**
 * **音频文件标注 + 标签表**（v17 / v18 起）。
 *
 * 标签学 Unity：**tag 是个整数**（就是 `audioTags` 的下标），名字只是它的显示文本；
 * 音频文件里只记 ID（`[0, 2]`）。所以这里盯住五件事：
 * - **改名字只改表**：`renameAudioTag` 之后文件里的 ID 一个字节都不动；
 * - **删除留洞**：`deleteAudioTag` 把槽设成 `null`、把引用从所有文件上摘掉，别人的 ID 不位移；
 * - 规范化：ID 去重 + 升序，越界 / 指向洞的丢掉；名字 trim，空名字拒掉；
 * - **不留空壳**：标签删空且没名字 → 删 entry；entry 空了 → 删 `audioMeta`；表全洞 → 删 `audioTags`；
 * - v17 的**字符串标签**由 `migrateAudioTags` 按出现顺序建成表并换成 ID，并标记回写。
 */

const CLIP_A = "project:C/Assets/audio/theme.mp3";
const CLIP_B = "project:C/Assets/audio/battle.wav";

function projectWith(recipe: (draft: Draft<ProjectDoc>) => void): ProjectDoc {
  return produce(createEmptyProject("测试项目"), recipe);
}

/** 起一个「战斗 = 0、紧张 = 1」的表，并把两个标签挂到 A 上。 */
function tagged(): ProjectDoc {
  return projectWith((draft) => {
    addAudioTag(draft, "战斗");
    addAudioTag(draft, "紧张");
    setAudioMetaTags(draft, CLIP_A, [0, 1]);
  });
}

describe("显示名", () => {
  it("起名 / 改名：去首尾空白，写进 audioMeta", () => {
    const named = projectWith((draft) => {
      expect(setAudioMetaName(draft, CLIP_A, "  开场曲  ")).toBe(true);
    });

    expect(named.audioMeta).toEqual({ [CLIP_A]: { name: "开场曲" } });
  });

  it("留空 = 退回素材文件名：删掉 name，没有标签时连这一条一起删", () => {
    const named = projectWith((draft) => {
      setAudioMetaName(draft, CLIP_A, "开场曲");
    });

    const cleared = produce(named, (draft) => {
      expect(setAudioMetaName(draft, CLIP_A, "   ")).toBe(true);
    });

    expect(cleared.audioMeta).toBeUndefined();
  });

  it("值没变 / clipId 是空白：返回 false（不进撤销栈）", () => {
    const named = projectWith((draft) => {
      setAudioMetaName(draft, CLIP_A, "开场曲");
    });

    const same = produce(named, (draft) => {
      expect(setAudioMetaName(draft, CLIP_A, " 开场曲 ")).toBe(false);
      expect(setAudioMetaName(draft, "   ", "随便")).toBe(false);
    });

    expect(same).toBe(named);
  });
});

describe("标签表：新建 / 改名", () => {
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
    const removed = produce(tagged(), (draft) => {
      deleteAudioTag(draft, 0);
    });

    const refilled = produce(removed, (draft) => {
      expect(addAudioTag(draft, "追击")).toBe(0);
    });

    expect(refilled.audioTags).toEqual(["追击", "紧张"]);
    // 文件上原来指向 #1（紧张）的引用没动
    expect(refilled.audioMeta?.[CLIP_A]?.tags).toEqual([1]);
  });

  it("改名：**只改表**，文件里的 ID 一个字节不动", () => {
    const start = tagged();
    const renamed = produce(start, (draft) => {
      expect(renameAudioTag(draft, 0, " 交战 ")).toBe(true);
    });

    expect(renamed.audioTags).toEqual(["交战", "紧张"]);
    expect(renamed.audioMeta?.[CLIP_A]?.tags).toEqual([0, 1]);

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
    const renamed = produce(tagged(), (draft) => {
      expect(renameAudioTag(draft, 1, "战斗")).toBe(true);
    });

    expect(renamed.audioTags).toEqual(["战斗", "战斗"]);
    expect(validateProject(renamed).map((issue) => issue.path)).toContain("audioTags/1");
  });
});

describe("标签表：按序号命名（序号预先定好，只填名字）", () => {
  it("序号越界时把中间的空槽补出来（空名字 = 还没起名字，不是洞）", () => {
    const named = produce(createEmptyProject("测试项目"), (draft) => {
      expect(setAudioTagName(draft, 2, "环境")).toBe(true);
    });

    expect(named.audioTags).toEqual(["", "", "环境"]);
    // 空名字不是脏数据：校验不该为它们报 warning
    expect(validateProject(named)).toEqual([]);
  });

  it("同一个序号再改名：只改那一格，别人的名字与引用都不动", () => {
    const two = produce(tagged(), (draft) => {
      setAudioTagName(draft, 1, "追击");
    });

    expect(two.audioTags).toEqual(["战斗", "追击"]);
    expect(two.audioMeta?.[CLIP_A]?.tags).toEqual([0, 1]);
  });

  it("名字没变 / 空名字 / 负序号：返回 false（不进撤销栈）", () => {
    const start = tagged();
    const after = produce(start, (draft) => {
      expect(setAudioTagName(draft, 0, "战斗")).toBe(false);
      expect(setAudioTagName(draft, 1, "   ")).toBe(false);
      expect(setAudioTagName(draft, -1, "越界")).toBe(false);
    });

    expect(after.audioTags).toEqual(["战斗", "紧张"]);
  });

  it("指向洞的序号不写（洞是「曾经删过」的记号，不能拿名字去顶它）", () => {
    const holed = produce(tagged(), (draft) => {
      deleteAudioTag(draft, 0);
    });

    const after = produce(holed, (draft) => {
      expect(setAudioTagName(draft, 0, "新名字")).toBe(false);
    });

    expect(after.audioTags).toEqual([null, "紧张"]);
  });
});

describe("标签表：删除（留洞 + 摘引用）", () => {
  it("从所有文件上摘掉这个 ID，表里留洞；别的标签与文件上的引用不动", () => {
    const two = produce(tagged(), (draft) => {
      setAudioMetaTags(draft, CLIP_B, [0]);
    });

    const removed = produce(two, (draft) => {
      expect(deleteAudioTag(draft, 0)).toBe(true);
    });

    expect(removed.audioTags).toEqual([null, "紧张"]);
    expect(removed.audioMeta).toEqual({
      [CLIP_A]: { tags: [1] },
      // B 只带 #0：摘空、又没名字 → 这一条一起收掉
    });
  });

  it("表里全成了洞：audioTags 字段整个删掉（不留空壳）", () => {
    const removed = produce(tagged(), (draft) => {
      deleteAudioTag(draft, 0);
      deleteAudioTag(draft, 1);
    });

    expect(removed.audioTags).toBeUndefined();
    expect(removed.audioMeta).toBeUndefined();
  });

  it("越界 / 已经是洞 / 没有表：返回 false", () => {
    const start = tagged();
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

describe("文件上的标签（ID 列表）", () => {
  it("规范化：去重、升序，越界与指向洞的 ID 丢掉", () => {
    const project = produce(tagged(), (draft) => {
      deleteAudioTag(draft, 1);
    });

    const set = produce(project, (draft) => {
      expect(setAudioMetaTags(draft, CLIP_B, [0, 1, 1, 9, -1, 0])).toBe(true);
    });

    // #1 是洞、#9 越界 → 只剩 #0
    expect(set.audioMeta?.[CLIP_B]).toEqual({ tags: [0] });
  });

  it("清空 = 删掉 tags 字段（没名字时连 entry 一起删）；值没变返回 false", () => {
    const tagged2 = tagged();

    const cleared = produce(tagged2, (draft) => {
      expect(setAudioMetaTags(draft, CLIP_A, [])).toBe(true);
    });

    expect(cleared.audioMeta).toBeUndefined();

    const same = produce(tagged2, (draft) => {
      // 顺序不同但集合一样（规范化后相同）
      expect(setAudioMetaTags(draft, CLIP_A, [1, 0])).toBe(false);
      expect(setAudioMetaTags(draft, "  ", [0])).toBe(false);
    });

    expect(same).toBe(tagged2);
  });

  it("名字与标签互不覆盖", () => {
    const project = projectWith((draft) => {
      setAudioMetaName(draft, CLIP_A, "开场曲");
      addAudioTag(draft, "战斗");
      setAudioMetaTags(draft, CLIP_A, [0]);
    });

    expect(project.audioMeta).toEqual({ [CLIP_A]: { name: "开场曲", tags: [0] } });
  });
});

describe("读写工程文件与 v17 → v18 迁移", () => {
  it("v18 的工程文件原样读回来，且不要求回写", () => {
    const file = {
      ...createEmptyProject("测试项目"),
      audioMeta: { [CLIP_A]: { name: "开场曲", tags: [0] } },
      audioTags: ["战斗"],
    };

    const load = parseProjectFile(file);

    expect(load.needsRewrite).toBe(false);
    expect(load.doc.audioMeta).toEqual({ [CLIP_A]: { name: "开场曲", tags: [0] } });
    expect(load.doc.audioTags).toEqual(["战斗"]);
  });

  it("没有 audioMeta / audioTags 的工程文件读出来就是「没有这一项」（不补空壳）", () => {
    const doc = parseProjectDoc(createEmptyProject("测试项目"));

    expect(doc.audioMeta).toBeUndefined();
    expect(doc.audioTags).toBeUndefined();
    expect(doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
  });

  it("v17 的字符串标签：按出现顺序建成表、文件里换成 ID，并要求回写", () => {
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
    expect(load.doc.audioMeta).toEqual({
      [CLIP_A]: { name: "开场曲", tags: [0, 1] },
      [CLIP_B]: { tags: [1, 2] },
    });
  });

  it("v17 里只有名字没有标签：不动 audioMeta，也不建空表", () => {
    const legacy = {
      formatVersion: 17,
      name: "测试项目",
      items: { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] },
      settings: { audio: { bgm: { volume: 0.6 }, sfx: { volume: 0.8 }, voice: { volume: 1 } } },
      audioMeta: { [CLIP_A]: { name: "开场曲" } },
    };

    const load = parseProjectFile(legacy);

    expect(load.doc.audioMeta).toEqual({ [CLIP_A]: { name: "开场曲" } });
    expect(load.doc.audioTags).toBeUndefined();
    // 版本升了，仍然要求回写一次（磁盘上的文件从此自描述）
    expect(load.needsRewrite).toBe(true);
  });

  it("v17 里的空标签列表：连 tags 字段一起收拾掉", () => {
    const legacy = {
      formatVersion: 17,
      name: "测试项目",
      items: { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] },
      settings: { audio: { bgm: { volume: 0.6 }, sfx: { volume: 0.8 }, voice: { volume: 1 } } },
      audioMeta: { [CLIP_A]: { tags: [] } },
    };

    const load = parseProjectFile(legacy);

    expect(load.doc.audioMeta).toBeUndefined();
    expect(load.doc.audioTags).toBeUndefined();
  });

  it("老工程文件（v16，没有音频标注）：补上版本号、要求回写", () => {
    const legacy = {
      formatVersion: 16,
      name: "测试项目",
      items: { source: "item.xlsx", updatedAt: "2026-09-18", count: 0, items: [] },
      settings: { audio: { bgm: { volume: 0.6 }, sfx: { volume: 0.8 }, voice: { volume: 1 } } },
    };

    const load = parseProjectFile(legacy);

    expect(load.needsRewrite).toBe(true);
    expect(load.doc.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(load.doc.audioMeta).toBeUndefined();
    expect(load.doc.audioTags).toBeUndefined();
  });
});

describe("校验", () => {
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

  it("文件上的标签：越界 / 指向洞 / 重复 / 空列表各一条 warning", () => {
    const doc: ProjectDoc = {
      ...createEmptyProject("测试项目"),
      audioTags: ["战斗", null],
      audioMeta: {
        [CLIP_A]: { tags: [0, 0, 1, 9] },
        [CLIP_B]: { tags: [] },
      },
    };

    const paths = validateProject(doc).map((issue) => issue.path);

    expect(paths).toContain(`audioMeta/${CLIP_A}/tags/1`);
    expect(paths).toContain(`audioMeta/${CLIP_A}/tags/2`);
    expect(paths).toContain(`audioMeta/${CLIP_A}/tags/3`);
    expect(paths).toContain(`audioMeta/${CLIP_B}/tags`);
  });

  it("干净的标注与标签表不报任何问题", () => {
    const doc = produce(tagged(), (draft) => {
      setAudioMetaName(draft, CLIP_A, "开场曲");
    });

    expect(validateProject(doc)).toEqual([]);
  });
});
