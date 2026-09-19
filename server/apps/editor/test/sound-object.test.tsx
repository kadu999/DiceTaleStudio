import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createSoundObject, type SceneObjectDoc } from "@dts/document";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { soundDeliveryHint, soundPlayBlockedReason } from "../src/panels/inspector/SoundFields";
import { displayRectOf } from "../src/panels/scene/ScenePanel";
import { KIND_LABELS, OBJECT_CATEGORIES, creatableObjects } from "../src/panels/object-kinds";
import { sceneHistory, useEditorStore, type EditorMode } from "../src/state/editor-store";
import type { RuntimeStatus } from "../src/services/runtime-client";
import type { ResourceTreeNode } from "../src/services/project-api";

/**
 * **声音对象**（动作对象）：弹框里「动作」种类下的「播放声音」。
 *
 * 它和实体一样摆在世界里（有位置 / 缩放 / 激活 / 锁定 / 显示顺序），画布上是一枚**固定的
 * 内置音频图标**（不给换贴图），另带自己的东西：**加进来的音频列表 + 选中的那条 + 层级**。
 * 而**编辑器不播放**——没有试听、不接音频解码，出声是前端的事。
 * 画布本身要真 canvas，所以这里钉住的是：种类表、创建、属性面板的分组与写回，
 * 以及「它和实体共用同一块显示矩形」这几件最容易出错的事。
 *
 * 两个地方的分工也在这里钉住：**面板**只把加进来的音频列出来单选；**「编辑声音」窗口**
 * 负责加 / 删 / 起名字（所以 store 侧的 `addSoundClip` / `removeSoundClip` 也在这一份里验）。
 */

const CLIP = "project:测试/Assets/audio/step1.mp3";
const CLIP2 = "project:测试/Assets/audio/step2.mp3";
const IMAGE = { id: "project:测试/Assets/images/Map001.png", width: 400, height: 300 };

/** 资源树：两条音频 + 一张图（「找不到」「不是音频」两种标记都要能验）。 */
const TREE: ResourceTreeNode[] = [
  {
    name: "Assets",
    path: "Assets",
    id: "project:测试/Assets",
    type: "folder",
    children: [
      {
        name: "audio",
        path: "Assets/audio",
        id: "project:测试/Assets/audio",
        type: "folder",
        children: [
          { name: "step1.mp3", path: "Assets/audio/step1.mp3", id: CLIP, type: "file" },
          { name: "step2.mp3", path: "Assets/audio/step2.mp3", id: CLIP2, type: "file" },
        ],
      },
      {
        name: "Map001.png",
        path: "Assets/images/Map001.png",
        id: IMAGE.id,
        type: "file",
      },
    ],
  },
];

function sound(clips: readonly string[] = [], layer: "bgm" | "sfx" = "sfx"): SceneObjectDoc {
  // 摆在场景正中（和实体一样）：没有贴图时显示矩形是 64×64 的兜底矩形，画内置音频徽标
  return createSoundObject({ id: "sound-1", name: "脚步", clips, layer, position: { x: 0, y: 0 } });
}

/** 手写文件里那种「有音频列表、但没写选了哪条」的样子（播放按钮该点不动）。 */
function unpicked(clips: readonly string[]): SceneObjectDoc {
  const object = sound(clips);
  return { ...object, sound: { clips: [...clips], layer: "sfx" } };
}

function seedScene(objects: SceneObjectDoc[], selected: readonly string[]): void {
  const scenes = [{ name: "Map001", objects }];
  sceneHistory.reset(scenes);
  useEditorStore.setState({
    scenes,
    activeSceneName: "Map001",
    selectedObjectIds: [...selected],
    selectedAssetId: null,
    project: { list: [], current: "测试", tree: TREE, busy: false, error: "" },
  });
}

const objectOf = (id: string): SceneObjectDoc | undefined =>
  useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === id);

const soundOf = (id: string) => objectOf(id)?.sound;

/** 面板上的音频小方块（顺序 = 加进来的先后）。 */
const chips = (): HTMLElement[] => screen.queryAllByTestId("sound-clip");

const hasGroup = (slug: string): boolean =>
  document.querySelector(`[data-group="${slug}"]`) !== null;

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    mode: "edit",
    soundPlayback: { layers: {} },
  });
});

describe("种类表：动作下的「播放声音」", () => {
  it("「动作」种类下有它、可以创建，展示名叫「播放声音」", () => {
    const action = OBJECT_CATEGORIES.find((category) => category.id === "action");
    expect(action).toBeDefined();
    expect(creatableObjects(action!).map((object) => object.kind)).toEqual(["PlaySound"]);
    expect(KIND_LABELS.PlaySound).toBe("播放声音");
  });
});

describe("创建声音对象", () => {
  it("store 建出来的是 PlaySound：摆在场景正中，带空音频列表 + 音效层", async () => {
    seedScene([], []);

    await act(async () => {
      expect(await useEditorStore.getState().createObject("PlaySound", "脚步")).toBeUndefined();
    });

    const created = useEditorStore.getState().scenes[0]?.objects[0];
    expect(created?.kind).toBe("PlaySound");
    expect(created?.sound).toEqual({ clips: [], layer: "sfx" });
    // 和实体同一个落点：世界原点（画布正中）
    expect(created?.position).toEqual({ x: 0, y: 0 });
    // 没有默认贴图：画布上画的是内置音频徽标
    expect(created?.image).toBeUndefined();
  });

  it("画布上和实体共用那一块矩形：摆了位置就有显示矩形（能点、能拖）", () => {
    const placed = sound([CLIP]);
    expect(displayRectOf(placed)).toEqual({
      center: { x: 0, y: 0 },
      size: { width: 64, height: 64 },
    });

    // 图标是固定的：手写文件里挂了个 image 也不认（矩形还是图标那块，validateScene 会警告）
    const withImage = { ...placed, image: { id: IMAGE.id, width: 120, height: 80 } };
    expect(displayRectOf(withImage)?.size).toEqual({ width: 64, height: 64 });

    // 缩放照旧一起放大
    expect(displayRectOf({ ...placed, scale: 2 })?.size).toEqual({ width: 128, height: 128 });

    // 没位置（手写文件）就是未放置，与普通对象同一个口径
    expect(displayRectOf(createSoundObject({ id: "s2", name: "脚步" }))).toBeUndefined();
  });

  it("未放置的声音对象有「落位」按钮：一键放到世界原点后就有显示矩形（画布上看得见）", () => {
    const unplaced = createSoundObject({ id: "s2", name: "脚步" });
    seedScene([unplaced], ["s2"]);
    render(<InspectorPanel />);

    expect(displayRectOf(unplaced)).toBeUndefined();
    expect(useEditorStore.getState().scenes[0]?.objects[0]?.position).toBeNull();

    fireEvent.click(screen.getByTestId("place-object-at-origin"));

    const placed = objectOf("s2");
    expect(placed?.position).toEqual({ x: 0, y: 0 });
    expect(placed === undefined ? undefined : displayRectOf(placed)?.size).toEqual({
      width: 64,
      height: 64,
    });
    // 落位之后按钮就没用了（已经摆好了）
    expect(screen.queryByTestId("place-object-at-origin")).toBeNull();
  });
});

describe("属性面板：声音组", () => {
  it("分组是「基础 / 声音」：没有渲染（图标固定、不给换贴图），没有区域 / 战争雾", () => {
    seedScene([sound([CLIP])], ["sound-1"]);
    render(<InspectorPanel />);

    const slugs = Array.from(
      document.querySelectorAll('[data-testid="object-properties"] [data-group]'),
    ).map((section) => section.getAttribute("data-group"));
    expect(slugs).toEqual(["basic", "sound"]);
    expect(hasGroup("render")).toBe(false);
    expect(hasGroup("edit")).toBe(false);
    expect(hasGroup("fog")).toBe(false);
    // 没有换贴图的入口（图标不允许改）
    expect(screen.queryByTestId("pick-texture")).toBeNull();
  });

  it("基础组和实体一样：名称 / 类型 / 激活 / 锁定 / 显示顺序 / 世界坐标 / 缩放", () => {
    seedScene([sound([CLIP])], ["sound-1"]);
    render(<InspectorPanel />);

    expect(screen.getByTestId("inspector-object-name")).toBeDefined();
    expect(screen.getByTestId("inspector-object-active")).toBeDefined();
    expect(screen.getByTestId("inspector-object-locked")).toBeDefined();
    expect(screen.getByTestId("inspector-object-sorting")).toBeDefined();
    expect(screen.getByTestId("inspector-object-x")).toBeDefined();
    expect(screen.getByTestId("inspector-object-y")).toBeDefined();
    expect(screen.getByTestId("inspector-object-scale")).toBeDefined();
  });

  it("层级是四档下拉：默认音效，改成背景音乐写进文档（可撤销）", () => {
    seedScene([sound([CLIP])], ["sound-1"]);
    render(<InspectorPanel />);

    const select = screen.getByTestId("sound-layer") as HTMLSelectElement;
    expect(select.value).toBe("sfx");
    expect(Array.from(select.options).map((option) => option.text)).toEqual([
      "背景音乐",
      "环境音",
      "音效",
      "语音",
    ]);

    fireEvent.change(select, { target: { value: "bgm" } });
    expect(soundOf("sound-1")?.layer).toBe("bgm");
    expect(useEditorStore.getState().canUndo).toBe(true);

    // 撤销回到音效（层级是文档数据，不是界面偏好）
    act(() => useEditorStore.getState().undo());
    expect(soundOf("sound-1")?.layer).toBe("sfx");
  });

  it("行序是 层级 → 音频 → 编辑音频… → 播放；小方块全列在「音频」那行，开窗口的按钮**单独一行**", () => {
    seedScene([sound([CLIP, CLIP2])], ["sound-1"]);
    render(<InspectorPanel />);

    const layer = screen.getByTestId("sound-layer");
    const list = screen.getByTestId("sound-clips");
    const edit = screen.getByTestId("sound-edit");
    const play = screen.getByTestId("sound-play");
    // 层级在音频上面（用户要求），播放排在最后
    expect(layer.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(list.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    // 开窗口的按钮**不在那排小方块里**（挨着放容易点错：一个点错是换声音、一个点错是弹窗口），
    // 它在小方块下面自己一行
    expect(list.contains(edit)).toBe(false);
    expect(list.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(edit.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(edit.textContent).toBe("编辑音频…");

    // 两条都在面板上，能选；名字输入框不在这里（在「编辑声音」窗口里）
    expect(chips().map((chip) => chip.getAttribute("data-clip"))).toEqual([CLIP, CLIP2]);
    expect(screen.queryByTestId("sound-edit-row")).toBeNull();
    expect(screen.queryByTestId("sound-name")).toBeNull();

    // 没起名字 → 显示素材文件名（去掉扩展名）；路径只进 tooltip
    expect(chips()[0]?.textContent).toBe("step1");
    expect(chips()[0]?.getAttribute("title")).toMatch(/^audio\/step1\.mp3/);
    // 第一条默认是选中的那条（新建时把第一条当选中）
    expect(chips()[0]?.getAttribute("data-selected")).toBe("true");
    expect(chips()[1]?.getAttribute("data-selected")).toBe("false");
  });

  it("点小方块 = 换选（单选，写进文档、可撤销）；再点选中的那条 = 取消选中", () => {
    seedScene([sound([CLIP, CLIP2])], ["sound-1"]);
    render(<InspectorPanel />);

    fireEvent.click(chips()[1]!);
    expect(soundOf("sound-1")?.picked).toBe(CLIP2);
    // 单选：另一条自动变回未选
    expect(chips()[0]?.getAttribute("data-selected")).toBe("false");
    expect(chips()[1]?.getAttribute("data-selected")).toBe("true");
    // 列表本身一动不动（选择是 `picked`，不是往列表里塞东西）
    expect(soundOf("sound-1")?.clips).toEqual([CLIP, CLIP2]);
    expect(useEditorStore.getState().canUndo).toBe(true);

    act(() => useEditorStore.getState().undo());
    expect(soundOf("sound-1")?.picked).toBe(CLIP);

    fireEvent.click(chips()[0]!);
    expect(soundOf("sound-1")?.picked).toBeUndefined();
    expect(chips()[0]?.getAttribute("data-selected")).toBe("false");
    // 都没选 → 播放点不了
    expect(screen.getByTestId("sound-play").hasAttribute("disabled")).toBe(true);
  });

  it("起过名字的小方块显示名字；一条都没加时写明「还没加音频」", () => {
    seedScene([sound([CLIP, CLIP2])], ["sound-1"]);
    act(() => useEditorStore.getState().setSoundClipName("sound-1", CLIP, "雷雨·高"));
    const { unmount } = render(<InspectorPanel />);
    expect(chips()[0]?.textContent).toBe("雷雨·高");
    expect(chips()[1]?.textContent).toBe("step2");
    unmount();

    seedScene([sound([])], ["sound-1"]);
    render(<InspectorPanel />);
    expect(screen.getByTestId("sound-empty").textContent).toBe("还没加音频");
    expect(chips()).toEqual([]);
    expect(screen.getByTestId("sound-play").hasAttribute("disabled")).toBe(true);
  });

  it("点「编辑」把目标交给「编辑声音」窗口", () => {
    seedScene([sound([CLIP])], ["sound-1"]);
    render(<InspectorPanel />);

    fireEvent.click(screen.getByTestId("sound-edit"));
    expect(useEditorStore.getState().soundEditor).toBe(true);
    expect(useEditorStore.getState().soundEditorTarget).toBe("sound-1");
  });
});

describe("编辑声音窗口（store 侧）：加 / 删 / 起名字", () => {
  const names = (): Record<string, string> | undefined => soundOf("sound-1")?.names;

  it("addSoundClip：加进来写进列表；一条都没选过就顺手把它选上", () => {
    seedScene([sound([])], ["sound-1"]);

    act(() => useEditorStore.getState().addSoundClip("sound-1", CLIP));
    expect(soundOf("sound-1")?.clips).toEqual([CLIP]);
    expect(soundOf("sound-1")?.picked).toBe(CLIP);
    expect(useEditorStore.getState().canUndo).toBe(true);

    // 已经加过的不会再加一遍
    act(() => useEditorStore.getState().addSoundClip("sound-1", CLIP));
    expect(soundOf("sound-1")?.clips).toEqual([CLIP]);

    // 普通对象 / 不存在的对象：直接拒掉
    act(() => expect(useEditorStore.getState().addSoundClip("不存在", CLIP)).toBe(false));
  });

  it("再加一条**不抢**当前选中的那条（正听着 A 的时候加 B，选择不该被顶掉）", () => {
    seedScene([sound([CLIP])], ["sound-1"]);

    act(() => useEditorStore.getState().addSoundClip("sound-1", CLIP2));
    expect(soundOf("sound-1")?.clips).toEqual([CLIP, CLIP2]);
    expect(soundOf("sound-1")?.picked).toBe(CLIP);

    // 想播新的那条，在面板 / 窗口里点一下就行
    act(() => useEditorStore.getState().selectSoundClip("sound-1", CLIP2));
    expect(soundOf("sound-1")?.picked).toBe(CLIP2);
  });

  it("removeSoundClip：移出去连名字一起清掉；移走选中的那条就顺到下一条", () => {
    seedScene([sound([CLIP, CLIP2])], ["sound-1"]);
    act(() => useEditorStore.getState().setSoundClipName("sound-1", CLIP, "雷雨·高"));
    act(() => useEditorStore.getState().setSoundClipName("sound-1", CLIP2, "雷雨·低"));

    act(() => useEditorStore.getState().removeSoundClip("sound-1", CLIP));
    expect(soundOf("sound-1")?.clips).toEqual([CLIP2]);
    expect(soundOf("sound-1")?.picked).toBe(CLIP2);
    expect(names()).toEqual({ [CLIP2]: "雷雨·低" });

    // 移走最后一条：列表、选中的那条、名字表都不留空壳
    act(() => useEditorStore.getState().removeSoundClip("sound-1", CLIP2));
    expect(soundOf("sound-1")).toEqual({ clips: [], layer: "sfx" });

    // 没加进来的（或已经移出去的）：拒掉
    act(() => expect(useEditorStore.getState().removeSoundClip("sound-1", CLIP)).toBe(false));
  });

  it("按文件起名字：写进 names，可撤销；留空把名字删掉", () => {
    seedScene([sound([CLIP])], ["sound-1"]);

    act(() => useEditorStore.getState().setSoundClipName("sound-1", CLIP, "雷雨·高"));
    expect(names()).toEqual({ [CLIP]: "雷雨·高" });
    expect(useEditorStore.getState().canUndo).toBe(true);

    act(() => useEditorStore.getState().undo());
    expect(names()).toBeUndefined();

    act(() => useEditorStore.getState().setSoundClipName("sound-1", CLIP, "雷雨·高"));
    act(() => useEditorStore.getState().setSoundClipName("sound-1", CLIP, "  "));
    expect(names()).toBeUndefined();
  });

  it("没加进来的音频没有名字可起（名字挂在加进来的音频上）", () => {
    seedScene([sound([])], ["sound-1"]);

    act(() =>
      expect(
        useEditorStore.getState().setSoundClipName("sound-1", "project:测试/Assets/audio/别的.mp3", "雷雨·低"),
      ).toBe(false),
    );
    expect(names()).toBeUndefined();
  });

  it("换选另一条声音**不会**动名字（名字按文件记）", () => {
    seedScene([sound([CLIP, CLIP2])], ["sound-1"]);
    act(() => useEditorStore.getState().setSoundClipName("sound-1", CLIP, "雷雨·高"));

    act(() => useEditorStore.getState().selectSoundClip("sound-1", CLIP2));
    expect(names()).toEqual({ [CLIP]: "雷雨·高" });
    expect(soundOf("sound-1")?.picked).toBe(CLIP2);
    // 列表也一动不动
    expect(soundOf("sound-1")?.clips).toEqual([CLIP, CLIP2]);
  });
});

/** 把运行态摆成「已连上服务端 / 前端连没连」的样子（只改 store，不起真连接）。 */
function seedRuntime(input: { status: RuntimeStatus; clientConnected: boolean }): void {
  useEditorStore.setState((state) => ({
    mode: "run",
    runtime: { ...state.runtime, status: input.status, clientConnected: input.clientConnected },
  }));
}

describe("播放 / 停止：能不能点", () => {
  it("一条音频都没加 / 加了但没选 → 各有各的说法；连没连前端不影响能不能点", () => {
    expect(soundPlayBlockedReason({ clips: 1, picked: CLIP })).toBeUndefined();
    expect(soundPlayBlockedReason({ clips: 0, picked: undefined })).toMatch(/先加一条音频/);
    expect(soundPlayBlockedReason({ clips: 2, picked: undefined })).toMatch(/先选一条声音/);

    const connected = { mode: "run" as EditorMode, status: "open" as RuntimeStatus, clientConnected: true };
    expect(soundDeliveryHint(connected)).toBeUndefined();
    expect(soundDeliveryHint({ ...connected, mode: "edit" })).toMatch(/还没连上服务端/);
    expect(soundDeliveryHint({ ...connected, status: "connecting" })).toMatch(/还没连上服务端/);
    expect(soundDeliveryHint({ ...connected, clientConnected: false })).toMatch(/前端（Unity）未连接/);
  });

  it("编辑态也能点：两个按钮的 title 都写明「已记录、等连上补发」", () => {
    seedScene([sound([CLIP])], ["sound-1"]);
    render(<InspectorPanel />);

    for (const id of ["sound-play", "sound-stop"]) {
      const button = screen.getByTestId(id);
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(button.getAttribute("title")).toMatch(/已记录：编辑器还没连上服务端/);
    }
  });

  it("运行态但前端没连：照样能点，title 换成「前端未连接，等它连上补发」", () => {
    seedScene([sound([CLIP])], ["sound-1"]);
    seedRuntime({ status: "open", clientConnected: false });
    render(<InspectorPanel />);

    const play = screen.getByTestId("sound-play");
    expect(play.hasAttribute("disabled")).toBe(false);
    expect(play.getAttribute("title")).toMatch(/前端（Unity）未连接/);
  });

  it("加了音频但没选 → 只有「播放」置灰（写明先选一条），「停止」照样能点", () => {
    seedScene([unpicked([CLIP])], ["sound-1"]);
    seedRuntime({ status: "open", clientConnected: true });
    render(<InspectorPanel />);

    expect(screen.getByTestId("sound-play").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("sound-play").getAttribute("title")).toMatch(/先选一条声音/);
    expect(screen.getByTestId("sound-stop").hasAttribute("disabled")).toBe(false);
  });

  it("一条音频都没加 → 「播放」置灰并写明先去加一条", () => {
    seedScene([sound([])], ["sound-1"]);
    seedRuntime({ status: "open", clientConnected: true });
    render(<InspectorPanel />);

    expect(screen.getByTestId("sound-play").getAttribute("title")).toMatch(/先加一条音频/);
  });
});

describe("播放 / 停止：面板上看得见的状态", () => {
  const playButton = (): HTMLElement => screen.getByTestId("sound-play");
  const status = (): HTMLElement => screen.getByTestId("sound-status");

  it("点「播放」→ 按钮写成「播放中」并高亮、跳出会动的声音条，旁边写明本层在播什么；点「停止」→ 回到原样", () => {
    seedScene([sound([CLIP])], ["sound-1"]);
    render(<InspectorPanel />);

    // 还没点：按钮是「播放」，状态写明这一层没在播，也没有动效图标
    expect(playButton().textContent).toBe("▶ 播放");
    expect(playButton().getAttribute("data-playing")).toBe("false");
    expect(status().getAttribute("data-state")).toBe("idle");
    expect(status().textContent).toBe("本层没在播");
    expect(screen.queryByTestId("sound-wave")).toBeNull();

    act(() => useEditorStore.getState().playSound("sound-1"));
    expect(playButton().textContent?.trim()).toBe("播放中");
    expect(playButton().getAttribute("data-playing")).toBe("true");
    expect(playButton().className).toMatch(/editor-accent/);
    // 会动的那个图标：三根声音条（关键帧在 styles/index.css 里）
    const wave = screen.getByTestId("sound-wave");
    expect(wave.querySelectorAll("span")).toHaveLength(3);
    expect(playButton().contains(wave)).toBe(true);
    expect(status().getAttribute("data-state")).toBe("playing");
    expect(status().textContent).toBe("本层正在播：step1");

    act(() => useEditorStore.getState().stopSound("sound-1"));
    expect(playButton().textContent).toBe("▶ 播放");
    expect(playButton().getAttribute("data-playing")).toBe("false");
    expect(screen.queryByTestId("sound-wave")).toBeNull();
    expect(status().getAttribute("data-state")).toBe("idle");
    expect(status().textContent).toBe("本层没在播");
  });

  it("本层被**别的对象**占着时，写明是谁占的（同层同时只响一条）", () => {
    const other = { ...sound([CLIP]), id: "sound-2", name: "开门" };
    seedScene([sound([CLIP]), other], ["sound-1"]);
    render(<InspectorPanel />);

    act(() => useEditorStore.getState().playSound("sound-2"));

    // 选中的还是 sound-1：它自己没在播，但本层被「开门」占着
    expect(playButton().getAttribute("data-playing")).toBe("false");
    expect(playButton().textContent).toBe("▶ 播放");
    expect(status().getAttribute("data-state")).toBe("busy");
    expect(status().textContent).toBe("本层正被「开门」占着");
  });

  it("「播放中」是运行态：不写文档、不进撤销栈；切场景就回到「本层没在播」", () => {
    seedScene([sound([CLIP])], ["sound-1"]);
    render(<InspectorPanel />);

    act(() => useEditorStore.getState().playSound("sound-1"));
    expect(status().getAttribute("data-state")).toBe("playing");
    // 播放只是「记账 + 下发指令」：文档没被动过，所以撤销栈里不该多出记录
    expect(useEditorStore.getState().canUndo).toBe(false);
    expect(soundOf("sound-1")?.picked).toBe(CLIP);

    // 切场景会把记账清掉（记的是「这个场景现在该响什么」）
    act(() => useEditorStore.getState().setActiveScene("Map001"));
    act(() => useEditorStore.setState({ selectedObjectIds: ["sound-1"] }));
    expect(status().getAttribute("data-state")).toBe("idle");
    expect(status().textContent).toBe("本层没在播");
  });
});

describe("播放 / 停止：store 的记账与日志", () => {
  const logs = (): string[] => useEditorStore.getState().runtime.logs.map((entry) => entry.message);
  const playback = () => useEditorStore.getState().soundPlayback;

  it("编辑器没连服务端时也**记账**，只是把「等连上补发」写进日志（编辑器自己不出声）", () => {
    seedScene([sound([CLIP])], ["sound-1"]);

    expect(useEditorStore.getState().playSound("sound-1")).toBeUndefined();
    expect(playback().layers.sfx?.objectId).toBe("sound-1");
    expect(logs().at(-1)).toMatch(/已记录播放：层级 音效/);
    expect(logs().at(-1)).toMatch(/连上后自动补发/);

    expect(useEditorStore.getState().stopSound("sound-1")).toBeUndefined();
    expect(playback().layers.sfx).toBeUndefined();
    expect(logs().at(-1)).toMatch(/已记录停止：层级 音效/);
  });

  it("记账只记**选中的那一条**；同一层再播别的对象就顶掉", () => {
    // 两条音频、选中第二条：播的就是它（不是列表里的第一条）
    seedScene([sound([CLIP, CLIP2])], ["sound-1"]);
    act(() => useEditorStore.getState().selectSoundClip("sound-1", CLIP2));

    act(() => useEditorStore.getState().playSound("sound-1"));
    expect(playback().layers.sfx?.clips).toEqual([CLIP2]);

    const second = { ...sound([CLIP]), id: "sound-2" };
    act(() => {
      useEditorStore.setState((state) => ({
        scenes: [{ name: "Map001", objects: [...state.scenes[0]!.objects, second] }],
      }));
      useEditorStore.getState().playSound("sound-2");
    });

    expect(playback().layers.sfx?.objectId).toBe("sound-2");
    expect(playback().layers.sfx?.clips).toEqual([CLIP]);
  });

  it("手写文件里加了音频却没写选中的那条：不记账，提示先选一条", () => {
    seedScene([unpicked([CLIP, CLIP2])], ["sound-1"]);

    expect(useEditorStore.getState().playSound("sound-1")).toBeUndefined();
    expect(playback().layers).toEqual({});
    expect(logs().at(-1)).toMatch(/还没选声音/);
  });

  it("没有音频时不记账；普通对象 / 不存在的对象也给明确提示", () => {
    seedScene([sound([])], ["sound-1"]);

    expect(useEditorStore.getState().playSound("sound-1")).toBeUndefined();
    expect(playback().layers).toEqual({});
    expect(logs().at(-1)).toMatch(/还没有加音频/);

    expect(useEditorStore.getState().playSound("不存在")).toBeUndefined();
    expect(logs().at(-1)).toMatch(/找不到这个声音对象/);
  });

  it("编辑器没连服务端时补发不做事（前端不在时也不发）", () => {
    seedScene([sound([CLIP])], ["sound-1"]);
    act(() => useEditorStore.getState().playSound("sound-1"));

    expect(useEditorStore.getState().flushSoundPlayback()).toBe(0);
  });

  it("切场景会清掉记账（记的对象属于上一个场景）", () => {
    seedScene([sound([CLIP])], ["sound-1"]);
    act(() => useEditorStore.getState().playSound("sound-1"));
    expect(playback().layers.sfx).toBeDefined();

    act(() => useEditorStore.getState().setActiveScene("Map001"));
    expect(playback().layers).toEqual({});
  });

  it("页面里永远没有播放器：编辑声音不会让编辑器自己响", () => {
    seedScene([sound([CLIP])], ["sound-1"]);
    render(<InspectorPanel />);

    expect(document.querySelector("audio")).toBeNull();
  });
});
