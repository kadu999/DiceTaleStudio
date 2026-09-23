import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DEFAULT_SLOT_COMPONENT,
  createMapObject,
  createGameObject,
  createSoundObject,
  createTeleportObject,
  videoDataOf,
  withFeature,
  type GameObjectDoc,
  type VideoDataDoc,
} from "@dts/document";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { videoDeliveryHint, videoPlayBlockedReason } from "../src/panels/inspector/VideoFields";
import { sceneHistory, useEditorStore, type EditorMode } from "../src/state/editor-store";
import type { RuntimeStatus } from "../src/services/runtime-client";
import type { ResourceTreeNode } from "../src/services/project-api";

/**
 * **地图 / 贴图上的视频**（v14 起）：一组视频 + 选中哪条 + 循环 / 声音两个开关。
 *
 * 三个地方分工，这一份钉前两个（第三个是真 canvas / 两层模态，交给 e2e）：
 * 1. **属性面板**：把加进来的视频列成小方块（选放哪条）+ 播放 / 暂停 / 停止 + 两个开关；
 * 2. **store**：加 / 删 / 改名 / 选中 / 开关都是文档命令（可撤销、自动存盘），
 *    播放 / 暂停 / 停止是**运行态记账**（不写文档、不进撤销栈、前端连上补发）；
 * 3. 「编辑视频」窗口与「选择视频」弹框（`e2e/video-object.spec.ts`）。
 *
 * 与声音的两处关键区别也在这里钉住：
 * - 视频挂在**对象自己身上**（v21 起只有地图与贴图能带，精灵不行），声音是单独一种动作对象；
 * - **每个对象各自一条、互不影响**，不像声音那样按层级互相顶掉。
 */

const CLIP = "project:测试/Assets/video/opening.mp4";
const CLIP2 = "project:测试/Assets/video/rain.webm";
const IMAGE = { id: "project:测试/Assets/images/Map001.png", width: 400, height: 300 };
const GRID = { width: 8, height: 6 };

/** 资源树：两条视频（一条 mp4、一条 webm）+ 一张图。 */
const TREE: ResourceTreeNode[] = [
  {
    name: "Assets",
    path: "Assets",
    id: "project:测试/Assets",
    type: "folder",
    children: [
      {
        name: "video",
        path: "Assets/video",
        id: "project:测试/Assets/video",
        type: "folder",
        children: [
          { name: "opening.mp4", path: "Assets/video/opening.mp4", id: CLIP, type: "file" },
          { name: "rain.webm", path: "Assets/video/rain.webm", id: CLIP2, type: "file" },
        ],
      },
      { name: "Map001.png", path: "Assets/images/Map001.png", id: IMAGE.id, type: "file" },
    ],
  },
];

function mapWith(video?: VideoDataDoc, id = "map-1"): GameObjectDoc {
  const object = createMapObject({ id, name: "网格地图", image: IMAGE, grid: GRID });
  // 视频是它的 `VideoOverlay` 组件（v19 起）
  return video === undefined ? object : withFeature(object, DEFAULT_SLOT_COMPONENT.video, video);
}

function textureWith(video?: VideoDataDoc, id = "tex-1"): GameObjectDoc {
  const object = createGameObject({ id, name: "贴图", kind: "Image" });
  return video === undefined ? object : withFeature(object, DEFAULT_SLOT_COMPONENT.video, video);
}

/** 精灵：**不再是**视频宿主（v21 起视频那一组归贴图）。 */
function spriteWith(video?: VideoDataDoc, id = "sprite-1"): GameObjectDoc {
  const object = createGameObject({ id, name: "精灵" });
  return video === undefined ? object : withFeature(object, DEFAULT_SLOT_COMPONENT.video, video);
}

/** 一条视频（默认开着、选中、不循环、静音）。 */
function video(clips: readonly string[] = [], extra: Partial<VideoDataDoc> = {}): VideoDataDoc {
  return { enabled: true, autoPlay: false, clips: [...clips], loop: false, audio: false, ...extra };
}

/** 手写文件里那种「有视频列表、但没写选了哪条」的样子（播放按钮该点不动）。 */
function unpicked(clips: readonly string[]): VideoDataDoc {
  return { enabled: true, autoPlay: false, clips: [...clips], loop: false, audio: false };
}

function seedScene(objects: GameObjectDoc[], selected: readonly string[]): void {
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

/** 把运行态摆成「已连上服务端 / 前端连没连」的样子（只改 store，不起真连接）。 */
function seedRuntime(input: { status: RuntimeStatus; clientConnected: boolean }): void {
  useEditorStore.setState((state) => ({
    mode: "run",
    runtime: {
      ...state.runtime,
      status: input.status,
      client: input.clientConnected
        ? { name: "DiceTale Unity", version: "1.0.0", connectedAt: 0 }
        : null,
    },
  }));
}

const objectOf = (id: string): GameObjectDoc | undefined =>
  useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === id);

const videoOf = (id: string): VideoDataDoc | undefined => {
  const object = objectOf(id);
  return object === undefined ? undefined : videoDataOf(object);
};

const logs = (): string[] => useEditorStore.getState().runtime.logs.map((entry) => entry.message);

/** 面板上的视频小方块（顺序 = 加进来的先后）。 */
const chips = (): HTMLElement[] => screen.queryAllByTestId("video-clip");

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
    videoEditor: false,
    videoEditorTarget: null,
    videoPlayback: { objects: {} },
  });
});

describe("属性面板：视频组", () => {
  it("地图与贴图都有「视频」组（关着时只有「启用」）；精灵、声音对象与传送阵没有", () => {
    seedScene(
      [
        mapWith(),
        textureWith(),
        spriteWith(),
        createSoundObject({ id: "sound-1", name: "脚步" }),
        createTeleportObject({ id: "tp-1", name: "传送阵" }),
      ],
      ["map-1"],
    );
    const { unmount } = render(<InspectorPanel />);

    // 没开视频：整组只剩「启用」那一个开关（与战争雾那一组同一套）
    expect(hasGroup("video")).toBe(true);
    expect(screen.getByTestId("video-enable")).toBeDefined();
    expect(screen.queryByTestId("video-empty")).toBeNull();
    expect(screen.queryByTestId("video-edit")).toBeNull();

    // 贴图也有这一组（v21 起取代精灵）
    unmount();
    seedScene([textureWith()], ["tex-1"]);
    render(<InspectorPanel />);
    expect(hasGroup("video")).toBe(true);
    expect(screen.getByTestId("video-enable")).toBeDefined();

    // 精灵**没有**这一组：视频宿主从精灵换成了贴图
    unmount();
    seedScene([spriteWith()], ["sprite-1"]);
    render(<InspectorPanel />);
    expect(hasGroup("video")).toBe(false);

    // 动作对象也没有：视频挂在对象自己的矩形上，声音对象 / 传送阵画的是固定徽标
    unmount();
    seedScene(
      [createSoundObject({ id: "sound-1", name: "脚步" }), createTeleportObject({ id: "tp-1", name: "传送阵" })],
      ["sound-1"],
    );
    render(<InspectorPanel />);
    expect(hasGroup("video")).toBe(false);
  });

  it("「启用」是整组的闸门：打开才露出列表 / 编辑入口 / 播放 / 循环 / 声音；关掉又收起来", () => {
    seedScene([mapWith()], ["map-1"]);
    render(<InspectorPanel />);

    const enable = screen.getByTestId("video-enable") as HTMLInputElement;
    expect(enable.checked).toBe(false);
    expect(hasGroup("video")).toBe(true);

    // 打开：写进文档（可撤销），整组露出来
    fireEvent.click(enable);
    expect(videoOf("map-1")).toEqual({ enabled: true, autoPlay: false, clips: [], loop: false, audio: false });
    expect(screen.getByTestId("video-empty").textContent).toBe("还没加视频");
    expect(screen.getByTestId("video-edit")).toBeDefined();
    expect(screen.getByTestId("video-play")).toBeDefined();
    expect(screen.getByTestId("video-loop")).toBeDefined();
    expect(screen.getByTestId("video-audio")).toBeDefined();

    // 关掉：整组只剩开关，但文档里那份配置留着（列表 + 两个开关）
    act(() => useEditorStore.getState().addVideoClip("map-1", CLIP));
    act(() => useEditorStore.getState().setVideoLoop("map-1", true));
    fireEvent.click(screen.getByTestId("video-enable"));
    expect(videoOf("map-1")).toEqual({ enabled: false, autoPlay: false, clips: [CLIP], picked: CLIP, loop: true, audio: false });
    expect(screen.queryByTestId("video-edit")).toBeNull();
    expect(screen.queryByTestId("video-play")).toBeNull();
    expect((screen.getByTestId("video-enable") as HTMLInputElement).checked).toBe(false);

    // 再打开：列表 / 循环都原样回来
    fireEvent.click(screen.getByTestId("video-enable"));
    expect(chips()).toHaveLength(1);
    expect((screen.getByTestId("video-loop") as HTMLInputElement).checked).toBe(true);

    // 开关本身也是一次文档编辑：撤销回到「关着」
    act(() => useEditorStore.getState().undo());
    expect(videoOf("map-1")?.enabled).toBe(false);
  });

  it("加进来的视频按顺序列成小方块，名字用素材文件名，选中的那条标出来", () => {
    seedScene([mapWith(video([CLIP, CLIP2], { picked: CLIP2 }))], ["map-1"]);
    render(<InspectorPanel />);

    const all = chips();
    expect(all).toHaveLength(2);
    expect(all[0]?.textContent).toBe("opening");
    expect(all[1]?.textContent).toBe("rain");
    expect(all[0]?.getAttribute("data-selected")).toBe("false");
    expect(all[1]?.getAttribute("data-selected")).toBe("true");
    // webm 那条的 tooltip 里带着提醒（Unity 在 Windows 上多半解不了）
    expect(all[1]?.getAttribute("title")).toMatch(/WebM：Windows 上多半解不了/);
  });

  it("点小方块换「放哪一条」：写进文档、可撤销；再点选中的那条 = 取消选中", () => {
    seedScene([mapWith(video([CLIP, CLIP2], { picked: CLIP }))], ["map-1"]);
    render(<InspectorPanel />);

    fireEvent.click(chips()[1]!);
    expect(videoOf("map-1")?.picked).toBe(CLIP2);
    // 一次文档编辑：撤销回到上一条（撤销要包在 act 里，DOM 才会跟着刷新）
    act(() => useEditorStore.getState().undo());
    expect(videoOf("map-1")?.picked).toBe(CLIP);

    // 现在 chips[0] 又是选中的那条：再点它 = 取消选中
    expect(chips()[0]?.getAttribute("data-selected")).toBe("true");
    fireEvent.click(chips()[0]!);
    expect(videoOf("map-1")?.picked).toBeUndefined();
  });

  it("循环 / 声音 / 自动播放开关写进文档（可撤销）", () => {
    seedScene([mapWith(video([CLIP]))], ["map-1"]);
    render(<InspectorPanel />);

    const loop = screen.getByTestId("video-loop") as HTMLInputElement;
    const audio = screen.getByTestId("video-audio") as HTMLInputElement;
    const autoPlay = screen.getByTestId("video-auto-play") as HTMLInputElement;
    expect(loop.checked).toBe(false);
    expect(audio.checked).toBe(false);
    expect(autoPlay.checked).toBe(false);
    // 开关行统一成「左边行名、右边勾选框」：不再挂「放一遍 / 静音」这类文字
    expect(screen.queryByText("放一遍")).toBeNull();
    expect(screen.queryByText("静音")).toBeNull();
    expect(screen.getByText("循环")).toBeDefined();
    expect(screen.getByText("声音")).toBeDefined();
    // 说明收进 title（鼠标停上去才看）
    expect(loop.getAttribute("title")).toMatch(/一直循环放/);
    expect(audio.getAttribute("title")).toMatch(/默认静音/);

    fireEvent.click(loop);
    fireEvent.click(audio);
    fireEvent.click(autoPlay);
    expect(videoOf("map-1")?.loop).toBe(true);
    expect(videoOf("map-1")?.audio).toBe(true);
    expect(videoOf("map-1")?.autoPlay).toBe(true);
    expect(loop.checked).toBe(true);
    expect(audio.checked).toBe(true);

    // Undo autoplay and verify it did not alter the other video switches.
    act(() => useEditorStore.getState().undo());
    expect(videoOf("map-1")?.autoPlay).toBe(false);
    expect(videoOf("map-1")?.loop).toBe(true);
    expect(videoOf("map-1")?.audio).toBe(true);
  });

  it("自动播放开关写进场景文档并可撤销", () => {
    seedScene([mapWith(video([CLIP], { picked: CLIP }))], ["map-1"]);
    render(<InspectorPanel />);

    const autoPlay = screen.getByTestId("video-auto-play") as HTMLInputElement;
    expect(autoPlay.checked).toBe(false);
    fireEvent.click(autoPlay);
    expect(videoOf("map-1")?.autoPlay).toBe(true);
    expect(autoPlay.checked).toBe(true);

    act(() => useEditorStore.getState().undo());
    expect(videoOf("map-1")?.autoPlay).toBe(false);
  });

  it("「编辑」把目标写进 store（窗口由 EditorShell 挂）", () => {
    seedScene([mapWith(video([CLIP]))], ["map-1"]);
    render(<InspectorPanel />);

    fireEvent.click(screen.getByTestId("video-edit"));
    expect(useEditorStore.getState().videoEditor).toBe(true);
    expect(useEditorStore.getState().videoEditorTarget).toBe("map-1");

    act(() => useEditorStore.getState().openVideoEditor(null));
    expect(useEditorStore.getState().videoEditor).toBe(false);
    expect(useEditorStore.getState().videoEditorTarget).toBeNull();
  });
});

describe("播放 / 暂停 / 停止：能不能点", () => {
  it("三条按钮的说法：没加 / 没选 / 没在放 / 连没连前端", () => {
    expect(videoPlayBlockedReason({ clips: 1, picked: CLIP })).toBeUndefined();
    expect(videoPlayBlockedReason({ clips: 0, picked: undefined })).toMatch(/先加一条视频/);
    expect(videoPlayBlockedReason({ clips: 2, picked: undefined })).toMatch(/先选一条视频/);

    const connected = {
      mode: "run" as EditorMode,
      status: "open" as RuntimeStatus,
      clientConnected: true,
    };
    expect(videoDeliveryHint(connected)).toBeUndefined();
    expect(videoDeliveryHint({ ...connected, mode: "edit" })).toMatch(/还没连上服务端/);
    expect(videoDeliveryHint({ ...connected, status: "connecting" })).toMatch(/还没连上服务端/);
    expect(videoDeliveryHint({ ...connected, clientConnected: false })).toMatch(/前端（Unity）未连接/);
  });

  it("编辑态也能点：记录 + 下发的那两个按钮的 title 写明「已记录、等连上补发」", () => {
    seedScene([mapWith(video([CLIP], { picked: CLIP }))], ["map-1"]);
    render(<InspectorPanel />);

    for (const id of ["video-play", "video-stop"]) {
      const button = screen.getByTestId(id);
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(button.getAttribute("title")).toMatch(/已记录：编辑器还没连上服务端/);
    }

    // 没在放的时候「暂停」点不动，并且说明原因
    const pause = screen.getByTestId("video-pause");
    expect(pause.hasAttribute("disabled")).toBe(true);
    expect(pause.getAttribute("title")).toMatch(/没在放视频/);
  });

  it("开了但一条都没加 / 加了但没选 → 「播放」置灰；「停止」照样能点", () => {
    seedScene([mapWith(video([]))], ["map-1"]);
    seedRuntime({ status: "open", clientConnected: true });
    const { unmount } = render(<InspectorPanel />);
    expect(screen.getByTestId("video-play").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("video-play").getAttribute("title")).toMatch(/先加一条视频/);
    expect(screen.getByTestId("video-stop").hasAttribute("disabled")).toBe(false);

    unmount();
    seedScene([mapWith(unpicked([CLIP]))], ["map-1"]);
    seedRuntime({ status: "open", clientConnected: true });
    render(<InspectorPanel />);
    expect(screen.getByTestId("video-play").getAttribute("title")).toMatch(/先选一条视频/);
  });

  it("运行态但前端没连：照样能点，title 换成「前端未连接，等它连上补发」", () => {
    seedScene([mapWith(video([CLIP], { picked: CLIP }))], ["map-1"]);
    seedRuntime({ status: "open", clientConnected: false });
    render(<InspectorPanel />);

    const play = screen.getByTestId("video-play");
    expect(play.hasAttribute("disabled")).toBe(false);
    expect(play.getAttribute("title")).toMatch(/前端（Unity）未连接/);
  });
});

describe("播放 / 暂停 / 停止：面板上看得见的状态", () => {
  const playButton = (): HTMLElement => screen.getByTestId("video-play");
  const pauseButton = (): HTMLElement => screen.getByTestId("video-pause");
  const status = (): HTMLElement => screen.getByTestId("video-status");

  it("播放 → 暂停 → 继续 → 停止：按钮文案与状态行一路跟着走（与声音那组同一套）", () => {
    seedScene([mapWith(video([CLIP], { picked: CLIP, loop: true }))], ["map-1"]);
    render(<InspectorPanel />);

    expect(playButton().textContent).toBe("▶ 播放");
    expect(playButton().getAttribute("data-playing")).toBe("false");
    expect(status().getAttribute("data-state")).toBe("idle");
    expect(status().textContent).toBe("没在播放");

    act(() => useEditorStore.getState().playVideo("map-1"));
    expect(playButton().textContent).toBe("▶ 播放中");
    expect(playButton().getAttribute("data-playing")).toBe("true");
    expect(playButton().className).toMatch(/editor-accent/);
    expect(status().getAttribute("data-state")).toBe("playing");
    expect(status().textContent).toBe("正在播放：opening");

    // 暂停：按钮变成「继续」，状态行改成「已暂停」
    act(() => useEditorStore.getState().pauseVideo("map-1"));
    expect(pauseButton().textContent).toBe("▶ 继续");
    expect(pauseButton().getAttribute("data-paused")).toBe("true");
    expect(status().getAttribute("data-state")).toBe("paused");
    expect(status().textContent).toBe("已暂停：opening");

    act(() => useEditorStore.getState().resumeVideo("map-1"));
    expect(pauseButton().textContent).toBe("⏸ 暂停");
    expect(status().getAttribute("data-state")).toBe("playing");

    act(() => useEditorStore.getState().stopVideo("map-1"));
    expect(playButton().textContent).toBe("▶ 播放");
    expect(status().getAttribute("data-state")).toBe("idle");
  });

  it("每个对象各记各的：地图放着的时候贴图也能放，停一个不影响另一个", () => {
    seedScene(
      [mapWith(video([CLIP], { picked: CLIP })), textureWith(video([CLIP2], { picked: CLIP2 }))],
      ["map-1"],
    );
    render(<InspectorPanel />);

    act(() => useEditorStore.getState().playVideo("map-1"));
    act(() => useEditorStore.getState().playVideo("tex-1"));

    const playback = useEditorStore.getState().videoPlayback.objects;
    expect(Object.keys(playback).sort()).toEqual(["map-1", "tex-1"]);
    expect(playback["map-1"]?.clip).toBe(CLIP);
    expect(playback["tex-1"]?.clip).toBe(CLIP2);

    // 面板正看着地图：它自己的状态不受贴图影响
    expect(status().getAttribute("data-state")).toBe("playing");

    act(() => useEditorStore.getState().stopVideo("tex-1"));
    expect(useEditorStore.getState().videoPlayback.objects["tex-1"]).toBeUndefined();
    expect(useEditorStore.getState().videoPlayback.objects["map-1"]).toBeDefined();
  });

  it("「正在放」是运行态：不写文档、不进撤销栈；切场景就回到「没在放」", () => {
    seedScene([mapWith(video([CLIP], { picked: CLIP }))], ["map-1"]);
    render(<InspectorPanel />);

    const before = videoOf("map-1");
    act(() => useEditorStore.getState().playVideo("map-1"));
    expect(status().getAttribute("data-state")).toBe("playing");
    // 播放只是「记账 + 下发指令」：文档没被动过，所以撤销栈里不该多出记录
    expect(useEditorStore.getState().canUndo).toBe(false);
    expect(videoOf("map-1")).toEqual(before);

    // 切场景：记账里的对象属于上一个场景，清掉
    act(() => useEditorStore.getState().setActiveScene("Map002"));
    expect(useEditorStore.getState().videoPlayback.objects).toEqual({});
  });
});

describe("失败原因：都在运行日志里写明", () => {
  it("开关关着 / 没加视频 / 没选 / 不是地图或贴图 / 对象不存在", () => {
    seedScene(
      [
        // 连 video 字段都没有 = 没开（前端/编辑器口径一致：就是「开关关着」）
        mapWith(),
        // 开着但一条都没加
        mapWith(video([]), "map-2"),
        // 加了但没选（手写文件里可能有）
        mapWith(unpicked([CLIP]), "map-3"),
        // 声音对象（动作对象）与**精灵**都不是视频宿主：
        // 精灵这一条是 v21 的行为变化——视频那一组从精灵挪到了贴图
        createSoundObject({ id: "sound-1", name: "脚步" }),
        createGameObject({ id: "sprite-1", name: "精灵" }),
      ],
      ["map-1"],
    );

    act(() => useEditorStore.getState().playVideo("map-1"));
    expect(logs().at(-1)).toMatch(/视频开关关着/);

    act(() => useEditorStore.getState().playVideo("map-2"));
    expect(logs().at(-1)).toMatch(/还没加视频/);

    act(() => useEditorStore.getState().playVideo("map-3"));
    expect(logs().at(-1)).toMatch(/还没选要放哪一条视频/);

    act(() => useEditorStore.getState().playVideo("sound-1"));
    expect(logs().at(-1)).toMatch(/不是地图或贴图/);

    act(() => useEditorStore.getState().playVideo("sprite-1"));
    expect(logs().at(-1)).toMatch(/不是地图或贴图/);

    act(() => useEditorStore.getState().playVideo("不存在"));
    expect(logs().at(-1)).toMatch(/找不到这个对象/);
  });

  it("没在放的时候点暂停 / 继续：写明原因，不记账", () => {
    seedScene([mapWith(video([CLIP], { picked: CLIP }))], ["map-1"]);

    act(() => useEditorStore.getState().pauseVideo("map-1"));
    expect(logs().at(-1)).toMatch(/没在放视频/);
    act(() => useEditorStore.getState().resumeVideo("map-1"));
    expect(logs().at(-1)).toMatch(/没在放视频/);

    expect(useEditorStore.getState().videoPlayback.objects).toEqual({});
  });

  it("编辑态点播放：记账 + 写一条「连上后自动补发」；暂停态也跟着记", () => {
    seedScene([mapWith(video([CLIP], { picked: CLIP, loop: true, audio: true }))], ["map-1"]);

    act(() => useEditorStore.getState().playVideo("map-1"));
    expect(useEditorStore.getState().videoPlayback.objects["map-1"]).toEqual({
      objectId: "map-1",
      clip: CLIP,
      loop: true,
      audio: true,
      paused: false,
    });
    expect(logs().at(-1)).toMatch(/已记录/);
    expect(logs().at(-1)).toMatch(/连上后自动补发/);

    act(() => useEditorStore.getState().pauseVideo("map-1"));
    expect(useEditorStore.getState().videoPlayback.objects["map-1"]?.paused).toBe(true);
  });
});

describe("store：加 / 删 / 改名（「编辑视频」窗口走的那几个入口）", () => {
  it("addVideoClip：去重；原来没选过就把它选上，已经在列表里就不再加", () => {
    seedScene([mapWith()], ["map-1"]);

    act(() => useEditorStore.getState().addVideoClip("map-1", CLIP));
    expect(videoOf("map-1")).toEqual({
      enabled: true,
      autoPlay: false,
      clips: [CLIP],
      picked: CLIP,
      loop: false,
      audio: false,
    });

    act(() => useEditorStore.getState().addVideoClip("map-1", CLIP2));
    expect(videoOf("map-1")?.clips).toEqual([CLIP, CLIP2]);
    // 已经选着 CLIP 就不抢：加一条不该把「放哪条」顶掉
    expect(videoOf("map-1")?.picked).toBe(CLIP);

    // 再加一次同一条：什么都不做
    expect(useEditorStore.getState().addVideoClip("map-1", CLIP2)).toBe(false);
    expect(videoOf("map-1")?.clips).toEqual([CLIP, CLIP2]);
  });

  it("removeVideoClip：移出选中的那条会顺到下一条；名字跟着清", () => {
    seedScene([mapWith(video([CLIP, CLIP2], { picked: CLIP }))], ["map-1"]);

    act(() => useEditorStore.getState().setVideoClipName("map-1", CLIP, "开场"));
    act(() => useEditorStore.getState().removeVideoClip("map-1", CLIP));

    expect(videoOf("map-1")).toEqual({
      enabled: true,
      autoPlay: false,
      clips: [CLIP2],
      picked: CLIP2,
      names: undefined,
      loop: false,
      audio: false,
    });
  });

  it("setVideoClipName：留空退回素材文件名；不在列表里的拒掉", () => {
    seedScene([mapWith(video([CLIP], { picked: CLIP }))], ["map-1"]);

    act(() => useEditorStore.getState().setVideoClipName("map-1", CLIP, "  开场  "));
    expect(videoOf("map-1")?.names).toEqual({ [CLIP]: "开场" });

    act(() => useEditorStore.getState().setVideoClipName("map-1", CLIP, "  "));
    expect(videoOf("map-1")?.names).toBeUndefined();

    expect(useEditorStore.getState().setVideoClipName("map-1", CLIP2, "别的")).toBe(false);
  });

  it("贴图与地图走同一套命令（两个宿主不分家）", () => {
    seedScene([textureWith()], ["tex-1"]);

    act(() => useEditorStore.getState().addVideoClip("tex-1", CLIP));
    act(() => useEditorStore.getState().setVideoLoop("tex-1", true));
    expect(videoOf("tex-1")).toEqual({
      enabled: true,
      autoPlay: false,
      clips: [CLIP],
      picked: CLIP,
      loop: true,
      audio: false,
    });
  });

  it("setVideoEnabled：写文档、可撤销；关着不影响列表命令", () => {
    seedScene([mapWith()], ["map-1"]);

    act(() => useEditorStore.getState().setVideoEnabled("map-1", true));
    expect(videoOf("map-1")?.enabled).toBe(true);

    act(() => useEditorStore.getState().addVideoClip("map-1", CLIP));
    act(() => useEditorStore.getState().setVideoEnabled("map-1", false));
    expect(videoOf("map-1")).toEqual({
      enabled: false,
      autoPlay: false,
      clips: [CLIP],
      picked: CLIP,
      loop: false,
      audio: false,
    });

    // 关着的时候前端不会放：播放被明确拒掉（不是静默失败）
    act(() => useEditorStore.getState().playVideo("map-1"));
    expect(logs().at(-1)).toMatch(/视频开关关着/);
    expect(useEditorStore.getState().videoPlayback.objects).toEqual({});

    // 撤销回到「开着」
    act(() => useEditorStore.getState().undo());
    expect(videoOf("map-1")?.enabled).toBe(true);
  });
});
