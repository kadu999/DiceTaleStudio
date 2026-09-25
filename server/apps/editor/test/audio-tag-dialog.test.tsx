import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { assetTagsOfMeta, createAssetMetas, createEmptyProject, emptyAssetMetas } from "@dts/document";
import { AudioTagDialog } from "../src/app/AudioTagDialog";
import { metaHistory } from "../src/state/store-core";
import { projectHistory, sceneHistory, useEditorStore } from "../src/state/editor-store";
import type { ResourceTreeNode } from "../src/services/project-api";
import { audioMetaTable } from "./asset-meta-fixtures";

/**
 * **「选择标签」框**（v18 起）：给一个素材文件**勾标签**——只做加 / 去。
 * 标签**任何素材**都能打（图 / 音频 / 视频），写一律落在 meta 顶层 `tags`。
 *
 * 新增 / 改名都在「标签」窗口里做（序号预先定好、只填名字），所以这一份钉住：
 * 1. 列的是**标签表里的全部标签**（含还没人用到的），带「N 个文件在用」
 *    （按**全部可打标签的素材**计数——同一个标签图 / 声 / 视频都在用）；
 * 2. 点一行 = 给这个文件加上 / 去掉那个 **tag ID**（写进**那个文件自己的 `.meta`**、可撤销；
 *    音频旧数据在 `audio.tags`，读统一走 `assetTagsOfMeta`）；
 * 3. **没有新建入口**（这里只从已有的标签里挑）；
 * 4. 空态 / 目标文件查不到时的提示。
 *
 * 目标文件必须**在资源树里**才勾得动：清单就是树里的素材——
 * 素材一删，它那份 `.meta` 就成了看不见的孤儿。
 */

const PROJECT = "测试";
const CLIP_A = `project:${PROJECT}/Assets/audio/theme.mp3`;
const CLIP_B = `project:${PROJECT}/Assets/audio/battle.wav`;
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
        ],
      },
    ],
  },
];

function seed(input?: {
  readonly tags?: (string | null)[];
  readonly meta?: Record<string, { name?: string; tags?: number[] }>;
}): void {
  projectHistory.reset({
    ...createEmptyProject(PROJECT),
    ...(input?.tags === undefined ? {} : { audioTags: [...input.tags] }),
  });
  // 显示名与标签住在**那个文件自己的 `.meta`** 里（v24）：种表 + 派生索引
  const table = audioMetaTable(input?.meta ?? {});
  metaHistory.reset(table);
  useEditorStore.setState({
    doc: projectHistory.current,
    assetMetaTable: table,
    assetMetas: createAssetMetas(Object.entries(table).map(([id, meta]) => ({ id, meta }))),
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    project: { list: [], current: PROJECT, tree: TREE, busy: false, error: "" },
  });
}

/** 素材 meta 的真源表（标签就在 `audio.tags` 里）。 */
const metas = (): ReturnType<typeof useEditorStore.getState>["assetMetaTable"] =>
  useEditorStore.getState().assetMetaTable;

/** 读这个文件的标签（任何素材都写顶层 `tags`，音频旧数据在 `audio.tags`——统一走 `assetTagsOfMeta`）。 */
const audioOf = (id: string): { name?: string; tags?: number[] } | undefined => {
  const meta = metas()[id];
  // 名字与标签都空了 = 「没整理过」（meta 只剩 guid / importer 那个壳，等同 undefined）
  if (meta === undefined || (meta.audio === undefined && assetTagsOfMeta(meta).length === 0)) {
    return undefined;
  }

  const tags = assetTagsOfMeta(meta);
  return { name: meta.audio?.name, tags: tags.length === 0 ? undefined : [...tags] };
};

const rowFor = (id: number): HTMLElement => {
  const row = screen
    .getAllByTestId("audio-tag-row")
    .find((item) => item.getAttribute("data-id") === String(id));
  if (row === undefined) {
    throw new Error(`选择框里没有这个 tag：${id}`);
  }

  return row;
};

const toggleFor = (id: number): HTMLElement =>
  rowFor(id).querySelector('[data-testid="audio-tag-toggle"]') as HTMLElement;

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  projectHistory.reset(createEmptyProject());
  // 素材 meta 是**第三条轨道**：不重置它，上一个用例的勾选会漏到下一个用例
  metaHistory.reset({});
  useEditorStore.setState({ assetMetaTable: {}, assetMetas: emptyAssetMetas() });
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    mode: "edit",
    audioTags: false,
    projectSaveState: "saved",
    project: { list: [], current: null, tree: [], busy: false, error: "" },
  });
});

describe("列标签 / 勾选", () => {
  it("列出标签表里的全部标签（含没人用的），按用量排序并标 ID", () => {
    seed({
      tags: ["战斗", "紧张", "环境"],
      meta: { [CLIP_A]: { tags: [0, 1] }, [CLIP_B]: { tags: [0] } },
    });
    render(<AudioTagDialog assetId={CLIP_A} onClose={() => undefined} />);

    expect(screen.getAllByTestId("audio-tag-row").map((row) => row.getAttribute("data-id"))).toEqual([
      "0",
      "1",
      "2",
    ]);
    expect(rowFor(0).getAttribute("data-count")).toBe("2");
    // 序号直接写数字（不写 `#`），用量照旧
    expect(rowFor(0).textContent).toContain("0");
    expect(rowFor(0).textContent).not.toContain("#");
    expect(rowFor(0).textContent).toContain("2 个文件在用");
    expect(rowFor(2).textContent).toContain("0 个文件在用");

    // 这个文件本来就有 0 / 1 → 勾着；2 没有
    expect(rowFor(0).getAttribute("data-selected")).toBe("true");
    expect(rowFor(1).getAttribute("data-selected")).toBe("true");
    expect(rowFor(2).getAttribute("data-selected")).toBe("false");
  });

  it("点一行 = 给这个文件加上那个 tag ID；再点 = 去掉（写进文件自己的 `.meta`，可撤销）", () => {
    seed({ tags: ["战斗", "紧张"], meta: { [CLIP_A]: { tags: [0] }, [CLIP_B]: { tags: [1] } } });
    render(<AudioTagDialog assetId={CLIP_A} onClose={() => undefined} />);

    fireEvent.click(toggleFor(1));
    expect(audioOf(CLIP_A)?.tags).toEqual([0, 1]);

    act(() => {
      useEditorStore.getState().undo();
    });
    expect(audioOf(CLIP_A)?.tags).toEqual([0]);
    expect(rowFor(1).getAttribute("data-selected")).toBe("false");

    // 去掉 #0（别的文件上那份不受影响）
    fireEvent.click(toggleFor(0));
    expect(audioOf(CLIP_A)).toBeUndefined();
    expect(audioOf(CLIP_B)?.tags).toEqual([1]);
  });

  it("洞（删过的 tag）不出现在列表里", () => {
    seed({ tags: ["战斗", null, "环境"], meta: { [CLIP_A]: { tags: [2] } } });
    render(<AudioTagDialog assetId={CLIP_A} onClose={() => undefined} />);

    expect(screen.getAllByTestId("audio-tag-row").map((row) => row.getAttribute("data-id"))).toEqual([
      "2",
      "0",
    ]);
  });

  it("「标签…」入口：先收起本框，再打开标签表窗口（改名 / 删除在那边做）", () => {
    seed({ tags: ["战斗"], meta: { [CLIP_A]: { tags: [0] } } });
    let closed = 0;
    render(
      <AudioTagDialog
        assetId={CLIP_A}
        onClose={() => {
          closed += 1;
        }}
      />,
    );

    // 本框里只做「给这个文件勾哪个」：标签表从「标签…」按钮（属性面板）/ 工程菜单进
    fireEvent.click(screen.getByTestId("audio-tag-close"));

    expect(closed).toBe(1);
  });
});

describe("只从已有标签里挑（没有新建入口）", () => {
  it("界面上没有新建输入框与「添加」按钮", () => {
    seed({ tags: ["战斗"], meta: { [CLIP_A]: { tags: [0] } } });
    render(<AudioTagDialog assetId={CLIP_A} onClose={() => undefined} />);

    expect(screen.queryByTestId("audio-tag-new")).toBeNull();
    expect(screen.queryByTestId("audio-tag-create")).toBeNull();
  });

  it("标签表是空的：只显示空态提示（想建标签去「标签」窗口）", () => {
    seed();
    render(<AudioTagDialog assetId={CLIP_A} onClose={() => undefined} />);

    expect(screen.getByTestId("audio-tag-empty").textContent).toContain("还没有标签");
    expect(screen.queryAllByTestId("audio-tag-row")).toHaveLength(0);
  });
});

describe("目标与关闭", () => {
  it("标题写清是哪个文件；关掉调用 onClose", () => {
    seed({ tags: ["战斗"], meta: { [CLIP_A]: { name: "开场曲", tags: [0] } } });
    const onClose = () => undefined;
    render(<AudioTagDialog assetId={CLIP_A} onClose={onClose} />);

    expect(screen.getByTestId("audio-tag-dialog").textContent).toContain("开场曲");

    fireEvent.click(screen.getByTestId("audio-tag-close"));
  });

  it("素材已从盘上删掉（它那份 `.meta` 成了孤儿）：清单里没有它，标签一个都没勾上", () => {
    seed({ tags: ["战斗"], meta: { [GONE]: { name: "删掉的那首", tags: [0] } } });
    render(<AudioTagDialog assetId={GONE} onClose={() => undefined} />);

    // v24 起清单**就是树里的音频**：盘上那份 `.meta` 谁也看不见（不再有 missing 行），
    // 所以标题带不出它的名字，只剩一句说明
    expect(screen.getByTestId("audio-tag-dialog").textContent).toContain("这个文件已经不在了");
    // 勾选状态读的是那个文件自己的 meta，而它不在清单里 → 表里的标签一个都没勾上
    expect(rowFor(0).getAttribute("data-selected")).toBe("false");
  });

  it("目标 id 在清单里查不到（防御分支）：只提示、不再给新建那一行", () => {
    seed({ tags: ["战斗"] });
    render(
      <AudioTagDialog
        assetId={`project:${PROJECT}/Assets/audio/unknown.mp3`}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByTestId("audio-tag-dialog").textContent).toContain("这个文件已经不在了");
    expect(screen.queryByTestId("audio-tag-new")).toBeNull();
  });
});
