import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import { setComponentField, createGameObject } from "../src/commands";
import { REJECT, coerceFieldValue } from "../src/component-spec";
import { componentSpecOf, defaultDataOf } from "../src/component-specs";
import { OBJECT_SPEC, objectFieldOf } from "../src/object-spec";
import { videoDataOf } from "../src/access";
import { DEFAULT_SLOT_COMPONENT } from "../src/presets";
import { createEmptyScene, createGridMapObject, createSoundObject } from "../src/factory";
import type { GameObjectDoc, SceneDoc } from "../src/types";

/**
 * **泛型组件字段写入**（`setComponentField`）与它依赖的组件规格。
 *
 * 这一份钉住「加一个简单字段只需要在规格里加一行」那条路的两半：
 * 1. **规格决定接管范围**：只有登记在 `fields` 里的字段能被泛型写入改动，
 *    有副作用的开关（`video.enabled`）与列表 / 引用类字段（`clips` / `picked`）**必须**留在外面；
 * 2. **判据从严**：未知组件 / 未知字段 / 这个 kind 不允许的槽位 / 非法值 / 值没变，
 *    一律返回 `false` 并且**不动文档**——宁可没反应，也不写进一个会被 zod 拒掉的值。
 */

const IMAGE = { id: "project:C/Assets/images/Map001.png", width: 400, height: 300 };
const GRID = { width: 8, height: 6 };

const VIDEO = DEFAULT_SLOT_COMPONENT.video;

function sceneWith(objects: readonly GameObjectDoc[]): SceneDoc {
  return { ...createEmptyScene("Map001"), objects: [...objects] };
}

function mutate(scene: SceneDoc, recipe: (draft: Draft<SceneDoc>) => void): SceneDoc {
  return produce(scene, recipe);
}

function objectOf(scene: SceneDoc, id: string): GameObjectDoc | undefined {
  return scene.objects.find((object) => object.id === id);
}

/** 地图：工厂建出来的只有 `GridMap`，**没有**可选的 `VideoOverlay`。 */
function mapObject(id = "map-1"): GameObjectDoc {
  return createGridMapObject({ id, name: "网格地图", image: IMAGE, grid: GRID });
}

describe("组件规格：VideoOverlay", () => {
  it("只接管三个无副作用的开关，`enabled` 与列表字段都不在里面", () => {
    const spec = componentSpecOf(VIDEO);
    expect(spec).toBeDefined();
    expect(spec?.fields.map((field) => field.key)).toEqual(["loop", "audio", "autoPlay"]);
  });

  it("每个接管字段都写了 testid 与行序（面板靠它们保住既有契约与新行序）", () => {
    const spec = componentSpecOf(VIDEO);
    const orders = spec?.fields.map((field) => field.order) ?? [];
    const testIds = spec?.fields.map((field) => field.testId) ?? [];

    expect(testIds).toEqual(["video-loop", "video-audio", "video-auto-play"]);
    // 行序必须严格递增：相等 / 倒序会让面板上的行序随排序实现漂移
    expect([...orders].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(orders);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("未登记的组件没有规格（`componentSpecOf` 返回 undefined，面板与写入都退回各自的旧路径）", () => {
    expect(componentSpecOf("GridMap")).toBeUndefined();
    expect(componentSpecOf("不存在")).toBeUndefined();
  });

  it("默认数据只有一处归属地：规格（老注册表那条 `fields` / `defaultComponentData` 已并过来）", () => {
    // 登记了规格的：用规格里的 `defaultData` 创建可选组件时作为完整形状
    expect(defaultDataOf(VIDEO)).toEqual({
      enabled: true,
      autoPlay: false,
      clips: [],
      loop: false,
      audio: false,
    });

    // 没登记规格的：落空记录（与旧 `defaultComponentData` 对 GridMap / 未知类型的行为一致）
    expect(defaultDataOf("GridMap")).toEqual({});
    expect(defaultDataOf("不存在")).toEqual({});
  });
});

describe("setComponentField：能改的", () => {
  it("改布尔字段：落进组件数据、返回 true", () => {
    const scene = sceneWith([mapObject()]);
    const next = mutate(scene, (draft) => {
      expect(setComponentField(draft, "map-1", VIDEO, "loop", true)).toBe(true);
    });

    expect(videoDataOf(objectOf(next, "map-1")!)?.loop).toBe(true);
  });

  it("可选组件缺实例时按规格创建，并把新值一起写进去", () => {
    const scene = sceneWith([mapObject()]);
    expect(videoDataOf(objectOf(scene, "map-1")!)).toBeUndefined();

    const next = mutate(scene, (draft) => {
      expect(setComponentField(draft, "map-1", VIDEO, "autoPlay", true)).toBe(true);
    });

    // 新组件是完整形状（与工厂 / 校验同一份口径），不是只有被改的那一个键
    expect(videoDataOf(objectOf(next, "map-1")!)).toEqual({
      enabled: true,
      autoPlay: true,
      clips: [],
      loop: false,
      audio: false,
    });
  });
});

describe("setComponentField：不改的（都返回 false 且文档不动）", () => {
  it("值没变：不进撤销栈（与其它专用命令同一个布尔约定）", () => {
    const scene = sceneWith([mapObject()]);
    const seeded = mutate(scene, (draft) => {
      setComponentField(draft, "map-1", VIDEO, "loop", false);
    });

    mutate(seeded, (draft) => {
      // 默认值就是 false，再写一次 false = 无变更
      expect(setComponentField(draft, "map-1", VIDEO, "loop", false)).toBe(false);
    });
  });

  it("字段不归规格管（`enabled` / `clips` / `picked`）：留给各自的专用命令", () => {
    const scene = sceneWith([mapObject()]);
    mutate(scene, (draft) => {
      for (const key of ["enabled", "clips", "picked", "names", "不存在"]) {
        expect(setComponentField(draft, "map-1", VIDEO, key, key === "enabled" ? false : "x")).toBe(false);
      }
    });

    // 一个字段都没写进去（连组件都没补出来）
    expect(videoDataOf(objectOf(scene, "map-1")!)).toBeUndefined();
  });

  it("未知组件类型：不写、不抛", () => {
    const scene = sceneWith([mapObject()]);
    mutate(scene, (draft) => {
      expect(setComponentField(draft, "map-1", "没有任何规格", "loop", true)).toBe(false);
    });
  });

  it("没有该组件且 kind 不提供回退时，仍不自动添加能力组件", () => {
    const scene = sceneWith([createGameObject({ id: "sprite-plain", name: "精灵", kind: "Sprite" })]);
    mutate(scene, (draft) => {
      expect(setComponentField(draft, "sprite-plain", VIDEO, "loop", true)).toBe(false);
    });
    expect(videoDataOf(objectOf(scene, "sprite-plain")!)).toBeUndefined();
  });

  it("这个 kind 不允许该槽位：拒掉（与 `ensureSlotData` 的准入判据同一口径）", () => {
    const scene = sceneWith([createSoundObject({ id: "sound-1", name: "脚步" })]);
    mutate(scene, (draft) => {
      expect(setComponentField(draft, "sound-1", VIDEO, "loop", true)).toBe(false);
    });

    expect(videoDataOf(objectOf(scene, "sound-1")!)).toBeUndefined();
  });

  it("对象身上已经有这个组件时，按组件编辑，不再由 kind 覆盖其能力", () => {
    const sprite = createGameObject({ id: "sprite-1", name: "精灵", kind: "Sprite" });
    const dirty: GameObjectDoc = {
      ...sprite,
      components: [{ id: "sprite-1__VideoOverlay", type: VIDEO, data: { clips: [] } }],
    };
    const scene = sceneWith([dirty]);

    const changed = mutate(scene, (draft) => {
      expect(setComponentField(draft, "sprite-1", VIDEO, "loop", true)).toBe(true);
    });

    expect(videoDataOf(objectOf(changed, "sprite-1")!)?.loop).toBe(true);
  });

  it("对象不存在：返回 false", () => {
    const scene = sceneWith([mapObject()]);
    mutate(scene, (draft) => {
      expect(setComponentField(draft, "没有这个对象", VIDEO, "loop", true)).toBe(false);
    });
  });

  it("类型不对的值：退回，不把字符串当布尔收下", () => {
    const scene = sceneWith([mapObject()]);
    mutate(scene, (draft) => {
      expect(setComponentField(draft, "map-1", VIDEO, "loop", "true")).toBe(false);
    });

    expect(videoDataOf(objectOf(scene, "map-1")!)).toBeUndefined();
  });
});

describe("coerceFieldValue：按 kind 收窄", () => {
  it("boolean 只认真正的布尔", () => {
    expect(coerceFieldValue({ key: "b", label: "B", kind: "boolean" }, true)).toBe(true);
    expect(coerceFieldValue({ key: "b", label: "B", kind: "boolean" }, "true")).toBe(REJECT);
    expect(coerceFieldValue({ key: "b", label: "B", kind: "boolean" }, 0)).toBe(REJECT);
  });

  it("integer 取整并夹到 min/max", () => {
    const field = { key: "n", label: "N", kind: "integer", min: 1, max: 5 } as const;
    expect(coerceFieldValue(field, 3.6)).toBe(4);
    expect(coerceFieldValue(field, 0)).toBe(1);
    expect(coerceFieldValue(field, 99)).toBe(5);
    expect(coerceFieldValue(field, Number.NaN)).toBe(REJECT);
    expect(coerceFieldValue(field, "3")).toBe(REJECT);
  });

  it("number 保留小数，只夹取范围", () => {
    const field = { key: "n", label: "N", kind: "number", min: 0, max: 10 } as const;
    expect(coerceFieldValue(field, 0.5)).toBe(0.5);
    expect(coerceFieldValue(field, -3)).toBe(0);
    expect(coerceFieldValue(field, Number.POSITIVE_INFINITY)).toBe(REJECT);
  });

  it("enum 必须命中候选值", () => {
    const field = {
      key: "e",
      label: "E",
      kind: "enum",
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
    } as const;
    expect(coerceFieldValue(field, "a")).toBe("a");
    expect(coerceFieldValue(field, "c")).toBe(REJECT);
    expect(coerceFieldValue(field, 1)).toBe(REJECT);
  });

  it("string / text 只认字符串", () => {
    expect(coerceFieldValue({ key: "s", label: "S", kind: "string" }, "x")).toBe("x");
    expect(coerceFieldValue({ key: "s", label: "S", kind: "string" }, 1)).toBe(REJECT);
    expect(coerceFieldValue({ key: "s", label: "S", kind: "text" }, "")).toBe("");
  });

  it("描述符表达不了的形状一律拒掉（列表 / 引用 / 颜色各有专用命令与副作用）", () => {
    for (const kind of ["stringList", "objectRef", "resourceRef", "vector2", "color"] as const) {
      expect(coerceFieldValue({ key: "x", label: "X", kind }, "任意值")).toBe(REJECT);
    }
  });
});

/**
 * **对象自身字段**那一路（`OBJECT_SPEC` + `setObjectField`）。
 *
 * v26 起这张表是空的：显示顺序搬进了渲染组件（走 `setRenderSortingOrder`），对象身上
 * 不再有「无专属语义的标量字段」。机制保留给下一个这样的字段——这条用例钉住「空表」
 * 这个当前事实，避免有人以为规格坏了。
 */
describe("对象字段规格：OBJECT_SPEC（v26 起为空）", () => {
  it("空表：显示顺序已搬进渲染组件，其余基础字段各有专属语义", () => {
    expect(OBJECT_SPEC.fields).toEqual([]);

    // 显示顺序与其余有专属语义的字段都不该进规格（进了就会绕过它的副作用 / 路由）
    for (const key of ["sortingOrder", "name", "active", "locked", "position", "scale", "rotation"]) {
      expect(objectFieldOf(key)).toBeUndefined();
    }
  });
});
