import { describe, expect, it } from "vitest";
import {
  COMPONENT_TYPE,
  SPRITE_SHEET_MAX as PROTOCOL_SPRITE_SHEET_MAX,
  componentDataOf,
  componentSchema,
  sceneComponentSchema,
  sceneSchema,
  type GameObjectPayload,
} from "@dts/protocol";
import {
  ASSET_META_FORMAT_VERSION,
  COMPONENT_TYPES,
  DEFAULT_SLOT_COMPONENT,
  DOCUMENT_FORMAT_VERSION,
  FEATURE_COMPONENT_TYPES,
  OBJECT_PRESETS,
  SLOT_COMPONENT_TYPES,
  SPRITE_COMPONENT,
  SPRITE_SHEET_MAX,
  componentId,
  createAssetMetas,
  createEmptyScene,
  createGridMapObject,
  createGameObject,
  createSoundObject,
  createTeleportObject,
  hasErrors,
  imageOf,
  parseSceneFile,
  resolveSceneSprites,
  validateScene,
  withFeature,
  type ImageRef,
  type GameObjectDoc,
} from "@dts/document";

/**
 * **跨包契约**：`@dts/protocol` 与 `@dts/document` 是两套刻意复刻的 schema
 * （协议不能反过来依赖文档包），所以「两边字段口径一致」这件事**必须由测试兜住**——
 * 否则改了文档侧忘了协议侧，类型检查不会报错，只会在运行时被 zod 丢掉或拒掉。
 *
 * 这个文件放在 `apps/backend/test` 是因为：只有后端同时依赖两个包，
 * 而架构边界测试只扫各包的 `src` 目录，不会把测试里的跨包 import 当成越权依赖。
 */
describe("契约：协议与文档的组件口径一致", () => {
  it("组件类型名逐字一致（改一处忘了另一处会在这里炸）", () => {
    expect(COMPONENT_TYPE.map).toBe(DEFAULT_SLOT_COMPONENT.map);
    expect(COMPONENT_TYPE.fog).toBe(DEFAULT_SLOT_COMPONENT.fog);
    expect(COMPONENT_TYPE.image).toBe(DEFAULT_SLOT_COMPONENT.image);
    // 「对象自己显示的图」有两种承载：贴图 `ImageLayer` / 精灵 `SpriteLayer`
    expect(COMPONENT_TYPE.sprite).toBe(SPRITE_COMPONENT);
    expect(COMPONENT_TYPE.sound).toBe(DEFAULT_SLOT_COMPONENT.sound);
    expect(COMPONENT_TYPE.teleport).toBe(DEFAULT_SLOT_COMPONENT.teleport);
    expect(COMPONENT_TYPE.video).toBe(DEFAULT_SLOT_COMPONENT.video);
  });

  it("每个槽位承载组件都在注册表里有定义，且 slot 与 legacyField 一一对应", () => {
    // 预设表允许的全部承载组件（含精灵专属 `SpriteLayer`）都必须在注册表里
    // （消息里带上是谁）——只遍历缺省承载会漏掉它
    for (const preset of Object.values(OBJECT_PRESETS)) {
      for (const component of Object.values(preset.slots)) {
        expect({
          missing: !COMPONENT_TYPES.some((item) => item.type === component),
          component,
        }).toEqual({ missing: false, component });
      }
    }

    // 从对象扁平字段提升上来的组件（v19 那 6 种）：`legacyField`（v19 之前住的
    // 扁平字段名）与自报的 `slot` 一一对应——既不能漏（老文件的字段搬不动），也不能多
    // （把没有历史字段的组件当成 v19 式迁移目标）。
    const legacyTypes = FEATURE_COMPONENT_TYPES.map((def) => def.type);
    for (const def of FEATURE_COMPONENT_TYPES) {
      expect({ component: def.type, legacyField: def.legacyField }).toEqual({
        component: def.type,
        legacyField: def.slot,
      });
      expect(SLOT_COMPONENT_TYPES).toContain(def);
    }

    // 有 slot、没 legacyField 的只许是 `FogOfWar`（v25 从 `GridMap` data 里拆出来的
    // 从属组件）：它的迁移是 `migrateMapFogToComponent`，不走 v19 那套扁平字段搬迁
    for (const def of SLOT_COMPONENT_TYPES) {
      if (legacyTypes.includes(def.type)) continue;
      expect({ component: def.type, legacyField: def.legacyField }).toEqual({
        component: "FogOfWar",
        legacyField: undefined,
      });
    }
  });

  it("文档校验接受的场景，协议侧也解析得开（真跑一遍工厂 → 校验 → 协议）", () => {
    const objects: GameObjectDoc[] = [
      createGridMapObject({
        name: "地图",
        image: { id: "project:P/Assets/images/场景1.png", width: 1920, height: 1080 },
        grid: { width: 64, height: 36 },
      }),
      createSoundObject({
        name: "脚步",
        clips: ["project:P/Assets/audio/step1.mp3"],
        position: { x: 0, y: 0 },
      }),
      createTeleportObject({ name: "传送阵", targets: ["场景2"], position: { x: 0, y: 0 } }),
    ];

    // 文档侧：三个对象都通过语义校验（没有 error）
    const scene = { ...createEmptyScene("场景1"), objects };
    const issues = validateScene(scene);
    expect(issues.filter((issue) => issue.level === "error")).toEqual([]);

    // 协议侧：每个特性组件都能过 sceneComponentSchema 的判别联合
    for (const object of objects) {
      for (const component of object.components) {
        expect(sceneComponentSchema.safeParse(component).success).toBe(true);
      }

      const withComponent = {
        id: object.id,
        name: object.name,
        kind: object.kind,
        active: object.active,
        position: object.position,
        rotation: object.rotation,
        scale: object.scale,
        components: object.components,
      } as GameObjectPayload;

      expect(sceneComponentSchema.safeParse(withComponent.components[0]).success).toBe(true);
    }
  });

  it("已知特性组件的 data 写坏了：协议侧也要拒（不能掉进「未知类型」的宽松分支）", () => {
    const broken = {
      id: componentId("map_01", COMPONENT_TYPE.map),
      type: COMPONENT_TYPE.map,
      // 少了 image / cells，grid 也不合法
      data: { grid: { width: 0, height: 0 } },
    };

    // `sceneComponentSchema` 是真正的门（5 种严格 + 未知宽松）；`componentSchema` 只是
    // 「未知类型」那一支——所以它本来就不该接受已知名（靠 refine 挡住）
    expect(sceneComponentSchema.safeParse(broken).success).toBe(false);
    expect(componentSchema.safeParse(broken).success).toBe(false);
  });

  it("未知组件类型在协议侧仍然是宽松分支（data 任意，不因新组件判整条消息非法）", () => {
    const parsed = componentSchema.safeParse({
      id: componentId("obj_1", "CustomThing"),
      type: "CustomThing",
      data: { anything: 1 },
    });
    expect(parsed.success, "协议拒了未知组件 CustomThing").toBe(true);
  });

  it("精灵：切分上限两边同值；文档 + 工程表解析出的载荷协议收得下", () => {
    // 两个常量各写一份（协议不能依赖文档包），值必须一样
    expect(PROTOCOL_SPRITE_SHEET_MAX).toBe(SPRITE_SHEET_MAX);

    const imageId = "project:P/Assets/images/sheet.png";
    const scene = {
      ...createEmptyScene("场景1"),
      objects: [
        withFeature<ImageRef>(createGameObject({ id: "sprite_1", name: "精灵" }), SPRITE_COMPONENT, {
          id: imageId,
          width: 64,
          height: 64,
          sprite: { column: 1, row: 0 },
        }),
      ],
    };
    // v23 起切分住在**素材自己的 `.meta`** 里，文档侧拿到的是它的索引：
    // guid（身份）与路径 ID 两个方向都查得到同一份（`createAssetMetas`）
    const metas = createAssetMetas([
      {
        id: imageId,
        meta: {
          formatVersion: ASSET_META_FORMAT_VERSION,
          guid: "0".repeat(32),
          importer: "texture",
          sprite: { mode: "Multiple", sheet: { columns: 4, rows: 2 } },
        },
      },
    ]);

    // 文档侧：语义校验没有 error（格子落在切分范围内）
    expect(hasErrors(validateScene(scene, { metas }))).toBe(false);

    // 推送时的解析：切分随载荷走（前端没有工程文件），协议侧收下。
    // 载荷里**只有路径 ID**（guid 在这里换算回路径），所以协议不需要认 guid
    const payload = { name: scene.name, objects: resolveSceneSprites(scene, metas).objects };
    const parsed = sceneSchema.parse(JSON.parse(JSON.stringify(payload)) as unknown);
    expect(componentDataOf(parsed.objects[0]!, COMPONENT_TYPE.sprite)).toEqual({
      id: imageId,
      width: 64,
      height: 64,
      sprite: { column: 1, row: 0 },
      spriteGrid: { columns: 4, rows: 2 },
      sortingOrder: 0,
    });
  });

  it("精灵：文档 schema 不认 spriteGrid（那是载荷专有的字段，落盘时不该留在场景文件里）", () => {
    const raw = {
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: [
        {
          id: "sprite_1",
          name: "精灵",
          kind: "Sprite",
          active: true,
          locked: false,
          sortingOrder: 0,
          position: null,
          rotation: 0,
          scale: 1,
          components: [
            {
              id: `sprite_1__${SPRITE_COMPONENT}`,
              type: SPRITE_COMPONENT,
              data: { id: "project:P/Assets/images/sheet.png", width: 64, height: 64, spriteGrid: { columns: 4, rows: 2 } },
              actions: [],
            },
          ],
        },
      ],
    };

    const loaded = parseSceneFile(raw);
    // zod 的「丢掉不认识的键」是静默的：读进来就当没有过（磁盘上的文件由此自描述）
    expect(imageOf(loaded.file.objects[0]!)).toEqual({
      id: "project:P/Assets/images/sheet.png",
      width: 64,
      height: 64,
    });
  });
});
