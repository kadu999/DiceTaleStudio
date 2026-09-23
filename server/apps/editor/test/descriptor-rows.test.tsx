import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DEFAULT_SLOT_COMPONENT,
  MAP_DEFAULT_SORTING_ORDER,
  createMapObject,
  videoDataOf,
  withFeature,
  type GameObjectDoc,
  type VideoDataDoc,
} from "@dts/document";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";
import type { ResourceTreeNode } from "../src/services/project-api";

/**
 * **描述符行**（`DescriptorRows.tsx` + `component-specs/video.ts`）：属性面板上那几行
 * 不再是一个个手写的 `FieldRow`，而是按组件规格自动出行。
 *
 * 这一份是那次重构的**等价性契约**——它断言的东西全部是「重构前就成立的事实」：
 * 1. **testid 一个不少、行序与手写版一致**（既有测试与 e2e 全按这些定位）；
 * 2. **写回走 store 的泛型入口**，并且是**一次可撤销的文档编辑**（撤销说明取规格里的标签）；
 * 3. 行名就是规格里的 `label`（`getByText("循环")` 这类断言照旧成立）。
 *
 * 换句话说：这一份红 = 重构改了行为；这一份绿 + 既有测试零改动 = 只是换了实现。
 * 完整的分组 / 列表 / 播放行为仍由 `video-object.test.tsx` 钉住，不在这里重复。
 */

const CLIP = "project:测试/Assets/video/opening.mp4";
const IMAGE = { id: "project:测试/Assets/images/Map001.png", width: 400, height: 300 };
const GRID = { width: 8, height: 6 };
const VIDEO = DEFAULT_SLOT_COMPONENT.video;

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
        children: [{ name: "opening.mp4", path: "Assets/video/opening.mp4", id: CLIP, type: "file" }],
      },
      { name: "Map001.png", path: "Assets/images/Map001.png", id: IMAGE.id, type: "file" },
    ],
  },
];

/** 一张开着视频、加了一条视频的地图（三个描述符行都会露出来）。 */
function mapWithVideo(): GameObjectDoc {
  const object = createMapObject({ id: "map-1", name: "网格地图", image: IMAGE, grid: GRID });
  const video: VideoDataDoc = {
    enabled: true,
    autoPlay: false,
    clips: [CLIP],
    picked: CLIP,
    loop: false,
    audio: false,
  };

  return withFeature(object, VIDEO, video);
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

/**
 * 面板里 `data-group="video"` 那一组上，按 DOM 顺序排好的**组件自己的** testid。
 *
 * 必须滤掉 `field-group-header` / `field-group-body`：那是分组外壳（`FieldGroup`）的，
 * 不是组里的行；不过滤的话前两个位置永远是它们。
 */
function videoRowTestIds(): string[] {
  return Array.from(
    document.querySelectorAll('[data-testid="object-properties"] [data-group="video"] [data-testid]'),
  )
    .map((element) => element.getAttribute("data-testid"))
    .filter((id): id is string => id !== null && id.startsWith("video-"));
}

afterEach(cleanup);

describe("描述符行：与手写版逐字等价", () => {
  it("三个开关照旧出现，且行序是 启用 → 循环 → 声音 → 自动播放", () => {
    seedScene([mapWithVideo()], ["map-1"]);
    render(<InspectorPanel />);

    // 前四行与手写版完全同序（「启用」是自定义行，三个开关由规格出行）
    expect(videoRowTestIds().slice(0, 4)).toEqual([
      "video-enable",
      "video-loop",
      "video-audio",
      "video-auto-play",
    ]);

    // 行名就是规格里的 label：既有的 getByText 断言照旧成立
    expect(screen.getByText("循环")).toBeDefined();
    expect(screen.getByText("声音")).toBeDefined();
    expect(screen.getByText("自动播放")).toBeDefined();
  });

  it("tooltip 仍在（说明收进 title 是那一组的外观约定）", () => {
    seedScene([mapWithVideo()], ["map-1"]);
    render(<InspectorPanel />);

    expect(screen.getByTestId("video-loop").getAttribute("title")).toMatch(/一直循环放/);
    expect(screen.getByTestId("video-audio").getAttribute("title")).toMatch(/默认静音/);
    expect(screen.getByTestId("video-auto-play").getAttribute("title")).toMatch(/场景激活时/);
  });

  it("勾选写进文档（走泛型入口），并且是**一次可撤销的编辑**，撤销说明取规格标签", () => {
    seedScene([mapWithVideo()], ["map-1"]);
    render(<InspectorPanel />);

    const autoPlay = screen.getByTestId("video-auto-play") as HTMLInputElement;
    expect(autoPlay.checked).toBe(false);

    fireEvent.click(autoPlay);
    expect(videoDataOf(useEditorStore.getState().scenes[0]!.objects[0]!)?.autoPlay).toBe(true);
    expect(autoPlay.checked).toBe(true);
    // 说明文字来自规格里的 `label`（`修改自动播放`），而不是一条新写的 action
    expect(useEditorStore.getState().undoLabel).toBe("修改自动播放");

    act(() => useEditorStore.getState().undo());
    expect(videoDataOf(useEditorStore.getState().scenes[0]!.objects[0]!)?.autoPlay).toBe(false);
  });

  it("三个开关互不干扰：改其中一个不动另外两个", () => {
    seedScene([mapWithVideo()], ["map-1"]);
    render(<InspectorPanel />);

    fireEvent.click(screen.getByTestId("video-loop"));
    fireEvent.click(screen.getByTestId("video-audio"));

    const data = videoDataOf(useEditorStore.getState().scenes[0]!.objects[0]!);
    expect(data?.loop).toBe(true);
    expect(data?.audio).toBe(true);
    expect(data?.autoPlay).toBe(false);
  });

  it("组件缺失时按规格补壳再写（手写文件里没写 `video` 也能打开开关）", () => {
    // 工厂建出来的地图只有 `GridMap`：没有 `VideoOverlay` 实例
    seedScene([createMapObject({ id: "map-1", name: "网格地图", image: IMAGE, grid: GRID })], ["map-1"]);
    render(<InspectorPanel />);

    // 关着时整组只剩「启用」那一个开关（早返回），打开它才露出三个描述符行
    expect((screen.getByTestId("video-enable") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByTestId("video-enable"));

    fireEvent.click(screen.getByTestId("video-loop"));
    const data = videoDataOf(useEditorStore.getState().scenes[0]!.objects[0]!);
    expect(data?.loop).toBe(true);
    // 补壳补的是完整形状，不是一个只有 loop 的残缺对象
    expect(data?.enabled).toBe(true);
    expect(data?.clips).toEqual([]);
  });
});

/** 「基础」那一组上，`inspector-*` 的 testid 按 DOM 顺序。 */
function basicRowTestIds(): string[] {
  return Array.from(
    document.querySelectorAll('[data-testid="object-properties"] [data-group="basic"] [data-testid]'),
  )
    .map((element) => element.getAttribute("data-testid"))
    .filter((id): id is string => id !== null && id.startsWith("inspector-"));
}

/**
 * **对象自身字段**那一路（`OBJECT_SPEC` + `objectFields`）。
 *
 * 与上面组件那一组是同一个渲染器、同一套约定；这里钉两件事：
 * 1. **迁移前后面板逐字一致**——testid、行名、以及它在「基础」组里的**位置**都没变
 *    （位置用 `inspector-*` 的顺序断言，因为 `sortingOrder` 是夹在激活 / 锁定与坐标之间的）；
 * 2. 改动走泛型入口 `setObjectField`，仍然是一次可撤销的文档编辑，说明取规格里的 `label`。
 */
describe("描述符行：对象自身字段（显示顺序）", () => {
  it("testid / 行名 / 在「基础」组里的位置与手写版逐字一致", () => {
    seedScene([mapWithVideo()], ["map-1"]);
    render(<InspectorPanel />);

    // 顺序就是界面顺序：名称 → 激活 → 锁定 → 显示顺序 → 坐标 X/Y → 等比锁 → 缩放 → 角度
    expect(basicRowTestIds()).toEqual([
      "inspector-object-name",
      "inspector-object-active",
      "inspector-object-locked",
      "inspector-object-sorting",
      "inspector-object-x",
      "inspector-object-y",
      "inspector-object-scale-uniform",
      "inspector-object-scale",
      "inspector-object-rotation",
    ]);

    const sorting = screen.getByTestId("inspector-object-sorting") as HTMLInputElement;
    expect(sorting.value).toBe(String(MAP_DEFAULT_SORTING_ORDER));
    expect(sorting.getAttribute("aria-label")).toBe("显示顺序");
    expect(sorting.getAttribute("title")).toMatch(/大的画在前面/);
    expect(screen.getByText("显示顺序")).toBeDefined();
  });

  it("改动写进文档（走泛型入口）并可撤销，撤销说明取规格里的 label", () => {
    seedScene([mapWithVideo()], ["map-1"]);
    render(<InspectorPanel />);

    const sorting = screen.getByTestId("inspector-object-sorting") as HTMLInputElement;
    fireEvent.change(sorting, { target: { value: "9" } });
    fireEvent.blur(sorting);

    expect(useEditorStore.getState().scenes[0]!.objects[0]!.sortingOrder).toBe(9);
    // 与迁移前那条手写控件写的说明逐字一致（`修改` + 描述符的 label）
    expect(useEditorStore.getState().undoLabel).toBe("修改显示顺序");

    act(() => useEditorStore.getState().undo());
    expect(useEditorStore.getState().scenes[0]!.objects[0]!.sortingOrder).toBe(
      MAP_DEFAULT_SORTING_ORDER,
    );
  });

  it("越界值被文档命令夹取（规格里的 min / max 说了算）", () => {
    seedScene([mapWithVideo()], ["map-1"]);
    render(<InspectorPanel />);

    const sorting = screen.getByTestId("inspector-object-sorting") as HTMLInputElement;
    fireEvent.change(sorting, { target: { value: "99999" } });
    fireEvent.blur(sorting);

    expect(useEditorStore.getState().scenes[0]!.objects[0]!.sortingOrder).toBe(9999);
  });
});
