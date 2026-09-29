import { describe, expect, it } from "vitest";
import {
  COMPONENT_TYPES,
  CONCRETE_KINDS,
  DEFAULT_SLOT_COMPONENT,
  DOCUMENT_FORMAT_VERSION,
  OBJECT_KINDS,
  OBJECT_PRESETS,
  SPRITE_COMPONENT,
  canAddOptionalObjectComponent,
  canRepairObjectComponent,
  createGameObject,
  featureComponent,
  isAbstractKind,
  parseSceneFile,
  presetOf,
  supportsSpriteSheet,
  supportsVideo,
} from "../src";

/**
 * 对象预设（原对象类型层级，v22 层级移除后 kind 只是预设 id）。
 *
 * 表本身只有三件事要钉住：
 * 1. **`OBJECT_PRESETS` 与 `OBJECT_KINDS` 一一对应**——文档 schema 的枚举就是
 *    `OBJECT_KINDS`，加一个预设只动 `presets.ts`；
 * 2. **创建模板槽位直接写在每个预设上**：Sprite 的 image 槽位是 `SpriteLayer`，
 *    其余可贴图预设是 `ImageLayer`；`Image` 还声明了 `map`（网格）与 `video` 两个**可选**槽位
 *    （v28 起网格就是「贴图 + `GridMap` 组件」，不是独立类型）；
 * 3. **抽象基类不落进文档**：`CONCRETE_KINDS` 里没有它，手写文件写了会被迁移改成 Sprite。
 */
describe("对象预设表（presets.ts）", () => {
  it("每个 kind 都有预设，顺序与 OBJECT_KINDS 一致", () => {
    expect(Object.values(OBJECT_PRESETS).map((preset) => preset.kind)).toEqual([...OBJECT_KINDS]);
    expect([...new Set(OBJECT_KINDS)]).toEqual([...OBJECT_KINDS]);
    expect(presetOf("Sprite")?.slots.image).toBe(SPRITE_COMPONENT);
    // 手写文件里的怪值查不到预设（对它的槽位查询一律落空，不替它猜）
    expect(presetOf("Portal")).toBeUndefined();
  });

  it("槽位路由：精灵的图是 SpriteLayer，其余可贴图预设是 ImageLayer", () => {
    expect(OBJECT_PRESETS.Sprite.slots).toEqual({ image: "SpriteLayer" });
    for (const kind of ["Image", "Player", "Item", "Event"] as const) {
      expect(OBJECT_PRESETS[kind].slots.image, kind).toBe("ImageLayer");
    }

    // 网格与视频是 Image 创建模板里的可选组件；sound / teleport 各归一个创建模板
    expect(OBJECT_PRESETS.Image.slots.map).toBe("GridMap");
    expect(OBJECT_PRESETS.Image.slots.video).toBe("VideoOverlay");
    expect(OBJECT_PRESETS.PlaySound.slots.sound).toBe("PlaySound");
    expect(OBJECT_PRESETS.Teleport.slots.teleport).toBe("Teleport");
  });

  it("only GridMap and video components are optional/removable", () => {
    expect(COMPONENT_TYPES.filter((definition) => definition.optional).map((item) => item.type).sort()).toEqual([
      "GridMap", "VideoBlend", "VideoOverlay",
    ]);
  });

  it("VideoOverlay 可按组件能力添加，不受 kind 限制", () => {
    const video = COMPONENT_TYPES.find((item) => item.type === DEFAULT_SLOT_COMPONENT.video);
    expect(video?.optional).toBe(true);

    const image = createGameObject({ id: "image", name: "贴图", kind: "Image" });
    const sprite = createGameObject({ id: "sprite", name: "精灵", kind: "Sprite" });
    expect(canAddOptionalObjectComponent(image, DEFAULT_SLOT_COMPONENT.video)).toBe(true);
    expect(canAddOptionalObjectComponent(sprite, DEFAULT_SLOT_COMPONENT.video)).toBe(true);
  });

  it("GridMap 是可选组件：任意对象均可显式添加", () => {
    const definition = COMPONENT_TYPES.find((item) => item.type === DEFAULT_SLOT_COMPONENT.map);
    expect(definition?.optional).toBe(true);

    const image = createGameObject({ id: "image", name: "贴图", kind: "Image" });
    const sprite = createGameObject({ id: "sprite", name: "精灵", kind: "Sprite" });
    expect(canAddOptionalObjectComponent(image, DEFAULT_SLOT_COMPONENT.map)).toBe(true);
    expect(canAddOptionalObjectComponent(sprite, DEFAULT_SLOT_COMPONENT.map)).toBe(true);
    expect(canRepairObjectComponent(image, DEFAULT_SLOT_COMPONENT.map)).toBe(false);
  });

  it("ImageLayer 与 SpriteLayer 可按用户选择的组件显式添加", () => {
    const sprite = createGameObject({ id: "sprite", name: "精灵", kind: "Sprite" });
    const image = createGameObject({ id: "image", name: "贴图", kind: "Image" });
    const player = createGameObject({ id: "player", name: "玩家", kind: "Player" });

    expect(canRepairObjectComponent(sprite, SPRITE_COMPONENT)).toBe(true);
    expect(canRepairObjectComponent(image, DEFAULT_SLOT_COMPONENT.image)).toBe(true);
    expect(canRepairObjectComponent(player, DEFAULT_SLOT_COMPONENT.image)).toBe(true);
    expect(canRepairObjectComponent(sprite, DEFAULT_SLOT_COMPONENT.image)).toBe(true);
    expect(canRepairObjectComponent(image, SPRITE_COMPONENT)).toBe(true);
  });

  it("attached component combinations do not veto adding an unused slot", () => {
    const image = createGameObject({ id: "image", name: "贴图", kind: "Image" });
    const mismatched = {
      ...image,
      components: [featureComponent(image.id, DEFAULT_SLOT_COMPONENT.teleport, { targets: [] })],
    };

    expect(canAddOptionalObjectComponent(mismatched, DEFAULT_SLOT_COMPONENT.map)).toBe(true);
    expect(canAddOptionalObjectComponent(mismatched, DEFAULT_SLOT_COMPONENT.video)).toBe(true);
    expect(canRepairObjectComponent(mismatched, DEFAULT_SLOT_COMPONENT.image)).toBe(true);
  });

  it("video and sprite sheet capability require attached components", () => {
    const base = createGameObject({ id: "sprite-teleport", name: "组合对象", kind: "Sprite" });
    const object = {
      ...base,
      components: [featureComponent(base.id, DEFAULT_SLOT_COMPONENT.teleport, { targets: [] })],
    };

    expect(supportsVideo(object)).toBe(false);
    expect(supportsSpriteSheet(object)).toBe(false);
  });

  it("creation presets retain initial component templates", () => {
    expect(OBJECT_PRESETS.Image.slots.video).toBe("VideoOverlay");
    expect(OBJECT_PRESETS.Sprite.slots.video).toBeUndefined();
    expect(OBJECT_PRESETS.Player.slots.video).toBeUndefined();

    // 预设声明的承载组件都必须注册在组件表里（消息里带上是谁）
    for (const preset of Object.values(OBJECT_PRESETS)) {
      for (const component of Object.values(preset.slots)) {
        expect(
          { missing: !COMPONENT_TYPES.some((def) => def.type === component), component },
          `${preset.kind}.${component}`,
        ).toEqual({ missing: false, component });
      }
    }
  });

  it("抽象基类不落进文档，也不在 CONCRETE_KINDS 里", () => {
    expect(isAbstractKind("GameObject")).toBe(true);
    for (const kind of [
      "Sprite",
      "Image",
      "Player",
      "Item",
      "Event",
      "PlaySound",
      "Teleport",
    ] as const) {
      expect(isAbstractKind(kind), kind).toBe(false);
    }

    expect([...CONCRETE_KINDS]).toEqual(OBJECT_KINDS.filter((kind) => kind !== "GameObject"));
  });

  it("component capabilities are inferred only from actual component instances", () => {
    const sprite = featureComponent("s", "SpriteLayer", { sortingOrder: 0 });
    const video = featureComponent("s", "VideoOverlay", {});
    const base = createGameObject({ id: "s", name: "sprite", kind: "Sprite" });
    expect(supportsSpriteSheet({ ...base, components: [sprite] })).toBe(true);
    expect(supportsSpriteSheet(base)).toBe(false);
    expect(supportsVideo({ ...base, components: [video] })).toBe(true);
    expect(supportsVideo(base)).toBe(false);
  });

  it("文档 schema 的枚举就是 OBJECT_KINDS：每个值都读得开，表外的值仍然被挡住", () => {
    const object = (kind: string) => ({
      id: `obj_${kind}`,
      name: kind,
      kind,
      active: true,
      locked: false,
      // 没有位置的对象迁移会补上世界原点（另一条既有规矩），这里给一个位置，
      // 于是「要不要回写」这一个断言只反映 kind 改名这一件事
      position: { x: 0, y: 0 },
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
      const expected = kind === "GameObject" ? "Sprite" : kind;
      expect(loaded.file.objects[0]?.kind, kind).toBe(expected as (typeof OBJECT_KINDS)[number]);
      expect(loaded.needsRewrite, kind).toBe(kind === "GameObject");
    }

    expect(() =>
      parseSceneFile({ formatVersion: DOCUMENT_FORMAT_VERSION, objects: [object("Portal")] }),
    ).toThrow(/场景文件校验失败/);
  });
});
