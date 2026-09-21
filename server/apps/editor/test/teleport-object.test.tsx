import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  createTeleportObject,
  type SceneDoc,
  type SceneObjectDoc,
} from "@dts/document";
import { TeleportEditDialog } from "../src/app/TeleportEditDialog";
import { InspectorPanel } from "../src/panels/inspector/InspectorPanel";
import { KIND_LABELS, OBJECT_CATEGORIES, creatableObjects } from "../src/panels/object-kinds";
import { displayRectOf } from "../src/panels/scene/display";
import { sceneHistory, useEditorStore } from "../src/state/editor-store";

/**
 * **传送阵**（动作对象）：弹框里「动作」种类下的第二个对象。
 *
 * 数据形状与**播放声音完全同一套**：**候选清单**（加进来的目标场景）+ **选中的那一个**。
 * 分工也一样：清单在「传送目标」窗口里勾（面板上那枚 `＋`），选哪个在属性面板上点小方块——
 * 所以这一份里两边都验。
 *
 * 另一件要钉死的事：**按一下 = 切换当前场景**（DM 的「换台」），走的是切场景那条唯一的路，
 * 而且**不改文档、不进撤销栈**。运行态下会立刻推给前端（那条在 e2e 里验）。
 */

const A = "Map002";
const B = "Map003";

/** 一个传送阵：候选 + 选中的那个（默认不传 = 候选空、没选）。 */
function teleport(targets: readonly string[] = [], picked?: string): SceneObjectDoc {
  return createTeleportObject({
    id: "teleport-1",
    name: "传送阵",
    targets,
    ...(picked === undefined ? {} : { picked }),
    position: { x: 0, y: 0 },
  });
}

/** 铺场景：默认三张图（当前在 Map001），对象列表按传入的来。 */
function seedScene(objects: SceneObjectDoc[], extraScenes: readonly SceneDoc[] = []): void {
  const scenes: SceneDoc[] = [{ name: "Map001", objects }, ...extraScenes];
  sceneHistory.reset(scenes);
  useEditorStore.setState({
    scenes,
    activeSceneName: "Map001",
    selectedObjectIds: [objects[0]?.id ?? ""],
    selectedAssetId: null,
    teleportEditor: false,
    teleportEditorTarget: null,
    project: { list: [], current: "测试", tree: [], busy: false, error: "" },
  });
}

const objectOf = (id: string): SceneObjectDoc | undefined =>
  useEditorStore
    .getState()
    .scenes.flatMap((scene) => scene.objects)
    .find((object) => object.id === id);

const targetsOf = (id: string): { targets?: readonly string[]; picked?: string } | undefined =>
  objectOf(id)?.teleport;

afterEach(() => {
  cleanup();
  sceneHistory.reset([]);
  useEditorStore.setState({
    scenes: [],
    activeSceneName: null,
    selectedObjectIds: [],
    mode: "edit",
    teleportEditor: false,
    teleportEditorTarget: null,
    runtime: {
      status: "idle",
      statusDetail: "",
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

describe("种类表：动作下的「传送阵」", () => {
  it("「动作」种类下有它、可以创建，展示名叫「传送阵」", () => {
    const action = OBJECT_CATEGORIES.find((category) => category.id === "action");
    expect(action).toBeDefined();
    expect(creatableObjects(action!).map((object) => object.kind)).toContain("Teleport");
    expect(KIND_LABELS.Teleport).toBe("传送阵");
  });
});

describe("创建传送阵", () => {
  it("store 建出来的是 Teleport：摆在场景正中，候选还是空的", async () => {
    seedScene([]);

    await act(async () => {
      expect(await useEditorStore.getState().createObject("Teleport", "传送阵")).toBeUndefined();
    });

    const object = useEditorStore.getState().scenes[0]?.objects[0];
    expect(object?.kind).toBe("Teleport");
    expect(object?.teleport).toEqual({ targets: [] });
    expect(object?.position).toEqual({ x: 0, y: 0 });
    // 画布上给的是**固定徽标**那块 64×64 的矩形（它没有贴图；挂了贴图也不认）
    expect(object === undefined ? undefined : displayRectOf(object)?.size).toEqual({
      width: 64,
      height: 64,
    });
    expect(object === undefined ? undefined : displayRectOf({ ...object, scale: 2 })?.size).toEqual({
      width: 128,
      height: 128,
    });
  });
});

describe("属性面板：候选小方块 + ＋ + 传送", () => {
  it("没加目标：按钮写「先加目标」并点不动", () => {
    seedScene([teleport()]);
    render(<InspectorPanel />);

    expect(screen.queryAllByTestId("teleport-target-chip")).toHaveLength(0);
    const go = screen.getByTestId("teleport-go") as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(go.textContent).toBe("先加目标");
  });

  it("候选列成一排小方块；点一下选它（进撤销栈），再点一下取消选中", () => {
    seedScene([teleport([A, B])]);
    render(<InspectorPanel />);

    const chips = screen.getAllByTestId("teleport-target-chip");
    expect(chips.map((chip) => chip.getAttribute("data-target"))).toEqual([A, B]);
    // 加进来时默认选第一条（与播放声音同一条规矩）
    expect(chips[0]?.getAttribute("data-selected")).toBe("true");

    act(() => {
      chips[1]?.click();
    });

    expect(targetsOf("teleport-1")).toEqual({ targets: [A, B], picked: B });
    expect(useEditorStore.getState().canUndo).toBe(true);
    expect(screen.getAllByTestId("teleport-target-chip")[1]?.getAttribute("data-selected")).toBe(
      "true",
    );

    // 再点选中的那一个 = 取消选中（`picked` 删掉，候选留着）：按钮自己写「先选一个目标」
    act(() => {
      screen.getAllByTestId("teleport-target-chip")[1]?.click();
    });

    expect(targetsOf("teleport-1")).toEqual({ targets: [A, B] });
    expect((screen.getByTestId("teleport-go") as HTMLButtonElement).textContent).toBe("先选一个目标");
  });

  it("「＋」打开窗口，并把对象 id 交给它", () => {
    seedScene([teleport()]);
    render(<InspectorPanel />);

    act(() => {
      screen.getByTestId("teleport-edit").click();
    });

    expect(useEditorStore.getState().teleportEditor).toBe(true);
    expect(useEditorStore.getState().teleportEditorTarget).toBe("teleport-1");
  });

  it("选中的场景不在候选里（手写文件）：按钮写「先选一个目标」", () => {
    const handWritten: SceneObjectDoc = {
      ...teleport([A]),
      teleport: { targets: [A], picked: B },
    };
    seedScene([handWritten]);
    render(<InspectorPanel />);

    expect((screen.getByTestId("teleport-go") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("teleport-go") as HTMLButtonElement).textContent).toBe("先选一个目标");
  });

  it("选中的就是当前场景：按钮写「已经在这个场景」", () => {
    seedScene([teleport(["Map001"], "Map001")]);
    render(<InspectorPanel />);

    expect((screen.getByTestId("teleport-go") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("teleport-go") as HTMLButtonElement).textContent).toBe(
      "已经在这个场景",
    );
  });

  it("候选里有个已经不存在的场景：方块标红提示，但不影响选中别的", () => {
    // A 是真实存在的场景，Map999 不是：候选里混着一条死名字，照样能传去 A
    seedScene([teleport(["Map999", A], A)], [{ name: A, objects: [] }]);
    render(<InspectorPanel />);

    const chips = screen.getAllByTestId("teleport-target-chip");
    expect(chips[0]?.getAttribute("data-missing")).toBe("true");
    // 按钮不写传到哪（上面选中的小方块已经说了），只写动作
    expect((screen.getByTestId("teleport-go") as HTMLButtonElement).textContent).toBe("⇢ 传送");
  });

  it("普通对象没有「传送」那一组", () => {
    seedScene([{ ...teleport([A], A), kind: "SceneObject" }]);
    render(<InspectorPanel />);

    expect(screen.queryByTestId("teleport-go")).toBeNull();
  });
});

describe("「传送目标」窗口：勾 / 取消勾", () => {
  it("列出项目里的全部场景；勾上就加进候选，取消勾就移出", () => {
    seedScene([teleport()], [
      { name: A, objects: [] },
      { name: B, objects: [] },
    ]);
    render(<TeleportEditDialog open objectId="teleport-1" onClose={() => undefined} />);

    const rows = screen.getAllByTestId("teleport-scene-row");
    expect(rows.map((row) => row.getAttribute("data-scene"))).toEqual(["Map001", A, B]);
    expect(rows.every((row) => row.getAttribute("data-checked") === "false")).toBe(true);

    // 勾上两张：勾进来的先后就是清单的顺序
    act(() => {
      fireEvent.click(screen.getAllByTestId("teleport-scene-check")[0] as Element);
    });
    act(() => {
      fireEvent.click(screen.getAllByTestId("teleport-scene-check")[1] as Element);
    });

    // 第一条（Map001）被勾上时，默认选中的是它；再勾 A 之后顺序是 [Map001, Map002]
    expect(targetsOf("teleport-1")?.targets).toEqual(["Map001", A]);

    // 取消勾第一条 → 移出（选中的那个跟着顺到下一条）
    act(() => {
      fireEvent.click(screen.getAllByTestId("teleport-scene-check")[0] as Element);
    });

    expect(targetsOf("teleport-1")).toEqual({ targets: [A], picked: A });
  });

  it("已经不在项目里的候选也列出来（点明「已失效」），在这儿就能取消勾", () => {
    seedScene([teleport(["Map999"], "Map999")], [{ name: A, objects: [] }]);
    render(<TeleportEditDialog open objectId="teleport-1" onClose={() => undefined} />);

    const rows = screen.getAllByTestId("teleport-scene-row");
    expect(rows.map((row) => row.getAttribute("data-scene"))).toEqual(["Map001", A, "Map999"]);
    expect(rows[2]?.getAttribute("data-checked")).toBe("true");
    expect(rows[2]?.textContent).toContain("已失效");

    act(() => {
      fireEvent.click(screen.getAllByTestId("teleport-scene-check")[2] as Element);
    });

    expect(targetsOf("teleport-1")).toEqual({ targets: [] });
  });

  it("对象已经不在了：窗口写明，不炸", () => {
    seedScene([]);
    render(<TeleportEditDialog open objectId="teleport-none" onClose={() => undefined} />);

    expect(screen.getByText(/这个传送阵已经不在了/)).toBeTruthy();
  });
});

describe("触发传送：按一下换台（不改文档）", () => {
  it("点「传送」→ 当前场景切到**选中的那一个**；文档没被改、撤销栈不动", () => {
    const here = teleport([A, B], B);
    seedScene([here], [
      { name: A, objects: [] },
      { name: B, objects: [] },
    ]);
    render(<InspectorPanel />);

    const before = useEditorStore.getState().canUndo;

    act(() => {
      screen.getByTestId("teleport-go").click();
    });

    expect(useEditorStore.getState().activeSceneName).toBe(B);
    // 「按一下换台」不是编辑：文档与撤销栈都不动
    expect(useEditorStore.getState().canUndo).toBe(before);
    expect(targetsOf("teleport-1")).toEqual({ targets: [A, B], picked: B });
    expect(useEditorStore.getState().runtime.logs.map((entry) => entry.message)).toContain(
      `传送阵「传送阵」→ 场景「${B}」`,
    );
  });

  it("候选空 / 没选 / 目标不存在 / 目标是当前场景：拒绝并写明理由（场景不动）", () => {
    // 四种「点不动」与面板上的护栏是同一套判断，理由要对得上
    const cases: ReadonlyArray<readonly [string, SceneObjectDoc, RegExp]> = [
      ["候选空", teleport(), /还没有加目标场景/],
      ["没选", { ...teleport([A]), teleport: { targets: [A] } }, /还没选要传送到哪一张/],
      ["目标不存在", teleport(["Map999"], "Map999"), /不存在/],
      ["目标是自己", teleport(["Map001"], "Map001"), /目标就是当前场景/],
    ];

    for (const [label, object, reason] of cases) {
      seedScene([object]);
      const logs = useEditorStore.getState().runtime.logs.length;

      expect(useEditorStore.getState().teleport("teleport-1"), `${label} 时不该传送成功`).toBe(false);
      expect(useEditorStore.getState().activeSceneName).toBe("Map001");

      const messages = useEditorStore.getState().runtime.logs.slice(logs).map((entry) => entry.message);
      expect(messages.some((message) => reason.test(message)), `${label}：日志里没写理由`).toBe(true);
    }
  });

  it("不是传送阵：拒绝（拿着 id 乱调也进不去）", () => {
    const door: SceneObjectDoc = { ...teleport([A], A), kind: "SceneObject" };
    seedScene([door]);

    expect(useEditorStore.getState().teleport("teleport-1")).toBe(false);
    expect(useEditorStore.getState().activeSceneName).toBe("Map001");
  });
});
