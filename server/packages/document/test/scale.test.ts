import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import {
  DEFAULT_OBJECT_SCALE,
  DOCUMENT_FORMAT_VERSION,
  MAX_OBJECT_SCALE,
  MIN_OBJECT_SCALE,
  clampObjectScale,
  collapseScale,
  createEmptyScene,
  effectiveScaleX,
  effectiveScaleY,
  isUniformScale,
  parseSceneFile,
  setObjectScale,
  setObjectScaleAxes,
  validateScene,
  type SceneDoc,
  type GameObjectDoc,
} from "../src";
import { formatIssues } from "../src/validation";

/**
 * 缩放的两轴模型（v11）：等比 `scale` + 可选的单轴 `scaleX` / `scaleY`。
 *
 * 这里钉住三件事：
 * 1. **读**：单轴字段缺省时用等比值（`effectiveScale*` 是唯一的读入口）；
 * 2. **写**：两轴相等时**折叠**回单个 `scale`（文件里「等比」只有一种写法）；
 * 3. **兼容**：v10 及更早的文件（只有 `scale`）读进来仍然对，回写后升到 v11。
 */

function scene(): SceneDoc {
  return createEmptyScene("Map001");
}

/** 一个只有 id 的普通对象（其余字段用默认值，见 `plainObject` 的同一套理由）。 */
function object(id = "door", patch: Partial<GameObjectDoc> = {}): GameObjectDoc {
  return {
    id,
    name: id,
    kind: "Sprite",
    active: true,
    sortingOrder: 0,
    position: { x: 0, y: 0 },
    rotation: 0,
    scale: 1,
    locked: false,
    components: [],
    ...patch,
  };
}

function withObject(target: SceneDoc, value: GameObjectDoc): SceneDoc {
  return produce(target, (draft) => {
    draft.objects.push(value as Draft<GameObjectDoc>);
  });
}

function mutate<T>(value: T, recipe: (draft: Draft<T>) => void): T {
  return produce(value, recipe);
}

describe("有效缩放（读路径）", () => {
  it("只有等比 `scale` 时两轴都用它", () => {
    const value = object("door", { scale: 2.5 });

    expect(effectiveScaleX(value)).toBe(2.5);
    expect(effectiveScaleY(value)).toBe(2.5);
  });

  it("单轴字段存在时覆盖对应那一轴，另一轴仍用等比值", () => {
    const value = object("door", { scale: 2, scaleX: 3 });

    expect(effectiveScaleX(value)).toBe(3);
    expect(effectiveScaleY(value)).toBe(2);
  });

  it("坏值退回原始尺寸 1，而不是被夹成 0.01（否则对象会看起来「没了」）", () => {
    // 这是读路径与写路径的**关键区别**：写路径「夹而不拒」，读路径必须退回兜底值。
    // 夹成 0.01 会让坏数据伪装成「对象特别小」，用户看到的是一个点、还查不出原因
    for (const broken of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const value = object("door", { scale: broken });

      expect(effectiveScaleX(value)).toBe(DEFAULT_OBJECT_SCALE);
      expect(effectiveScaleY(value)).toBe(DEFAULT_OBJECT_SCALE);
    }
  });

  it("单轴坏值只影响那一轴，另一轴照常用等比值", () => {
    const value = object("door", { scale: 2, scaleX: -1 });

    expect(effectiveScaleX(value)).toBe(2);
    expect(effectiveScaleY(value)).toBe(2);
  });

  it("超上限的值夹到 100（读路径也认这个上限）", () => {
    expect(effectiveScaleX(object("door", { scale: 1e9 }))).toBe(MAX_OBJECT_SCALE);
  });
});

describe("写法归一（写路径）", () => {
  it("两轴相等 → 只留等比 `scale`，两个单轴字段被摘掉", () => {
    const value = object("door", { scale: 1, scaleX: 2, scaleY: 2 });
    const collapsed = collapseScale(value);

    expect(collapsed.scale).toBe(2);
    // 摘干净：不是置成 undefined，而是**没有这个键**（序列化出去的 JSON 才干净）
    expect("scaleX" in collapsed).toBe(false);
    expect("scaleY" in collapsed).toBe(false);
  });

  it("两轴不等 → `scale` 归 1，两轴各写各的", () => {
    const collapsed = collapseScale(object("door", { scale: 2, scaleX: 3, scaleY: 1 }));

    expect(collapsed.scale).toBe(1);
    expect(collapsed.scaleX).toBe(3);
    expect(collapsed.scaleY).toBe(1);
  });

  it("已经是规范形状时原样返回（序列化每帧都可能跑）", () => {
    const value = object("door", { scale: 2 });

    expect(collapseScale(value)).toBe(value);
  });

  it("两轴「差不多」也算等比：反复拖手柄的浮点误差不会把对象钉在非等比形态", () => {
    expect(isUniformScale(2, 2.0000000001)).toBe(true);
    expect(isUniformScale(2, 2.1)).toBe(false);

    const collapsed = collapseScale(object("door", { scale: 1, scaleX: 2, scaleY: 2.0000000001 }));
    expect(collapsed.scaleX).toBeUndefined();
    expect(collapsed.scale).toBeCloseTo(2, 6);
  });

  it("写路径的夹取照旧：0 / 负数夹到 0.01，NaN 交给调用方拒绝", () => {
    expect(clampObjectScale(0)).toBe(MIN_OBJECT_SCALE);
    expect(clampObjectScale(-3)).toBe(MIN_OBJECT_SCALE);
    expect(clampObjectScale(1e9)).toBe(MAX_OBJECT_SCALE);
    expect(clampObjectScale(Number.NaN)).toBeUndefined();
  });
});

describe("setObjectScaleAxes", () => {
  it("两轴各自独立落盘，`scale` 归 1", () => {
    const target = withObject(scene(), object("door"));
    const changed = mutate(target, (draft) => {
      expect(setObjectScaleAxes(draft, "door", { x: 3, y: 0.5 })).toBe(true);
    });

    expect(changed.objects[0]?.scaleX).toBe(3);
    expect(changed.objects[0]?.scaleY).toBe(0.5);
    expect(changed.objects[0]?.scale).toBe(1);
  });

  it("两轴相等时折叠回等比（`scaleX` / `scaleY` 被摘掉）", () => {
    const target = withObject(scene(), object("door", { scale: 1, scaleX: 3, scaleY: 0.5 }));
    const changed = mutate(target, (draft) => {
      expect(setObjectScaleAxes(draft, "door", { x: 2, y: 2 })).toBe(true);
    });

    expect(changed.objects[0]?.scale).toBe(2);
    expect(changed.objects[0]?.scaleX).toBeUndefined();
    expect(changed.objects[0]?.scaleY).toBeUndefined();
  });

  it("任一轴是 NaN / Infinity 就整体拒绝，不写半个脏值进去", () => {
    const target = withObject(scene(), object("door"));
    let changed = true;

    const next = mutate(target, (draft) => {
      changed = setObjectScaleAxes(draft, "door", { x: 2, y: Number.NaN });
    });

    expect(changed).toBe(false);
    expect(next).toBe(target);
  });

  it("值没变就不产生变更（撤销栈里不留空记录）", () => {
    const target = withObject(scene(), object("door", { scale: 2 }));
    let changed = true;

    const next = mutate(target, (draft) => {
      changed = setObjectScaleAxes(draft, "door", { x: 2, y: 2 });
    });

    expect(changed).toBe(false);
    // 命令返回 false = 没改任何东西；这里只断言「值还是原样」，
    // 不依赖 immer 在「零改动」时是否返回同一个引用（那是它的实现细节）
    expect(next.objects[0]?.scale).toBe(2);
  });

  it("对象不存在时什么都不改", () => {
    const target = withObject(scene(), object("door"));
    const next = mutate(target, (draft) => {
      setObjectScaleAxes(draft, "nope", { x: 2, y: 2 });
    });

    expect(next.objects).toHaveLength(1);
    expect(next.objects[0]?.scale).toBe(1);
    expect(next.objects[0]?.scaleX).toBeUndefined();
  });

  it("等比入口仍然只是两轴相等的特例", () => {
    const target = withObject(scene(), object("door", { scale: 1, scaleX: 3, scaleY: 0.5 }));
    const changed = mutate(target, (draft) => {
      expect(setObjectScale(draft, "door", 1.5)).toBe(true);
    });

    expect(changed.objects[0]?.scale).toBe(1.5);
    expect(changed.objects[0]?.scaleX).toBeUndefined();
  });
});

describe("v10 → v11 迁移", () => {
  /** v10 的场景文件：只有等比 `scale`，没有单轴字段。 */
  function v10File(): Record<string, unknown> {
    return {
      formatVersion: 10,
      objects: [
        {
          id: "door",
          name: "木门",
          kind: "Sprite",
          active: true,
          sortingOrder: 0,
          position: { x: 10, y: 20 },
          rotation: 0,
          scale: 2,
          locked: false,
          components: [],
        },
      ],
    };
  }

  it("老文件读进来仍然等比；回写只因为**版本号**低于当前，不是因为缺单轴字段", () => {
    const parsed = parseSceneFile(v10File());

    expect(effectiveScaleX(parsed.file.objects[0] as GameObjectDoc)).toBe(2);
    expect(effectiveScaleY(parsed.file.objects[0] as GameObjectDoc)).toBe(2);
    // v10 低于当前版本 → 会回写一次把版本号升上来。**单轴字段本身不是回写理由**：
    // 它是可选字段，「没写」是合法且有意义的写法
    expect(parsed.needsRewrite).toBe(true);

    // 已经声明成 v11 的文件如果只有 `scale`，那就不该被再写一遍
    const current = parseSceneFile({ ...v10File(), formatVersion: DOCUMENT_FORMAT_VERSION });
    expect(current.needsRewrite).toBe(false);
  });

  it("回写时版本升到 v11，但**不会**凭空补出 scaleX / scaleY", () => {
    const parsed = parseSceneFile(v10File());
    const object = parsed.file.objects[0];

    expect(parsed.file.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
    expect(object?.scaleX).toBeUndefined();
    expect(object?.scaleY).toBeUndefined();
  });

  it("带单轴字段的文件正常读出来", () => {
    const file = v10File();
    const objects = file.objects as Record<string, unknown>[];
    objects[0] = { ...objects[0], scale: 1, scaleX: 4, scaleY: 0.25 };

    const parsed = parseSceneFile({ ...file, formatVersion: DOCUMENT_FORMAT_VERSION });
    const object = parsed.file.objects[0] as GameObjectDoc;

    expect(effectiveScaleX(object)).toBe(4);
    expect(effectiveScaleY(object)).toBe(0.25);
  });

  it("版本高于支持范围照样拒绝（不让新文件在新字段上被静默降级）", () => {
    expect(() => parseSceneFile({ ...v10File(), formatVersion: DOCUMENT_FORMAT_VERSION + 1 })).toThrow(
      /高于本编辑器支持/,
    );
  });
});

describe("坏数据的校验", () => {
  it("单轴缩放为 0 / 负数时报错，且路径指到具体那一轴", () => {
    const target = withObject(scene(), object("door", { scale: 1, scaleX: 0, scaleY: -1 }));
    const issues = formatIssues(validateScene(target));

    expect(issues).toMatch(/scaleX/);
    expect(issues).toMatch(/scaleY/);
    // 等比的 `scale` 本身是好的，不该被连坐
    expect(issues).not.toMatch(/objects\/door\/scale:/);
  });

  it("缺省的单轴字段不是错误（它是合法写法）", () => {
    const target = withObject(scene(), object("door", { scale: 2 }));

    expect(formatIssues(validateScene(target))).not.toMatch(/单轴缩放/);
  });
});
