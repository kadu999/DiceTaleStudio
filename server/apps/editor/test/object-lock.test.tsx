import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createEmptyScene, createMapObject, createGameObject, type GameObjectDoc } from "@dts/document";
import { HierarchyPanel } from "../src/panels/hierarchy/HierarchyPanel";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";

/**
 * 对象的**锁定**：锁上就**不能被移动**。
 *
 * 画布拖动不好在 jsdom 里驱动（要真画布与指针事件），所以这里钉住三件事：
 * 1. 列表里的锁按钮与属性面板的勾选框都能切；
 * 2. `moveObject`（**全项目唯一的移动入口**，画布拖动与坐标输入都走它）对锁住的对象直接不生效；
 * 3. 锁定时属性面板的世界坐标输入框被禁用。
 */

const IMAGE = { id: "project:测试/Assets/images/Map001.png", width: 400, height: 300 };

function seedScene(objects: GameObjectDoc[], selected: readonly string[] = []): void {
  const scenes = [{ ...createEmptyScene("Map001"), objects }];
  sceneHistory.reset(scenes);
  useEditorStore.setState({
    scenes,
    activeSceneName: "Map001",
    selectedObjectIds: [...selected],
    selectedAssetId: null,
    project: { list: [], current: "测试", tree: [], busy: false, error: "" },
  });
}

const objectOf = (id: string): GameObjectDoc | undefined =>
  useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === id);

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  useEditorStore.setState({ scenes: [], activeSceneName: null, selectedObjectIds: [] });
});

describe("列表里的锁按钮", () => {
  it("每个对象都有一枚锁，默认不锁；点一下锁上、再点解开", () => {
    seedScene([
      createMapObject({ id: "map-1", name: "网格地图", image: IMAGE, grid: { width: 8, height: 6 } }),
      createGameObject({ id: "door", name: "木门", position: { x: 0, y: 0 } }),
    ]);
    render(<HierarchyPanel />);

    const locks = screen.getAllByTestId("object-lock-toggle");
    expect(locks).toHaveLength(2);
    for (const lock of locks) {
      expect(lock.getAttribute("data-locked")).toBe("false");
      expect(lock.getAttribute("aria-pressed")).toBe("false");
    }

    // 两次点击都直接读 store 的当前值：目标值必须由 store 现算
    const first = locks[0];
    expect(first).toBeDefined();
    first?.click();
    expect(objectOf("map-1")?.locked).toBe(true);

    first?.click();
    expect(objectOf("map-1")?.locked).toBe(false);
  });

  it("锁上不动别的字段（位置 / 激活 / 缩放照旧）", () => {
    seedScene([createGameObject({ id: "door", name: "木门", position: { x: 12, y: -34 } })]);
    render(<HierarchyPanel />);

    screen.getByTestId("object-lock-toggle").click();

    const object = objectOf("door");
    expect(object?.locked).toBe(true);
    expect(object?.position).toEqual({ x: 12, y: -34 });
    expect(object?.active).toBe(true);
    expect(object?.scale).toBe(1);
  });
});

describe("锁住 = 不能移动", () => {
  it("moveObject 对锁住的对象直接不生效（画布拖动与坐标输入都走它）", () => {
    seedScene([createGameObject({ id: "door", name: "木门", position: { x: 0, y: 0 } })]);

    // 未锁：能移动
    useEditorStore.getState().moveObject("door", { x: 100, y: 50 });
    expect(objectOf("door")?.position).toEqual({ x: 100, y: 50 });

    // 锁上：怎么移都不动
    useEditorStore.getState().setObjectLocked("door", true);
    useEditorStore.getState().moveObject("door", { x: -999, y: 999 });
    expect(objectOf("door")?.position).toEqual({ x: 100, y: 50 });

    // 解锁：又能移动了
    useEditorStore.getState().setObjectLocked("door", false);
    useEditorStore.getState().moveObject("door", { x: -10, y: 20 });
    expect(objectOf("door")?.position).toEqual({ x: -10, y: 20 });
  });

  it("锁地图也一样（底图最容易被误拖）", () => {
    seedScene([
      createMapObject({ id: "map-1", name: "网格地图", image: IMAGE, grid: { width: 8, height: 6 } }),
    ]);
    useEditorStore.getState().setObjectLocked("map-1", true);

    useEditorStore.getState().moveObject("map-1", { x: 300, y: 300 });
    expect(objectOf("map-1")?.position).toEqual({ x: 0, y: 0 });
  });
});

describe("属性面板里的锁定", () => {
  it("勾选框能锁 / 解锁，并禁用世界坐标输入", () => {
    seedScene([createGameObject({ id: "door", name: "木门", position: { x: 7, y: 8 } })], ["door"]);
    render(<InspectorPanel />);

    const locked = screen.getByTestId("inspector-object-locked") as HTMLInputElement;
    const x = screen.getByTestId("inspector-object-x") as HTMLInputElement;
    expect(locked.checked).toBe(false);
    expect(x.disabled).toBe(false);

    fireEvent.click(locked);

    expect(objectOf("door")?.locked).toBe(true);
    expect(locked.checked).toBe(true);
    // 锁上以后坐标框禁用（还看得见当前值，只是改不了）
    expect(x.disabled).toBe(true);
    expect(x.value).toBe("7");
    expect((screen.getByTestId("inspector-object-y") as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(locked);
    expect(objectOf("door")?.locked).toBe(false);
    expect((screen.getByTestId("inspector-object-x") as HTMLInputElement).disabled).toBe(false);
  });
});
