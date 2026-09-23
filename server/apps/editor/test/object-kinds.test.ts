import { describe, expect, it } from "vitest";
import { CONCRETE_KINDS, OBJECT_KINDS, presetOf } from "@dts/document";
import {
  KIND_LABELS,
  OBJECT_CATEGORIES,
  categoryOfKind,
  creatableObjects,
} from "../src/panels/object-kinds";

/**
 * 对象类型表的两条**表级**不变量（单看某一个类型看不出来，加类型时最容易破）：
 *
 * 1. **每个 `kind` 都要有种类归属**——场景对象面板按种类过滤，归类漏一个，那种对象在
 *    面板上就会凭空消失（手写文件里真写了 `GameObject` 这种值也一样）；
 * 2. **抽象基类不进弹框**——`GameObject` 是所有场景对象的抽象基类，只作归类项（`creatable: false`），
 *    落进文档的永远是具体类型（`Sprite` / `Image` / …）。
 *
 * 名字与「哪些类型可创建」的中文口径见 `object-kinds.ts` 的文件头注释；
 * 预设（哪个 kind 允许哪些能力槽位）在 `@dts/document` 的 `presets.ts`，不在这张表里。
 */
describe("对象类型表（object-kinds.ts）", () => {
  it("每个 ObjectKind 都有种类归属，且只归一个种类", () => {
    for (const kind of OBJECT_KINDS) {
      const owners = OBJECT_CATEGORIES.filter((category) =>
        category.objects.some((object) => object.kind === kind),
      );
      expect(owners.map((category) => category.id), kind).toHaveLength(1);
      expect(categoryOfKind(kind)?.id, kind).toBe(owners[0]?.id);
    }
  });

  it("表里的类型不超过 ObjectKind；每个类型都有展示名", () => {
    const declared = OBJECT_CATEGORIES.flatMap((category) => category.objects);
    for (const type of declared) {
      expect(OBJECT_KINDS, type.id).toContain(type.kind);
      // 名字是**类型自己的**（`label`），不是 `KIND_LABELS[kind]`
      expect(type.label.length, type.id).toBeGreaterThan(0);
      expect(KIND_LABELS[type.kind], type.kind).toBeTruthy();
    }
    // 弹框的瓦片 key 用 `id`，重复会让两个瓦片共用选中态
    expect(new Set(declared.map((type) => type.id)).size).toBe(declared.length);
  });

  it("抽象基类只作归类项：不可创建、也不在弹框的候选里", () => {
    const base = OBJECT_CATEGORIES.flatMap((category) => category.objects).find(
      (object) => object.kind === "GameObject",
    );
    expect(base).toBeDefined();
    expect(base?.creatable).toBe(false);
    expect(base?.label).toBe("游戏对象");
    // 它仍然有种类归属（手写文件里出现这个值时，面板不会把它漏掉）
    expect(categoryOfKind("GameObject")?.id).toBe("entity");

    for (const category of OBJECT_CATEGORIES) {
      expect(
        creatableObjects(category).some((object) => object.kind === "GameObject"),
        category.id,
      ).toBe(false);
    }
  });

  it("实体下可创建的就是三个具体类型，顺序为 网格地图 / 精灵 / 贴图", () => {
    const entity = OBJECT_CATEGORIES.find((category) => category.id === "entity");
    expect(entity).toBeDefined();
    expect(creatableObjects(entity!).map((object) => object.kind)).toEqual([
      "Map",
      "Sprite",
      "Image",
    ]);
    // 三个都是具体类型（没有一个是抽象基类）
    for (const kind of creatableObjects(entity!).map((object) => object.kind)) {
      expect(CONCRETE_KINDS, kind).toContain(kind);
    }
    // 它们三个在预设表里都声明了贴图槽位（「能显示一张图」是实体这条线的共同能力）
    for (const kind of creatableObjects(entity!).map((object) => object.kind)) {
      expect(presetOf(kind)?.slots.image, kind).toBeDefined();
    }
  });
});
