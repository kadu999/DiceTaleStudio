import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createEmptyProject } from "@dts/document";
import { MenuBar } from "../src/app/MenuBar";
import { BgmControl, bgmDeliveryHint } from "../src/app/BgmControl";
import { BgmDialog } from "../src/app/BgmDialog";
import { projectHistory, sceneHistory, useEditorStore } from "../src/state/editor-store";
import type { ResourceTreeNode } from "../src/services/project-api";

/**
 * **背景音乐**（v16）的界面：顶栏「音乐」按钮 + 「背景音乐」弹框。
 *
 * 两个位置分工（这一份钉住，真浏览器在 `e2e/global-bgm.spec.ts`）：
 * 1. **顶栏按钮**：只显示状态（`♫ 曲名（播放中 / 已暂停）`）并**打开弹框**；
 * 2. **弹框**：列出项目 `Assets/audio/` 下的音频（按目录分组 + 搜索），**点一首就播**，
 *    底部是暂停 · 继续 / 停止 / 关闭，外加一行「现在在放什么」；
 * 3. **音量不在这里**：那是项目级设置（「工程 → 全局设置…」）。
 *
 * **菜单里的点按交给 e2e**：Radix 的下拉靠指针序列开合，jsdom 里只有第一条用例开得起来
 * （与「两层模态交给 e2e」同一条规矩）。这里用 store 驱动来验控件上的措辞与状态。
 */

const PROJECT = "测试";
const CLIP_A = `project:${PROJECT}/Assets/audio/theme.mp3`;
const CLIP_B = `project:${PROJECT}/Assets/audio/battle.wav`;
const CLIP_C = `project:${PROJECT}/Assets/audio/environment/rain.ogg`;
/** 标注里还留着、盘上已经没有的那个文件（只在「音频文件」窗口里露面）。 */
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

function seed(input?: {
  readonly tags?: (string | null)[];
  readonly meta?: Record<string, { name?: string; tags?: number[] }>;
}): void {
  projectHistory.reset({
    ...createEmptyProject(PROJECT),
    ...(input?.tags === undefined ? {} : { audioTags: [...input.tags] }),
    ...(input?.meta === undefined ? {} : { audioMeta: input.meta }),
  });
  useEditorStore.setState({
    doc: projectHistory.current,
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    project: { list: [], current: PROJECT, tree: TREE, busy: false, error: "" },
    bgmPlayback: { clip: null, paused: false },
    bgmDialog: false,
    globalSettings: false,
  });
}

const playback = (): ReturnType<typeof useEditorStore.getState>["bgmPlayback"] =>
  useEditorStore.getState().bgmPlayback;

/** 某一首那一行（列表的顺序由「目录分组 + 路径排序」决定，用例不依赖它）。 */
const rowFor = (clip: string): HTMLElement => {
  const row = screen
    .getAllByTestId("bgm-track")
    .find((item) => item.getAttribute("data-clip") === clip);
  if (row === undefined) {
    throw new Error(`列表里没有这一行：${clip}`);
  }

  return row;
};

/** 点行上的「播这一首」（标签 chip 是筛选用途，不触发播放）。 */
const playRowFor = (clip: string): void => {
  const button = rowFor(clip).querySelector('[data-testid="bgm-track-play"]');
  if (button === null) {
    throw new Error(`这一行没有播放按钮：${clip}`);
  }

  fireEvent.click(button);
};

/** 行上的某个标签 chip。 */
const tagChipFor = (clip: string, tag: string): HTMLElement => {
  const chip = [...rowFor(clip).querySelectorAll<HTMLElement>('[data-testid="bgm-tag"]')].find(
    (item) => item.getAttribute("data-tag") === tag,
  );
  if (chip === undefined) {
    throw new Error(`这一行没有标签 ${tag}：${clip}`);
  }

  return chip;
};

const logs = (): string[] => useEditorStore.getState().runtime.logs.map((entry) => entry.message);

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  projectHistory.reset(createEmptyProject());
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    mode: "edit",
    bgmPlayback: { clip: null, paused: false },
    bgmDialog: false,
    globalSettings: false,
    projectSaveState: "saved",
    project: { list: [], current: null, tree: [], busy: false, error: "" },
    runtime: { ...useEditorStore.getState().runtime, status: "idle", client: null, logs: [] },
  });
});

describe("顶栏「音乐」按钮", () => {
  it("没点过时就是一句「背景音乐」（没有默认曲这回事了）", () => {
    seed();
    render(<BgmControl />);

    expect(screen.getByTestId("bgm-control").textContent).toContain("背景音乐");
    expect(screen.getByTestId("bgm-control").getAttribute("data-state")).toBe("idle");
  });

  it("点一首之后写「播放中」并带上曲名；暂停写「已暂停」", () => {
    seed();
    render(<BgmControl />);

    act(() => {
      useEditorStore.getState().playBgm(CLIP_A);
    });

    expect(playback()).toEqual({ clip: CLIP_A, paused: false });
    expect(screen.getByTestId("bgm-control").textContent).toContain("theme");
    expect(screen.getByTestId("bgm-control").textContent).toContain("播放中");
    expect(screen.getByTestId("bgm-control").getAttribute("data-state")).toBe("playing");
    // 前端还没连上：只记账 + 写一条「已记录」，等它连上补发
    expect(logs().some((line) => line.includes("已记录"))).toBe(true);

    act(() => {
      useEditorStore.getState().pauseBgm();
    });

    expect(screen.getByTestId("bgm-control").textContent).toContain("已暂停");
    expect(screen.getByTestId("bgm-control").getAttribute("data-state")).toBe("paused");
  });

  it("点一下就是「打开弹框」（按钮本身不发命令）", () => {
    seed();
    render(<BgmControl />);

    fireEvent.click(screen.getByTestId("bgm-control"));

    expect(useEditorStore.getState().bgmDialog).toBe(true);
  });

  it("没在放时暂停没有意义：不记账、写一条说明（按钮在弹框里禁用，e2e 覆盖）", () => {
    seed();
    render(<BgmControl />);

    act(() => {
      useEditorStore.getState().pauseBgm();
    });

    expect(playback()).toEqual({ clip: null, paused: false });
    expect(logs().some((line) => line.includes("先在弹框里点一首"))).toBe(true);
  });

  it("操作提示与声音 / 视频两组同一套措辞（没连上时点下去会怎样）", () => {
    expect(bgmDeliveryHint({ mode: "edit", status: "idle", clientConnected: false })).toContain(
      "编辑器还没连上服务端",
    );
    expect(bgmDeliveryHint({ mode: "run", status: "open", clientConnected: false })).toContain(
      "前端（Unity）未连接",
    );
    expect(bgmDeliveryHint({ mode: "run", status: "open", clientConnected: true })).toBeUndefined();
  });
});

describe("「背景音乐」弹框", () => {
  it("列出项目里的全部音频（按目录分组，图片不出现）", () => {
    seed();
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    // 目录分组：`audio/` 底下的两首先列（目录内按路径排序），再是 `audio/environment/`
    const clips = screen.getAllByTestId("bgm-track").map((row) => row.getAttribute("data-clip"));
    expect(clips).toEqual([CLIP_B, CLIP_A, CLIP_C]);
    expect(screen.getByTestId("bgm-dialog").textContent).toContain("audio");
    expect(screen.getByTestId("bgm-dialog").textContent).toContain("audio/environment");
    expect(screen.getByTestId("bgm-dialog").textContent).not.toContain("Map001");
  });

  it("项目里一个音频都没有：说清去哪儿放素材", () => {
    seed();
    useEditorStore.setState({
      bgmDialog: true,
      project: { list: [], current: PROJECT, tree: [], busy: false, error: "" },
    });
    render(<BgmDialog />);

    expect(screen.getByTestId("bgm-empty").textContent).toContain("Assets/audio/");
  });

  it("搜索按文件名 / 路径过滤；搜不到说「没有匹配的音频」", () => {
    seed();
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    fireEvent.change(screen.getByTestId("bgm-search"), { target: { value: "rain" } });
    expect(screen.getAllByTestId("bgm-track").map((row) => row.getAttribute("data-clip"))).toEqual([
      CLIP_C,
    ]);

    fireEvent.change(screen.getByTestId("bgm-search"), { target: { value: "environment" } });
    expect(screen.getAllByTestId("bgm-track").map((row) => row.getAttribute("data-clip"))).toEqual([
      CLIP_C,
    ]);

    fireEvent.change(screen.getByTestId("bgm-search"), { target: { value: "nope" } });
    expect(screen.queryAllByTestId("bgm-track")).toEqual([]);
    expect(screen.getByTestId("bgm-empty").textContent).toContain("没有匹配的音频");
  });

  it("点一行就播（一条命令，命令里带 clip）；当前那一首标出来", () => {
    seed();
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    playRowFor(CLIP_B);

    expect(playback()).toEqual({ clip: CLIP_B, paused: false });
    expect(rowFor(CLIP_B).getAttribute("data-active")).toBe("true");
    expect(rowFor(CLIP_A).getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("bgm-status").textContent).toContain("battle");
  });

  it("暂停 · 继续 / 停止：没在放时暂停点不动；停止后回到「没在放」", () => {
    seed();
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    expect((screen.getByTestId("bgm-pause") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("bgm-stop") as HTMLButtonElement).disabled).toBe(true);

    playRowFor(CLIP_A);
    expect((screen.getByTestId("bgm-pause") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId("bgm-pause"));
    expect(playback()).toEqual({ clip: CLIP_A, paused: true });
    expect(screen.getByTestId("bgm-pause").textContent).toContain("继续");

    fireEvent.click(screen.getByTestId("bgm-pause"));
    expect(playback()).toEqual({ clip: CLIP_A, paused: false });
    expect(screen.getByTestId("bgm-pause").textContent).toContain("暂停");

    fireEvent.click(screen.getByTestId("bgm-stop"));
    expect(playback()).toEqual({ clip: null, paused: false });
    expect(screen.getByTestId("bgm-status").textContent).toContain("没在放");
  });

  it("显示名优先，行上带标签（按 tag ID 解出名字）：起过名的显示名字，没起名的显示文件名", () => {
    seed({
      tags: ["战斗", "环境"],
      meta: { [CLIP_A]: { name: "开场曲", tags: [0] }, [CLIP_C]: { tags: [1] } },
    });
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    expect(rowFor(CLIP_A).textContent).toContain("开场曲");
    expect(rowFor(CLIP_A).getAttribute("data-tags")).toBe("战斗");
    expect(rowFor(CLIP_C).textContent).toContain("rain");
    expect(rowFor(CLIP_C).textContent).toContain("环境");
    expect(rowFor(CLIP_B).textContent).toContain("battle");
  });

  it("按标签搜到；点行上的标签 = 筛它；「清除筛选」把列表放回去", () => {
    seed({
      tags: ["战斗"],
      meta: { [CLIP_A]: { name: "开场曲", tags: [0] }, [CLIP_C]: { tags: [0] } },
    });
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    fireEvent.change(screen.getByTestId("bgm-search"), { target: { value: "战斗" } });
    expect(screen.getAllByTestId("bgm-track").map((row) => row.getAttribute("data-clip"))).toEqual([
      CLIP_C,
      CLIP_A,
    ]);

    fireEvent.change(screen.getByTestId("bgm-search"), { target: { value: "" } });
    fireEvent.click(tagChipFor(CLIP_A, "战斗"));

    expect(screen.getAllByTestId("bgm-track").map((row) => row.getAttribute("data-clip"))).toEqual([
      CLIP_C,
      CLIP_A,
    ]);
    expect(screen.getByTestId("bgm-tag-filter").getAttribute("data-tag")).toBe("战斗");

    fireEvent.click(screen.getByTestId("bgm-clear-filter"));
    expect(screen.getAllByTestId("bgm-track")).toHaveLength(3);
  });

  it("标注指向已经删掉的文件：不列出来（点了只会发出一条注定失败的命令）", () => {
    seed({ tags: ["战斗"], meta: { [GONE]: { name: "删掉的那首", tags: [0] } } });
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    // 目录分组后的 DOM 顺序：audio 底下的两首（战斗、主题）在前，再是 audio/environment 的雨声
    expect(screen.queryAllByTestId("bgm-track").map((row) => row.getAttribute("data-clip"))).toEqual([
      CLIP_B,
      CLIP_A,
      CLIP_C,
    ]);
    expect(screen.getByTestId("bgm-dialog").textContent).not.toContain("删掉的那首");
  });

  it("弹框只负责「找 + 播」：名字 / 标签的编辑入口在属性面板与「标签」窗口（这里不再有「编辑…」按钮）", () => {
    seed({ meta: { [CLIP_B]: { name: "战斗曲" } } });
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    expect(screen.queryByTestId("bgm-edit-files")).toBeNull();
    // 提示里写清了去哪儿配
    expect(screen.getByTestId("bgm-dialog").textContent).toContain("属性面板");
    expect(screen.getByTestId("bgm-dialog").textContent).toContain("标签");
  });

  it("「关闭」把弹框关掉（状态在 store 里，下次还能再开）", () => {
    seed();
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    fireEvent.click(screen.getByTestId("bgm-close"));

    expect(useEditorStore.getState().bgmDialog).toBe(false);
  });
});

describe("与项目设置分离", () => {
  it("顶栏与弹框都不提供歌单 / 默认曲 / 循环那一套（它们不存在了）", () => {
    seed();
    useEditorStore.setState({ bgmDialog: true });
    render(
      <>
        <MenuBar compact={false} />
        <BgmDialog />
      </>,
    );

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("默认曲");
    expect(text).not.toContain("歌单");
    expect(text).not.toContain("设为默认");
    expect(text).not.toContain("循环");
  });
});
