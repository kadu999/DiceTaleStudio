import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import {
  addMagnifierImage,
  removeMagnifierImage,
  repairObjectComponent,
  setMagnifierPicked,
} from "../src/commands";
import { imageOf, magnifierDataOf, mapDataOf, soundDataOf } from "../src/access";
import { featureComponent } from "../src/components";
import { DEFAULT_SLOT_COMPONENT } from "../src/presets";
import { createEmptyScene, createMagnifierObject } from "../src/factory";
import { ASSET_META_FORMAT_VERSION, createAssetMetas, type AssetMetaDoc } from "../src/asset-meta";
import { sceneAssetRefsToGuids, sceneAssetRefsToIds } from "../src/scene-asset-refs";
import { resolveSceneSprites } from "../src/sprites";
import { parseSceneFile } from "../src/schema";
import { formatIssues, hasErrors, validateScene } from "../src/validation";
import { DOCUMENT_FORMAT_VERSION, type ImageRef, type SceneDoc, type GameObjectDoc, type SpriteSheetDoc } from "../src/types";

/**
 * 放大镜（弹框里「动作」种类下的**放大镜**，v30 加）。
 *
 * 基础属性与实体完全同一套（位置 / 缩放 / 激活 / 锁定 / 显示顺序），画布上画一枚
 * **固定的内置放大镜徽标**（不给换贴图）；它自己那份数据是「**图片列表 + 当前展示的那一张**」，
 * 触发它 = 让**前端**弹一扇窗显示选中的那张图（开 / 关两条命令，换图不是命令）。
 *
 * 这里钉的是**数据**这一侧，三条贯穿全篇的规矩：
 * 1. 列表项就是一份**图片引用**（`ImageRef`，可以取图集里的一格）——与贴图 / 精灵同一个形状；
 * 2. **选中是下标**（同一张图的两个不同格子是两条，id 当不了键）——移出一条要顺手调 `picked`；
 * 3. 存盘走 GUID、推送补 `spriteGrid`——与图片层完全同一条链（这里各钉一条）。
 */

const IMAGE_ID = "project:C/Assets/images/handout.png";
const IMAGE_GUID = "ab".repeat(16);
const OTHER_ID = "project:C/Assets/images/clue.png";
const OTHER_GUID = "cd".repeat(16);

function imageOf_(overrides: Partial<ImageRef> & { sprite?: { column: number; row: number } }): ImageRef {
  return { id: IMAGE_ID, width: 400, height: 300, ...overrides };
}

function sceneWith(objects: readonly GameObjectDoc[]): SceneDoc {
  return { ...createEmptyScene("Map001"), objects: [...objects] };
}

function mutate(scene: SceneDoc, recipe: (draft: Draft<SceneDoc>) => void): SceneDoc {
  return produce(scene, recipe);
}

function objectOf(scene: SceneDoc, id: string): GameObjectDoc | undefined {
  return scene.objects.find((object) => object.id === id);
}

/** v29 形状的原始 JSON：放大镜数据挂在 `components[]` 里（这个 kind 是本版新加的）。 */
function rawFile(data?: Record<string, unknown>): unknown {
  return {
    formatVersion: DOCUMENT_FORMAT_VERSION,
    objects: [
      {
        id: "m1",
        name: "放大镜",
        kind: "Magnifier",
        position: { x: 0, y: 0 },
        rotation: 0,
        scale: 1,
        active: true,
        locked: false,
        components:
          data === undefined
            ? []
            : [{ id: "m1__Magnifier", type: DEFAULT_SLOT_COMPONENT.magnifier, data }],
      },
    ],
  };
}

function metaWith(guid: string, sheet?: SpriteSheetDoc): AssetMetaDoc {
  return sheet === undefined
    ? { formatVersion: ASSET_META_FORMAT_VERSION, guid, importer: "texture" }
    : {
        formatVersion: ASSET_META_FORMAT_VERSION,
        guid,
        importer: "texture",
        sprite: { mode: "Multiple", sheet },
      };
}

describe("放大镜的工厂", () => {
  it("新建：kind = Magnifier，图片列表是空的（还没挑素材）；不给落点就是未放置", () => {
    const magnifier = createMagnifierObject({ name: "放大镜", id: "m1" });

    expect(magnifier.kind).toBe("Magnifier");
    expect(magnifierDataOf(magnifier)).toEqual({ images: [] });
    expect(magnifier.position).toBeNull();
    // 和实体一样：没有地图数据、也没有默认贴图（画布上画内置的放大镜徽标）
    expect(imageOf(magnifier)).toBeUndefined();
    expect(mapDataOf(magnifier)).toBeUndefined();
    expect(soundDataOf(magnifier)).toBeUndefined();
    expect(magnifier.scale).toBe(1);
    expect(magnifier.locked).toBe(false);
    // v30 起放大镜数据就是它身上唯一的组件
    expect(magnifier.components.map((component) => component.type)).toEqual([
      DEFAULT_SLOT_COMPONENT.magnifier,
    ]);
  });

  it("可以带着图片与世界坐标新建；没指定展示哪一张就默认展示第一条", () => {
    const magnifier = createMagnifierObject({
      name: "线索放大镜",
      images: [imageOf_({}), imageOf_({ id: OTHER_ID, sprite: { column: 1, row: 0 } })],
      position: { x: 120, y: -40 },
    });

    expect(magnifierDataOf(magnifier)).toEqual({
      images: [imageOf_({}), imageOf_({ id: OTHER_ID, sprite: { column: 1, row: 0 } })],
      picked: 0,
    });
    expect(magnifier.position).toEqual({ x: 120, y: -40 });
  });

  it("也可以指定展示第几条（面板上点小方块选出来的就是它）", () => {
    const magnifier = createMagnifierObject({
      name: "放大镜",
      images: [imageOf_({}), imageOf_({ id: OTHER_ID })],
      picked: 1,
      id: "m1",
    });

    expect(magnifierDataOf(magnifier)?.picked).toBe(1);
  });
});

describe("addMagnifierImage：往列表里加一条", () => {
  function empty(): SceneDoc {
    return sceneWith([createMagnifierObject({ name: "放大镜", id: "m1" })]);
  }

  it("第一条加进来就选中它（不选中面板上看着像坏了）", () => {
    const next = mutate(empty(), (draft) => {
      expect(addMagnifierImage(draft, "m1", imageOf_({}))).toBe(true);
    });

    expect(magnifierDataOf(objectOf(next, "m1")!)).toEqual({ images: [imageOf_({})], picked: 0 });
  });

  it("再加一条：列表变长，**不动已经选中的那一条**", () => {
    const scene = mutate(empty(), (draft) => {
      addMagnifierImage(draft, "m1", imageOf_({}));
    });

    const next = mutate(scene, (draft) => {
      expect(addMagnifierImage(draft, "m1", imageOf_({ id: OTHER_ID }))).toBe(true);
    });

    expect(magnifierDataOf(objectOf(next, "m1")!)).toEqual({
      images: [imageOf_({}), imageOf_({ id: OTHER_ID })],
      picked: 0,
    });
  });

  it("同一张图的**同一个格子**已经在列表里：不重复加，改成选中那一条", () => {
    let scene = mutate(empty(), (draft) => {
      addMagnifierImage(draft, "m1", imageOf_({}));
      addMagnifierImage(draft, "m1", imageOf_({ id: OTHER_ID }));
    });
    // 先选到第二条：下面「再加一次第一条」才会产生「选中变了」这件事
    scene = mutate(scene, (draft) => {
      setMagnifierPicked(draft, "m1", 1);
    });

    const next = mutate(scene, (draft) => {
      expect(addMagnifierImage(draft, "m1", imageOf_({}))).toBe(true);
    });

    expect(magnifierDataOf(objectOf(next, "m1")!)).toEqual({
      images: [imageOf_({}), imageOf_({ id: OTHER_ID })],
      picked: 0,
    });

    // 已经选中它了：再点一次不算改动
    const again = mutate(next, (draft) => {
      expect(addMagnifierImage(draft, "m1", imageOf_({}))).toBe(false);
    });
    expect(again).toBe(next);
  });

  it("同一张图的两个**不同格子**是两条（id 当键会撞车，所以选中是下标）", () => {
    const next = mutate(empty(), (draft) => {
      addMagnifierImage(draft, "m1", imageOf_({ sprite: { column: 0, row: 0 } }));
      addMagnifierImage(draft, "m1", imageOf_({ sprite: { column: 1, row: 0 } }));
    });

    expect(magnifierDataOf(objectOf(next, "m1")!)?.images).toEqual([
      imageOf_({ sprite: { column: 0, row: 0 } }),
      imageOf_({ sprite: { column: 1, row: 0 } }),
    ]);
  });

  it("格子取整 + 非负（界面上敲进来的小数不该原样落盘）", () => {
    const next = mutate(empty(), (draft) => {
      addMagnifierImage(draft, "m1", imageOf_({ sprite: { column: 1.6, row: -2 } }));
    });

    expect(magnifierDataOf(objectOf(next, "m1")!)?.images[0]?.sprite).toEqual({ column: 2, row: 0 });
  });

  it("缺放大镜组件时加不进去（不补建）；显式修复后可编辑", () => {
    const broken: GameObjectDoc = {
      ...createMagnifierObject({ name: "放大镜", id: "m1" }),
      components: [],
    };

    const next = mutate(sceneWith([broken]), (draft) => {
      expect(addMagnifierImage(draft, "m1", imageOf_({}))).toBe(false);
    });
    expect(magnifierDataOf(objectOf(next, "m1")!)).toBeUndefined();

    const repaired = mutate(next, (draft) => {
      expect(repairObjectComponent(draft, "m1", "Magnifier")).toBe(true);
    });
    expect(magnifierDataOf(objectOf(repaired, "m1")!)).toEqual({ images: [] });

    const edited = mutate(repaired, (draft) => {
      expect(addMagnifierImage(draft, "m1", imageOf_({}))).toBe(true);
    });
    expect(magnifierDataOf(objectOf(edited, "m1")!)?.images).toHaveLength(1);
  });
});

describe("removeMagnifierImage：移出一条，并收拾「展示第几张」", () => {
  function withImages(): SceneDoc {
    return sceneWith([
      createMagnifierObject({
        name: "放大镜",
        id: "m1",
        images: [imageOf_({}), imageOf_({ id: OTHER_ID }), imageOf_({ id: IMAGE_ID, sprite: { column: 1, row: 1 } })],
        picked: 1,
      }),
    ]);
  }

  it("移出展示中的那一条：留在同一个下标（后面那条补上来）", () => {
    const next = mutate(withImages(), (draft) => {
      expect(removeMagnifierImage(draft, "m1", 1)).toBe(true);
    });

    expect(magnifierDataOf(objectOf(next, "m1")!)).toEqual({
      images: [imageOf_({}), imageOf_({ id: IMAGE_ID, sprite: { column: 1, row: 1 } })],
      picked: 1,
    });
  });

  it("移出的是最后一条、而它正被展示：退到新的最后一个", () => {
    const last = mutate(withImages(), (draft) => {
      setMagnifierPicked(draft, "m1", 2);
    });
    const next = mutate(last, (draft) => {
      expect(removeMagnifierImage(draft, "m1", 2)).toBe(true);
    });

    expect(magnifierDataOf(objectOf(next, "m1")!)?.picked).toBe(1);
  });

  it("移出的是**前面**的一条：下标跟着减一（还是同一张图被展示）", () => {
    const next = mutate(withImages(), (draft) => {
      expect(removeMagnifierImage(draft, "m1", 0)).toBe(true);
    });

    expect(magnifierDataOf(objectOf(next, "m1")!)?.picked).toBe(0);
    expect(magnifierDataOf(objectOf(next, "m1")!)?.images).toHaveLength(2);
  });

  it("一条不剩：`picked` 整个删掉（不留空壳）", () => {
    let scene = sceneWith([
      createMagnifierObject({ name: "放大镜", id: "m1", images: [imageOf_({})] }),
    ]);
    scene = mutate(scene, (draft) => {
      expect(removeMagnifierImage(draft, "m1", 0)).toBe(true);
    });

    expect(magnifierDataOf(objectOf(scene, "m1")!)).toEqual({ images: [] });
  });

  it("越界 / 不是整数：无变更（不进撤销栈）", () => {
    const scene = withImages();
    for (const index of [-1, 3, 1.5]) {
      const next = mutate(scene, (draft) => {
        expect(removeMagnifierImage(draft, "m1", index)).toBe(false);
      });
      expect(next).toBe(scene);
    }
  });
});

describe("setMagnifierPicked：换展示的那一张", () => {
  function withImages(): SceneDoc {
    return sceneWith([
      createMagnifierObject({
        name: "放大镜",
        id: "m1",
        images: [imageOf_({}), imageOf_({ id: OTHER_ID })],
        picked: 0,
      }),
    ]);
  }

  it("换一条：写进文档；值没变就不算改动", () => {
    const next = mutate(withImages(), (draft) => {
      expect(setMagnifierPicked(draft, "m1", 1)).toBe(true);
    });
    expect(magnifierDataOf(objectOf(next, "m1")!)?.picked).toBe(1);

    const same = mutate(next, (draft) => {
      expect(setMagnifierPicked(draft, "m1", 1)).toBe(false);
    });
    expect(same).toBe(next);
  });

  it("越界的下标直接拒掉（不悄悄夹到最后一格）", () => {
    const scene = withImages();
    for (const index of [-1, 2, 0.5]) {
      const next = mutate(scene, (draft) => {
        expect(setMagnifierPicked(draft, "m1", index)).toBe(false);
      });
      expect(next).toBe(scene);
    }
  });

  it("传 null = 取消选中（`picked` 删掉，图片留着）", () => {
    const next = mutate(withImages(), (draft) => {
      expect(setMagnifierPicked(draft, "m1", null)).toBe(true);
    });

    expect(magnifierDataOf(objectOf(next, "m1")!)).toEqual({
      images: [imageOf_({}), imageOf_({ id: OTHER_ID })],
    });

    const again = mutate(next, (draft) => {
      expect(setMagnifierPicked(draft, "m1", null)).toBe(false);
    });
    expect(again).toBe(next);
  });
});

describe("放大镜的解析与版本", () => {
  it("带图片与展示项能往返解析", () => {
    const images = [imageOf_({}), imageOf_({ id: OTHER_ID, sprite: { column: 1, row: 0 } })];
    const parsed = parseSceneFile(rawFile({ images, picked: 1 }));

    expect(magnifierDataOf(parsed.file.objects[0]!)).toEqual({ images, picked: 1 });
  });

  it("`images` 不写就当成空列表（还没挑素材），`picked` 不写就是还没选", () => {
    const parsed = parseSceneFile(rawFile({}));

    expect(magnifierDataOf(parsed.file.objects[0]!)).toEqual({ images: [] });
  });

  it("当前文档格式是 30（v30 加的放大镜）", () => {
    expect(DOCUMENT_FORMAT_VERSION).toBe(30);
  });

  it("`picked` 只收非负整数（小数 / 负数直接被 schema 拒掉）", () => {
    expect(() => parseSceneFile(rawFile({ images: [imageOf_({})], picked: 0.5 }))).toThrow(
      /场景文件校验失败/,
    );
    expect(() => parseSceneFile(rawFile({ images: [imageOf_({})], picked: -1 }))).toThrow(
      /场景文件校验失败/,
    );
  });
});

describe("放大镜的校验", () => {
  it("缺图片数据（整个组件没有）= error", () => {
    const broken: GameObjectDoc = {
      ...createMagnifierObject({ name: "放大镜", id: "m1" }),
      components: [],
    };

    const issues = validateScene(sceneWith([broken]));
    expect(hasErrors(issues)).toBe(true);
    expect(formatIssues(issues)).toMatch(/缺少图片数据/);
  });

  it("还没加图片 = warning（新建出来就是这个状态，是合法的）", () => {
    const issues = validateScene(sceneWith([createMagnifierObject({ name: "放大镜", id: "m1" })]));

    expect(hasErrors(issues)).toBe(false);
    expect(formatIssues(issues)).toMatch(/还没加图片/);
  });

  it("有图片但没选 = warning；选中的下标越界也 = warning", () => {
    const unpicked: GameObjectDoc = {
      ...createMagnifierObject({ name: "放大镜", id: "m1" }),
      components: [featureComponent("m1", DEFAULT_SLOT_COMPONENT.magnifier, { images: [imageOf_({})] })],
    };
    expect(formatIssues(validateScene(sceneWith([unpicked])))).toMatch(/还没选要展示哪一张/);

    const stale: GameObjectDoc = {
      ...createMagnifierObject({ name: "放大镜", id: "m2" }),
      components: [
        featureComponent("m2", DEFAULT_SLOT_COMPONENT.magnifier, { images: [imageOf_({})], picked: 3 }),
      ],
    };
    expect(formatIssues(validateScene(sceneWith([stale])))).toMatch(/不在图片列表里/);
  });
});

describe("放大镜的存盘与推送", () => {
  function sceneWithImages(): SceneDoc {
    return sceneWith([
      createMagnifierObject({
        name: "放大镜",
        id: "m1",
        images: [
          { id: IMAGE_ID, guid: IMAGE_GUID, width: 400, height: 300 },
          { id: OTHER_ID, guid: OTHER_GUID, width: 100, height: 100, sprite: { column: 1, row: 0 } },
        ],
        picked: 1,
      }),
    ]);
  }

  it("存盘：列表里每一条的 id 都换算成 GUID（与图片层同一条链）", () => {
    const metas = createAssetMetas([
      { id: IMAGE_ID, meta: metaWith(IMAGE_GUID) },
      { id: OTHER_ID, meta: metaWith(OTHER_GUID) },
    ]);

    const stored = sceneAssetRefsToGuids(sceneWithImages(), metas);
    const images = magnifierDataOf(objectOf(stored, "m1")!)?.images ?? [];

    expect(images.map((image) => image.id)).toEqual([IMAGE_GUID, OTHER_GUID]);
    // 读回来又变回路径（guid 原样留着）
    const back = sceneAssetRefsToIds(stored, metas);
    expect(magnifierDataOf(objectOf(back, "m1")!)?.images.map((image) => image.id)).toEqual([
      IMAGE_ID,
      OTHER_ID,
    ]);
  });

  it("推送：格子补上 `spriteGrid`（几行几列），越界的夹到最后一格", () => {
    const metas = createAssetMetas([
      { id: IMAGE_ID, meta: metaWith(IMAGE_GUID, { columns: 2, rows: 2 }) },
      { id: OTHER_ID, meta: metaWith(OTHER_GUID, { columns: 4, rows: 2 }) },
    ]);
    const scene = sceneWith([
      createMagnifierObject({
        name: "放大镜",
        id: "m1",
        images: [
          { id: IMAGE_ID, guid: IMAGE_GUID, width: 200, height: 150, sprite: { column: 1, row: 1 } },
          // 越界（这一张只切了 4 列 2 行）：夹到最后一格
          { id: OTHER_ID, guid: OTHER_GUID, width: 25, height: 50, sprite: { column: 9, row: 9 } },
        ],
        picked: 0,
      }),
    ]);

    const payload = resolveSceneSprites(scene, metas);
    const images = magnifierDataOf(objectOf(payload, "m1")!)?.images ?? [];
    const raw = images as unknown as Array<Record<string, unknown>>;

    // 载荷的 id 是路径 ID（guid 不下发），格子带「几行几列」
    expect(raw[0]).toEqual({
      id: IMAGE_ID,
      width: 200,
      height: 150,
      sprite: { column: 1, row: 1 },
      spriteGrid: { columns: 2, rows: 2 },
    });
    expect(raw[1]).toMatchObject({
      id: OTHER_ID,
      sprite: { column: 3, row: 1 },
      spriteGrid: { columns: 4, rows: 2 },
    });
  });

  it("已经是载荷形状的列表原样返回（内容没变不重造对象）", () => {
    const metas = createAssetMetas([]);
    const scene = sceneWith([
      createMagnifierObject({
        name: "放大镜",
        id: "m1",
        images: [{ id: IMAGE_ID, width: 400, height: 300 }],
        picked: 0,
      }),
    ]);

    expect(resolveSceneSprites(scene, metas)).toBe(scene);
  });
});
