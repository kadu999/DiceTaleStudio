import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createEmptyScene, createGridMapObject, createGameObject, sortingOrderOf, type GameObjectDoc } from "@dts/document";
import { HierarchyPanel } from "../src/panels/hierarchy/HierarchyPanel";
import { checkerOriginOf } from "../src/panels/scene/ScenePanel";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";

/**
 * 「对象激活 / 显示顺序」在**列表与画布**两侧的行为。
 *
 * 画布本身不好在这里驱动（要 rAF、要真画布），所以这里钉住两件最容易出错的事：
 * 1. 列表里每个对象都有一枚激活按钮，点一下就把对象切到隐藏 / 显示，并落进 store；
 * 2. 画布用的棋盘底纹锚点算得对（地图矩形的左下角；没有地图就是世界原点）。
 */

const IMAGE = { id: "project:测试/Assets/images/Map001.png", width: 400, height: 300 };

/**
 * 把 store 摆成「打开了一个项目、里面有一个场景」的样子（不碰磁盘）。
 *
 * **必须同时 `sceneHistory.reset`**：对象编辑走的是历史容器，
 * 忘了这一步 `applyScenes` 会在空数组里找场景、永远「没产生变更」。
 */
function seedScene(objects: GameObjectDoc[]): void {
  const scenes = [{ ...createEmptyScene("Map001"), objects }];
  sceneHistory.reset(scenes);
  useEditorStore.setState({
    scenes,
    activeSceneName: "Map001",
    selectedObjectIds: [],
    project: { list: [], current: "测试", tree: [], busy: false, error: "" },
  });
}

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  useEditorStore.setState({ scenes: [], activeSceneName: null, selectedObjectIds: [] });
});

describe("场景对象列表：激活按钮", () => {
  it("每个对象都有一枚激活按钮，默认是激活的", () => {
    seedScene([
      createGridMapObject({ name: "网格地图", image: IMAGE, grid: { width: 8, height: 6 } }),
      createGameObject({ name: "木门", position: { x: 0, y: 0 } }),
    ]);

    render(<HierarchyPanel />);

    const toggles = screen.getAllByTestId("object-active-toggle");
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) {
      expect(toggle.getAttribute("data-active")).toBe("true");
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
    }
  });

  it("点一下就隐藏，再点一下回到显示", () => {
    seedScene([createGameObject({ id: "door", name: "木门", position: { x: 0, y: 0 } })]);
    render(<HierarchyPanel />);

    const toggle = screen.getByTestId("object-active-toggle");
    const active = (): boolean | undefined =>
      useEditorStore.getState().scenes[0]?.objects[0]?.active;

    // 两次点击都直接读 store 的当前值（jsdom 下不依赖组件重渲染）。
    // 「点第二下要能切回来」是有意的：目标值必须由 store 现算，
    // 若按钮拿着渲染时的旧 active 去算目标值，第二下就会变成重复设同一个值 = 什么都不做。
    toggle.click();
    expect(active()).toBe(false);

    toggle.click();
    expect(active()).toBe(true);
  });

  it("隐藏只动 active，不碰位置与显示顺序", () => {
    seedScene([createGameObject({ id: "door", name: "木门", position: { x: 12, y: -34 } })]);
    render(<HierarchyPanel />);

    screen.getByTestId("object-active-toggle").click();

    const object = useEditorStore.getState().scenes[0]?.objects[0];
    expect(object?.active).toBe(false);
    expect(object?.position).toEqual({ x: 12, y: -34 });
    expect(sortingOrderOf(object!)).toBe(0);
  });
});

describe("棋盘底纹的锚点", () => {
  it("有地图时锚在地图矩形的左下角（格子与地图网格同一套）", () => {
    const map = createGridMapObject({
      name: "网格地图",
      image: IMAGE,
      grid: { width: 8, height: 6 },
      position: { x: -300, y: 200 },
    });

    // 宽 400、高 300：左下角 = 中心 - 半宽 / 半高
    expect(checkerOriginOf([map])).toEqual({ x: -500, y: 50 });
  });

  it("没有地图时退回世界原点（底纹总得有个相位）", () => {
    expect(checkerOriginOf([createGameObject({ name: "木门" })])).toEqual({ x: 0, y: 0 });
    expect(checkerOriginOf([])).toEqual({ x: 0, y: 0 });
  });
});
