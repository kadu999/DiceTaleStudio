import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createAssetMetas, createEmptyProject, emptyAssetMetas } from "@dts/document";
import { MenuBar } from "../src/app/MenuBar";
import { BgmControl, bgmDeliveryHint } from "../src/app/BgmControl";
import { BgmDialog } from "../src/app/BgmDialog";
import { metaHistory } from "../src/state/store-core";
import { projectHistory, sceneHistory, useEditorStore } from "../src/state/editor-store";
import type { ResourceTreeNode } from "../src/services/project-api";
import { audioMetaTable } from "./asset-meta-fixtures";

/**
 * **背景音乐**（v16）的界面：顶栏「音乐」按钮 + 「背景音乐」弹框。
 *
 * 两个位置分工（这一份钉住，真浏览器在 `e2e/global-bgm.spec.ts`）：
 * 1. **顶栏按钮**：只显示状态（`♫ 曲名（播放中 / 已暂停）`）并**打开弹框**；
 * 2. **弹框**：列出项目 `Assets/audio/` 下的音频（**按显示名排序、不分组**，一行只有
 *    「哪一首 + 路径」；标签靠清单上方那一排**勾**），**点一首就播**，底部是暂停 · 继续 /
 *    停止 / 关闭，外加一行「现在在放什么」；这一页**不写说明文字**（v19 起）；
 * 3. **音量不在这里**：那是项目级设置（「工程 → 全局设置…」）。
 *
 * **菜单里的点按交给 e2e**：Radix 的下拉靠指针序列开合，jsdom 里只有第一条用例开得起来
 * （与「两层模态交给 e2e」同一条规矩）。这里用 store 驱动来验控件上的措辞与状态。
 */

const PROJECT = "测试";
const CLIP_A = `project:${PROJECT}/Assets/audio/theme.mp3`;
const CLIP_B = `project:${PROJECT}/Assets/audio/battle.wav`;
const CLIP_C = `project:${PROJECT}/Assets/audio/environment/rain.ogg`;
/** 盘上已经没有、但旧工程文件 / 旧 `.meta` 里还留着标注的那个文件（v24 起是看不见的孤儿）。 */
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
    bgmPlayback: { clip: null, paused: false },
    bgmDialog: false,
    globalSettings: false,
    // 路径开关是**浏览器本地偏好**、存在 store 里：用例之间不会互相影响
    ui: { ...useEditorStore.getState().ui, bgmPaths: false },
  });
}

const playback = (): ReturnType<typeof useEditorStore.getState>["bgmPlayback"] =>
  useEditorStore.getState().bgmPlayback;

/** 某一首那一行（列表按显示名排序，用例不依赖它）。 */
const rowFor = (clip: string): HTMLElement => {
  const row = screen
    .getAllByTestId("bgm-track")
    .find((item) => item.getAttribute("data-clip") === clip);
  if (row === undefined) {
    throw new Error(`列表里没有这一行：${clip}`);
  }

  return row;
};

/** 列表顺序（找那一首时不靠位置，验排序时才用它）。 */
const listedClips = (): (string | null)[] =>
  screen.getAllByTestId("bgm-track").map((row) => row.getAttribute("data-clip"));

/** 勾选那一排里的某个标签（`undefined` = 标签表里没有它）。 */
const tagOptionFor = (tag: string): HTMLElement | undefined =>
  screen.queryAllByTestId("bgm-tag-option").find((item) => item.getAttribute("data-tag") === tag);

/**
 * 选中某一首（**点行只选中，不出声**）。
 *
 * 弹框里唯一会出声的键是底部那一排的「播放」——所以「放某一首」= 选中它 + 按播放。
 */
const selectRowFor = (clip: string): void => {
  fireEvent.click(rowFor(clip));
};

/** 点底部那一枚「播放」（唯一的一枚：作用在选中的那一首上）。 */
const clickPlay = (): void => {
  fireEvent.click(screen.getByTestId("bgm-play"));
};

/** 选中某一首再按播放。 */
const playRowFor = (clip: string): void => {
  selectRowFor(clip);
  clickPlay();
};

const logs = (): string[] => useEditorStore.getState().runtime.logs.map((entry) => entry.message);

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  projectHistory.reset(createEmptyProject());
  // 素材 meta 是**第三条轨道**：不重置它，上一个用例种下的显示名 / 标签会漏到下一个用例
  metaHistory.reset({});
  useEditorStore.setState({ assetMetaTable: {}, assetMetas: emptyAssetMetas() });
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
  it("列出项目里的全部音频：按**显示名**排序、不分组（路径默认不露），图片不出现", () => {
    seed();
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    // 显示名排序：battle < rain < theme（与目录无关）
    expect(listedClips()).toEqual([CLIP_B, CLIP_C, CLIP_A]);
    expect(screen.getByTestId("bgm-dialog").textContent).not.toContain("Map001");
    // 路径**默认不显示**（开关在搜索框右边）
    expect(screen.getByTestId("bgm-dialog").textContent).not.toContain("audio/environment");
    expect(screen.getByTestId("bgm-paths-toggle").getAttribute("data-shown")).toBe("false");
    // 没有目录分组那一层：清单里只有行，没有分组标题
    const list = screen.getByTestId("bgm-list");
    expect(list.children).toHaveLength(1);
  });

  it("「路径」开关：点开才在行右边显示路径（默认关）", () => {
    seed();
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    fireEvent.click(screen.getByTestId("bgm-paths-toggle"));

    expect(screen.getByTestId("bgm-paths-toggle").getAttribute("data-shown")).toBe("true");
    expect(useEditorStore.getState().ui.bgmPaths).toBe(true);
    expect(rowFor(CLIP_C).textContent).toContain("audio/environment/rain.ogg");

    fireEvent.click(screen.getByTestId("bgm-paths-toggle"));

    expect(screen.getByTestId("bgm-paths-toggle").getAttribute("data-shown")).toBe("false");
    expect(rowFor(CLIP_C).textContent).not.toContain("audio/environment");
  });

  it("起过显示名的按显示名排（分组那层壳没了，名字就是唯一的顺序）", () => {
    seed({ meta: { [CLIP_C]: { name: "aaa 雨声" } } });
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    expect(listedClips()).toEqual([CLIP_C, CLIP_B, CLIP_A]);
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

  it("搜索按文件名 / 路径过滤（标签不归它管）；搜不到说「没有匹配的音频」", () => {
    seed({ tags: ["战斗"], meta: { [CLIP_B]: { tags: [0] } } });
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    fireEvent.change(screen.getByTestId("bgm-search"), { target: { value: "rain" } });
    expect(listedClips()).toEqual([CLIP_C]);

    fireEvent.change(screen.getByTestId("bgm-search"), { target: { value: "environment" } });
    expect(listedClips()).toEqual([CLIP_C]);

    // 标签名搜不到：标签是**勾的**（那一排），不是敲的
    fireEvent.change(screen.getByTestId("bgm-search"), { target: { value: "战斗" } });
    expect(screen.queryAllByTestId("bgm-track")).toEqual([]);

    fireEvent.change(screen.getByTestId("bgm-search"), { target: { value: "nope" } });
    expect(screen.queryAllByTestId("bgm-track")).toEqual([]);
    expect(screen.getByTestId("bgm-empty").textContent).toContain("没有匹配的音频");
  });

  it("点行只**选中**、不出声；出声的是底部那一枚「播放」", () => {
    seed();
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    // 选中不等于播放：点一下只把这一首选上（什么命令都不发）
    expect((screen.getByTestId("bgm-play") as HTMLButtonElement).disabled).toBe(true);
    selectRowFor(CLIP_B);
    expect(rowFor(CLIP_B).getAttribute("data-selected")).toBe("true");
    expect(playback()).toEqual({ clip: null, paused: false });

    clickPlay();

    expect(playback()).toEqual({ clip: CLIP_B, paused: false });
    // 选中与「真的在放」是两件事，各画各的
    expect(rowFor(CLIP_B).getAttribute("data-selected")).toBe("true");
    expect(rowFor(CLIP_B).getAttribute("data-playing")).toBe("true");
    expect(rowFor(CLIP_A).getAttribute("data-playing")).toBe("false");
    expect(rowFor(CLIP_B).textContent).toContain("●");
    expect(screen.getByTestId("bgm-status").textContent).toContain("battle");
  });

  it("选中另一首不会把正在放的那一首掐了（选中 = 让它等着）", () => {
    seed();
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    playRowFor(CLIP_B);
    selectRowFor(CLIP_A);

    expect(playback()).toEqual({ clip: CLIP_B, paused: false });
    expect(rowFor(CLIP_A).getAttribute("data-selected")).toBe("true");
    expect(rowFor(CLIP_A).getAttribute("data-playing")).toBe("false");
    expect(rowFor(CLIP_B).getAttribute("data-playing")).toBe("true");
    expect(screen.getByTestId("bgm-status").textContent).toContain("battle");
  });

  it("打开弹框时恢复「正在放的那一首」：选中 / 播放态都在，并滚到它上面", () => {
    seed();
    // 弹框没开的时候就点过一首，而且是暂停态（这正是「恢复」要还原的两件事）
    useEditorStore.setState({
      bgmPlayback: { clip: CLIP_A, paused: true },
      bgmDialog: true,
    });

    // jsdom 不实现滚动：把两个原型上的 scrollIntoView 都换成记账的桩（元素实际挂在哪个上
    // 跟着 jsdom 版本走，两边都盖住最稳），断言完把原来的属性描述符还回去
    // （jsdom 里本来就没有这个方法 → 还回去 = 删掉我们加的那个）
    const scrolled: Element[] = [];
    const spy = function spyScrollIntoView(this: Element): void {
      scrolled.push(this);
    };
    const targets: Array<Element | HTMLElement> = [Element.prototype, HTMLElement.prototype];
    const originals = targets.map((proto) => Object.getOwnPropertyDescriptor(proto, "scrollIntoView"));
    for (const proto of targets) {
      Object.defineProperty(proto, "scrollIntoView", {
        value: spy,
        writable: true,
        configurable: true,
      });
    }

    try {
      render(<BgmDialog />);

      // 选中态：那一首被选上（播放键因此可用），行上带 ⏸ 标记
      expect(rowFor(CLIP_A).getAttribute("data-selected")).toBe("true");
      expect(rowFor(CLIP_A).getAttribute("data-playing")).toBe("true");
      expect(rowFor(CLIP_A).textContent).toContain("⏸");
      expect(rowFor(CLIP_B).getAttribute("data-selected")).toBe("false");
      expect((screen.getByTestId("bgm-play") as HTMLButtonElement).disabled).toBe(false);
      // 播放态：底部那三个键与状态行都在说「暂停着」
      expect((screen.getByTestId("bgm-pause") as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByTestId("bgm-pause").textContent).toContain("继续");
      expect(screen.getByTestId("bgm-status").textContent).toContain("theme");
      expect(screen.getByTestId("bgm-status").textContent).toContain("已暂停");
      // 滚到正在放的那一行（清单长了才看得见「现在放的是哪首」）
      expect(scrolled).toEqual([rowFor(CLIP_A)]);
    } finally {
      targets.forEach((proto, index) => {
        const descriptor = originals[index];
        if (descriptor === undefined) {
          delete (proto as { scrollIntoView?: unknown }).scrollIntoView;
        } else {
          Object.defineProperty(proto, "scrollIntoView", descriptor);
        }
      });
    }
  });

  it("播放 · 暂停 · 继续 / 停止：没在放时暂停点不动；停掉之后状态行什么都不写", () => {
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
    // 没在放就什么都不说（以前那句「没在放」是废话：按钮灰着已经说明了）
    expect(screen.getByTestId("bgm-status").textContent).toBe("");
    // 选中的那一首还在：再按播放 = 从头放
    expect(rowFor(CLIP_A).getAttribute("data-selected")).toBe("true");
    expect((screen.getByTestId("bgm-play") as HTMLButtonElement).disabled).toBe(false);
    clickPlay();
    expect(playback()).toEqual({ clip: CLIP_A, paused: false });
  });

  it("行上只有「哪一首」：显示名优先，没起名字的显示文件名（标签不上行）", () => {
    seed({
      tags: ["战斗", "环境"],
      meta: { [CLIP_A]: { name: "开场曲", tags: [0] }, [CLIP_C]: { tags: [1] } },
    });
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    expect(rowFor(CLIP_A).textContent).toContain("开场曲");
    expect(rowFor(CLIP_C).textContent).toContain("rain");
    expect(rowFor(CLIP_B).textContent).toContain("battle");

    // 一行就是一整块「选中」的命中区（行本身就是按钮，里面不再套按钮），
    // 标签 chip 只在清单上方那一排（行 = 标记 + 显示名，路径默认也不露）
    for (const row of screen.getAllByTestId("bgm-track")) {
      expect(row.tagName).toBe("BUTTON");
      expect(row.querySelectorAll("button")).toHaveLength(0);
      expect(row.textContent).not.toContain("战斗");
      expect(row.textContent).not.toContain("环境");
    }
  });

  it("标签是**勾的**：那一排列的是标签表里的全部标签（含没人用的），点一下筛、再点一下取消", () => {
    seed({
      tags: ["战斗", "环境", "紧张"],
      meta: { [CLIP_A]: { name: "opening", tags: [0] }, [CLIP_C]: { tags: [0] } },
    });
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    const optionNames = (): (string | null)[] =>
      screen.getAllByTestId("bgm-tag-option").map((item) => item.getAttribute("data-tag"));

    // 表里的标签全在（按名字排 = 拼音序），**没人用**的那个也列——先建后用是正常用法
    expect(optionNames()).toEqual(["环境", "紧张", "战斗"]);

    fireEvent.click(tagOptionFor("战斗") as HTMLElement);
    expect(listedClips()).toEqual([CLIP_A, CLIP_C]);
    expect(tagOptionFor("战斗")?.getAttribute("data-selected")).toBe("true");

    // 多选 = AND：再勾一个没人用的标签，就没有匹配的了
    fireEvent.click(tagOptionFor("紧张") as HTMLElement);
    expect(screen.queryAllByTestId("bgm-track")).toEqual([]);
    expect(screen.getByTestId("bgm-empty").textContent).toContain("没有匹配的音频");

    // 取消（再点一下）
    fireEvent.click(tagOptionFor("紧张") as HTMLElement);
    expect(listedClips()).toEqual([CLIP_A, CLIP_C]);
    fireEvent.click(tagOptionFor("战斗") as HTMLElement);
    expect(listedClips()).toEqual([CLIP_B, CLIP_A, CLIP_C]);
  });

  it("标签表是空的：那一排不画（没有可勾的东西）", () => {
    seed();
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    expect(screen.queryByTestId("bgm-tag-picker")).toBeNull();
  });

  it("素材已经删了、那份 `.meta` 还留在盘上：不列出来（看不见的孤儿，点了只会发一条注定失败的命令）", () => {
    seed({ tags: ["战斗"], meta: { [GONE]: { name: "删掉的那首", tags: [0] } } });
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    // 名字排序后的清单：battle < rain < theme（删掉的那首不在树里，所以也不在清单里）
    expect(listedClips()).toEqual([CLIP_B, CLIP_C, CLIP_A]);
    expect(screen.getByTestId("bgm-dialog").textContent).not.toContain("删掉的那首");
  });

  it("弹框只负责「找 + 播」：没有编辑入口，也没有一句说明文字", () => {
    seed({ meta: { [CLIP_B]: { name: "战斗曲" } } });
    useEditorStore.setState({ bgmDialog: true });
    render(<BgmDialog />);

    expect(screen.queryByTestId("bgm-edit-files")).toBeNull();

    // 说明文字一律不写（名字 / 标签去哪儿配是另一件事，写在清单上只会占地方）
    const text = screen.getByTestId("bgm-dialog").textContent ?? "";
    for (const noise of ["属性面板", "工程 →", "编辑器自己不出声", "标签表"]) {
      expect(text).not.toContain(noise);
    }
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
