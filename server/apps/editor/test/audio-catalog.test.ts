import { describe, expect, it } from "vitest";
import {
  allTagsOf,
  audioCatalog,
  audioDisplayName,
  audioNameOf,
  filterAudioRows,
  matchesAudioQuery,
  sortAudioRowsByName,
  tagEntriesOf,
  tagNameOf,
  tagOptionsOf,
  tagsOfClip,
  type AudioCatalogRow,
} from "../src/panels/audio-catalog";
import type { ResourceTreeNode } from "../src/services/project-api";

/**
 * 音频清单 + 标注（含**整数标签表**）→ 列表行（几个音频窗口共用的纯逻辑）。
 *
 * 标签学 Unity：**tag 是个整数**（`audioTags` 的下标），名字住在表里。这里钉住：
 * 标签按名字显示、按 ID 编辑；越界 / 指向洞 / 没名字的 ID 一律跳过（不给界面画空标签）；
 * 「表里有、没人用」的标签照列（count = 0）；搜索 / 筛选按名字。
 */

const PROJECT = "测试";
const CLIP_A = `project:${PROJECT}/Assets/audio/theme.mp3`;
const CLIP_B = `project:${PROJECT}/Assets/audio/battle.wav`;
const CLIP_C = `project:${PROJECT}/Assets/audio/environment/rain.ogg`;
/** 另一个目录下的同名素材（给「同名按路径定序」用）。 */
const TWIN = `project:${PROJECT}/Assets/audio/act-2/theme.mp3`;
const GONE = `project:${PROJECT}/Assets/audio/deleted.mp3`;

const TREE: ResourceTreeNode[] = [
  {
    name: "Assets",
    path: "Assets",
    id: `project:${PROJECT}/Assets`,
    type: "folder",
    children: [
      {
        name: "audio",
        path: "Assets/audio",
        id: `project:${PROJECT}/Assets/audio`,
        type: "folder",
        children: [
          { name: "theme.mp3", path: "Assets/audio/theme.mp3", id: CLIP_A, type: "file" },
          { name: "battle.wav", path: "Assets/audio/battle.wav", id: CLIP_B, type: "file" },
          {
            name: "environment",
            path: "Assets/audio/environment",
            id: `project:${PROJECT}/Assets/audio/environment`,
            type: "folder",
            children: [
              {
                name: "rain.ogg",
                path: "Assets/audio/environment/rain.ogg",
                id: CLIP_C,
                type: "file",
              },
            ],
          },
        ],
      },
      {
        name: "images",
        path: "Assets/images",
        id: `project:${PROJECT}/Assets/images`,
        type: "folder",
        children: [
          {
            name: "Map001.png",
            path: "Assets/images/Map001.png",
            id: `project:${PROJECT}/Assets/images/Map001.png`,
            type: "file",
          },
        ],
      },
    ],
  },
];

/** 标签表：0 战斗、1 紧张、2 环境（3 是删过的洞）。 */
const TABLE = ["战斗", "紧张", "环境", null];

const rowOf = (rows: readonly AudioCatalogRow[], id: string): AudioCatalogRow => {
  const row = rows.find((item) => item.id === id);
  if (row === undefined) {
    throw new Error(`清单里没有这一行：${id}`);
  }

  return row;
};

describe("清单：项目音频 + 标注", () => {
  it("只列音频（图片不进来），按路径排序", () => {
    const rows = audioCatalog(TREE, undefined, undefined);

    // 路径排序：`audio/battle.wav` < `audio/environment/rain.ogg` < `audio/theme.mp3`
    expect(rows.map((row) => row.id)).toEqual([CLIP_B, CLIP_C, CLIP_A]);
    expect(rows.every((row) => !row.missing)).toBe(true);
  });

  it("sortAudioRowsByName：按**显示名**排（BGM 弹框的口径）；同名按路径定序", () => {
    const rows = audioCatalog(
      TREE,
      // 起过名的按显示名排：与路径序（battle / rain / theme）**故意不同**
      { [CLIP_A]: { name: "charlie" }, [CLIP_B]: { name: "zulu" }, [CLIP_C]: { name: "alpha" } },
      undefined,
    );

    expect(sortAudioRowsByName(rows).map((row) => row.id)).toEqual([CLIP_C, CLIP_A, CLIP_B]);

    // 两个目录下都叫 theme：显示名一样，按路径定序（排序要稳，不然顺序每次跳）
    const twins = audioCatalog(
      [
        {
          name: "Assets",
          path: "Assets",
          id: `project:${PROJECT}/Assets`,
          type: "folder",
          children: [
            {
              name: "audio",
              path: "Assets/audio",
              id: `project:${PROJECT}/Assets/audio`,
              type: "folder",
              children: [
                { name: "theme.mp3", path: "Assets/audio/theme.mp3", id: CLIP_A, type: "file" },
                {
                  name: "act-2",
                  path: "Assets/audio/act-2",
                  id: `project:${PROJECT}/Assets/audio/act-2`,
                  type: "folder",
                  children: [
                    {
                      name: "theme.mp3",
                      path: "Assets/audio/act-2/theme.mp3",
                      id: TWIN,
                      type: "file",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      undefined,
      undefined,
    );

    expect(sortAudioRowsByName(twins).map((row) => row.path)).toEqual([
      "audio/act-2/theme.mp3",
      "audio/theme.mp3",
    ]);
  });

  it("显示名 = 全局标注的名字；没起名字就退回素材文件名（去扩展名）", () => {
    const rows = audioCatalog(
      TREE,
      { [CLIP_A]: { name: "开场曲" }, [CLIP_B]: { name: "   " } },
      undefined,
    );

    expect(rowOf(rows, CLIP_A).displayName).toBe("开场曲");
    expect(rowOf(rows, CLIP_A).customName).toBe("开场曲");
    expect(rowOf(rows, CLIP_B).displayName).toBe("battle");
    expect(rowOf(rows, CLIP_B).customName).toBe("");
  });

  it("标签解析成 { id, name }：越界 / 指向洞 / 没名字的 ID 一律跳过", () => {
    const rows = audioCatalog(
      TREE,
      { [CLIP_A]: { tags: [0, 1, 3, 9, 2] } },
      // #2 名字是空的（表里写了空白）→ 也跳过
      ["战斗", "紧张", "  ", null],
    );

    expect(rowOf(rows, CLIP_A).tags).toEqual([
      { id: 0, name: "战斗" },
      { id: 1, name: "紧张" },
    ]);
  });

  it("标注还在、文件没了：列成 missing 行（路径退回逻辑 ID），标签照常解析", () => {
    const rows = audioCatalog(
      TREE,
      { [GONE]: { name: "删掉的那首", tags: [0] } },
      ["战斗"],
    );

    expect(rows).toHaveLength(4);
    expect(rowOf(rows, GONE).missing).toBe(true);
    expect(rowOf(rows, GONE).displayName).toBe("删掉的那首");
    expect(rowOf(rows, GONE).path).toBe("audio/deleted.mp3");
    expect(rowOf(rows, GONE).tags).toEqual([{ id: 0, name: "战斗" }]);
  });
});

describe("标签表与文件的标签", () => {
  it("tagEntriesOf / tagNameOf：洞被跳过，名字已 trim", () => {
    expect(tagEntriesOf([" 战斗 ", null, "紧张"])).toEqual([
      { id: 0, name: "战斗" },
      { id: 2, name: "紧张" },
    ]);
    expect(tagNameOf(["战斗"], 0)).toBe("战斗");
    expect(tagNameOf([null], 0)).toBeUndefined();
    expect(tagNameOf(["战斗"], 3)).toBeUndefined();
    expect(tagEntriesOf(undefined)).toEqual([]);
  });

  it("tagsOfClip：把整数 ID 清单解析成引用", () => {
    expect(tagsOfClip(["战斗", null, "紧张"], [2, 0])).toEqual([
      { id: 2, name: "紧张" },
      { id: 0, name: "战斗" },
    ]);
    expect(tagsOfClip(["战斗"], undefined)).toEqual([]);
  });

  it("allTagsOf：含**没人用到**的标签（count = 0），用量降序、同量按 ID 升序", () => {
    const rows = audioCatalog(
      TREE,
      {
        [CLIP_A]: { tags: [0, 1] },
        [CLIP_B]: { tags: [0] },
      },
      TABLE,
    );

    expect(allTagsOf(TABLE, rows)).toEqual([
      { id: 0, name: "战斗", count: 2 },
      { id: 1, name: "紧张", count: 1 },
      // 表里有、没人用：照样列出来（tag 是整数，先建后用是正常用法）
      { id: 2, name: "环境", count: 0 },
    ]);
  });
});

describe("名字兜底链", () => {
  it("对象名 → 全局名 → 文件名；空白一律当作没写", () => {
    const meta = { [CLIP_A]: { name: "开场曲" } };

    expect(audioDisplayName(meta, CLIP_A, "序幕")).toBe("序幕");
    expect(audioDisplayName(meta, CLIP_A, "   ")).toBe("开场曲");
    expect(audioDisplayName(meta, CLIP_A)).toBe("开场曲");
    expect(audioDisplayName(meta, CLIP_B)).toBe("battle");
    expect(audioNameOf(meta, CLIP_B)).toBeUndefined();
    expect(audioNameOf({ [CLIP_B]: { name: " " } }, CLIP_B)).toBeUndefined();
  });
});

describe("搜索与标签筛选", () => {
  const rows = audioCatalog(
    TREE,
    {
      [CLIP_A]: { name: "开场曲", tags: [0, 1] },
      [CLIP_B]: { tags: [0] },
      [CLIP_C]: { name: "雨声", tags: [2] },
    },
    ["战斗", "紧张", "环境"],
  );

  it("搜索面 = 显示名 / 自定义名 / 文件名 / 路径，大小写不敏感", () => {
    for (const query of ["开场", "battle", "theme", "environment", "雨声"]) {
      const hit = rows.filter((row) => matchesAudioQuery(row, query)).map((row) => row.id);
      expect(hit.length).toBeGreaterThan(0);
    }

    expect(rows.filter((row) => matchesAudioQuery(row, "THEME")).map((row) => row.id)).toEqual([CLIP_A]);
    expect(rows.filter((row) => matchesAudioQuery(row, "没有这个"))).toEqual([]);
    // 空搜索 = 不筛
    expect(rows.filter((row) => matchesAudioQuery(row, "  "))).toHaveLength(3);
    // 默认也搜标签名（「选择音频」那个窗口要用：它没有勾选那一排）
    expect(rows.filter((row) => matchesAudioQuery(row, "环境")).map((row) => row.id)).toEqual([
      CLIP_C,
    ]);
  });

  it("searchTags = false：搜索框只管名字 / 路径，标签交给勾选那一排", () => {
    expect(
      filterAudioRows(rows, { query: "环境", tags: [], searchTags: false }),
    ).toEqual([]);
    expect(
      filterAudioRows(rows, { query: "雨", tags: [], searchTags: false }).map((row) => row.id),
    ).toEqual([CLIP_C]);
  });

  it("标签筛选是 AND（每个选中的标签名都要有），与搜索词叠加", () => {
    expect(filterAudioRows(rows, { query: "", tags: ["战斗"] }).map((row) => row.id)).toEqual([
      CLIP_B,
      CLIP_A,
    ]);
    expect(filterAudioRows(rows, { query: "", tags: ["战斗", "紧张"] }).map((row) => row.id)).toEqual([
      CLIP_A,
    ]);
    expect(filterAudioRows(rows, { query: "雨", tags: ["战斗"] })).toEqual([]);
    expect(filterAudioRows(rows, { query: "开场", tags: ["战斗"] }).map((row) => row.id)).toEqual([
      CLIP_A,
    ]);
  });

  it("tagOptionsOf：给「勾选那一排」用——按名字排、空名字的槽不列", () => {
    expect(tagOptionsOf(["战斗", "  ", null, "环境", "紧张"])).toEqual([
      { id: 3, name: "环境" },
      { id: 4, name: "紧张" },
      { id: 0, name: "战斗" },
    ]);
    expect(tagOptionsOf(undefined)).toEqual([]);
  });
});
