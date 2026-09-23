import { describe, expect, it } from "vitest";
import {
  CONCRETE_KINDS,
  DOCUMENT_FORMAT_VERSION,
  FEATURE_COMPONENT,
  OBJECT_KIND_DEFS,
  OBJECT_KINDS,
  SPRITE_COMPONENT,
  carriesKind,
  componentForKind,
  isAbstractKind,
  kindAncestors,
  kindDescendants,
  kindIsA,
  kindLineage,
  kindsCarrying,
  objectKindDef,
  parseSceneFile,
  supportsSpriteSheet,
  supportsVideo,
  type ObjectKind,
} from "../src";

/**
 * `SceneObject` 是所有场景对象的抽象基类；每种具体对象类型都继承它。
 *
 * 表本身只有三件事要钉住：
 * 1. **`OBJECT_KINDS` 是唯一来源**——文档 schema 的枚举就是它，加一个类型只动 `kinds.ts`；
 * 2. **判据走层级**：`kindIsA` / `kindLineage` 认子类型，`carriesKind` 因此不必在
 *    每个子类型上重写一遍名单；
 * 3. **抽象基类不落进文档**：`CONCRETE_KINDS` 里没有它，`kindsCarrying` 也不把它算成
 *    「能挂某个组件的类型」。
 */
describe("对象类型层级（kinds.ts）", () => {
  it("表与定义一一对应，顺序也一致", () => {
    expect(OBJECT_KIND_DEFS.map((def) => def.kind)).toEqual([...OBJECT_KINDS]);
    expect([...new Set(OBJECT_KINDS)]).toEqual([...OBJECT_KINDS]);
    expect(objectKindDef("Sprite")?.parent).toBe("SceneObject");
    // 手写文件里的怪值查不到定义（`carriesKind` 对它一律 false，不替它猜）
    expect(objectKindDef("Portal")).toBeUndefined();
  });

  it("祖先链 / 自身链：所有具体对象类型的父类都是 SceneObject", () => {
    expect(kindAncestors("SceneObject")).toEqual([]);
    for (const kind of OBJECT_KINDS) {
      if (kind !== "SceneObject") {
        expect(kindAncestors(kind), kind).toEqual(["SceneObject"]);
      }
    }

    // `kindLineage` 是「自己 + 祖先」，**从自己往上**（查组件路由靠这个顺序）
    expect(kindLineage("Sprite")).toEqual(["Sprite", "SceneObject"]);
    expect(kindLineage("PlaySound")).toEqual(["PlaySound", "SceneObject"]);
  });

  it("kindIsA：自己与子类型都算，父类不算子类型", () => {
    expect(kindIsA("Sprite", "SceneObject")).toBe(true);
    expect(kindIsA("Image", "SceneObject")).toBe(true);
    expect(kindIsA("SceneObject", "SceneObject")).toBe(true);
    // 反向不成立：基类不是子类型
    expect(kindIsA("SceneObject", "Sprite")).toBe(false);
    for (const kind of OBJECT_KINDS) {
      expect(kindIsA(kind, "SceneObject"), kind).toBe(true);
    }
  });

  it("抽象基类不落进文档；子类型列表按层级算出来", () => {
    expect(isAbstractKind("SceneObject")).toBe(true);
    for (const kind of ["Sprite", "Image", "Map", "Player", "Item", "Event", "PlaySound", "Teleport"] as const) {
      expect(isAbstractKind(kind), kind).toBe(false);
    }

    expect([...CONCRETE_KINDS]).toEqual(OBJECT_KINDS.filter((kind) => kind !== "SceneObject"));
    expect(kindDescendants("SceneObject")).toEqual(OBJECT_KINDS.slice(1));
  });
});

/**
 * 类型层级表达对象归属；特性表仍单独声明哪些子类型拥有哪项能力。
 */
describe("层级落到特性表上（features.ts）", () => {
  it("carriesKind：image 只授予支持贴图的具体对象", () => {
    expect(carriesKind(FEATURE_COMPONENT.image, "SceneObject")).toBe(false);
    expect(carriesKind(FEATURE_COMPONENT.image, "Sprite")).toBe(true);
    expect(carriesKind(FEATURE_COMPONENT.image, "Image")).toBe(true);
    expect(carriesKind(FEATURE_COMPONENT.image, "Player")).toBe(true);
    expect(carriesKind(FEATURE_COMPONENT.image, "Item")).toBe(true);
    expect(carriesKind(FEATURE_COMPONENT.image, "Event")).toBe(true);
    // 其它 SceneObject 子类不因此自动获得图片特性
    expect(carriesKind(FEATURE_COMPONENT.image, "Map")).toBe(false);
    expect(carriesKind(FEATURE_COMPONENT.image, "PlaySound")).toBe(false);
    expect(carriesKind(FEATURE_COMPONENT.image, "Teleport")).toBe(false);

    // 视频那一行**刻意不写基类**：写了精灵就会继承到（视频是盖在整图上的，精灵不该有）
    expect(carriesKind(FEATURE_COMPONENT.video, "Sprite")).toBe(false);
    expect(carriesKind(FEATURE_COMPONENT.video, "Image")).toBe(true);
    expect(carriesKind(FEATURE_COMPONENT.video, "Map")).toBe(true);
  });

  it("componentForKind：精灵有自己的路由，其余图片对象使用缺省承载", () => {
    expect(componentForKind("image", "Sprite")).toBe(SPRITE_COMPONENT);
    // 自己没写路由 → 使用缺省 ImageLayer
    expect(componentForKind("image", "Image")).toBe(FEATURE_COMPONENT.image);
    expect(componentForKind("image", "SceneObject")).toBe(FEATURE_COMPONENT.image);
    expect(componentForKind("image", "Player")).toBe(FEATURE_COMPONENT.image);
    // 认不出的特性字段返回空串（调用方不必自己判空）
    expect(componentForKind("image", "Map")).toBe(FEATURE_COMPONENT.image);
  });

  it("kindsCarrying：算出来的是**具体类型**，被路由走的那个不算在缺省组件里", () => {
    // 精灵的图住在 SpriteLayer，所以 ImageLayer 那一份里没有它
    expect([...kindsCarrying(FEATURE_COMPONENT.image)]).toEqual(["Image", "Player", "Item", "Event"]);
    expect([...kindsCarrying(SPRITE_COMPONENT)]).toEqual(["Sprite"]);
    // 抽象基类不会出现在任何一份名单里（它不落进文档）
    for (const component of [FEATURE_COMPONENT.image, SPRITE_COMPONENT, FEATURE_COMPONENT.map]) {
      expect(kindsCarrying(component)).not.toContain("SceneObject");
    }
    expect([...kindsCarrying(FEATURE_COMPONENT.video)]).toEqual(["Image", "Map"]);
    expect([...kindsCarrying(FEATURE_COMPONENT.map)]).toEqual(["Map"]);
  });

  it("按组件路由判断子图能力，按特性表判断视频能力", () => {
    expect(supportsSpriteSheet("Sprite")).toBe(true);
    expect(supportsSpriteSheet("Image")).toBe(false);
    // 基类本身没有子图能力（它那份缺省承载就是整图）
    expect(supportsSpriteSheet("SceneObject")).toBe(false);
    expect(supportsSpriteSheet("Map")).toBe(false);

    expect(supportsVideo("Image")).toBe(true);
    expect(supportsVideo("Map")).toBe(true);
    expect(supportsVideo("Sprite")).toBe(false);
    expect(supportsVideo("SceneObject")).toBe(false);
  });

  it("文档 schema 的枚举就是 OBJECT_KINDS：每个值都读得开，表外的值仍然被挡住", () => {
    const object = (kind: string) => ({
      id: `obj_${kind}`,
      name: kind,
      kind,
      active: true,
      sortingOrder: 0,
      locked: false,
      // 地图没有位置时迁移会补上世界原点（另一条既有规矩），这里给它一个位置，
      // 于是「要不要回写」这一个断言只反映 kind 改名这一件事
      position: kind === "Map" ? { x: 0, y: 0 } : null,
      rotation: 0,
      scale: 1,
      components: [],
    });

    for (const kind of OBJECT_KINDS) {
      const loaded = parseSceneFile({
        // 用**当前版本**：这一条只反映 kind 改名，不该被「版本号 +1 要回写一次」搅进来
        formatVersion: DOCUMENT_FORMAT_VERSION,
        objects: [object(kind)],
      });

      // **抽象基类不落进文档**：写它的文件（老文件、或手写文件）一读出来就是具体的
      // `Sprite`，并因此要求回写一次——其余类型原样读回、不需要回写
      const expected = kind === "SceneObject" ? "Sprite" : kind;
      expect(loaded.file.objects[0]?.kind, kind).toBe(expected as ObjectKind);
      expect(loaded.needsRewrite, kind).toBe(kind === "SceneObject");
    }

    expect(() =>
      parseSceneFile({ formatVersion: DOCUMENT_FORMAT_VERSION, objects: [object("Portal")] }),
    ).toThrow(/场景文件校验失败/);
  });
});
