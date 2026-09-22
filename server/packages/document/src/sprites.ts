import type { ImageSize } from "@dts/grid";
import { imageOf, mapDataOf } from "./access";
import { FEATURE_COMPONENT, carriesFeatureComponent, carriesKind } from "./features";
import type {
  ImageRef,
  ImageSpriteRef,
  ProjectDoc,
  ResolvedSprite,
  SceneDoc,
  SceneObjectDoc,
  SpriteSheetDoc,
} from "./types";

/**
 * **精灵（子图）**的全部知识都在这一个文件里：一张图怎么切、对象取哪一格、
 * 那一格在图片里的哪块矩形、在画布上要画多大。
 *
 * 「精灵 = 纹理 + 一块矩形」（Unity 也是这么定义 Sprite 的），而这个仓库里
 * **切分只有一份、矩形一像素都不存**：
 *
 * - 切分住在工程文件（`ProjectDoc.spriteSheets`，key = 图片逻辑 ID）；
 * - 对象只存「引用哪张图 + 第几格」（`ImageRef.sprite`），改切分 = 所有引用它的对象一起变；
 * - 矩形由**格序数 ÷ 加载到的纹理尺寸**算出来——编辑器画布与前端各算一次，
 *   两侧不可能各差一像素（存像素就会和事实不一致，与 `GridSpec` 不存 `cellSize` 同一条规矩）。
 *
 * 两个口径在这里定死，别处不要再各写一遍：
 *
 * 1. **格序数从左上数**（`column: 0` = 最左、`row: 0` = 最上），对齐 Unity 的 Sprite Editor。
 *    它与 `GridMap` 的 `rowOrder: "bottom-up"` 无关——那是「网格坐标系锚在哪」，
 *    这里是「第几个格子」，序数只有从左上数这一种读法。
 * 2. **归一化矩形一律左上角为原点、y 向下**（与 canvas `drawImage` 同向）。整条链路上
 *    只有一次 y 翻转，在 Unity 的 `ImageLayer` / `SpriteLayer`（把 UV 的 v 翻过来）——这里不翻。
 *
 * 地图贴图（`map.image`）**不支持子图**：地图的格子是按整张贴图算好的，「取一块」会让
 * 已有格子标注的含义静默改变（`validateScene` 会警告，`displaySpriteOf` 直接不认）。
 */

/**
 * 一张图最多切多少格子（列与行各自的上限）。
 *
 * 再密就没有「一格」可言了（4096 的图切 64 列 = 每格 64px，已经是像素画的粒度），
 * 而且属性面板与预览要给得出可点的格子。
 */
export const SPRITE_SHEET_MAX = 64;

/** 缺省切分：**整图**（1×1）。没有表项 = 这一份，所以这种表项不写进工程文件。 */
export const DEFAULT_SPRITE_SHEET: SpriteSheetDoc = { columns: 1, rows: 1 };

/**
 * 归一化一份切分：取整 + 夹到 `1..SPRITE_SHEET_MAX`。
 *
 * 手写文件（或界面上敲进来的数字）可能是小数 / 0 / 超大值：坏数字不该让整张图集画不出来，
 * 这里统一收成合法值；**语义上的错**（1×1 的多余表项、越界的格子）由 `validateProject` /
 * `validateScene` 报 warning。
 */
export function normalizeSpriteSheet(sheet: SpriteSheetDoc): SpriteSheetDoc {
  return {
    columns: clampInt(sheet.columns, 1, SPRITE_SHEET_MAX),
    rows: clampInt(sheet.rows, 1, SPRITE_SHEET_MAX),
  };
}

/** `1×1` = 整图：这种表项**不写**（与 `video` / `audioMeta` 同一个「不留空壳」口径）。 */
export function isTrivialSpriteSheet(sheet: SpriteSheetDoc): boolean {
  return sheet.columns <= 1 && sheet.rows <= 1;
}

/**
 * 这张图的切分（**没有表项 / 没打开项目时就是整图**）。
 *
 * 「没有表项 = 1×1」这条语义只在这里判：调用方一律拿一份合法的 `SpriteSheetDoc`，
 * 不必到处 `?? DEFAULT_SPRITE_SHEET`。
 */
export function spriteSheetOf(
  spriteSheets: ProjectDoc["spriteSheets"],
  imageId: string,
): SpriteSheetDoc {
  const sheet = spriteSheets?.[imageId];
  return sheet === undefined ? DEFAULT_SPRITE_SHEET : normalizeSpriteSheet(sheet);
}

/** 把一格夹到切分范围内（越界 → 最后一格）。负数 / 小数一并收干净。 */
export function clampSpriteCell(cell: ImageSpriteRef, sheet: SpriteSheetDoc): ImageSpriteRef {
  const columns = Math.max(1, sheet.columns);
  const rows = Math.max(1, sheet.rows);
  return {
    column: clampInt(cell.column, 0, columns - 1),
    row: clampInt(cell.row, 0, rows - 1),
  };
}

/**
 * 解析一个图片引用：**有 `sprite` 才有返回值**（没有 = 整张图）。
 *
 * 返回的是「几行几列 + 第几格（已夹取）」——协议载荷与编辑器画布都要的那一份形状。
 */
export function resolvedSpriteOf(
  image: ImageRef | undefined,
  spriteSheets: ProjectDoc["spriteSheets"],
): ResolvedSprite | undefined {
  const sprite = image?.sprite;
  if (image === undefined || sprite === undefined) {
    return undefined;
  }

  const sheet = spriteSheetOf(spriteSheets, image.id);
  const cell = clampSpriteCell(sprite, sheet);
  return { columns: sheet.columns, rows: sheet.rows, column: cell.column, row: cell.row };
}

/**
 * 这个对象**实际要画的**子图（没有子图 / 是地图对象时 `undefined`）。
 *
 * 「地图贴图不支持子图」只有这一处判据——编辑器画布、推送载荷、校验三处都走它，
 * 于是手写文件里给地图写了一个 `sprite` 时，编辑器与前端的行为**一致**（都当整图），
 * 不会出现「编辑器画的是裁过的一块、前端铺的是整张」这种对不上的半套状态。
 */
export function displaySpriteOf(
  object: SceneObjectDoc,
  spriteSheets: ProjectDoc["spriteSheets"],
): ResolvedSprite | undefined {
  // 地图的贴图住在 GridMap 里，格子按整张贴图算：取一块会让已有标注的含义静默改变
  if (carriesKind(FEATURE_COMPONENT.map, object.kind)) {
    return undefined;
  }

  return resolvedSpriteOf(imageOf(object), spriteSheets);
}

/**
 * 子图在图片里的**归一化矩形**（左上角原点、y 向下，与 canvas 同向）。
 *
 * 除法是**归一化**的（每个格子恰好 `1/columns`、`1/rows`），不取整像素：图片尺寸不是行列的
 * 整数倍时（100px 切 3 列），编辑器画布与前端算出来的是同一块，不会各差一像素。
 */
export function spriteUvRectOf(sprite: ResolvedSprite): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} {
  return {
    x: sprite.column / sprite.columns,
    y: sprite.row / sprite.rows,
    width: 1 / sprite.columns,
    height: 1 / sprite.rows,
  };
}

/**
 * 子图在图片里的**像素矩形**（画布 `drawImage` 的源矩形）。左上角原点、y 向下。
 *
 * `image` 是**实际加载到的那张图**的尺寸（编辑器里是 `<img>` 的自然尺寸）：真实像素说了算，
 * 声明的 `ImageRef.width/height` 只决定「画多大」。
 */
export function spritePixelRectOf(
  sprite: ResolvedSprite,
  image: ImageSize,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const uv = spriteUvRectOf(sprite);
  return {
    x: uv.x * image.width,
    y: uv.y * image.height,
    width: uv.width * image.width,
    height: uv.height * image.height,
  };
}

/**
 * 一格的**声明尺寸**（像素，四舍五入）：挑图时写进 `ImageRef.width/height`。
 *
 * 只有这一处算它：画布上「对象多大」由声明尺寸决定，而重切**不会**回头改已放好的对象
 * （那要同时改场景与工程两条撤销轨道）——所以选格那一刻算出来的这个数字才是场景数据。
 */
export function spriteCellSizeOf(
  sheet: SpriteSheetDoc,
  image: ImageSize,
): { readonly width: number; readonly height: number } {
  const columns = Math.max(1, sheet.columns);
  const rows = Math.max(1, sheet.rows);
  return {
    width: Math.max(1, Math.round(image.width / columns)),
    height: Math.max(1, Math.round(image.height / rows)),
  };
}

/**
 * 预览图上某个比例位置落在**哪一格**（点击选格用；`fraction` 是 0..1，左上角为原点）。
 *
 * 与 `spriteUvRectOf` 是同一套除法的逆运算，所以「点哪一格」与「画哪一块」永远对得上；
 * 越界（点在边框上、外面）由 `clampSpriteCell` 收进最后一格。
 */
export function spriteCellAtFraction(
  fraction: { readonly x: number; readonly y: number },
  sheet: SpriteSheetDoc,
): ImageSpriteRef {
  const normalized = normalizeSpriteSheet(sheet);
  return clampSpriteCell(
    {
      column: Math.floor(fraction.x * normalized.columns),
      row: Math.floor(fraction.y * normalized.rows),
    },
    normalized,
  );
}

/** 整数化 + 夹到 `min..max`（非有限数值当 `min` 处理，坏数据不该把渲染带崩）。 */
function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

// ---------------------------------------------------------------- 推送用的解析

/**
 * 把场景解析成**推给前端的那一份**：对象身上的子图引用多一项 `spriteGrid`（这张图几列几行）。
 *
 * 为什么要在推送时解析：切分在编辑器这边**只有一份**（工程文件的 `spriteSheets`），而前端
 * 手上没有工程文件——所以「几行几列」必须随载荷走。这是「文档 → 线上形状」的**唯一**转换点：
 * 载荷与文档的差别只有 `spriteGrid` 这一项，其余逐字相同（协议包的 `sceneSchema` 因此也
 * 只是把 `imageRefSchema` 多写一项，两份 schema 仍然对得上）。
 *
 * 两件事在这里做干净：
 * - **夹格子**：切分被改小之后，老对象可能指向越界的格子——推送时统一夹到最后一格
 *   （协议 schema 会拒越界值，前端也不必自己防）；
 * - **摘掉地图贴图上的误写**：地图的格子按整张贴图算，子图引用会被两边忽略
 *   （编辑器画布走 `displaySpriteOf`）——这里顺手从载荷里摘掉，免得前端收到一个它不该理会的字段。
 *
 * 返回的是**新对象**（不改输入文档）：推送路径上同时要文本比对，按值比较才不会产生假变更。
 */
export function resolveSceneSprites(
  scene: SceneDoc,
  spriteSheets: ProjectDoc["spriteSheets"],
): SceneDoc {
  let changed = false;
  const objects = scene.objects.map((object) => {
    // 对象自己那份图片的子图（地图对象一律没有——`displaySpriteOf` 是那条口径的唯一判据）
    const sprite = displaySpriteOf(object, spriteSheets);
    const mapSprite = mapDataOf(object)?.image.sprite;
    if (sprite === undefined && mapSprite === undefined) {
      return object;
    }

    changed = true;
    const components = object.components.map((component) => {
      // 图片有两种组件（精灵 `SpriteLayer` / 贴图 `ImageLayer`）——**有格子要写回的那个**
      // 只可能是其中实际存在的那一种，所以按组件名匹配，不再按 kind 判一次
      if (carriesFeatureComponent("image", component.type) && sprite !== undefined) {
        const image = imageOf(object);
        if (image === undefined) {
          return component;
        }

        return {
          ...component,
          // 格子按解析结果写回（越界的已夹），切分一并带上
          data: {
            ...image,
            sprite: { column: sprite.column, row: sprite.row },
            spriteGrid: { columns: sprite.columns, rows: sprite.rows },
          },
        };
      }

      if (component.type === FEATURE_COMPONENT.map && mapSprite !== undefined) {
        const map = mapDataOf(object);
        if (map === undefined) {
          return component;
        }

        // 整份地图数据原样，只把贴图上那份误写的引用摘掉
        return {
          ...component,
          data: {
            ...(component.data as Record<string, unknown>),
            image: { id: map.image.id, width: map.image.width, height: map.image.height },
          },
        };
      }

      return component;
    });

    return { ...object, components };
  });

  return changed ? { ...scene, objects } : scene;
}
