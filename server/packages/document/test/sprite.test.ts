import { describe, expect, it } from "vitest";
import { produce, type Draft } from "immer";
import { createGameObject, repairImageObjectComponent, setObjectImage, setObjectSprite } from "../src/commands";
import { createEmptyScene, createMapObject } from "../src/factory";
import { imageOf } from "../src/access";
import {
  ASSET_META_FORMAT_VERSION,
  createAssetMetas,
  emptyAssetMetas,
  type AssetMetaDoc,
  type AssetMetas,
} from "../src/asset-meta";
import {
  DEFAULT_SPRITE_SHEET,
  SPRITE_SHEET_MAX,
  clampSpriteCell,
  displaySpriteOf,
  isTrivialSpriteSheet,
  normalizeSpriteSheet,
  resolvedSpriteOf,
  resolveSceneSprites,
  spriteCellAtFraction,
  spriteCellSizeOf,
  spritePixelRectOf,
  spriteSheetOf,
  spriteUvRectOf,
} from "../src/sprites";
import { parseSceneFile } from "../src/schema";
import { formatIssues, validateScene } from "../src/validation";
import {
  DOCUMENT_FORMAT_VERSION,
  type ImageRef,
  type SceneDoc,
  type GameObjectDoc,
  type SpriteSheetDoc,
} from "../src/types";

/**
 * **精灵（子图）**（v20 起）：一张图按「行×列」切，对象引用其中一格。
 *
 * 三条贯穿全篇的口径（都在这一个文件里钉住）：
 * 1. **切分只有一份**——住在**素材自己的 `.meta`** 里（v23 起；v22 及更早住在工程文件），
 *    查它一律经索引 `AssetMetas`（**guid 优先、路径兜底**），所以「改切分，所有引用它的
 *    对象一起变」，而「素材改名」也不断链；
 * 2. **格序数从左上数**（`row: 0` = 最上），且矩形是**算出来的**（不存像素）；
 * 3. **地图贴图不支持子图**（`displaySpriteOf` 是唯一判据）。
 *
 * meta 自己的读写（解析 / 序列化 / 纯函数写入 / v22 → v23 迁移）由 `asset-meta.test.ts` 管，
 * 这里只管「精灵这条链路上，切分是被谁按什么口径查出来的」。
 */

const IMAGE_ID = "project:C/Assets/images/hero.png";
const IMAGE_GUID = "1f".repeat(16);
const IMAGE = { id: IMAGE_ID, width: 400, height: 300 };
/** 第二张图（测「几张图各一份」）。 */
const OTHER_ID = "project:C/Assets/images/tiles.png";

function sceneWith(objects: readonly GameObjectDoc[]): SceneDoc {
  return { ...createEmptyScene("Map001"), objects: [...objects] };
}

function mutateScene(scene: SceneDoc, recipe: (draft: Draft<SceneDoc>) => void): SceneDoc {
  return produce(scene, recipe);
}

/** 一份素材 meta（`sheet` 不写 = 整图）；guid 由测试给定，改名之后才断言得了同一份。 */
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

/** 一张图的索引（两个方向指向同一份 meta）。 */
function metasFor(id: string, guid: string, sheet?: SpriteSheetDoc): AssetMetas {
  return createAssetMetas([{ id, meta: metaWith(guid, sheet) }]);
}

/** `IMAGE_ID` 那一份切分索引（最常用的输入）。 */
function imageMetas(sheet?: SpriteSheetDoc): AssetMetas {
  return metasFor(IMAGE_ID, IMAGE_GUID, sheet);
}

/** 一个挑了图的精灵（子图的宿主）。 */
function spriteObject(id = "sprite-1", image: ImageRef = IMAGE): GameObjectDoc {
  return setImage(createGameObject({ id, name: "精灵" }), id, image);
}

function setImage(object: GameObjectDoc, id: string, image: ImageRef = IMAGE): GameObjectDoc {
  const scene = sceneWith([object]);
  repairImageObjectComponent(scene, id, image);
  const next = scene.objects[0];
  if (next === undefined) {
    throw new Error("对象不见了");
  }

  return next;
}

/** 这张图某一格的引用（写进对象后读回来）。 */
function sheetOf(width: number, height: number): { columns: number; rows: number } {
  return { columns: width, rows: height };
}

describe("切分：按 meta 索引查（只有这一份数据）", () => {
  it("没有 meta / meta 里没写 sheet = 整图（1×1）", () => {
    expect(spriteSheetOf(emptyAssetMetas(), IMAGE)).toEqual(DEFAULT_SPRITE_SHEET);
    expect(spriteSheetOf(imageMetas(), IMAGE)).toEqual(DEFAULT_SPRITE_SHEET);
    expect(spriteSheetOf(imageMetas(), undefined)).toEqual(DEFAULT_SPRITE_SHEET);
    expect(isTrivialSpriteSheet(DEFAULT_SPRITE_SHEET)).toBe(true);
  });

  it("有 sheet 就用它；坏数字收干净（取整 + 夹到 1..64）", () => {
    expect(spriteSheetOf(imageMetas(sheetOf(2, 2)), IMAGE)).toEqual(sheetOf(2, 2));
    expect(
      spriteSheetOf(metasFor(IMAGE_ID, IMAGE_GUID, { columns: 999, rows: 3.4 }), IMAGE),
    ).toEqual({ columns: SPRITE_SHEET_MAX, rows: 3 });

    expect(normalizeSpriteSheet({ columns: 3.4, rows: 0 })).toEqual({ columns: 3, rows: 1 });
    expect(normalizeSpriteSheet({ columns: 999, rows: Number.NaN })).toEqual({
      columns: SPRITE_SHEET_MAX,
      rows: 1,
    });
    expect(SPRITE_SHEET_MAX).toBe(64);
  });

  it("先按 guid 查：素材改名（引用上的 id 是旧路径）之后切分照样找得到", () => {
    const renamedId = "project:C/Assets/images/A/B/C/D.png";
    const renamed = metasFor(renamedId, IMAGE_GUID, sheetOf(2, 2));

    // guid 是身份、路径只是「上次见到的位置」
    expect(spriteSheetOf(renamed, { id: IMAGE_ID, guid: IMAGE_GUID })).toEqual(sheetOf(2, 2));
    // 老文件只有路径：按 id 兜底
    expect(spriteSheetOf(renamed, { id: renamedId })).toEqual(sheetOf(2, 2));
    // guid 在索引里查不到（手写的怪值）时退回 id——两个都落空才是整图
    expect(spriteSheetOf(renamed, { id: IMAGE_ID, guid: "b".repeat(32) })).toEqual(
      DEFAULT_SPRITE_SHEET,
    );
  });

  it("几张图各自一份：查哪张就是哪张", () => {
    const metas = createAssetMetas([
      { id: IMAGE_ID, meta: metaWith(IMAGE_GUID, sheetOf(2, 2)) },
      { id: OTHER_ID, meta: metaWith("2f".repeat(16), sheetOf(8, 8)) },
    ]);

    expect(spriteSheetOf(metas, { id: OTHER_ID })).toEqual(sheetOf(8, 8));
    expect(spriteSheetOf(metas, { id: IMAGE_ID })).toEqual(sheetOf(2, 2));
  });
});

describe("对象：引用哪一格", () => {
  it("选一格、改回整图；对象上只有格子引用，没有行列", () => {
    const scene = sceneWith([spriteObject()]);
    const picked = mutateScene(scene, (draft) => {
      expect(setObjectSprite(draft, "sprite-1", { column: 2, row: 1 })).toBe(true);
    });

    // 对象只记「引用哪张图 + 第几格」——行列在素材的 `.meta` 里，一个字节都不在场景文件里
    expect(imageOf(picked.objects[0]!)).toEqual({ ...IMAGE, sprite: { column: 2, row: 1 } });
    expect(JSON.stringify(picked)).not.toMatch(/columns|spriteGrid/);

    // 同一格再选一次：不是变更
    expect(
      mutateScene(picked, (draft) => {
        expect(setObjectSprite(draft, "sprite-1", { column: 2, row: 1 })).toBe(false);
      }),
    ).toEqual(picked);

    // 改回整图：`sprite` 整个字段被删掉（不留 `sprite: undefined`）
    const cleared = mutateScene(picked, (draft) => {
      expect(setObjectSprite(draft, "sprite-1", null)).toBe(true);
    });
    expect(imageOf(cleared.objects[0]!)).toEqual(IMAGE);
    expect(JSON.stringify(imageOf(cleared.objects[0]!))).not.toMatch(/sprite/);
  });

  it("换一张图就丢掉旧的格子引用（那格子指的是别的图集了）", () => {
    const scene = mutateScene(sceneWith([spriteObject()]), (draft) => {
      setObjectSprite(draft, "sprite-1", { column: 1, row: 1 });
    });

    const other = { id: "project:C/Assets/images/other.png", width: 64, height: 64 };
    const swapped = mutateScene(scene, (draft) => {
      expect(setObjectImage(draft, "sprite-1", other)).toBe(true);
    });
    expect(imageOf(swapped.objects[0]!)).toEqual(other);
  });

  it("同一个 id 再挑一次（只是宽高不同）时格子留着", () => {
    const scene = mutateScene(sceneWith([spriteObject()]), (draft) => {
      setObjectSprite(draft, "sprite-1", { column: 1, row: 1 });
    });

    const resized = mutateScene(scene, (draft) => {
      expect(setObjectImage(draft, "sprite-1", { ...IMAGE, width: 100, height: 75 })).toBe(true);
    });
    expect(imageOf(resized.objects[0]!)).toEqual({
      id: IMAGE_ID,
      width: 100,
      height: 75,
      sprite: { column: 1, row: 1 },
    });
  });

  it("没挑图、以及地图对象：选格返回 false（格子没有意义）", () => {
    const noImage = createGameObject({ id: "sprite-1", name: "精灵" });
    expect(
      mutateScene(sceneWith([noImage]), (draft) => {
        expect(setObjectSprite(draft, "sprite-1", { column: 0, row: 0 })).toBe(false);
      }),
    ).toEqual(sceneWith([noImage]));

    const mapScene = sceneWith([
      createMapObject({ id: "map-1", name: "网格地图", image: IMAGE, grid: { width: 8, height: 6 } }),
    ]);
    expect(
      mutateScene(mapScene, (draft) => {
        expect(setObjectSprite(draft, "map-1", { column: 1, row: 1 })).toBe(false);
      }),
    ).toEqual(mapScene);
  });

  it("坏格子（负数 / 小数）在命令这一层收成非负整数", () => {
    const scene = mutateScene(sceneWith([spriteObject()]), (draft) => {
      setObjectSprite(draft, "sprite-1", { column: -3, row: 1.6 });
    });
    expect(imageOf(scene.objects[0]!)?.sprite).toEqual({ column: 0, row: 2 });
  });

  it("换图带上 guid；同一个 id 再挑一次（没给 guid）时原引用的 guid 留着", () => {
    const withGuid = { ...IMAGE, guid: IMAGE_GUID };
    const scene = sceneWith([spriteObject("sprite-1", withGuid)]);

    // 调用方给了 guid（刚挑的图带着 meta 的 guid）就用它
    const picked = mutateScene(scene, (draft) => {
      setObjectImage(draft, "sprite-1", { ...withGuid, width: 100, height: 75 });
    });
    expect(imageOf(picked.objects[0]!)).toEqual({
      id: IMAGE_ID,
      guid: IMAGE_GUID,
      width: 100,
      height: 75,
    });

    // 只给 id（老调用方 / 只改尺寸）：稳定身份不该被抹掉——改名之后全靠它
    const resized = mutateScene(scene, (draft) => {
      setObjectImage(draft, "sprite-1", { id: IMAGE_ID, width: 100, height: 75 });
    });
    expect(imageOf(resized.objects[0]!)?.guid).toBe(IMAGE_GUID);

    // 换了另一张图：旧的 guid 跟着旧图一起丢掉
    const swapped = mutateScene(scene, (draft) => {
      setObjectImage(draft, "sprite-1", { id: OTHER_ID, width: 64, height: 64 });
    });
    expect(imageOf(swapped.objects[0]!)?.guid).toBeUndefined();
  });
});

describe("解析：格子落在图片的哪块矩形", () => {
  it("归一化矩形：左上角原点、y 向下；每格恰好 1/列、1/行", () => {
    const sprite = { columns: 4, rows: 2, column: 1, row: 1 };
    expect(spriteUvRectOf(sprite)).toEqual({ x: 0.25, y: 0.5, width: 0.25, height: 0.5 });
  });

  it("像素矩形由**加载到的**图片尺寸算（不做整数取整，两端算出来是同一块）", () => {
    const sprite = { columns: 3, rows: 1, column: 2, row: 0 };
    const rect = spritePixelRectOf(sprite, { width: 100, height: 30 });
    expect(rect.x).toBeCloseTo(200 / 3, 6);
    expect(rect.width).toBeCloseTo(100 / 3, 6);
    expect(rect.height).toBe(30);
  });

  it("越界的格子在解析时夹到最后一格（切分改小之后老对象仍然画得出来）", () => {
    expect(clampSpriteCell({ column: 9, row: 9 }, sheetOf(4, 2))).toEqual({ column: 3, row: 1 });
    expect(
      resolvedSpriteOf({ ...IMAGE, sprite: { column: 5, row: 0 } }, imageMetas(sheetOf(2, 2))),
    ).toEqual({ columns: 2, rows: 2, column: 1, row: 0 });
  });

  it("没有 sprite 时解析为 undefined（整图）", () => {
    expect(resolvedSpriteOf(IMAGE, imageMetas(sheetOf(4, 4)))).toBeUndefined();
    expect(resolvedSpriteOf(undefined, emptyAssetMetas())).toBeUndefined();
  });

  it("地图贴图一律没有子图（判据只有 displaySpriteOf 一处）", () => {
    const metas = imageMetas(sheetOf(4, 4));
    const map = setImage(
      createMapObject({ id: "map-1", name: "网格地图", image: IMAGE, grid: { width: 8, height: 6 } }),
      "map-1",
    );
    const mapWithSprite = produce(map, (draft) => {
      const mapData = draft.components[0]!.data as { image: { sprite?: unknown } };
      mapData.image.sprite = { column: 1, row: 1 };
    });

    // 数据留在文件里（不静默删），但两边都不认它：编辑器与前端都按整图渲染
    expect(displaySpriteOf(mapWithSprite, metas)).toBeUndefined();
    expect(
      displaySpriteOf(spriteObject("sprite-1", { ...IMAGE, sprite: { column: 1, row: 1 } }), metas),
    ).toEqual({ columns: 4, rows: 4, column: 1, row: 1 });
  });

  it("一格的声明尺寸 = 图片尺寸 ÷ 行列（四舍五入，至少 1）", () => {
    expect(spriteCellSizeOf(sheetOf(4, 2), { width: 400, height: 300 })).toEqual({
      width: 100,
      height: 150,
    });
    expect(spriteCellSizeOf(sheetOf(64, 64), { width: 10, height: 10 })).toEqual({
      width: 1,
      height: 1,
    });
  });

  it("点在预览图的哪个位置 = 哪一格（与画哪一块是同一套除法）", () => {
    const sheet = sheetOf(4, 2);
    expect(spriteCellAtFraction({ x: 0.01, y: 0.01 }, sheet)).toEqual({ column: 0, row: 0 });
    expect(spriteCellAtFraction({ x: 0.3, y: 0.6 }, sheet)).toEqual({ column: 1, row: 1 });
    // 点在右下角外面 / 边框上：夹进最后一格，不会算出越界的格子
    expect(spriteCellAtFraction({ x: 1, y: 1 }, sheet)).toEqual({ column: 3, row: 1 });
  });
});

describe("落盘：schema 与版本", () => {
  it("场景文件往返：sprite 引用读得回来；v19 的文件升到 v20 并需要回写", () => {
    const scene = mutateScene(sceneWith([spriteObject()]), (draft) => {
      setObjectSprite(draft, "sprite-1", { column: 3, row: 2 });
    });

    const raw = {
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: JSON.parse(JSON.stringify(scene.objects)) as unknown[],
    };
    const loaded = parseSceneFile(raw);
    expect(imageOf(loaded.file.objects[0]!)?.sprite).toEqual({ column: 3, row: 2 });
    expect(loaded.needsRewrite).toBe(false);

    // v19（没有 sprite 字段）读出来照样能用，只是要被回写一次
    const upgraded = parseSceneFile({ formatVersion: 19, objects: raw.objects });
    expect(upgraded.needsRewrite).toBe(true);
    expect(imageOf(upgraded.file.objects[0]!)?.sprite).toEqual({ column: 3, row: 2 });
  });

  it("场景文件往返：图片引用上的 guid 读得回来（v23 的 schema 必须认它）", () => {
    // schema 是白名单：不认 guid 就会把它静默丢掉——那等于「改名之后引用照样断」，
    // 整个 v23 白做，所以这一条钉在落盘这一层。
    const scene = sceneWith([spriteObject("sprite-1", { ...IMAGE, guid: IMAGE_GUID })]);
    const loaded = parseSceneFile({
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: JSON.parse(JSON.stringify(scene.objects)) as unknown[],
    });

    expect(imageOf(loaded.file.objects[0]!)?.guid).toBe(IMAGE_GUID);
    expect(loaded.needsRewrite).toBe(false);
  });

  it("格子写成负数 / 小数：schema 直接拒（不给画布喂坏数据）", () => {
    const raw = JSON.parse(JSON.stringify(sceneWith([spriteObject()]))) as {
      objects: { components: { data: Record<string, unknown> }[] }[];
    };
    raw.objects[0]!.components[0]!.data.sprite = { column: -1, row: 0 };
    expect(() =>
      parseSceneFile({ formatVersion: DOCUMENT_FORMAT_VERSION, objects: raw.objects }),
    ).toThrow();

    raw.objects[0]!.components[0]!.data.sprite = { column: 0.5, row: 0 };
    expect(() =>
      parseSceneFile({ formatVersion: DOCUMENT_FORMAT_VERSION, objects: raw.objects }),
    ).toThrow();
  });
});

describe("推送用的解析：切分随载荷走", () => {
  it("对象那份图片上补出 spriteGrid；引用的图不在索引里时按整图（不加）", () => {
    const metas = imageMetas(sheetOf(4, 4));
    const scene = mutateScene(sceneWith([spriteObject()]), (draft) => {
      setObjectSprite(draft, "sprite-1", { column: 1, row: 2 });
    });

    expect(resolveSceneSprites(scene, metas).objects[0]!.components).toEqual([
      {
        id: "sprite-1__SpriteLayer",
        type: "SpriteLayer",
        data: { ...IMAGE, sprite: { column: 1, row: 2 }, spriteGrid: sheetOf(4, 4), sortingOrder: 0 },
      },
    ]);

    // 整图（没有引用）：一个字节都不多，载荷与 v9 完全一样
    const plain = sceneWith([spriteObject()]);
    expect(resolveSceneSprites(plain, metas)).toBe(plain);
  });

  it("素材改过名：载荷里写索引里的**当前路径**，guid 不下发", () => {
    const renamedId = "project:C/Assets/images/A/B/C/D.png";
    const metas = metasFor(renamedId, IMAGE_GUID, sheetOf(2, 1));
    const scene = mutateScene(
      sceneWith([spriteObject("sprite-1", { ...IMAGE, guid: IMAGE_GUID })]),
      (draft) => {
        setObjectSprite(draft, "sprite-1", { column: 1, row: 0 });
      },
    );

    const resolved = resolveSceneSprites(scene, metas);
    expect(resolved.objects[0]!.components[0]!.data).toEqual({
      id: renamedId,
      width: 400,
      height: 300,
      sprite: { column: 1, row: 0 },
      spriteGrid: sheetOf(2, 1),
      sortingOrder: 0,
    });
    // 载荷只有路径 ID 这一种身份（协议与前端都不认 guid）
    expect(JSON.stringify(resolved)).not.toMatch(/guid/);
  });

  it("越界的格子在推送时夹到最后一格（协议会拒越界值）", () => {
    const scene = mutateScene(sceneWith([spriteObject()]), (draft) => {
      setObjectSprite(draft, "sprite-1", { column: 9, row: 9 });
    });

    const resolved = resolveSceneSprites(scene, imageMetas(sheetOf(2, 3)));
    const data = resolved.objects[0]!.components[0]!.data as Record<string, unknown>;
    expect(data.sprite).toEqual({ column: 1, row: 2 });
    expect(data.spriteGrid).toEqual({ columns: 2, rows: 3 });
  });

  it("地图贴图上误写的引用在载荷里被摘掉（前端不会收到它）", () => {
    const map = createMapObject({
      id: "map-1",
      name: "网格地图",
      image: { ...IMAGE, sprite: { column: 1, row: 0 } },
      grid: { width: 8, height: 6 },
    });

    const resolved = resolveSceneSprites(sceneWith([map]), imageMetas(sheetOf(4, 4)));
    const data = resolved.objects[0]!.components[0]!.data as { image: Record<string, unknown> };
    expect(data.image).toEqual(IMAGE);
    expect(JSON.stringify(resolved)).not.toMatch(/spriteGrid/);
  });

  it("不改输入文档：解析出来的是新对象，原文档一个字段都没多", () => {
    const metas = imageMetas(sheetOf(4, 4));
    const scene = mutateScene(sceneWith([spriteObject()]), (draft) => {
      setObjectSprite(draft, "sprite-1", { column: 0, row: 1 });
    });
    const before = JSON.stringify(scene);

    resolveSceneSprites(scene, metas);
    expect(JSON.stringify(scene)).toBe(before);
  });
});

describe("校验：只提醒，不算错", () => {
  it("格子超出切分 → warning（按最后一格显示）；没传索引就不查这条", () => {
    const scene = mutateScene(sceneWith([spriteObject()]), (draft) => {
      setObjectSprite(draft, "sprite-1", { column: 3, row: 3 });
    });

    const issues = validateScene(scene, { metas: imageMetas(sheetOf(2, 2)) });
    expect(formatIssues(issues)).toMatch(/超出这张图的切分 2×2/);
    expect(validateScene(scene).map((issue) => issue.message).join()).not.toMatch(/切分/);
  });

  it("按 guid 查切分：素材改过名也照样查得出越界", () => {
    const scene = mutateScene(
      sceneWith([spriteObject("sprite-1", { ...IMAGE, guid: IMAGE_GUID })]),
      (draft) => {
        setObjectSprite(draft, "sprite-1", { column: 3, row: 0 });
      },
    );

    const metas = metasFor("project:C/Assets/images/A/B/C/D.png", IMAGE_GUID, sheetOf(2, 2));
    expect(formatIssues(validateScene(scene, { metas }))).toMatch(/超出这张图的切分 2×2/);
  });

  it("地图贴图带了 sprite → warning（会被忽略）", () => {
    const map = createMapObject({
      id: "map-1",
      name: "网格地图",
      image: { ...IMAGE, sprite: { column: 1, row: 0 } },
      grid: { width: 8, height: 6 },
    });

    expect(formatIssues(validateScene(sceneWith([map])))).toMatch(/地图贴图不支持子图/);
  });
});

/**
 * v20 → v21：**精灵的图片组件从 `TextureRenderer` 改名成 `SpriteLayer`**。
 *
 * 这一条是 v21 唯一一处会**动老文件里的数据**的迁移，所以两件事都要钉住：
 * 组件名字换对（否则精灵与贴图两种形状长期共存），**组件 id 也跟着换**
 * （组件 id 的规范是 `<对象 id>__<组件类型>`；只改类型不改 id 的话，编辑器下一次写这个组件时
 * 按新名字找不到旧实例、会**多补一个**，对象上就挂了两份图）。
 */
describe("v21 迁移：图片组件改名（按 kind）", () => {
  /** 一个 v20 形状的精灵：kind=SceneObject（那时精灵复用这个名字）+ 旧组件名 `TextureRenderer`。 */
  const legacySprite = (id: string, data: Record<string, unknown>): Record<string, unknown> => ({
    id,
    name: "精灵",
    kind: "SceneObject",
    active: true,
    sortingOrder: 0,
    locked: false,
    position: { x: 0, y: 0 },
    rotation: 0,
    scale: 1,
    components: [{ id: `${id}__TextureRenderer`, type: "TextureRenderer", data, actions: [] }],
  });

  const load = (objects: readonly Record<string, unknown>[]) =>
    parseSceneFile({ formatVersion: 20, objects: [...objects] });

  it("精灵的 TextureRenderer → SpriteLayer，组件 id 与类型一起换；图与格子照旧", () => {
    const loaded = load([
      legacySprite("obj_1", { id: IMAGE_ID, width: 64, height: 64, sprite: { column: 1, row: 0 } }),
    ]);

    const object = loaded.file.objects[0]!;
    expect(object.components.map((item) => item.type)).toEqual(["SpriteLayer"]);
    expect(object.components[0]?.id).toBe("obj_1__SpriteLayer");
    expect(imageOf(object)).toEqual({
      id: IMAGE_ID,
      width: 64,
      height: 64,
      sprite: { column: 1, row: 0 },
    });
    // 版本号升到 21，所以要回写一次
    expect(loaded.needsRewrite).toBe(true);
    expect(loaded.file.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
  });

  it("Player / Item / Event 上的 TextureRenderer → ImageLayer：组件 id 与类型一起换", () => {
    // v19 时 `image` 特性的 kinds 含 Player / Item / Event（旧编辑器对它们也开放渲染分组），
    // 所以老工程里这些 kind 可能挂着 `TextureRenderer`——它们不是精灵，得进 `ImageLayer`。
    const entity = (id: string, kind: string): Record<string, unknown> => ({
      id,
      name: kind,
      kind,
      active: true,
      sortingOrder: 0,
      locked: false,
      position: { x: 0, y: 0 },
      rotation: 0,
      scale: 1,
      components: [{ id: `${id}__TextureRenderer`, type: "TextureRenderer", data: { id: IMAGE_ID, width: 64, height: 64 }, actions: [] }],
    });

    const loaded = load([
      entity("player_1", "Player"),
      entity("item_1", "Item"),
      entity("event_1", "Event"),
    ]);

    for (const [index, id] of ["player_1", "item_1", "event_1"].entries()) {
      const object = loaded.file.objects[index]!;
      expect(object.components.map((item) => item.type)).toEqual(["ImageLayer"]);
      expect(object.components[0]?.id).toBe(`${id}__ImageLayer`);
      // 图数据照旧，没丢
      expect(imageOf(object)).toEqual({ id: IMAGE_ID, width: 64, height: 64 });
    }
    expect(loaded.needsRewrite).toBe(true);
  });

  it("不在 image 特性 kinds 里的 kind：TextureRenderer 原样留着（不替它猜归属）", () => {
    // 未知组件类型有宽松分支（手写自定义组件读得回来），所以这里不会读不开——
    // 迁移的承诺只是「不碰它」，把它留给用户自己处理。
    const sound = {
      id: "sound_1",
      name: "声音",
      kind: "PlaySound",
      active: true,
      sortingOrder: 0,
      locked: false,
      position: { x: 0, y: 0 },
      rotation: 0,
      scale: 1,
      components: [
        {
          id: "sound_1__TextureRenderer",
          type: "TextureRenderer",
          data: { id: IMAGE_ID, width: 64, height: 64 },
          actions: [],
        },
      ],
    };

    const loaded = load([sound]);
    expect(loaded.file.objects[0]!.components.map((item) => item.type)).toEqual([
      "TextureRenderer",
    ]);
    expect(loaded.file.objects[0]!.components[0]?.id).toBe("sound_1__TextureRenderer");
    // 读得开（宽松分支）；回写只是因为版本号 v20 → v21，迁移本身没改这个组件
    expect(loaded.needsRewrite).toBe(true);
  });

  it("改名只认 image 特性的 kind：地图的 GridMap 一个字节都不动", () => {
    const map = {
      id: "map_1",
      name: "地图",
      kind: "Map",
      active: true,
      sortingOrder: -10,
      locked: false,
      position: { x: 0, y: 0 },
      rotation: 0,
      scale: 1,
      components: [
        {
          id: "map_1__GridMap",
          type: "GridMap",
          data: {
            image: { id: IMAGE_ID, width: 100, height: 100 },
            grid: { width: 2, height: 2 },
            rowOrder: "bottom-up",
            cells: { encoding: "rle", runs: [[0, 4]] },
          },
          actions: [],
        },
      ],
    };

    const loaded = load([legacySprite("obj_1", { id: IMAGE_ID, width: 64, height: 64 }), map]);
    expect(loaded.file.objects[1]!.components.map((item) => item.type)).toEqual(["GridMap"]);
    expect(loaded.file.objects[1]!.components[0]?.id).toBe("map_1__GridMap");
  });

  it("幂等：已经叫 SpriteLayer 的文件再读一遍不会多出实例", () => {
    const once = parseSceneFile({
      formatVersion: DOCUMENT_FORMAT_VERSION,
      objects: [...load([legacySprite("obj_1", { id: IMAGE_ID, width: 64, height: 64 })]).file.objects],
    });
    const twice = parseSceneFile(JSON.parse(JSON.stringify(once.file)) as unknown);

    expect(twice.file.objects[0]!.components).toHaveLength(1);
    expect(twice.file.objects[0]!.components[0]?.type).toBe("SpriteLayer");
    expect(twice.file.objects[0]!.components[0]?.id).toBe("obj_1__SpriteLayer");
    // 已经是当前版本、也没有别的要补 → 不需要再回写
    expect(twice.needsRewrite).toBe(false);
  });

  it("v18 那种扁平 `image` 字段：按 kind 路由到精灵那一份组件（不是贴图那一份）", () => {
    // kind 写的是**那时候的名字** `SceneObject`（v22 才改叫 `Sprite`）：老文件里两个迁移
    // 叠在一起——先改 kind、再按 kind 挑组件名，挑错就会把精灵的图搬进贴图的 `ImageLayer`
    const loaded = parseSceneFile({
      formatVersion: 18,
      objects: [
        {
          id: "obj_2",
          name: "精灵2",
          kind: "SceneObject",
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: 1,
          image: { id: IMAGE_ID, width: 32, height: 32 },
        },
      ],
    });

    expect(loaded.file.objects[0]!.components.map((item) => item.type)).toEqual(["SpriteLayer"]);
    expect(loaded.file.objects[0]!.kind).toBe("Sprite");
  });
});

/**
 * v21 → v22：**两种实体的 kind 改名**——贴图 `Texture` → `Image`、精灵 `SceneObject` → `Sprite`。
 *
 * 纯改名（数据形状一个字没动），所以这一组只钉三件事：两个老值换对、**别的地方一个字节不碰**、
 * 幂等。真正的风险不在改名本身，而在**它必须排在按 kind 路由的那两条迁移前面**——
 * 那一条由上面「v18 扁平字段」与「v20 图片组件改名」两个用例兜着。
 */
describe("v22 迁移：kind 改名（Texture → Image / GameObject → Sprite）", () => {
  const load = (objects: readonly Record<string, unknown>[], formatVersion = 21) =>
    parseSceneFile({ formatVersion, objects: [...objects] });

  /** 一个只有基础字段的对象（组件由各用例自己给）。 */
  const bare = (id: string, kind: string, components: readonly Record<string, unknown>[] = []) => ({
    id,
    name: kind,
    kind,
    active: true,
    sortingOrder: 0,
    locked: false,
    position: { x: 0, y: 0 },
    rotation: 0,
    scale: 1,
    components: [...components],
  });

  it("精灵 SceneObject → Sprite、贴图 Texture → Image，并回写一次", () => {
    const loaded = load([bare("obj_1", "SceneObject"), bare("obj_2", "Texture")]);

    expect(loaded.file.objects.map((object) => object.kind)).toEqual(["Sprite", "Image"]);
    expect(loaded.needsRewrite).toBe(true);
    expect(loaded.file.formatVersion).toBe(DOCUMENT_FORMAT_VERSION);
  });

  it("其余 kind 与手写怪值原样不动（怪值照旧被枚举挡住，不给它猜一个新归属）", () => {
    const known = load([
      bare("map_1", "Map"),
      bare("player_1", "Player"),
      bare("item_1", "Item"),
      bare("event_1", "Event"),
      bare("sound_1", "PlaySound"),
      bare("teleport_1", "Teleport"),
    ]);
    expect(known.file.objects.map((object) => object.kind)).toEqual([
      "Map",
      "Player",
      "Item",
      "Event",
      "PlaySound",
      "Teleport",
    ]);

    expect(() => load([bare("portal_1", "Portal")])).toThrow(/场景文件校验失败/);
  });

  it("只换 kind 这一个字段：组件与图片数据一个字节不动（v21 形状的文件）", () => {
    const loaded = load([
      bare("obj_1", "SceneObject", [
        {
          id: "obj_1__SpriteLayer",
          type: "SpriteLayer",
          data: { id: IMAGE_ID, width: 64, height: 64, sprite: { column: 1, row: 0 } },
          actions: [],
        },
        // v21 起视频那一组的宿主是贴图，但**旧文件里精灵身上这一份不删**（不静默改用户数据）
        {
          id: "obj_1__VideoOverlay",
          type: "VideoOverlay",
          data: { enabled: true, clips: ["project:C/Assets/video/open.mp4"], picked: "project:C/Assets/video/open.mp4" },
          actions: [],
        },
      ]),
    ]);

    const object = loaded.file.objects[0]!;
    expect(object.kind).toBe("Sprite");
    expect(object.components.map((component) => component.type)).toEqual([
      "SpriteLayer",
      "VideoOverlay",
    ]);
    expect(imageOf(object)).toEqual({
      id: IMAGE_ID,
      width: 64,
      height: 64,
      sprite: { column: 1, row: 0 },
    });
  });

  it("幂等：现行值再读一遍不改、也不需要回写", () => {
    const once = load([bare("obj_1", "SceneObject"), bare("obj_2", "Texture")]);
    const twice = parseSceneFile(JSON.parse(JSON.stringify(once.file)) as unknown);

    expect(twice.file.objects.map((object) => object.kind)).toEqual(["Sprite", "Image"]);
    expect(twice.needsRewrite).toBe(false);
  });
});
