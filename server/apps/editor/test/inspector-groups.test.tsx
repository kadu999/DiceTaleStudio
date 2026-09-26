import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  createGridMapObject,
  createGameObject,
  createFogObject,
  featureComponent,
  imageOf,
  mapDataOf,
  type GameObjectDoc,
} from "@dts/document";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";

/**
 * 属性面板的**分组**（可折叠）：对象分组 = 「基础」+ **一一对应的组件组**——
 * 地图对象是「基础 / 网格地图 / 视频」，战争雾对象是「基础 / 战争雾」，精灵是「基础 / 精灵层」，
 * 贴图是「基础 / 图片层 / 视频」。点标题收起 / 展开。
 *
 * 参考实现也是这套行为（Unity 组件头式的折叠分组）：默认全展开、点标题切换、
 * 切换对象时回到展开。所以这里钉住五件事：分组出现、能收起 / 展开、
 * 折叠只影响显示不影响数据、换对象时状态重置，以及**顺序**（组件组跟在基础后面）。
 *
 * 「一个组件一个组」：网格地图的贴图 / 网格规格 / 标注合并在一组（`map`），
 * 战争雾自 v25 起是独立的 `FogOfWar` 组件（自己的 `fog` 组，跟着组件走）。
 * 「基础」组是**实体属性**（名称 / 变换，不进组件），角标「实体」；
 * 组件未添加时的组（视频启用开关、选图并添加、修复入口）是**能力入口**，角标「未添加」。
 */

const IMAGE = { id: "project:测试/Assets/images/Map001.png", width: 400, height: 300 };
const GRID = { width: 8, height: 6 };

function mapObject(): GameObjectDoc {
  return createGridMapObject({ id: "map-1", name: "网格地图", image: IMAGE, grid: GRID });
}

/** 贴图（v21 起取代精灵成为视频的另一个宿主）。 */
function textureObject(): GameObjectDoc {
  return createGameObject({ id: "tex-1", name: "贴图", kind: "Image" });
}

/** 战争雾对象（v27 起是独立的 `Fog` 对象，引用一张地图）。 */
function fogObject(): GameObjectDoc {
  return createFogObject({ id: "fog-1", name: "战争雾", mapId: "map-1", position: { x: 0, y: 0 } });
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

describe("属性分组：基础 + 一一对应的组件组", () => {
  it("空白精灵和贴图通过选图显式添加正确的图片组件并可一次撤销", () => {
    seedScene([
      createGameObject({ id: "sprite", name: "精灵", kind: "Sprite" }),
      createGameObject({ id: "image", name: "贴图", kind: "Image" }),
    ], ["sprite"]);
    render(<InspectorPanel />);

    expect(screen.getByTestId("pick-texture").textContent).toBe("选择图片并添加");
    expect(screen.getByText("图片组件缺失")).toBeDefined();
    act(() => {
      useEditorStore.getState().setObjectImageSprite(
        "sprite",
        { id: "project:测试/Assets/images/sheet.png", width: 128, height: 64 },
        { column: 1, row: 0 },
      );
    });
    expect(useEditorStore.getState().scenes[0]?.objects[0]?.components[0]).toMatchObject({
      id: "sprite__SpriteLayer",
      type: "SpriteLayer",
      data: { sprite: { column: 1, row: 0 } },
    });
    expect(useEditorStore.getState().canUndo).toBe(true);
    act(() => useEditorStore.getState().undo());
    expect(useEditorStore.getState().scenes[0]?.objects[0]?.components).toEqual([]);
    expect(useEditorStore.getState().canUndo).toBe(false);

    act(() => useEditorStore.getState().setSelection(["image"]));
    expect(screen.getByTestId("pick-texture").textContent).toBe("选择图片并添加");
    act(() => {
      useEditorStore.getState().setObjectImageSprite(
        "image",
        { id: "project:测试/Assets/images/picture.png", width: 96, height: 48 },
        null,
      );
    });
    const imageObject = useEditorStore.getState().scenes[0]?.objects[1];
    expect(imageObject?.components[0]).toMatchObject({ id: "image__ImageLayer", type: "ImageLayer" });
    expect(imageOf(imageObject!)).toEqual({
      id: "project:测试/Assets/images/picture.png",
      width: 96,
      height: 48,
    });
  });

  it("没有网格的贴图：网格组给「添加网格」入口，加完按图片尺寸建网格（一次撤销可还原）", () => {
    const broken = {
      ...createGameObject({ id: "broken-map", name: "贴图", kind: "Image" }),
      components: [
        featureComponent("broken-map", "ImageLayer", {
          id: "stale-image.png",
          width: 128,
          height: 64,
        }),
        { id: "unknown", type: "FutureComponent", data: { keep: true } },
      ],
    } satisfies GameObjectDoc;
    seedScene([broken], ["broken-map"]);
    render(<InspectorPanel />);

    const gridGroup = groupOf("map");
    expect(within(gridGroup).getByTestId("add-grid-map")).toBeDefined();
    // 战争雾自 v27 起是独立对象，这里没有它那一组
    expect(groupSlugs()).not.toContain("fog");

    fireEvent.click(within(gridGroup).getByTestId("add-grid-map"));

    const withGrid = useEditorStore.getState().scenes[0]?.objects[0];
    expect(mapDataOf(withGrid!)).toMatchObject({
      grid: { width: 4, height: 2 },
      cells: { encoding: "rle", runs: [[0, 8]] },
    });
    expect(withGrid?.components.find((component) => component.type === "FutureComponent")?.data).toEqual({ keep: true });
    expect(useEditorStore.getState().canUndo).toBe(true);

    act(() => useEditorStore.getState().undo());
    expect(mapDataOf(useEditorStore.getState().scenes[0]!.objects[0]!)).toBeUndefined();
    expect(useEditorStore.getState().canUndo).toBe(false);
  });

  it("网格地图分四组（基础 + 图片层 + 网格 + 视频）；精灵 / 贴图各两组、三组", () => {
    seedScene(
      [mapObject(), createGameObject({ id: "sprite", name: "精灵" }), fogObject()],
      ["map-1"],
    );
    const { unmount } = render(<InspectorPanel />);

    expect(headerOf("basic")).toBeDefined();
    expect(headerOf("image")).toBeDefined();
    expect(headerOf("map")).toBeDefined();
    expect(headerOf("video")).toBeDefined();
    expect(isOpen("basic")).toBe(true);
    expect(isOpen("image")).toBe(true);
    expect(isOpen("map")).toBe(true);
    expect(isOpen("video")).toBe(true);

    // 组序 = 基础 + 组件组（注册表顺序）：图片层 → 网格地图 → 视频
    // （战争雾自 v27 起是**独立对象**；网格自 v28 起是贴图上的可选组件）
    expect(groupSlugs()).toEqual(["basic", "image", "map", "video"]);
    expect(hasGroup("fog")).toBe(false);

    // 「基础」是实体属性组：挂「实体」角标，组件组不挂角标
    expect(groupOf("basic").querySelector('[data-testid="field-group-badge"]')?.getAttribute("data-kind")).toBe("entity");
    expect(groupOf("image").querySelector('[data-testid="field-group-badge"]')).toBeNull();
    expect(groupOf("map").querySelector('[data-testid="field-group-badge"]')).toBeNull();

    // 贴图那一行在「图片层」组里（v28 起网格地图的贴图也在图片层）：基础组里不再有它
    expect(within(groupOf("image")).getByTestId("pick-texture")).toBeDefined();
    expect(within(groupOf("basic")).queryByTestId("pick-texture")).toBeNull();

    // 视频那一组对贴图（含网格地图）出现；还没开时整组只剩「启用」那一个开关（也是能力入口）
    expect(within(groupOf("video")).getByTestId("video-enable")).toBeDefined();
    expect(within(groupOf("video")).queryByTestId("video-edit")).toBeNull();
    expect(groupOf("video").querySelector('[data-testid="field-group-badge"]')?.getAttribute("data-kind")).toBe("capability");

    // 网格规格（列 · 行 / 每格 / 行序）跟标注一起归「网格地图」组，基础组里不再有它
    expect(within(groupOf("map")).getByTestId("inspector-grid-columns")).toBeDefined();
    expect(within(groupOf("map")).getByTestId("inspector-grid-rows")).toBeDefined();
    expect(within(groupOf("map")).getByText("每格")).toBeDefined();
    expect(within(groupOf("map")).getByText("行序")).toBeDefined();
    expect(within(groupOf("basic")).queryByTestId("inspector-grid-columns")).toBeNull();
    expect(within(groupOf("basic")).queryByText("每格")).toBeNull();
    expect(within(groupOf("basic")).queryByText("行序")).toBeNull();

    // 战争雾对象（v27 起是独立对象）：「基础 / 战争雾」，组件在 = 正式组（不挂角标）
    act(() => useEditorStore.getState().setSelection(["fog-1"]));
    expect(headerOf("basic")).toBeDefined();
    expect(headerOf("fog")).toBeDefined();
    expect(groupSlugs()).toEqual(["basic", "fog"]);
    expect(within(groupOf("fog")).getByTestId("fog-map")).toBeDefined();
    expect(within(groupOf("fog")).getByTestId("fog-enable")).toBeDefined();
    expect(groupOf("fog").querySelector('[data-testid="field-group-badge"]')).toBeNull();
    expect(hasGroup("map")).toBe(false);
    expect(hasGroup("video")).toBe(false);

    unmount();
    seedScene([mapObject(), createGameObject({ id: "sprite", name: "精灵" })], ["sprite"]);
    const spritePanel = render(<InspectorPanel />);

    // 精灵：「基础 / 精灵层」（图片组件是 `SpriteLayer`，组 slug 跟着组件走）。
    // 没有「视频」（v21 起那一组归贴图），也不是地图 → 没有网格地图 / 战争雾
    expect(headerOf("basic")).toBeDefined();
    expect(headerOf("sprite")).toBeDefined();
    expect(groupSlugs()).toEqual(["basic", "sprite"]);
    expect(hasGroup("video")).toBe(false);
    expect(hasGroup("map")).toBe(false);
    expect(hasGroup("fog")).toBe(false);

    spritePanel.unmount();
    seedScene([mapObject(), textureObject()], ["tex-1"]);
    render(<InspectorPanel />);

    // 贴图：「基础 / 图片层 / 网格 / 视频」（网格是可选能力，入口照常出现），没有战争雾
    expect(headerOf("basic")).toBeDefined();
    expect(headerOf("image")).toBeDefined();
    expect(headerOf("map")).toBeDefined();
    expect(headerOf("video")).toBeDefined();
    expect(groupSlugs()).toEqual(["basic", "image", "map", "video"]);
    expect(within(groupOf("video")).getByTestId("video-enable")).toBeDefined();
    expect(within(groupOf("map")).getByTestId("add-grid-map")).toBeDefined();
    expect(hasGroup("fog")).toBe(false);
  });

  it("点「网格地图」标题收起内容（网格行一起），再点展开", () => {
    seedScene([mapObject()], ["map-1"]);
    render(<InspectorPanel />);

    // 展开时看得见网格规格与网格编辑入口
    expect(screen.getByTestId("inspector-grid-columns")).toBeDefined();
    expect(screen.getByTestId("grid-editor-open")).toBeDefined();

    fireEvent.click(headerOf("map"));
    expect(isOpen("map")).toBe(false);
    expect(headerOf("map").getAttribute("aria-expanded")).toBe("false");
    // 收起 = 内容不渲染（不是藏起来还留在 DOM 里）：网格行一起消失
    expect(within(groupOf("map")).queryByTestId("inspector-grid-columns")).toBeNull();
    expect(within(groupOf("map")).queryByTestId("grid-editor-open")).toBeNull();

    fireEvent.click(headerOf("map"));
    expect(isOpen("map")).toBe(true);
    expect(screen.getByTestId("inspector-grid-columns")).toBeDefined();
    expect(screen.getByTestId("grid-editor-open")).toBeDefined();
  });

  it("点「战争雾」标题收起内容，再点展开", () => {
    seedScene([mapObject(), fogObject()], ["fog-1"]);
    render(<InspectorPanel />);

    // 展开时看得见启用开关
    expect(screen.getByTestId("fog-enable")).toBeDefined();

    // 箭头是内联 SVG（不是 10px 的 `▾` / `▸` 字形）：收起时也还在，只是转了方向
    expect(headerOf("fog").querySelector("svg")).not.toBeNull();

    fireEvent.click(headerOf("fog"));
    expect(isOpen("fog")).toBe(false);
    expect(headerOf("fog").getAttribute("aria-expanded")).toBe("false");
    // 收起 = 内容不渲染（不是藏起来还留在 DOM 里）
    expect(within(groupOf("fog")).queryByTestId("fog-enable")).toBeNull();
    expect(headerOf("fog").querySelector("svg")).not.toBeNull();

    fireEvent.click(headerOf("fog"));
    expect(isOpen("fog")).toBe(true);
    expect(screen.getByTestId("fog-enable")).toBeDefined();
  });

  it("折叠只影响「看见什么」：数据与画笔都不动", () => {
    seedScene([mapObject()], ["map-1"]);
    useEditorStore.getState().setGridBrush(128);
    render(<InspectorPanel />);

    fireEvent.click(headerOf("map"));

    expect(isOpen("map")).toBe(false);
    expect(useEditorStore.getState().gridPaint.mask).toBe(128);
    // 基础组照常开着，对象数据也没被碰
    expect(isOpen("basic")).toBe(true);
    expect(screen.getByTestId("inspector-object-name")).toBeDefined();
  });

  it("换对象时分组回到展开（上一个对象收起的分组不会跟过来）", () => {
    seedScene(
      [mapObject(), createGameObject({ id: "sprite", name: "精灵" }), fogObject()],
      ["map-1"],
    );
    render(<InspectorPanel />);

    fireEvent.click(headerOf("map"));
    fireEvent.click(headerOf("video"));
    expect(isOpen("map")).toBe(false);
    expect(isOpen("video")).toBe(false);

    // 换到雾对象：它是另一套（基础 + 战争雾），地图 / 视频不跟过来
    act(() => useEditorStore.getState().setSelection(["fog-1"]));
    expect(headerOf("basic")).toBeDefined();
    expect(headerOf("fog")).toBeDefined();
    expect(isOpen("fog")).toBe(true);
    expect(hasGroup("map")).toBe(false);
    expect(hasGroup("video")).toBe(false);

    // 再回到地图：那些组都是**展开**的
    act(() => useEditorStore.getState().setSelection(["map-1"]));
    expect(isOpen("basic")).toBe(true);
    expect(isOpen("map")).toBe(true);
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
    expect(hasGroup("sprite")).toBe(false);
    expect(hasGroup("video")).toBe(false);
  });
});
