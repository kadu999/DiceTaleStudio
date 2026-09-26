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
  carriesComponent,
  componentForSlot,
  createGameObject,
  featureComponent,
  isAbstractKind,
  parseSceneFile,
  presetOf,
  supportsSpriteSheet,
  supportsVideo,
  type ObjectKind,
} from "../src";

/**
 * 对象预设（原对象类型层级，v22 层级移除后 kind 只是预设 id）。
 *
 * 表本身只有三件事要钉住：
 * 1. **`OBJECT_PRESETS` 与 `OBJECT_KINDS` 一一对应**——文档 schema 的枚举就是
 *    `OBJECT_KINDS`，加一个预设只动 `presets.ts`；
 * 2. **槽位路由直接写在每个预设上**：Sprite 的 image 槽位是 `SpriteLayer`，
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

    // 网格与视频是贴图上的两个可选槽位；sound / teleport 各归一个预设
    expect(OBJECT_PRESETS.Image.slots.map).toBe("GridMap");
    expect(OBJECT_PRESETS.Image.slots.video).toBe("VideoOverlay");
    expect(OBJECT_PRESETS.PlaySound.slots.sound).toBe("PlaySound");
    expect(OBJECT_PRESETS.Teleport.slots.teleport).toBe("Teleport");
  });

  it("组件模板 kind 声明覆盖预设槽位，必需组件使用显式修复", () => {
    for (const preset of Object.values(OBJECT_PRESETS)) {
      for (const component of Object.values(preset.slots)) {
        const definition = COMPONENT_TYPES.find((item) => item.type === component);
        expect(definition?.templateKinds, `${preset.kind}.${component}`).toContain(preset.kind);
        if (definition?.optionalKinds?.includes(preset.kind) !== true) {
          expect(definition?.repairKinds, `${preset.kind}.${component}`).toContain(preset.kind);
        }
      }
    }

    for (const definition of COMPONENT_TYPES) {
      const presetKinds: string[] = Object.values(OBJECT_PRESETS)
        .filter((preset) => Object.values(preset.slots).includes(definition.type))
        .map((preset) => preset.kind);
      expect([...(definition.templateKinds ?? [])].sort(), definition.type).toEqual(presetKinds.sort());

      const optionalKinds = definition.optionalKinds ?? [];
      const repairKinds = definition.repairKinds ?? [];
      const repairableKinds = presetKinds.filter((kind) => !optionalKinds.includes(kind));
      expect([...repairKinds].sort(), `${definition.type} repair`).toEqual(repairableKinds.sort());
      expect(optionalKinds.every((kind) => presetKinds.includes(kind)), `${definition.type} optional`).toBe(true);
      expect(repairKinds.every((kind) => presetKinds.includes(kind)), `${definition.type} repairable`).toBe(true);
      expect(repairKinds.some((kind) => optionalKinds.includes(kind)), `${definition.type} repair overlap`).toBe(false);
    }
  });

  it("VideoOverlay 是贴图可显式添加的可选组件（v28 起只有贴图）", () => {
    const video = COMPONENT_TYPES.find((item) => item.type === DEFAULT_SLOT_COMPONENT.video);
    expect(video?.templateKinds).toEqual(["Image"]);
    expect(video?.optionalKinds).toEqual(["Image"]);

    const image = createGameObject({ id: "image", name: "贴图", kind: "Image" });
    const sprite = createGameObject({ id: "sprite", name: "精灵", kind: "Sprite" });
    expect(canAddOptionalObjectComponent(image, DEFAULT_SLOT_COMPONENT.video)).toBe(true);
    expect(canAddOptionalObjectComponent(sprite, DEFAULT_SLOT_COMPONENT.video)).toBe(false);
  });

  it("GridMap 是贴图上的可选组件：能加、没有「缺失修复」一说", () => {
    const definition = COMPONENT_TYPES.find((item) => item.type === DEFAULT_SLOT_COMPONENT.map);
    expect(definition?.optionalKinds).toEqual(["Image"]);
    expect(definition?.repairKinds).toBeUndefined();

    const image = createGameObject({ id: "image", name: "贴图", kind: "Image" });
    const sprite = createGameObject({ id: "sprite", name: "精灵", kind: "Sprite" });
    expect(canAddOptionalObjectComponent(image, DEFAULT_SLOT_COMPONENT.map)).toBe(true);
    expect(canAddOptionalObjectComponent(sprite, DEFAULT_SLOT_COMPONENT.map)).toBe(false);
    expect(canRepairObjectComponent(image, DEFAULT_SLOT_COMPONENT.map)).toBe(false);
  });

  it("ImageLayer 与 SpriteLayer 只允许按对象模板显式添加", () => {
    const sprite = createGameObject({ id: "sprite", name: "精灵", kind: "Sprite" });
    const image = createGameObject({ id: "image", name: "贴图", kind: "Image" });
    const player = createGameObject({ id: "player", name: "玩家", kind: "Player" });

    expect(canRepairObjectComponent(sprite, SPRITE_COMPONENT)).toBe(true);
    expect(canRepairObjectComponent(image, DEFAULT_SLOT_COMPONENT.image)).toBe(true);
    expect(canRepairObjectComponent(player, DEFAULT_SLOT_COMPONENT.image)).toBe(true);
    expect(canRepairObjectComponent(sprite, DEFAULT_SLOT_COMPONENT.image)).toBe(false);
  });

  it("组件 kind mismatch 时，不会以可选准入或显式修复补建缺失组件", () => {
    const image = createGameObject({ id: "image", name: "贴图", kind: "Image" });
    const mismatched = {
      ...image,
      components: [featureComponent(image.id, DEFAULT_SLOT_COMPONENT.teleport, { targets: [] })],
    };

    expect(canAddOptionalObjectComponent(mismatched, DEFAULT_SLOT_COMPONENT.map)).toBe(false);
    expect(canAddOptionalObjectComponent(mismatched, DEFAULT_SLOT_COMPONENT.video)).toBe(false);
    expect(canRepairObjectComponent(mismatched, DEFAULT_SLOT_COMPONENT.image)).toBe(false);
  });

  it("kind mismatch 不会再为缺失组件提供视频或子图 fallback", () => {
    const base = createGameObject({ id: "sprite-teleport", name: "组合对象", kind: "Sprite" });
    const object = {
      ...base,
      components: [featureComponent(base.id, DEFAULT_SLOT_COMPONENT.teleport, { targets: [] })],
    };

    expect(supportsVideo(object)).toBe(false);
    expect(supportsSpriteSheet(object)).toBe(false);
  });

  it("video 槽位只给贴图（精灵刻意不给）", () => {
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

  it("componentForSlot：预设没有 / 认不出的 kind 落到缺省承载组件", () => {
    expect(componentForSlot("image", "Sprite")).toBe(SPRITE_COMPONENT);
    expect(componentForSlot("image", "Image")).toBe(DEFAULT_SLOT_COMPONENT.image);
    expect(componentForSlot("image", "Player")).toBe(DEFAULT_SLOT_COMPONENT.image);
    // 抽象基类没有槽位表 → 缺省承载（与旧 `componentForKind` 同一个兜底）
    expect(componentForSlot("image", "GameObject")).toBe(DEFAULT_SLOT_COMPONENT.image);
    // 预设没写 image 槽位的（战争雾 / 声音 / …）也落缺省承载
    expect(componentForSlot("image", "Fog")).toBe(DEFAULT_SLOT_COMPONENT.image);
    expect(componentForSlot("sound", "Sprite")).toBe(DEFAULT_SLOT_COMPONENT.sound);
    // 认不出的 kind 同样落缺省承载，不替它猜
    expect(componentForSlot("image", "Portal" as ObjectKind)).toBe(DEFAULT_SLOT_COMPONENT.image);
  });

  it("carriesComponent：只有槽位表的承载组件才算；未知 kind 一律 false", () => {
    expect(carriesComponent("SpriteLayer", "Sprite")).toBe(true);
    expect(carriesComponent("ImageLayer", "Sprite")).toBe(false);
    expect(carriesComponent("ImageLayer", "Image")).toBe(true);
    // 网格是贴图的可选槽位 → 算「这个 kind 能承载它」
    expect(carriesComponent("GridMap", "Image")).toBe(true);
    expect(carriesComponent("PlaySound", "PlaySound")).toBe(true);
    // 抽象基类与认不出的 kind 都是空槽位表 → false（与旧 `carriesKind` 一致）
    expect(carriesComponent("ImageLayer", "GameObject")).toBe(false);
    expect(carriesComponent("ImageLayer", "Portal" as ObjectKind)).toBe(false);
  });

  it("按槽位组件判断子图能力，按预设表判断视频能力", () => {
    expect(supportsSpriteSheet("Sprite")).toBe(true);
    expect(supportsSpriteSheet("Image")).toBe(false);
    // 基类本身没有子图能力（它没有 image 槽位）
    expect(supportsSpriteSheet("GameObject")).toBe(false);

    expect(supportsVideo("Image")).toBe(true);
    expect(supportsVideo("Sprite")).toBe(false);
    expect(supportsVideo("GameObject")).toBe(false);
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
      expect(loaded.file.objects[0]?.kind, kind).toBe(expected as ObjectKind);
      expect(loaded.needsRewrite, kind).toBe(kind === "GameObject");
    }

    expect(() =>
      parseSceneFile({ formatVersion: DOCUMENT_FORMAT_VERSION, objects: [object("Portal")] }),
    ).toThrow(/场景文件校验失败/);
  });
});
