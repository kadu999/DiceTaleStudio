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
  type MagnifierState,
} from "@dts/document";
import { MagnifierDialog } from "../src/app/MagnifierDialog";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { KIND_LABELS, OBJECT_CATEGORIES, creatableObjects } from "../src/panels/object-kinds";
import { displayRectOf } from "../src/panels/scene/display";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";

/**
 * **放大镜**（动作对象，v30；v31 起数据是**状态列表**）：弹框里「动作」种类下的第三个对象。
 *
 * 数据是「**状态列表 + 当前展示的那一个**」：每个状态 = 标题 + 图 + 文字（三项都可以没有，
 * 空状态槽合法），状态里那张图复用 `ImageRef`（所以可以只是图集里的一格），
 * **选中是下标**（空状态槽没有 id 可用，位置才是身份）。
 *
 * 界面分工（v31 起）：**列表与内容整行搬进那扇窗口里**（下排状态槽 + 上面那块编辑区），
 * 属性面板只剩「窗口」那一行，而且**只有「打开窗口」一个按钮**（关闭画面在编辑器那扇窗的底栏）。
 * 另一件要钉死的事：**触发它 = 让前端弹一扇窗**（`open_magnifier` / `close_magnifier`），
 * 编辑态只预览、一条命令都不发；前端那扇窗没有按钮，只能由后端开、由后端关。
 */

const IMAGE: ImageRef = { id: "project:测试/Assets/images/handout.png", width: 400, height: 300 };
const OTHER: ImageRef = { id: "project:测试/Assets/images/clue.png", width: 64, height: 64 };
/** 同一张图的**另一格**（与 `IMAGE` 同 id、不同格子 = 另一个状态里的图）。 */
const CELL: ImageRef = { ...IMAGE, width: 100, height: 100, sprite: { column: 1, row: 0 } };

function magnifier(states: readonly MagnifierState[] = [], picked?: number): GameObjectDoc {
  return createMagnifierObject({
    id: "magnifier-1",
    name: "放大镜",
    states,
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

const dataOf = (id: string): { states?: readonly MagnifierState[]; picked?: number } | undefined => {
  const object = objectOf(id);
  return object === undefined ? undefined : magnifierDataOf(object);
};

const logs = (): string[] => useEditorStore.getState().runtime.logs.map((entry) => entry.message);

/** 窗口下排的状态槽（顺序 = 加进来的先后）。 */
const slots = (): HTMLElement[] => screen.queryAllByTestId("magnifier-state");

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
  it("store 建出来的是 Magnifier：摆在场景正中，状态列表还是空的", async () => {
    await act(async () => {
      seedScene([]);
      expect(await useEditorStore.getState().createObject("Magnifier", "放大镜")).toBeUndefined();
    });

    const object = useEditorStore.getState().scenes[0]?.objects[0];
    expect(object?.kind).toBe("Magnifier");
    expect(object === undefined ? undefined : magnifierDataOf(object)).toEqual({ states: [] });
    expect(object?.position).toEqual({ x: 0, y: 0 });
    // 画布上给的是**固定徽标**那块 64×64 的矩形（它没有贴图；挂了贴图也不认）
    expect(object === undefined ? undefined : displayRectOf(object)?.size).toEqual({
      width: 64,
      height: 64,
    });
  });
});

describe("属性面板：只剩「窗口」那一行（状态列表整行搬进窗口里）", () => {
  it("缺少放大镜组件时提供显式修复；修复后显示「窗口」那一行", () => {
    const broken = { ...magnifier(), components: [] };
    seedScene([broken]);
    render(<InspectorPanel />);

    expect(screen.getByText("组件数据缺失")).toBeDefined();
    expect(screen.queryByTestId("magnifier-window")).toBeNull();
    fireEvent.click(screen.getByTestId("repair-component-Magnifier"));

    expect(dataOf(broken.id)).toEqual({ states: [] });
    expect(screen.getByTestId("magnifier-window")).toBeDefined();
  });

  it("**不再有**「图片」那一行（加状态 / 挑图 / 写字都在窗口里做）", () => {
    seedScene([magnifier([{ image: IMAGE }], 0)]);
    render(<InspectorPanel />);

    expect(screen.queryByTestId("magnifier-images")).toBeNull();
    expect(screen.queryByTestId("magnifier-empty")).toBeNull();
    expect(screen.queryByTestId("magnifier-add")).toBeNull();
    // 「窗口」那一行只剩「打开窗口」一个按钮：状态说明与「关闭画面」都没有
    expect(screen.queryByTestId("magnifier-window-state")).toBeNull();
    expect(screen.queryByTestId("magnifier-close-window")).toBeNull();
  });

  it("编辑态：点「打开窗口」只开编辑器那扇窗（一条命令都不发）", async () => {
    seedScene([magnifier([{ image: IMAGE }], 0)]);
    render(<InspectorPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("magnifier-open"));
    });

    expect(useEditorStore.getState().magnifierEditor).toBe(true);
    expect(useEditorStore.getState().magnifierEditorTarget).toBe("magnifier-1");
    // 编辑态：前端那扇窗的记账没动，也没写任何「已记录」的日志
    expect(useEditorStore.getState().magnifierShown).toBeNull();
    expect(logs()).toEqual([]);
    // 面板里没有状态说明文字了（这一行只留动作本身）
    expect(screen.queryByTestId("magnifier-window-state")).toBeNull();
  });

  it("运行态：点「打开窗口」记账 + 尽力下发；没连上时写明「等它连上后自动补发」", async () => {
    seedScene([magnifier([{ image: IMAGE }], 0)]);
    seedRuntime(false);
    render(<InspectorPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("magnifier-open"));
    });

    expect(useEditorStore.getState().magnifierShown).toBe("magnifier-1");
    // 测试环境里编辑器自己也没连服务端，所以命中 `guardDeliver` 的第一条（无论哪条，
    // 关键是「只记账 + 写明会补发」）
    expect(logs().join("\n")).toMatch(/连上后自动补发/);

    // 属性面板这一行**没有**「关闭画面」：前端那扇窗的开关就是编辑器这扇窗本身
    expect(screen.queryByTestId("magnifier-close-window")).toBeNull();

    // 关掉编辑器那扇窗 = 前端那扇跟着收（界面上不加额外按钮）
    await act(async () => {
      useEditorStore.getState().openMagnifierEditor(null);
    });
    expect(useEditorStore.getState().magnifierShown).toBeNull();
  });

  it("只有标题 / 文字的状态**也能**打开（纯文字线索卡）；三项全空才点不动", async () => {
    seedScene([magnifier([{ title: "只有标题" }, { text: "只有文字" }, {}], 1)]);
    seedRuntime(false);
    render(<InspectorPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("magnifier-open"));
    });
    expect(useEditorStore.getState().magnifierShown).toBe("magnifier-1");

    // 换成那个三项全空的状态：点不动，并写明原因
    await act(async () => {
      useEditorStore.getState().selectMagnifierState("magnifier-1", 2);
      useEditorStore.getState().closeMagnifierWindow();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("magnifier-open"));
    });

    expect(useEditorStore.getState().magnifierShown).toBeNull();
    expect(logs().join("\n")).toMatch(/是空的/);
  });
});

describe("放大镜窗口：上面一块是选中状态的画面，下面一排状态槽", () => {
  it("一个状态都没有：上面写「还没有状态」，底栏没有开 / 关按钮", () => {
    seedScene([magnifier()]);
    render(<MagnifierDialog open objectId="magnifier-1" onClose={() => undefined} />);

    expect(screen.getByTestId("magnifier-stage-empty").textContent).toMatch(/还没有状态/);
    expect(screen.queryByTestId("magnifier-show")).toBeNull();
    expect(screen.queryByTestId("magnifier-hide")).toBeNull();
    expect(slots()).toHaveLength(0);
  });

  it("有状态但没选：上面写「下面点一个状态」（手写一份坏数据）", () => {
    const unpicked: GameObjectDoc = {
      ...magnifier(),
      components: [
        featureComponent("magnifier-1", DEFAULT_SLOT_COMPONENT.magnifier, { states: [{ image: IMAGE }] }),
      ],
    };
    seedScene([unpicked]);
    render(<MagnifierDialog open objectId="magnifier-1" onClose={() => undefined} />);

    expect(screen.getByTestId("magnifier-stage-empty").textContent).toMatch(/下面点一个状态/);
    expect(slots()).toHaveLength(1);
    expect(slots()[0]?.getAttribute("data-selected")).toBe("false");
  });

  it("选中一个有图的状态：中间是那张图；下面点第二个槽 = 换成展示它（写进文档）", async () => {
    seedScene([magnifier([{ image: IMAGE }, { image: OTHER }], 0)]);
    render(<MagnifierDialog open objectId="magnifier-1" onClose={() => undefined} />);

    expect(screen.getByTestId("magnifier-stage")).toBeDefined();
    expect(slots()).toHaveLength(2);
    expect(slots()[0]?.getAttribute("data-selected")).toBe("true");
    expect(slots()[1]?.getAttribute("data-selected")).toBe("false");

    await act(async () => {
      fireEvent.click(slots()[1]!);
    });

    expect(dataOf("magnifier-1")?.picked).toBe(1);
    expect(useEditorStore.getState().canUndo).toBe(true);
    expect(slots()[1]?.getAttribute("data-selected")).toBe("true");
  });

  it("「添加状态」加一个空槽并选中它（上面那块跟着换成它，等着填）", async () => {
    seedScene([magnifier([{ image: IMAGE, title: "线索一" }], 0)]);
    render(<MagnifierDialog open objectId="magnifier-1" onClose={() => undefined} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("magnifier-add-state"));
    });

    expect(dataOf("magnifier-1")).toEqual({ states: [{ image: IMAGE, title: "线索一" }, {}], picked: 1 });
    expect(slots()).toHaveLength(2);
    // 新加的空槽：上面那块换成「点这里挑一张图」，标题输入框也是空的
    expect(screen.getByTestId("magnifier-image-empty")).toBeDefined();
    expect((screen.getByTestId("magnifier-title") as HTMLInputElement).value).toBe("");
  });

  it("状态槽上那个 × 移出一个（列表缩短，展示项跟着走）", async () => {
    seedScene([magnifier([{ image: IMAGE }, { image: OTHER }], 1)]);
    render(<MagnifierDialog open objectId="magnifier-1" onClose={() => undefined} />);

    await act(async () => {
      fireEvent.click(screen.getAllByTestId("magnifier-state-remove")[0]!);
    });

    expect(dataOf("magnifier-1")).toEqual({ states: [{ image: OTHER }], picked: 0 });
  });

  it("标题与文字：敲进那一格、失焦写进文档（多行文字照原样）", async () => {
    seedScene([magnifier([{}], 0)]);
    render(<MagnifierDialog open objectId="magnifier-1" onClose={() => undefined} />);

    const title = screen.getByTestId("magnifier-title");
    const text = screen.getByTestId("magnifier-text");

    await act(async () => {
      fireEvent.change(title, { target: { value: "线索一" } });
      fireEvent.blur(title);
      fireEvent.change(text, { target: { value: "第一行\n第二行" } });
      fireEvent.blur(text);
    });

    expect(dataOf("magnifier-1")?.states?.[0]).toEqual({ title: "线索一", text: "第一行\n第二行" });
  });

  it("点图那块弹选图框；右上角 × 把图移出（状态还在，只是没图了）", async () => {
    seedScene([magnifier([{ image: IMAGE, title: "线索一" }], 0)]);
    render(<MagnifierDialog open objectId="magnifier-1" onClose={() => undefined} />);

    expect(screen.queryByTestId("image-picker-dialog")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("magnifier-image-pick"));
    });
    expect(screen.getByTestId("image-picker-dialog")).toBeDefined();

    // 选图框那层先收起来（它自己是个模态），再点 × 移出图
    await act(async () => {
      fireEvent.click(screen.getByTestId("image-picker-cancel"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("magnifier-image-clear"));
    });

    expect(dataOf("magnifier-1")?.states?.[0]).toEqual({ title: "线索一" });
  });

  it("编辑器窗的开 / 关就是前端那扇窗的开 / 关；底栏不再有开 / 关按钮", async () => {
    seedScene([magnifier([{ text: "只有文字" }], 0)]);
    seedRuntime(true);
    render(<MagnifierDialog open objectId="magnifier-1" onClose={() => undefined} />);

    // 底栏那两枚按钮与状态提示都没了（界面上不加额外按钮）
    expect(screen.queryByTestId("magnifier-show")).toBeNull();
    expect(screen.queryByTestId("magnifier-hide")).toBeNull();
    expect(screen.queryByTestId("magnifier-dialog-state")).toBeNull();

    // 开编辑器窗 → 前端跟着投（纯文字线索卡也照投：判据是选中的状态非空，不看有没有图）
    await act(async () => {
      useEditorStore.getState().openMagnifierEditor("magnifier-1");
    });
    expect(useEditorStore.getState().magnifierShown).toBe("magnifier-1");

    // 关掉编辑器窗 → 前端那扇跟着收
    await act(async () => {
      useEditorStore.getState().openMagnifierEditor(null);
    });
    expect(useEditorStore.getState().magnifierShown).toBeNull();
  });

  it("对象已经被删掉：给「找不到这个放大镜」兜底，不崩", () => {
    seedScene([]);
    render(<MagnifierDialog open objectId="gone" onClose={() => undefined} />);

    expect(screen.getByTestId("magnifier-missing").textContent).toMatch(/找不到这个放大镜/);
  });
});

describe("放大镜的「当前展示那一个状态」", () => {
  it("`magnifierImageOf` 按下标取那个状态里的图；越界 / 没选 / 没图都当「没有」", () => {
    expect(magnifierImageOf(magnifier([{ image: IMAGE }, { image: CELL }], 1))).toEqual(CELL);

    // 「有状态但没选展示哪个」：工厂会自动选第一个，所以这里手写一份（老文件 / 坏数据）
    const unpicked: GameObjectDoc = {
      ...magnifier(),
      components: [
        featureComponent("magnifier-1", DEFAULT_SLOT_COMPONENT.magnifier, { states: [{ image: IMAGE }] }),
      ],
    };
    expect(magnifierImageOf(unpicked)).toBeUndefined();

    // 选中的那个状态还没有图（只有标题）：也是「没有」
    expect(magnifierImageOf(magnifier([{ title: "只有标题" }], 0))).toBeUndefined();

    // 越界（手写文件里列表被改短）：按「还没选」处理，与校验的 warning 同一口径
    expect(magnifierImageOf(magnifier([{ image: IMAGE }], 3))).toBeUndefined();
  });
});
