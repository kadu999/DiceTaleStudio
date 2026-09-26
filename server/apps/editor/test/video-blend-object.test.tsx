import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  createGameObject,
  createSoundObject,
  createTeleportObject,
  videoBlendDataOf,
  type GameObjectDoc,
  type VideoBlendDataDoc,
} from "@dts/document";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";
import type { ResourceTreeNode } from "../src/services/project-api";

/**
 * **贴图上的视频混合**（`VideoBlend`）：两条通道（A 盖住 / B 擦开露出）+ 循环 + 声音来源。
 *
 * 与「视频」那一组的关键区别：
 * - 两条通道**各自**是一份「列表 + 选中」，互不影响；
 * - 遮罩是纯运行态（Mask 窗口，下一批接上），文档里只声明「放哪两条 / 循环 / 声音」。
 *
 * 这一份钉属性面板与 store 的**文档数据**那一半；Mask 窗口与运行态下发给 e2e。
 */

const CLIP = "project:测试/Assets/video/opening.mp4";
const CLIP2 = "project:测试/Assets/video/rain.webm";
const CLIP3 = "project:测试/Assets/video/loop.mp4";

/** 资源树：三条视频（含一条 webm）。 */
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
          { name: "loop.mp4", path: "Assets/video/loop.mp4", id: CLIP3, type: "file" },
        ],
      },
    ],
  },
];

function texture(id = "tex-1"): GameObjectDoc {
  return createGameObject({ id, name: "贴图", kind: "Image" });
}

function sprite(id = "sprite-1"): GameObjectDoc {
  return createGameObject({ id, name: "精灵", kind: "Sprite" });
}

function seedScene(objects: GameObjectDoc[], selected: string[] = []): void {
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

const objectOf = (id: string): GameObjectDoc | undefined =>
  useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === id);

const blendOf = (id: string): VideoBlendDataDoc | undefined => {
  const object = objectOf(id);
  return object === undefined ? undefined : videoBlendDataOf(object);
};

const hasGroup = (slug: string): boolean =>
  document.querySelector(`[data-group="${slug}"]`) !== null;

function groupOf(slug: string): HTMLElement {
  const section = document.querySelector<HTMLElement>(`[data-group="${slug}"]`);
  if (section === null) {
    throw new Error(`没有找到分组 ${slug}`);
  }

  return section;
}

/** 打开底部「添加组件」菜单，返回里面列出的组件名（读完收起）。 */
function addableLabels(): string[] {
  const trigger = screen.queryByTestId("add-component");
  if (trigger === null) {
    return [];
  }

  fireEvent.click(trigger);
  const labels = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-testid^="add-component-"]'),
  )
    .filter((element) => element.tagName === "BUTTON")
    .map((element) => element.textContent ?? "");
  fireEvent.click(trigger);
  return labels;
}

function addComponentFromMenu(type: string): void {
  fireEvent.click(screen.getByTestId("add-component"));
  fireEvent.click(screen.getByTestId(`add-component-${type}`));
}

/** 摆一个「贴图 + 已挂视频混合组件」并渲染面板。 */
function blended(): void {
  seedScene([texture()], ["tex-1"]);
  render(<InspectorPanel />);
  addComponentFromMenu("VideoBlend");
}

const logs = (): string[] => useEditorStore.getState().runtime.logs.map((entry) => entry.message);

/** 某条通道的小方块（顺序 = 加进来的先后）。 */
const chips = (channel: "a" | "b"): HTMLElement[] =>
  screen.queryAllByTestId(`video-blend-${channel}-clip`);

/** 小方块里「选它」的那枚按钮（第一个是选择区，第二个是 × 移出）。 */
const chipSelect = (channel: "a" | "b", index: number): HTMLElement =>
  chips(channel)[index]!.querySelector("button") as HTMLElement;

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    mode: "edit",
    videoBlendPlayback: { objects: {} },
    videoBlendMask: false,
    videoBlendMaskTarget: null,
    videoBlendReveal: { objects: {} },
  });
});

describe("视频混合：哪些对象能加", () => {
  it("只有贴图能在底部「添加组件」里看到「视频混合」；精灵 / 声音 / 传送不能", () => {
    seedScene([texture()], ["tex-1"]);
    const first = render(<InspectorPanel />);
    expect(addableLabels()).toContain("视频混合");
    expect(hasGroup("videoBlend")).toBe(false);
    first.unmount();

    seedScene(
      [sprite(), createSoundObject({ id: "s1", name: "脚步" }), createTeleportObject({ id: "tp1", name: "传送阵" })],
      ["sprite-1"],
    );
    render(<InspectorPanel />);
    expect(addableLabels()).not.toContain("视频混合");
  });
});

describe("视频混合：添加与移除", () => {
  it("从菜单加上：两条空通道 + 循环 / 声音；组头移除整个摘掉（可撤销）", () => {
    seedScene([texture()], ["tex-1"]);
    render(<InspectorPanel />);

    expect(hasGroup("videoBlend")).toBe(false);
    addComponentFromMenu("VideoBlend");
    expect(blendOf("tex-1")).toEqual({ a: { clips: [] }, b: { clips: [] }, loop: false, audio: "none" });
    expect(hasGroup("videoBlend")).toBe(true);
    expect(screen.getByTestId("video-blend-a-empty").textContent).toBe("还没加视频");
    expect(screen.getByTestId("video-blend-b-empty").textContent).toBe("还没加视频");
    expect(screen.getByTestId("video-blend-loop")).toBeDefined();
    expect(screen.getByTestId("video-blend-audio")).toBeDefined();

    act(() => useEditorStore.getState().addVideoBlendClip("tex-1", "a", CLIP));
    act(() => useEditorStore.getState().addVideoBlendClip("tex-1", "b", CLIP2));
    fireEvent.click(within(groupOf("videoBlend")).getByTestId("remove-component"));
    expect(blendOf("tex-1")).toBeUndefined();
    expect(hasGroup("videoBlend")).toBe(false);

    // 移除也是一次文档编辑：撤销把两条通道（含选中）原样带回来
    act(() => useEditorStore.getState().undo());
    expect(blendOf("tex-1")).toEqual({
      a: { clips: [CLIP], picked: CLIP },
      b: { clips: [CLIP2], picked: CLIP2 },
      loop: false,
      audio: "none",
    });
  });
});

describe("视频混合：两条通道", () => {
  it("两条通道各自列小方块、名字用素材文件名，互不影响", () => {
    blended();
    act(() => useEditorStore.getState().addVideoBlendClip("tex-1", "a", CLIP));
    act(() => useEditorStore.getState().addVideoBlendClip("tex-1", "a", CLIP3));
    act(() => useEditorStore.getState().addVideoBlendClip("tex-1", "b", CLIP2));

    const a = chips("a");
    const b = chips("b");
    expect(a.map((chip) => chip.textContent)).toEqual(["opening", "loop"]);
    expect(b.map((chip) => chip.textContent)).toEqual(["rain"]);
    // 每条通道第一次加进来的那条默认被选上
    expect(a[0]?.getAttribute("data-selected")).toBe("true");
    expect(b[0]?.getAttribute("data-selected")).toBe("true");
    // webm 那条的 tooltip 里带着提醒
    expect(b[0]?.getAttribute("title")).toMatch(/WebM：Windows 上多半解不了/);
  });

  it("点小方块换选中 / 再点取消；写进文档、可撤销", () => {
    blended();
    act(() => useEditorStore.getState().addVideoBlendClip("tex-1", "a", CLIP));
    act(() => useEditorStore.getState().addVideoBlendClip("tex-1", "a", CLIP3));

    fireEvent.click(chipSelect("a", 1));
    expect(blendOf("tex-1")?.a.picked).toBe(CLIP3);
    act(() => useEditorStore.getState().undo());
    expect(blendOf("tex-1")?.a.picked).toBe(CLIP);

    // 现在 chips[0] 又是选中的那条：再点它 = 取消选中
    expect(chips("a")[0]?.getAttribute("data-selected")).toBe("true");
    fireEvent.click(chipSelect("a", 0));
    expect(blendOf("tex-1")?.a.picked).toBeUndefined();
  });

  it("清空某条通道不动另一条", () => {
    blended();
    act(() => useEditorStore.getState().addVideoBlendClip("tex-1", "a", CLIP));
    act(() => useEditorStore.getState().addVideoBlendClip("tex-1", "b", CLIP2));

    fireEvent.click(screen.getByTestId("video-blend-a-clear"));
    expect(blendOf("tex-1")?.a).toEqual({ clips: [] });
    expect(blendOf("tex-1")?.b).toEqual({ clips: [CLIP2], picked: CLIP2 });
  });

  it("从某条通道移出一条：移出的正好是选中的那条就顺到第一条", () => {
    blended();
    act(() => useEditorStore.getState().addVideoBlendClip("tex-1", "a", CLIP));
    act(() => useEditorStore.getState().addVideoBlendClip("tex-1", "a", CLIP3));

    // 移出选中的第一条（CLIP）→ 顺到 CLIP3
    fireEvent.click(within(groupOf("videoBlend")).getAllByTestId("video-blend-a-remove")[0]!);
    expect(blendOf("tex-1")?.a).toEqual({ clips: [CLIP3], picked: CLIP3 });
  });
});

describe("视频混合：播放记账", () => {
  it("两条通道都没选时播放被拒（写日志、不记账）", () => {
    blended();

    act(() => {
      expect(useEditorStore.getState().playVideoBlend("tex-1")).toBeUndefined();
    });
    expect(useEditorStore.getState().videoBlendPlayback.objects["tex-1"]).toBeUndefined();
    expect(logs().some((message) => message.includes("两条通道都还没选"))).toBe(true);
  });

  it("选了之后播放 → 记账两条通道；暂停 / 继续 / 停止", () => {
    blended();
    act(() => useEditorStore.getState().addVideoBlendClip("tex-1", "a", CLIP));
    act(() => useEditorStore.getState().addVideoBlendClip("tex-1", "b", CLIP2));

    act(() => useEditorStore.getState().playVideoBlend("tex-1"));
    expect(useEditorStore.getState().videoBlendPlayback.objects["tex-1"]?.clips).toEqual([CLIP, CLIP2]);
    expect(useEditorStore.getState().videoBlendPlayback.objects["tex-1"]?.paused).toBe(false);

    act(() => useEditorStore.getState().pauseVideoBlend("tex-1"));
    expect(useEditorStore.getState().videoBlendPlayback.objects["tex-1"]?.paused).toBe(true);
    act(() => useEditorStore.getState().resumeVideoBlend("tex-1"));
    expect(useEditorStore.getState().videoBlendPlayback.objects["tex-1"]?.paused).toBe(false);

    act(() => useEditorStore.getState().stopVideoBlend("tex-1"));
    expect(useEditorStore.getState().videoBlendPlayback.objects["tex-1"]).toBeUndefined();
  });

  it("面板：没选时「播放」不可点，选了能动；点一下状态变「播放中」", () => {
    blended();
    expect((screen.getByTestId("video-blend-play") as HTMLButtonElement).disabled).toBe(true);

    act(() => useEditorStore.getState().addVideoBlendClip("tex-1", "a", CLIP));
    expect((screen.getByTestId("video-blend-play") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId("video-blend-play"));
    expect(screen.getByTestId("video-blend-status").textContent).toContain("正在混合播放");
  });
});

describe("视频混合：Mask 窗口与擦除记账", () => {
  it("「编辑」按钮打开 Mask 窗口；编辑态擦一笔只预览、不记账", () => {
    blended();

    fireEvent.click(screen.getByTestId("video-blend-mask-open"));
    expect(useEditorStore.getState().videoBlendMask).toBe(true);
    expect(useEditorStore.getState().videoBlendMaskTarget).toBe("tex-1");

    act(() => useEditorStore.getState().eraseVideoBlendMask("tex-1", [{ x: 0.5, y: 0.5 }], true));
    expect(useEditorStore.getState().videoBlendReveal.objects["tex-1"]).toBeUndefined();
  });

  it("运行态：擦一笔记进轨迹（前端不在也只记账）；补发未连上返回 0", () => {
    blended();
    act(() => useEditorStore.setState({ mode: "run" }));
    act(() => useEditorStore.getState().eraseVideoBlendMask("tex-1", [{ x: 0.3, y: 0.4 }], true));

    const entry = useEditorStore.getState().videoBlendReveal.objects["tex-1"];
    expect(entry?.ops).toHaveLength(1);
    expect(entry?.ops[0]).toMatchObject({
      kind: "stroke",
      stroke: { points: [{ x: 0.3, y: 0.4 }] },
    });

    // 编辑器 / 前端都没连：补发什么都不做
    let steps = 1;
    act(() => {
      steps = useEditorStore.getState().flushVideoBlendReveal();
    });
    expect(steps).toBe(0);
  });
});
