import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createMapObject, createGameObject, featureComponent, type GameObjectDoc } from "@dts/document";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";

/**
 * 属性面板的**分组**（可折叠）：地图对象分「基础 / 渲染 / 区域 / 战争雾」四组，点标题收起 / 展开。
 *
 * 参考实现也是这套行为（Unity 组件头式的折叠分组）：默认全展开、点标题切换、
 * 切换对象时回到展开。所以这里钉住五件事：分组出现、能收起 / 展开、
 * 折叠只影响显示不影响数据、换对象时状态重置，以及**顺序**（渲染在基础下面、战争雾在最后）。
 *
 * 「区域」组（slug 仍是 `edit`）同时钉住**网格规格的归属**：列 · 行 / 每格 / 行序
 * 以前挂在「基础」里，现在跟显示开关、标注入口一起归这一组。
 */

const IMAGE = { id: "project:测试/Assets/images/Map001.png", width: 400, height: 300 };
const GRID = { width: 8, height: 6 };

function mapObject(): GameObjectDoc {
  return createMapObject({ id: "map-1", name: "网格地图", image: IMAGE, grid: GRID });
}

/** 贴图（v21 起取代精灵成为视频的另一个宿主）。 */
function textureObject(): GameObjectDoc {
  return createGameObject({ id: "tex-1", name: "贴图", kind: "Image" });
}

function seedScene(objects: GameObjectDoc[], selected: readonly string[]): void {
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

/**
 * 面板上分组的**先后**（按 DOM 顺序）——「渲染排在基础下面」这类位置约束靠它钉住。
 *
 * 只在**对象属性**里数：`data-group` 是通用属性，别的组件（分栏容器之类）也会挂。
 */
const groupSlugs = (): (string | null)[] =>
  Array.from(document.querySelectorAll('[data-testid="object-properties"] [data-group]')).map(
    (section) => section.getAttribute("data-group"),
  );

function headerOf(slug: string): HTMLElement {
  return within(groupOf(slug)).getByTestId("field-group-header");
}

/**
 * 有没有这个分组。
 *
 * 断言「没有区域组」要用它而不是按名字找按钮：菜单栏里也有一个「编辑」菜单，
 * 组内那个入口按钮同样叫「编辑」，按名字找会撞车（而且这里想钉的本来就是**分组**在不在）。
 */
const hasGroup = (slug: string): boolean =>
  document.querySelector(`[data-group="${slug}"]`) !== null;

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  useEditorStore.setState({ scenes: [], activeSceneName: null, selectedObjectIds: [] });
});

describe("属性分组：基础 / 渲染 / 区域 / 战争雾 / 视频", () => {
  it("地图对象分五组；精灵只有基础 / 渲染；贴图有基础 / 渲染 / 视频", () => {
    seedScene([mapObject(), createGameObject({ id: "sprite", name: "精灵" })], ["map-1"]);
    const { unmount } = render(<InspectorPanel />);

    expect(headerOf("basic")).toBeDefined();
    expect(headerOf("render")).toBeDefined();
    expect(headerOf("edit")).toBeDefined();
    expect(headerOf("fog")).toBeDefined();
    expect(headerOf("video")).toBeDefined();
    expect(isOpen("basic")).toBe(true);
    expect(isOpen("render")).toBe(true);
    expect(isOpen("edit")).toBe(true);
    expect(isOpen("fog")).toBe(true);
    expect(isOpen("video")).toBe(true);
    expect(headerOf("render").getAttribute("aria-expanded")).toBe("true");

    // 渲染**紧跟在基础后面**（在「区域」之前）：换贴图属于「画成什么样」，与格子的编辑分开；
    // 战争雾与视频排在最后（都是运行时要用的东西，且是随后才加的）
    expect(groupSlugs()).toEqual(["basic", "render", "edit", "fog", "video"]);

    // 贴图那一行搬进了「渲染」：基础组里不再有它
    expect(within(groupOf("render")).getByTestId("pick-texture")).toBeDefined();
    expect(within(groupOf("basic")).queryByTestId("pick-texture")).toBeNull();
    // 战争雾那一组只在有地图数据时出现
    expect(within(groupOf("fog")).getByTestId("fog-enable")).toBeDefined();
    // 视频那一组对地图与贴图都出现；还没开时整组只剩「启用」那一个开关
    expect(within(groupOf("video")).getByTestId("video-enable")).toBeDefined();
    expect(within(groupOf("video")).queryByTestId("video-edit")).toBeNull();

    // 网格规格（列 · 行 / 每格 / 行序）在「区域」里，基础组里不再有它
    expect(within(groupOf("edit")).getByTestId("inspector-grid-columns")).toBeDefined();
    expect(within(groupOf("edit")).getByTestId("inspector-grid-rows")).toBeDefined();
    expect(within(groupOf("edit")).getByText("每格")).toBeDefined();
    expect(within(groupOf("edit")).getByText("行序")).toBeDefined();
    expect(within(groupOf("basic")).queryByTestId("inspector-grid-columns")).toBeNull();
    expect(within(groupOf("basic")).queryByText("每格")).toBeNull();
    expect(within(groupOf("basic")).queryByText("行序")).toBeNull();

    unmount();
    seedScene([mapObject(), createGameObject({ id: "sprite", name: "精灵" })], ["sprite"]);
    const spritePanel = render(<InspectorPanel />);

    // 精灵也有「渲染」（每个对象都能显示图片），但**没有**「视频」——v21 起视频宿主换成了贴图；
    // 也没有格子可编辑、不是地图 → 没有区域 / 战争雾
    expect(headerOf("basic")).toBeDefined();
    expect(headerOf("render")).toBeDefined();
    expect(groupSlugs()).toEqual(["basic", "render"]);
    expect(hasGroup("video")).toBe(false);
    expect(hasGroup("edit")).toBe(false);
    expect(hasGroup("fog")).toBe(false);

    spritePanel.unmount();
    seedScene([mapObject(), textureObject()], ["tex-1"]);
    render(<InspectorPanel />);

    // 贴图：基础 + 渲染 + 视频（视频的另一个宿主），但没有区域 / 战争雾
    expect(headerOf("basic")).toBeDefined();
    expect(headerOf("render")).toBeDefined();
    expect(headerOf("video")).toBeDefined();
    expect(groupSlugs()).toEqual(["basic", "render", "video"]);
    expect(within(groupOf("video")).getByTestId("video-enable")).toBeDefined();
    expect(hasGroup("edit")).toBe(false);
    expect(hasGroup("fog")).toBe(false);
  });

  it("点「渲染」标题收起内容，再点展开", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    // 展开时看得见贴图那一行（「选择」按钮就是换图入口）
    expect(screen.getByTestId("pick-texture")).toBeDefined();

    fireEvent.click(headerOf("render"));
    expect(isOpen("render")).toBe(false);
    expect(headerOf("render").getAttribute("aria-expanded")).toBe("false");
    // 收起 = 内容不渲染（不是藏起来还留在 DOM 里）
    expect(within(groupOf("render")).queryByTestId("pick-texture")).toBeNull();

    fireEvent.click(headerOf("render"));
    expect(isOpen("render")).toBe(true);
    expect(screen.getByTestId("pick-texture")).toBeDefined();
  });

  it("点「区域」标题收起内容，再点展开", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    // 展开时看得见编辑窗口的入口
    expect(screen.getByTestId("grid-editor-open")).toBeDefined();

    // 箭头是内联 SVG（不是 10px 的 `▾` / `▸` 字形）：收起时也还在，只是转了方向
    expect(headerOf("edit").querySelector("svg")).not.toBeNull();

    fireEvent.click(headerOf("edit"));
    expect(isOpen("edit")).toBe(false);
    expect(headerOf("edit").getAttribute("aria-expanded")).toBe("false");
    // 收起 = 内容不渲染（不是藏起来还留在 DOM 里）
    expect(within(groupOf("edit")).queryByTestId("grid-editor-open")).toBeNull();
    expect(headerOf("edit").querySelector("svg")).not.toBeNull();

    fireEvent.click(headerOf("edit"));
    expect(isOpen("edit")).toBe(true);
    expect(screen.getByTestId("grid-editor-open")).toBeDefined();
  });

  it("折叠只影响「看见什么」：数据与画笔都不动", () => {
    seedScene([mapObject()], ["map-1"]);
    useEditorStore.getState().setGridBrush(128);
    render(<InspectorPanel />);

    fireEvent.click(headerOf("edit"));

    expect(isOpen("edit")).toBe(false);
    expect(useEditorStore.getState().gridPaint.mask).toBe(128);
    // 基础组照常开着，对象数据也没被碰
    expect(isOpen("basic")).toBe(true);
    expect(screen.getByTestId("inspector-object-name")).toBeDefined();
  });

  it("换对象时分组回到展开（上一个对象收起的分组不会跟过来）", () => {
    seedScene([mapObject(), createGameObject({ id: "sprite", name: "精灵" })], ["map-1"]);
    render(<InspectorPanel />);

    fireEvent.click(headerOf("render"));
    fireEvent.click(headerOf("edit"));
    fireEvent.click(headerOf("fog"));
    expect(isOpen("render")).toBe(false);
    expect(isOpen("edit")).toBe(false);
    expect(isOpen("fog")).toBe(false);

    // 换到精灵：分组是另一套（基础 + 渲染，没有视频 / 区域 / 战争雾）
    act(() => useEditorStore.getState().setSelection(["sprite"]));
    expect(headerOf("basic")).toBeDefined();
    expect(headerOf("render")).toBeDefined();
    expect(hasGroup("video")).toBe(false);
    expect(hasGroup("edit")).toBe(false);
    expect(hasGroup("fog")).toBe(false);

    // 再回到地图：那些组都是**展开**的
    act(() => useEditorStore.getState().setSelection(["map-1"]));
    expect(isOpen("basic")).toBe(true);
    expect(isOpen("render")).toBe(true);
    expect(isOpen("edit")).toBe(true);
    expect(isOpen("fog")).toBe(true);
    expect(isOpen("video")).toBe(true);
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

  it("显式组件决定组件编辑器，不再额外按旧 kind 补出预设组件编辑器", () => {
    const object = createGameObject({ id: "custom", name: "组合对象", kind: "PlaySound" });
    object.components.push(
      featureComponent(object.id, "VideoOverlay", {
        enabled: true,
        autoPlay: false,
        clips: [],
        loop: false,
        audio: false,
      }),
    );
    seedScene([object], [object.id]);

    render(<InspectorPanel />);

    expect(groupSlugs()).toEqual(["basic", "video"]);
    expect(within(groupOf("video")).getByTestId("video-enable")).toBeDefined();
    expect(hasGroup("sound")).toBe(false);
  });

  it("kind 与组件错位时显示实际挂载的组件编辑器", () => {
    const object = createGameObject({ id: "custom", name: "组合对象", kind: "Sprite" });
    object.components.push(
      featureComponent(object.id, "Teleport", { targets: [], picked: undefined }),
    );
    seedScene([object], [object.id]);

    render(<InspectorPanel />);

    expect(groupSlugs()).toEqual(["basic", "teleport"]);
    expect(hasGroup("render")).toBe(false);
    expect(hasGroup("video")).toBe(false);
  });
});
