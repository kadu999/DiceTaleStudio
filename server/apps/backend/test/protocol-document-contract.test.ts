import { describe, expect, it } from "vitest";
import {
  COMPONENT_TYPE,
  componentSchema,
  sceneComponentSchema,
  type SceneObjectPayload,
} from "@dts/protocol";
import {
  COMPONENT_TYPES,
  FEATURE_COMPONENT,
  FEATURE_COMPONENT_TYPES,
  OBJECT_FEATURES,
  componentId,
  createEmptyScene,
  createMapObject,
  createSoundObject,
  createTeleportObject,
  validateScene,
  type SceneObjectDoc,
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
    expect(COMPONENT_TYPE.map).toBe(FEATURE_COMPONENT.map);
    expect(COMPONENT_TYPE.image).toBe(FEATURE_COMPONENT.image);
    expect(COMPONENT_TYPE.sound).toBe(FEATURE_COMPONENT.sound);
    expect(COMPONENT_TYPE.teleport).toBe(FEATURE_COMPONENT.teleport);
    expect(COMPONENT_TYPE.video).toBe(FEATURE_COMPONENT.video);
  });

  it("每个特性组件在文档注册表里都有定义，且能挂的 kind 与 OBJECT_FEATURES 一致", () => {
    for (const def of OBJECT_FEATURES) {
      const registered = COMPONENT_TYPES.find((item) => item.type === def.component);
      // 注册表里缺组件时这里会失败（消息里带上是谁）
      expect({ missing: registered === undefined, component: def.component }).toEqual({
        missing: false,
        component: def.component,
      });
      expect(registered?.legacyField).toBe(def.field);
      // kinds 由注册表从 OBJECT_FEATURES 取回来，这里反向确认没有走偏
      expect([...(registered?.kinds ?? [])].sort()).toEqual([...def.kinds].sort());
    }

    expect(FEATURE_COMPONENT_TYPES).toHaveLength(OBJECT_FEATURES.length);
  });

  it("文档校验接受的场景，协议侧也解析得开（真跑一遍工厂 → 校验 → 协议）", () => {
    const objects: SceneObjectDoc[] = [
      createMapObject({
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
        sortingOrder: object.sortingOrder,
        position: object.position,
        rotation: object.rotation,
        scale: object.scale,
        components: object.components,
      } as SceneObjectPayload;

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

  it("前端组件体系那 7 种在协议侧仍然是宽松分支（data 任意，不因新组件判整条消息非法）", () => {
    const legacy = COMPONENT_TYPES.filter((def) => def.legacyField === undefined);
    expect(legacy).toHaveLength(7);

    for (const def of legacy) {
      const parsed = componentSchema.safeParse({
        id: componentId("obj_1", def.type),
        type: def.type,
        data: { anything: 1 },
        actions: [],
      });
      expect(parsed.success, `协议拒了已知组件 ${def.type}`).toBe(true);
    }
  });
});
