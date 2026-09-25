import { describe, expect, it } from "vitest";
import {
  DOCUMENT_FORMAT_VERSION,
  canRepairObjectComponent,
  componentOfSlot,
  emptyAssetMetas,
  parseProjectFile,
  parseSceneFile,
  validateScene,
  type SceneDoc,
} from "../src/index";

/**
 * 阶段 4 合成盘点：外部真实项目样本不可得的**替代方法**。
 *
 * 退役决策真正担心的只有一件事：「收窄/停用 kind 兼容后，某种真实存在过的旧文档读坏」。
 * 没有外部样本时，把「真实存在过」换成**代码自己记录的历史**——schema.ts 的迁移链
 * （v1 → v24）就是历史上全部文档形状的完整档案。这里把每个记载过的形状合成出来、
 * 走真实加载管线（`parseSceneFile`），断言它们全部落到现行组件结构、校验无 error：
 * 历史上的形状全部由 **schema 迁移**承载，运行时 kind 兼容元数据
 * （`templateKinds` / `repairKinds` / `optionalKinds`）只服务「现行格式但不完整」的文档。
 *
 * 残余风险（如实记录）：手写文件里**迁移链没有记载**的形状（例如表外 kind、自造组件名）
 * 不在覆盖范围内——它们按设计要么被 schema 明确拒绝（读不开、不静默毁数），
 * 要么作为未知组件原样往返。这与外部样本无关，是文档化的既定行为。
 */

const IMG = { id: "project:P/Assets/images/m.png", width: 200, height: 100 };

/** v18 时代地图对象上那个扁平 `map` 字段（内容形状 = 现行 GridMap 数据）。 */
const FLAT_MAP = {
  image: IMG,
  grid: { width: 10, height: 5 },
  rowOrder: "bottom-up",
  cells: { encoding: "rle", runs: [[0, 50]] },
  fog: { enabled: true, regions: [] },
};

const FLAT_VIDEO = {
  enabled: true,
  autoPlay: false,
  clips: ["project:P/Assets/video/v.mp4"],
  picked: "project:P/Assets/video/v.mp4",
  loop: false,
  audio: false,
};

/** 老对象只有：身份、kind、位置（v7 起的 active/sortingOrder、v8 scale、v9 locked 都是后补的）。 */
function legacyObject(
  id: string,
  kind: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return { id, name: id, kind, position: { x: 0, y: 0 }, rotation: 0, ...extra };
}

function load(formatVersion: number, objects: unknown[], size?: { width: number; height: number }) {
  return parseSceneFile({ formatVersion, objects }, size);
}

function typesOf(scene: SceneDoc, index = 0): string[] {
  return (scene.objects[index]?.components ?? []).map((c) => c.type);
}

/** 迁移后的场景必须「干净」：error 级问题一个都不许有（warning 可以）。 */
function expectClean(scene: SceneDoc) {
  const errors = validateScene(scene, { metas: emptyAssetMetas() }).filter(
    (issue) => issue.level === "error",
  );
  expect(errors).toEqual([]);
}

/** parseSceneFile 返回的是**文件**形状（名字在文件名上）；validateScene 要的是带名字的 SceneDoc。 */
function named(file: { objects: SceneDoc["objects"] }): SceneDoc {
  return { name: "盘点场景", objects: file.objects };
}

describe("合成盘点 A：v18 扁平字段时代（特性住在对象顶层字段上）", () => {
  const cases: Array<{
    title: string;
    object: Record<string, unknown>;
    kind: string;
    components: string[];
  }> = [
    {
      title: "Map：map + video 两个扁平字段 → GridMap + VideoOverlay + FogOfWar",
      object: legacyObject("o-map", "Map", { map: FLAT_MAP, video: FLAT_VIDEO }),
      kind: "Map",
      components: ["GridMap", "VideoOverlay", "FogOfWar"],
    },
    {
      title: "SceneObject（v22 前的精灵名）：扁平 image → Sprite + SpriteLayer",
      object: legacyObject("o-spr", "SceneObject", { image: IMG }),
      kind: "Sprite",
      components: ["SpriteLayer"],
    },
    {
      title: "Texture（v22 前的贴图名）：扁平 image + video → Image + ImageLayer + VideoOverlay",
      object: legacyObject("o-img", "Texture", { image: IMG, video: FLAT_VIDEO }),
      kind: "Image",
      components: ["ImageLayer", "VideoOverlay"],
    },
    {
      title: "Player：扁平 image → ImageLayer（非精灵路由，kind 不动）",
      object: legacyObject("o-player", "Player", { image: IMG }),
      kind: "Player",
      components: ["ImageLayer"],
    },
    {
      title: "Item：扁平 image → ImageLayer",
      object: legacyObject("o-item", "Item", { image: IMG }),
      kind: "Item",
      components: ["ImageLayer"],
    },
    {
      title: "Event：扁平 image → ImageLayer",
      object: legacyObject("o-event", "Event", { image: IMG }),
      kind: "Event",
      components: ["ImageLayer"],
    },
    {
      title: "PlaySound：扁平 sound → PlaySound 组件",
      object: legacyObject("o-snd", "PlaySound", {
        sound: { clips: ["project:P/Assets/audio/a.mp3"], picked: "project:P/Assets/audio/a.mp3", layer: "sfx" },
      }),
      kind: "PlaySound",
      components: ["PlaySound"],
    },
  ];

  for (const c of cases) {
    it(c.title, () => {
      const { file, needsRewrite } = load(18, [c.object]);
      const object = file.objects[0]!;
      expect(object.kind).toBe(c.kind);
      expect(typesOf(named(file))).toEqual(c.components);
      expect(needsRewrite).toBe(true);
      expectClean(named(file));
    });
  }

  it("Teleport：v12 的单目标 teleport{target} → targets + picked 都补上", () => {
    const { file } = load(18, [
      legacyObject("o-tp", "Teleport", { teleport: { target: "场景2" } }),
    ]);
    const object = file.objects[0]!;
    expect(object.kind).toBe("Teleport");
    expect(typesOf(named(file))).toEqual(["Teleport"]);
    const data = componentOfSlot(object, "teleport")?.data as {
      targets: string[];
      picked?: string;
    };
    expect(data.targets).toEqual(["场景2"]);
    expect(data.picked).toBe("场景2");
    expectClean(named(file));
  });
});

describe("合成盘点 B：v19–20 TextureRenderer 时代（图片组件旧名按 kind 路由）", () => {
  const legacyRenderer = {
    id: "o__TextureRenderer",
    type: "TextureRenderer",
    data: { id: IMG.id, width: IMG.width, height: IMG.height },
  };

  const cases: Array<{ title: string; kind: string; expectKind: string; expectType: string }> = [
    { title: "SceneObject + TextureRenderer → Sprite + SpriteLayer", kind: "SceneObject", expectKind: "Sprite", expectType: "SpriteLayer" },
    { title: "Texture + TextureRenderer → Image + ImageLayer", kind: "Texture", expectKind: "Image", expectType: "ImageLayer" },
    { title: "Player + TextureRenderer → Player + ImageLayer（非精灵一律贴图组件）", kind: "Player", expectKind: "Player", expectType: "ImageLayer" },
  ];

  for (const c of cases) {
    it(c.title, () => {
      const object = legacyObject("o", c.kind, { components: [legacyRenderer] });
      const { file, needsRewrite } = load(20, [object]);
      const parsed = file.objects[0]!;
      expect(parsed.kind).toBe(c.expectKind);
      expect(typesOf(named(file))).toEqual([c.expectType]);
      // 组件 id 跟着改名（<对象 id>__<组件类型>），否则下次写盘会多补一份
      expect(componentOfSlot(parsed, "image")?.id).toBe(`o__${c.expectType}`);
      expect(needsRewrite).toBe(true);
      expectClean(named(file));
    });
  }
});

describe("合成盘点 C：更早的结构时代", () => {
  it("v4 归一化坐标（y 向下）→ 世界坐标（y 向上），按场景尺寸换算", () => {
    const center = legacyObject("o-c", "Image", { image: IMG, position: { x: 0.5, y: 0.5 } });
    const corner = legacyObject("o-k", "Image", { image: IMG, position: { x: 0, y: 0 } });
    const { file } = load(4, [center, corner], { width: 200, height: 100 });

    expect(file.objects[0]!.position).toEqual({ x: 0, y: 0 });
    // 左上角（归一化 y=0 是最上）→ 世界左边缘、上边缘
    expect(file.objects[1]!.position?.x).toBeCloseTo(-100);
    expect(file.objects[1]!.position?.y).toBeCloseTo(50);
    expectClean(named(file));
  });

  it("v1 地图即场景（工程文件层）：maps[] 拆成内联场景，地图对象落到 GridMap 组件", () => {
    const raw = {
      name: "老项目",
      items: { source: "", updatedAt: "", count: 0, items: [] },
      maps: [
        {
          id: "m1",
          name: "老地图",
          image: IMG,
          grid: { width: 10, height: 5 },
          rowOrder: "bottom-up",
          cells: { encoding: "rle", runs: [[0, 50]] },
          objects: [legacyObject("o-spr", "SceneObject", { image: IMG })],
        },
      ],
    };
    // v1/v2 是**工程文件**的历史：场景内联在 project 文档里，由 parseProjectFile 拆出来
    const { migratedScenes, needsRewrite } = parseProjectFile(raw);
    expect(needsRewrite).toBe(true);
    expect(migratedScenes).toHaveLength(1);

    const scene = migratedScenes[0]!;
    expect(scene.name).toBe("老地图");
    expect(scene.objects).toHaveLength(2);
    expect(scene.objects[0]!.kind).toBe("Map");
    expect(componentOfSlot(scene.objects[0]!, "map")?.type).toBe("GridMap");
    expect(scene.objects[0]!.position).toEqual({ x: 0, y: 0 }); // v1 地图没位置 → 补世界原点
    expect(scene.objects[1]!.kind).toBe("Sprite");
    expect(componentOfSlot(scene.objects[1]!, "image")?.type).toBe("SpriteLayer");
    expectClean(scene);
  });
});

describe("合成盘点 D：现行版本（v24）无组件对象 = 不完整文档，走显式修复", () => {
  function currentObject(id: string, kind: string) {
    return {
      id,
      name: id,
      kind,
      active: true,
      locked: false,
      position: { x: 0, y: 0 },
      rotation: 0,
      scale: 1,
      components: [],
    };
  }

  const cases: Array<{ kind: string; repairType: string; expectError: boolean }> = [
    // 地图 / 动作对象：特性组件就是它的全部意义，缺失 = error + 显式修复
    { kind: "Map", repairType: "GridMap", expectError: true },
    { kind: "PlaySound", repairType: "PlaySound", expectError: true },
    { kind: "Teleport", repairType: "Teleport", expectError: true },
    // 图片组件：缺失是「还没选图」的合法态，不报错；显式添加（首次选图）入口可用
    { kind: "Sprite", repairType: "SpriteLayer", expectError: false },
    { kind: "Image", repairType: "ImageLayer", expectError: false },
  ];

  for (const c of cases) {
    it(`${c.kind}：${c.expectError ? "校验报缺组件 error（可定位），且给显式修复入口" : "缺组件是合法未配置态（无 error），显式添加入口可用"}`, () => {
      const { file, needsRewrite } = load(DOCUMENT_FORMAT_VERSION, [currentObject("o", c.kind)]);
      expect(needsRewrite).toBe(false); // 现行版本、字段齐全：不回写
      const scene = named(file);
      const errors = validateScene(scene, { metas: emptyAssetMetas() }).filter(
        (issue) => issue.level === "error",
      );
      if (c.expectError) {
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]!.path).toContain("o");
      } else {
        expect(errors).toEqual([]);
      }
      expect(canRepairObjectComponent(file.objects[0]!, c.repairType)).toBe(true);
    });
  }
});
