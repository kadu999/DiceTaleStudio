import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createMapObject, createSceneObject, type SceneObjectDoc } from "@dts/document";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";

/**
 * 属性面板的**分组**（可折叠）：地图对象分「基础 / 编辑」两组，点标题收起 / 展开。
 *
 * 参考实现也是这套行为（Unity 组件头式的折叠分组）：默认全展开、点标题切换、
 * 切换对象时回到展开。所以这里钉住四件事：分组出现、能收起 / 展开、
 * 折叠只影响显示不影响数据、换对象时状态重置。
 */

const IMAGE = { id: "project:测试/Assets/images/Map001.png", width: 400, height: 300 };
const GRID = { width: 8, height: 6 };

function mapObject(): SceneObjectDoc {
  return createMapObject({ id: "map-1", name: "网格地图", image: IMAGE, grid: GRID });
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

/** 某个分组的 `<section>`（按 `data-group` slug 定位；中文标题只用于显示）。 */
function groupOf(slug: string): HTMLElement {
  const section = document.querySelector<HTMLElement>(`[data-group="${slug}"]`);
  if (section === null) {
    throw new Error(`没有找到分组 ${slug}`);
  }

  return section;
}

const isOpen = (slug: string): boolean => groupOf(slug).getAttribute("data-open") === "true";

function headerOf(slug: string): HTMLElement {
  return within(groupOf(slug)).getByTestId("field-group-header");
}

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  useEditorStore.setState({ scenes: [], activeSceneName: null, selectedObjectIds: [] });
});

describe("属性分组：基础 / 编辑", () => {
  it("地图对象分两组，默认都展开；精灵只有「基础」", () => {
    seedScene([mapObject(), createSceneObject({ id: "sprite", name: "精灵" })], ["map-1"]);
    const { unmount } = render(<InspectorPanel />);

    expect(screen.getByRole("button", { name: "基础" })).toBeDefined();
    expect(screen.getByRole("button", { name: "编辑" })).toBeDefined();
    expect(isOpen("basic")).toBe(true);
    expect(isOpen("edit")).toBe(true);
    expect(headerOf("edit").getAttribute("aria-expanded")).toBe("true");

    unmount();
    seedScene([mapObject(), createSceneObject({ id: "sprite", name: "精灵" })], ["sprite"]);
    render(<InspectorPanel />);

    // 精灵没有格子可编辑：不该有「编辑」组（也不该空着一块）
    expect(screen.getByRole("button", { name: "基础" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
  });

  it("点「编辑」标题收起内容，再点展开", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    // 展开时看得见调色板的入口
    expect(screen.getByTestId("grid-paint-enter")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(isOpen("edit")).toBe(false);
    expect(headerOf("edit").getAttribute("aria-expanded")).toBe("false");
    // 收起 = 内容不渲染（不是藏起来还留在 DOM 里）
    expect(within(groupOf("edit")).queryByTestId("grid-paint-enter")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(isOpen("edit")).toBe(true);
    expect(screen.getByTestId("grid-paint-enter")).toBeDefined();
  });

  it("折叠只影响「看见什么」：数据与画笔都不动", () => {
    seedScene([mapObject()], ["map-1"]);
    useEditorStore.getState().setGridBrush(128);
    render(<InspectorPanel />);

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));

    expect(isOpen("edit")).toBe(false);
    expect(useEditorStore.getState().gridPaint.mask).toBe(128);
    // 基础组照常开着，对象数据也没被碰
    expect(isOpen("basic")).toBe(true);
    expect(screen.getByTestId("inspector-object-name")).toBeDefined();
  });

  it("换对象时分组回到展开（上一个对象收起的分组不会跟过来）", () => {
    seedScene([mapObject(), createSceneObject({ id: "sprite", name: "精灵" })], ["map-1"]);
    render(<InspectorPanel />);

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(isOpen("edit")).toBe(false);

    // 换到精灵：分组是另一套（只有基础）
    act(() => useEditorStore.getState().setSelection(["sprite"]));
    expect(screen.getByRole("button", { name: "基础" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();

    // 再回到地图：编辑组是**展开**的
    act(() => useEditorStore.getState().setSelection(["map-1"]));
    expect(isOpen("basic")).toBe(true);
    expect(isOpen("edit")).toBe(true);
  });

  it("场景 / 资源 / 项目视图也走同一套可折叠分组", () => {
    seedScene([mapObject()], []);
    render(<InspectorPanel />);

    // 没有选中对象、有场景 → 场景分组
    expect(within(groupOf("scene")).getByText("名称")).toBeDefined();
    expect(isOpen("scene")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "场景" }));
    expect(isOpen("scene")).toBe(false);
  });
});
