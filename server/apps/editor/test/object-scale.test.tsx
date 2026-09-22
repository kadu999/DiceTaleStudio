import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DEFAULT_OBJECT_SCALE,
  FEATURE_COMPONENT,
  MAX_OBJECT_SCALE,
  MIN_OBJECT_SCALE,
  featureComponent,
} from "@dts/document";
import { createMapObject, createSceneObject, type SceneObjectDoc } from "@dts/document";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { displayRectOf } from "../src/panels/scene/display";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";

/**
 * 对象的**缩放**：属性面板里的那个字段 + 它在画布上真正起的作用。
 *
 * 画布本身不好在这里驱动（要 rAF、要真画布），所以这里钉住两件最容易出错的：
 * 1. 「缩放」字段（每个对象都有、默认 1、提交后进文档、可撤销）；
 * 2. `displayRectOf` —— 显示 / 拾取 / 选中框**共用**的那块矩形确实乘上了缩放
 *    （这块矩形一旦算错，就会出现「看着在那儿、点不到」）。
 */

const IMAGE = { id: "project:测试/Assets/images/Map001.png", width: 400, height: 300 };
const GRID = { width: 8, height: 6 };

function sprite(scale = 1): SceneObjectDoc {
  return {
    ...createSceneObject({ id: "sprite-1", name: "精灵", position: { x: 100, y: 50 } }),
    // 贴图是它的 `TextureRenderer` 组件（v19 起）
    components: [
      featureComponent("sprite-1", FEATURE_COMPONENT.image, {
        id: "project:测试/Assets/images/Sprite.png",
        width: 120,
        height: 80,
      }),
    ],
    scale,
  };
}

function seedScene(objects: SceneObjectDoc[], selected: readonly string[]): void {
  const scenes = [{ name: "Map001", objects }];
  sceneHistory.reset(scenes);
  useEditorStore.setState({
    scenes,
    activeSceneName: "Map001",
    selectedObjectIds: [...selected],
    selectedAssetId: null,
    project: { list: [], current: "测试", tree: [], busy: false, error: "" },
  });
}

const objectOf = (id: string): SceneObjectDoc | undefined =>
  useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === id);

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  useEditorStore.setState({ scenes: [], activeSceneName: null, selectedObjectIds: [] });
});

describe("缩放字段（所有对象都有）", () => {
  it("默认显示 1；精灵与地图都有这一行", () => {
    seedScene([sprite(), createMapObject({ id: "map-1", name: "地图", image: IMAGE, grid: GRID })], [
      "sprite-1",
    ]);
    const { unmount } = render(<InspectorPanel />);
    expect((screen.getByTestId("inspector-object-scale") as HTMLInputElement).value).toBe("1");
    unmount();

    seedScene(
      [sprite(), createMapObject({ id: "map-1", name: "地图", image: IMAGE, grid: GRID })],
      ["map-1"],
    );
    render(<InspectorPanel />);
    expect((screen.getByTestId("inspector-object-scale") as HTMLInputElement).value).toBe("1");
  });

  it("改成 2.5 就写进文档，并能撤销回 1", () => {
    seedScene([sprite()], ["sprite-1"]);
    render(<InspectorPanel />);

    const input = screen.getByTestId("inspector-object-scale");
    fireEvent.change(input, { target: { value: "2.5" } });
    fireEvent.blur(input);

    expect(objectOf("sprite-1")?.scale).toBe(2.5);
    expect(useEditorStore.getState().undoLabel).toBe("修改缩放");

    useEditorStore.getState().undo();
    expect(objectOf("sprite-1")?.scale).toBe(DEFAULT_OBJECT_SCALE);
  });

  it("越界值由文档夹住，框里回填的是**实际采用的值**", () => {
    seedScene([sprite()], ["sprite-1"]);
    render(<InspectorPanel />);
    const input = screen.getByTestId("inspector-object-scale") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "1000" } });
    fireEvent.blur(input);
    expect(objectOf("sprite-1")?.scale).toBe(MAX_OBJECT_SCALE);
    expect(input.value).toBe(String(MAX_OBJECT_SCALE));

    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    // 0 被夹到下限（文档里是正数），而不是把零面积写进去
    expect(objectOf("sprite-1")?.scale).toBe(MIN_OBJECT_SCALE);
    expect(input.value).toBe(String(MIN_OBJECT_SCALE));
  });

  it("留空 / 敲字母都退回当前值，不把 NaN 写进文档", () => {
    seedScene([sprite(2)], ["sprite-1"]);
    render(<InspectorPanel />);
    const input = screen.getByTestId("inspector-object-scale") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(objectOf("sprite-1")?.scale).toBe(2);
    expect(input.value).toBe("2");
  });
});

describe("displayRectOf：显示 / 拾取 / 选中框共用的矩形", () => {
  it("有图片时 = 图片尺寸 × 缩放，中心就是位置", () => {
    expect(displayRectOf(sprite(1))).toEqual({
      center: { x: 100, y: 50 },
      size: { width: 120, height: 80 },
    });

    expect(displayRectOf(sprite(2))?.size).toEqual({ width: 240, height: 160 });
    expect(displayRectOf(sprite(0.5))?.size).toEqual({ width: 60, height: 40 });
    // 缩放不改中心
    expect(displayRectOf(sprite(3))?.center).toEqual({ x: 100, y: 50 });
  });

  it("地图按缩放后的矩形算（贴图与网格一起缩放）", () => {
    const map = { ...createMapObject({ name: "地图", image: IMAGE, grid: GRID }), scale: 2 };
    expect(displayRectOf(map)?.size).toEqual({ width: 800, height: 600 });
  });

  it("没有图片（刚建出来的精灵）用兜底矩形，同样乘缩放", () => {
    const bare = createSceneObject({ id: "bare", name: "空对象", position: { x: 0, y: 0 } });
    expect(displayRectOf(bare)?.size).toEqual({ width: 64, height: 64 });
    expect(displayRectOf({ ...bare, scale: 2 })?.size).toEqual({ width: 128, height: 128 });
  });

  it("缩放坏掉（0 / 负数 / NaN）时按 1 画：画布不能因为一个坏数字整块消失", () => {
    for (const broken of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(displayRectOf({ ...sprite(1), scale: broken })?.size).toEqual({
        width: 120,
        height: 80,
      });
    }
  });

  it("旋转不改这块矩形：`rotation` 由绘制 / 拾取 / 手柄各自带上", () => {
    // 曾经返回的是**旋转后的外框**：非正方形对象转过角度后，贴图会被画成外框的形状
    // （1920×1080 的地图转 45° 就变成 2121×2121 的方块），而且绘制用的手柄几何（外框）
    // 与命中测试用的几何（局部矩形）对不上——「看得见的柄点不中」
    for (const rotation of [Math.PI / 6, Math.PI / 4, Math.PI / 2, -1]) {
      expect(displayRectOf({ ...sprite(1), rotation })).toEqual({
        center: { x: 100, y: 50 },
        size: { width: 120, height: 80 },
      });
    }
  });

  it("没有位置的对象没有矩形（不画也点不到）", () => {
    expect(displayRectOf(sprite())).toBeDefined();
    const unplaced = createSceneObject({ id: "x", name: "未放置" });
    expect(displayRectOf(unplaced)).toBeUndefined();
  });
});
