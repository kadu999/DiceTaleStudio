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
 * **贴图上的视频混合**（`VideoBlend`）：两路素材（A 盖住 / B 擦开露出）+ 循环 / 声音 / 自动播放。
 *
 * 与「视频」那一组的关键区别：
 * - 每路只放**一个素材**，可以是**图片或视频**（面板上先选种类再「选择」）；
 * - 遮罩是纯运行态（Mask 窗口），文档里只声明「每路放什么 / 循环 / 声音 / 自动播放」。
 *
 * 这一份钉属性面板与 store 的**文档数据**那一半；Mask 窗口与运行态下发给 e2e。
 */

const CLIP = "project:测试/Assets/video/opening.mp4";
const CLIP2 = "project:测试/Assets/video/rain.webm";
const IMG = "project:测试/Assets/images/bg.png";

/** 资源树：两条视频（含一条 webm）+ 一张图片。 */
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
      {
        name: "images",
        path: "Assets/images",
        id: "project:测试/Assets/images",
        type: "folder",
        children: [{ name: "bg.png", path: "Assets/images/bg.png", id: IMG, type: "file" }],
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

  it("与「视频」互斥：挂了一个，另一个就不在「添加组件」里", () => {
    // 先挂视频 → 底部菜单里没有「视频混合」
    seedScene([texture()], ["tex-1"]);
    const first = render(<InspectorPanel />);
    addComponentFromMenu("VideoOverlay");
    expect(addableLabels()).not.toContain("视频混合");
    first.unmount();

    // 先挂视频混合 → 底部菜单里没有「视频」
    seedScene([texture()], ["tex-1"]);
    render(<InspectorPanel />);
    addComponentFromMenu("VideoBlend");
    expect(addableLabels()).not.toContain("视频");
  });
});

describe("视频混合：添加与移除", () => {
  it("从菜单加上：两路空素材 + 循环 / 声音 / 自动播放；组头移除整个摘掉（可撤销）", () => {
    seedScene([texture()], ["tex-1"]);
    render(<InspectorPanel />);

    expect(hasGroup("videoBlend")).toBe(false);
    addComponentFromMenu("VideoBlend");
    expect(blendOf("tex-1")).toEqual({
      a: { kind: "video" },
      b: { kind: "video" },
      loop: false,
      autoPlay: false,
      audio: "none",
    });
    expect(hasGroup("videoBlend")).toBe(true);
    expect(screen.getByTestId("video-blend-a-empty").textContent).toBe("还没选");
    expect(screen.getByTestId("video-blend-b-empty").textContent).toBe("还没选");
    expect(screen.getByTestId("video-blend-loop")).toBeDefined();
    expect(screen.getByTestId("video-blend-audio")).toBeDefined();
    expect(screen.getByTestId("video-blend-auto-play")).toBeDefined();

    act(() => useEditorStore.getState().setVideoBlendChannelId("tex-1", "a", CLIP));
    act(() => useEditorStore.getState().setVideoBlendChannelId("tex-1", "b", CLIP2));
    fireEvent.click(within(groupOf("videoBlend")).getByTestId("remove-component"));
    expect(blendOf("tex-1")).toBeUndefined();
    expect(hasGroup("videoBlend")).toBe(false);

    // 移除也是一次文档编辑：撤销把两路（含素材）原样带回来
    act(() => useEditorStore.getState().undo());
    expect(blendOf("tex-1")).toEqual({
      a: { kind: "video", id: CLIP },
      b: { kind: "video", id: CLIP2 },
      loop: false,
      autoPlay: false,
      audio: "none",
    });
  });
});

describe("视频混合：自动播放开关（规格自动出行）", () => {
  it("勾上进文档、可撤销（与「视频」那个开关同一套泛型写入）", () => {
    blended();

    const autoPlay = screen.getByTestId("video-blend-auto-play") as HTMLInputElement;
    expect(autoPlay.checked).toBe(false);

    fireEvent.click(autoPlay);
    expect(blendOf("tex-1")?.autoPlay).toBe(true);
    expect(autoPlay.checked).toBe(true);

    act(() => useEditorStore.getState().undo());
    expect(blendOf("tex-1")?.autoPlay).toBe(false);
  });
});

describe("视频混合：两路素材（种类开关 + 选择 + 清除）", () => {
  it("面板：默认「视频」；种类开关写进文档并清掉这一路已选的素材；一次撤销全回来", () => {
    blended();

    // 默认是视频：开关上「视频」亮着、按钮写着「选择视频…」
    expect(screen.getByTestId("video-blend-a-kind-video").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("video-blend-a-kind-image").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("video-blend-a-pick").textContent).toBe("选择视频…");
    expect(screen.getByTestId("video-blend-a-empty").textContent).toBe("还没选");

    // 选了视频 → 面板上显示素材名（webm 会带格式提醒）
    act(() => useEditorStore.getState().setVideoBlendChannelId("tex-1", "a", CLIP));
    expect(screen.getByTestId("video-blend-a-current").textContent).toBe("opening");
    expect(blendOf("tex-1")?.a).toEqual({ kind: "video", id: CLIP });

    // 切到图片：写文档、清素材、按钮与提示换文案
    fireEvent.click(screen.getByTestId("video-blend-a-kind-image"));
    expect(blendOf("tex-1")?.a).toEqual({ kind: "image" });
    expect(screen.getByTestId("video-blend-a-pick").textContent).toBe("选择图片…");
    expect(screen.getByTestId("video-blend-a-empty").textContent).toBe("还没选");

    // 撤销把「视频 + 素材」一起带回来（换种类 + 清素材是同一次文档编辑）
    act(() => useEditorStore.getState().undo());
    expect(blendOf("tex-1")?.a).toEqual({ kind: "video", id: CLIP });
  });

  it("两路互不影响：图片那一路不会碰视频那一路", () => {
    blended();
    act(() => useEditorStore.getState().setVideoBlendChannelId("tex-1", "a", CLIP));
    act(() => useEditorStore.getState().setVideoBlendChannelKind("tex-1", "b", "image"));
    act(() => useEditorStore.getState().setVideoBlendChannelId("tex-1", "b", IMG));

    expect(blendOf("tex-1")?.a).toEqual({ kind: "video", id: CLIP });
    expect(blendOf("tex-1")?.b).toEqual({ kind: "image", id: IMG });
    expect(screen.getByTestId("video-blend-a-current").textContent).toBe("opening");
    expect(screen.getByTestId("video-blend-b-current").textContent).toBe("bg");
  });

  it("选择按钮按当前种类弹对应的通用选择框", () => {
    blended();

    // 视频那一路 → 视频选择框
    fireEvent.click(screen.getByTestId("video-blend-b-pick"));
    expect(screen.getByTestId("video-picker-dialog")).toBeDefined();
  });

  it("图片那一路 → 图片选择框", () => {
    blended();
    act(() => useEditorStore.getState().setVideoBlendChannelKind("tex-1", "a", "image"));

    fireEvent.click(screen.getByTestId("video-blend-a-pick"));
    expect(screen.getByTestId("image-picker-dialog")).toBeDefined();
  });

  it("「×」清掉这一路选的素材、不动另一路；kind 留着", () => {
    blended();
    act(() => useEditorStore.getState().setVideoBlendChannelId("tex-1", "a", CLIP));
    act(() => useEditorStore.getState().setVideoBlendChannelKind("tex-1", "b", "image"));
    act(() => useEditorStore.getState().setVideoBlendChannelId("tex-1", "b", IMG));

    fireEvent.click(screen.getByTestId("video-blend-a-clear"));
    expect(blendOf("tex-1")?.a).toEqual({ kind: "video" });
    expect(blendOf("tex-1")?.b).toEqual({ kind: "image", id: IMG });
  });
});

describe("视频混合：播放记账", () => {
  it("两路都没选时播放被拒（写日志、不记账）", () => {
    blended();

    act(() => {
      expect(useEditorStore.getState().playVideoBlend("tex-1")).toBeUndefined();
    });
    expect(useEditorStore.getState().videoBlendPlayback.objects["tex-1"]).toBeUndefined();
    expect(logs().some((message) => message.includes("两路都还没选素材"))).toBe(true);
  });

  it("选了之后播放 → 记账两路；暂停 / 继续 / 停止", () => {
    blended();
    act(() => useEditorStore.getState().setVideoBlendChannelId("tex-1", "a", CLIP));
    act(() => useEditorStore.getState().setVideoBlendChannelId("tex-1", "b", CLIP2));

    act(() => useEditorStore.getState().playVideoBlend("tex-1"));
    expect(useEditorStore.getState().videoBlendPlayback.objects["tex-1"]?.sources).toEqual([CLIP, CLIP2]);
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

    act(() => useEditorStore.getState().setVideoBlendChannelId("tex-1", "a", IMG));
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

  it("编辑态整张填 1 / 0 也不记账（那是一整张遮罩，和擦一笔同一条规矩）", () => {
    blended();

    act(() => {
      expect(useEditorStore.getState().fillVideoBlendMask("tex-1", false)).toBeUndefined();
    });
    expect(useEditorStore.getState().videoBlendReveal.objects["tex-1"]).toBeUndefined();
  });

  it("运行态：整张填与擦一笔记进**同一条有序序列**；连着点同一个状态不重复记", () => {
    blended();
    act(() => useEditorStore.setState({ mode: "run" }));

    // 先擦一笔、再整张盖住；盖住要排在那一笔**之后**（重放时它才盖得掉那一笔）
    act(() => useEditorStore.getState().eraseVideoBlendMask("tex-1", [{ x: 0.4, y: 0.6 }], true));
    act(() => useEditorStore.getState().fillVideoBlendMask("tex-1", true));
    act(() => useEditorStore.getState().fillVideoBlendMask("tex-1", true));

    const ops = useEditorStore.getState().videoBlendReveal.objects["tex-1"]?.ops ?? [];
    expect(ops.map((op) => op.kind)).toEqual(["stroke", "fill"]);
    expect(ops[1]).toMatchObject({ kind: "fill", covered: true });

    // 再整张擦开：追加成第三步（不是覆盖前两步）
    act(() => useEditorStore.getState().fillVideoBlendMask("tex-1", false));
    const after = useEditorStore.getState().videoBlendReveal.objects["tex-1"]?.ops ?? [];
    expect(after.map((op) => op.kind)).toEqual(["stroke", "fill", "fill"]);
    expect(after[2]).toMatchObject({ kind: "fill", covered: false });

    // 前端不在：只记账，日志里说明白「等连上补发」
    expect(logs().some((message) => message.includes("已记录整张擦开"))).toBe(true);
  });

  it("不能挂混合层的对象（声音 / 精灵）：整张填被拒（写日志、不记账）", () => {
    seedScene([createSoundObject({ id: "s1", name: "脚步" })], ["s1"]);
    act(() => useEditorStore.setState({ mode: "run" }));

    act(() => {
      expect(useEditorStore.getState().fillVideoBlendMask("s1", true)).toBeUndefined();
    });
    expect(useEditorStore.getState().videoBlendReveal.objects["s1"]).toBeUndefined();
    expect(logs().some((message) => message.includes("没有视频混合组件"))).toBe(true);
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
