import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DEFAULT_SLOT_COMPONENT,
  createMagnifierObject,
  featureComponent,
  magnifierDataOf,
  magnifierImageOf,
  type GameObjectDoc,
  type ImageRef,
} from "@dts/document";
import { MagnifierDialog } from "../src/app/MagnifierDialog";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { KIND_LABELS, OBJECT_CATEGORIES, creatableObjects } from "../src/panels/object-kinds";
import { displayRectOf } from "../src/panels/scene/display";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";

/**
 * **放大镜**（动作对象，v30）：弹框里「动作」种类下的第三个对象。
 *
 * 数据是「**图片列表 + 当前展示的那一张**」：列表项直接复用 `ImageRef`（所以一条可以只是
 * 图集里的一格），**选中是下标**（同一张图的两个不同格子是两条）。
 * 分工与声音 / 传送阵同一套：列表在属性面板里加 / 移出，展示哪一张在面板的小方块或
 * 那扇窗下面那排小图上点——**都是文档数据**（进撤销栈、随场景存盘下发）。
 *
 * 另一件要钉死的事：**触发它 = 让前端弹一扇窗**（`open_magnifier` / `close_magnifier`），
 * 编辑态只预览、一条命令都不发；前端那扇窗没有按钮，只能由后端开、由后端关。
 */

const IMAGE: ImageRef = { id: "project:测试/Assets/images/handout.png", width: 400, height: 300 };
const OTHER: ImageRef = { id: "project:测试/Assets/images/clue.png", width: 64, height: 64 };
/** 同一张图的**另一格**（与 `IMAGE` 同 id、不同格子 = 列表里的另一条）。 */
const CELL: ImageRef = { ...IMAGE, width: 100, height: 100, sprite: { column: 1, row: 0 } };

function magnifier(images: readonly ImageRef[] = [], picked?: number): GameObjectDoc {
  return createMagnifierObject({
    id: "magnifier-1",
    name: "放大镜",
    images,
    ...(picked === undefined ? {} : { picked }),
    position: { x: 0, y: 0 },
  });
}

function seedScene(objects: GameObjectDoc[]): void {
  const scenes = [{ name: "Map001", objects }];
  sceneHistory.reset(scenes);
  useEditorStore.setState({
    scenes,
    activeSceneName: "Map001",
    selectedObjectIds: [objects[0]?.id ?? ""],
    selectedAssetId: null,
    magnifierEditor: false,
    magnifierEditorTarget: null,
    magnifierShown: null,
    project: { list: [], current: "测试", tree: [], busy: false, error: "" },
  });
}

/** 把运行态摆成「已连上服务端 / 前端连没连」的样子（只改 store，不起真连接）。 */
function seedRuntime(clientConnected: boolean): void {
  useEditorStore.setState((state) => ({
    mode: "run" as const,
    runtime: {
      ...state.runtime,
      status: "open" as const,
      client: clientConnected ? { name: "DiceTale Unity", version: "1.0.0", connectedAt: 0 } : null,
    },
  }));
}

const objectOf = (id: string): GameObjectDoc | undefined =>
  useEditorStore.getState().scenes[0]?.objects.find((item) => item.id === id);

const dataOf = (id: string): { images?: readonly ImageRef[]; picked?: number } | undefined => {
  const object = objectOf(id);
  return object === undefined ? undefined : magnifierDataOf(object);
};

const logs = (): string[] => useEditorStore.getState().runtime.logs.map((entry) => entry.message);

/** 面板上的图片小方块（顺序 = 加进来的先后）。 */
const chips = (): HTMLElement[] => screen.queryAllByTestId("magnifier-image");

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    mode: "edit",
    magnifierEditor: false,
    magnifierEditorTarget: null,
    magnifierShown: null,
    runtime: {
      status: "idle",
      runtimeActive: false,
      client: null,
      scene: null,
      resources: null,
      settings: null,
      logs: [],
      lastError: "",
    },
  });
});

describe("种类表：动作下的「放大镜」", () => {
  it("「动作」种类下有它、可以创建，展示名叫「放大镜」", () => {
    const action = OBJECT_CATEGORIES.find((category) => category.id === "action");
    expect(action).toBeDefined();
    expect(creatableObjects(action!).map((object) => object.kind)).toContain("Magnifier");
    expect(KIND_LABELS.Magnifier).toBe("放大镜");
  });
});

describe("创建放大镜", () => {
  it("store 建出来的是 Magnifier：摆在场景正中，图片列表还是空的", async () => {
    await act(async () => {
      seedScene([]);
      expect(await useEditorStore.getState().createObject("Magnifier", "放大镜")).toBeUndefined();
    });

    const object = useEditorStore.getState().scenes[0]?.objects[0];
    expect(object?.kind).toBe("Magnifier");
    expect(object === undefined ? undefined : magnifierDataOf(object)).toEqual({ images: [] });
    expect(object?.position).toEqual({ x: 0, y: 0 });
    // 画布上给的是**固定徽标**那块 64×64 的矩形（它没有贴图；挂了贴图也不认）
    expect(object === undefined ? undefined : displayRectOf(object)?.size).toEqual({
      width: 64,
      height: 64,
    });
  });
});

describe("属性面板：图片小方块 + 加 / 移出 + 打开窗口", () => {
  it("缺少放大镜组件时提供显式修复；修复后显示正常字段", () => {
    const broken = { ...magnifier(), components: [] };
    seedScene([broken]);
    render(<InspectorPanel />);

    expect(screen.getByText("组件数据缺失")).toBeDefined();
    expect(screen.queryByTestId("magnifier-images")).toBeNull();
    fireEvent.click(screen.getByTestId("repair-component-Magnifier"));

    expect(dataOf(broken.id)).toEqual({ images: [] });
    expect(screen.getByTestId("magnifier-images")).toBeDefined();
  });

  it("还没加图片：写明「还没加图片」（点 ＋ 去挑）", () => {
    seedScene([magnifier()]);
    render(<InspectorPanel />);

    expect(screen.getByTestId("magnifier-empty")).toBeDefined();
    expect(chips()).toHaveLength(0);
  });

  it("点一下小图 = 换成展示它（写进文档、可撤销）；再点一下取消展示", async () => {
    seedScene([magnifier([IMAGE, OTHER], 0)]);
    render(<InspectorPanel />);

    expect(chips()).toHaveLength(2);
    expect(chips()[0]?.getAttribute("data-selected")).toBe("true");
    expect(chips()[1]?.getAttribute("data-selected")).toBe("false");

    // 第二条：小图里那枚按钮（每条的第二个按钮是 × 移出）
    const picks = screen.getAllByTestId("magnifier-image-pick");
    await act(async () => {
      fireEvent.click(picks[1]!);
    });
    expect(dataOf("magnifier-1")?.picked).toBe(1);
    expect(useEditorStore.getState().canUndo).toBe(true);

    // 再点一次（已选中的那条）= 取消展示
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("magnifier-image-pick")[1]!);
    });
    expect(dataOf("magnifier-1")?.picked).toBeUndefined();
  });

  it("× 移出一条：列表缩短，展示项跟着走（移出前面那条 → 下标减一）", async () => {
    seedScene([magnifier([IMAGE, OTHER], 1)]);
    render(<InspectorPanel />);

    await act(async () => {
      fireEvent.click(screen.getAllByTestId("magnifier-image-remove")[0]!);
    });

    expect(dataOf("magnifier-1")).toEqual({ images: [OTHER], picked: 0 });
  });

  it("编辑态：点「打开窗口」只开编辑器那扇窗（一条命令都不发）", async () => {
    seedScene([magnifier([IMAGE], 0)]);
    render(<InspectorPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("magnifier-open"));
    });

    expect(useEditorStore.getState().magnifierEditor).toBe(true);
    expect(useEditorStore.getState().magnifierEditorTarget).toBe("magnifier-1");
    // 编辑态：前端那扇窗的记账没动，也没写任何「已记录」的日志
    expect(useEditorStore.getState().magnifierShown).toBeNull();
    expect(logs()).toEqual([]);
    expect(screen.getByTestId("magnifier-window-state").textContent).toMatch(/编辑态只有窗口预览/);
  });

  it("运行态：点「打开窗口」记账 + 尽力下发；没连上时写明「等它连上后自动补发」", async () => {
    seedScene([magnifier([IMAGE], 0)]);
    seedRuntime(false);
    render(<InspectorPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("magnifier-open"));
    });

    expect(useEditorStore.getState().magnifierShown).toBe("magnifier-1");
    // 测试环境里编辑器自己也没连服务端，所以命中 `guardDeliver` 的第一条（无论哪条，
    // 关键是「只记账 + 写明会补发」）
    expect(logs().join("\n")).toMatch(/连上后自动补发/);

    // 「关闭画面」只在**这个对象正被投影**时出现；点它就是清记账 + 尽力下发关闭
    await act(async () => {
      fireEvent.click(screen.getByTestId("magnifier-close"));
    });
    expect(useEditorStore.getState().magnifierShown).toBeNull();
    expect(screen.queryByTestId("magnifier-close")).toBeNull();
  });
});

describe("放大镜窗口：中间一张大图 + 下面一排可以选的图", () => {
  it("没有可展示的图时中间写「还没加图片」，底栏的「在画面上打开」点不了", () => {
    seedScene([magnifier()]);
    render(<MagnifierDialog open objectId="magnifier-1" onClose={() => undefined} />);

    expect(screen.getByTestId("magnifier-stage-empty").textContent).toMatch(/还没加图片/);
    expect((screen.getByTestId("magnifier-show") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("magnifier-hide") as HTMLButtonElement).disabled).toBe(true);
  });

  it("中间是当前那一张（舞台），下面那排点一下就换图（与面板同一份数据）", async () => {
    seedScene([magnifier([IMAGE, OTHER], 0)]);
    render(<MagnifierDialog open objectId="magnifier-1" onClose={() => undefined} />);

    expect(screen.getByTestId("magnifier-stage")).toBeDefined();
    const picks = screen.getAllByTestId("magnifier-pick");
    expect(picks).toHaveLength(2);
    expect(picks[0]?.getAttribute("data-selected")).toBe("true");

    await act(async () => {
      fireEvent.click(picks[1]!);
    });

    expect(dataOf("magnifier-1")?.picked).toBe(1);
    expect(screen.getAllByTestId("magnifier-pick")[1]?.getAttribute("data-selected")).toBe("true");
  });

  it("编辑态：底栏写明只是预览，「在画面上打开」点不了", () => {
    seedScene([magnifier([IMAGE], 0)]);
    render(<MagnifierDialog open objectId="magnifier-1" onClose={() => undefined} />);

    expect((screen.getByTestId("magnifier-show") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("magnifier-dialog-state").textContent).toMatch(/编辑态只是预览/);
  });

  it("运行态：能打开也能关（记账跟着走，按钮的可用状态跟着换）", async () => {
    seedScene([magnifier([IMAGE], 0)]);
    seedRuntime(true);
    render(<MagnifierDialog open objectId="magnifier-1" onClose={() => undefined} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("magnifier-show"));
    });
    expect(useEditorStore.getState().magnifierShown).toBe("magnifier-1");
    expect((screen.getByTestId("magnifier-show") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("magnifier-hide") as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByTestId("magnifier-hide"));
    });
    expect(useEditorStore.getState().magnifierShown).toBeNull();
    expect((screen.getByTestId("magnifier-show") as HTMLButtonElement).disabled).toBe(false);
  });

  it("对象已经被删掉：给「找不到这个放大镜」兜底，不崩", () => {
    seedScene([]);
    render(<MagnifierDialog open objectId="gone" onClose={() => undefined} />);

    expect(screen.getByTestId("magnifier-missing").textContent).toMatch(/找不到这个放大镜/);
  });
});

describe("放大镜的「当前展示那一张」", () => {
  it("`magnifierImageOf` 按下标取；越界 / 没选都当「没有」", () => {
    expect(magnifierImageOf(magnifier([IMAGE, CELL], 1))).toEqual(CELL);

    // 「选了图但没选展示哪张」：工厂会自动选第一条，所以这里手写一份（老文件 / 坏数据）
    const unpicked: GameObjectDoc = {
      ...magnifier([IMAGE]),
      components: [featureComponent("magnifier-1", DEFAULT_SLOT_COMPONENT.magnifier, { images: [IMAGE] })],
    };
    expect(magnifierImageOf(unpicked)).toBeUndefined();

    // 越界（手写文件里列表被改短）：按「还没选」处理，与校验的 warning 同一口径
    expect(magnifierImageOf(magnifier([IMAGE], 3))).toBeUndefined();
  });
});
