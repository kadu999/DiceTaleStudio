import type { ImageSize } from "@dts/grid";
import { imageOf, mapDataOf } from "./access";
import type { AssetMetaDoc, AssetMetas } from "./asset-meta";
import { findComponentType } from "./components";
import type {
  ImageRef,
  ImageSpriteRef,
  ResolvedSprite,
  SceneDoc,
  GameObjectDoc,
  SpriteSheetDoc,
} from "./types";

/**
 * **精灵（子图）**的全部知识都在这一个文件里：一张图怎么切、对象取哪一格、
 * 那一格在图片里的哪块矩形、在画布上要画多大。
 *
 * 「精灵 = 纹理 + 一块矩形」（Unity 也是这么定义 Sprite 的），而这个仓库里
 * **切分只有一份、矩形一像素都不存**：
 *
 * - 切分住在**素材自己的 `.meta`** 里（v23 起；v22 及更早住在工程文件的 `spriteSheets`），
 *   调用方把它读成索引 `AssetMetas` 交进来，这里**按引用查**（guid 优先、路径兜底）；
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

/** 缺省切分：**整图**（1×1）。meta 里没写 `sheet` = 这一份，所以这种值不写进文件。 */
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
 * 一份「按引用查 meta」的最小输入：对象身上的 `ImageRef` 与只知道 id 的调用方都合用。
 *
 * 有 `guid` 就以它为准（素材改过名时 `id` 是旧路径）；没有就按 `id` 兜底（老文件）。
 */
type ImageLookup = { readonly guid?: string; readonly id?: string };

/**
 * 按引用查 meta：**先 guid、再 id**。
 *
 * `asset-meta.ts` 的 `metaOfImage` 是同一条口径，但那边是**上一层**（它要 import 这里的
 * 切分工具），反向 import 会成环——所以这三行在这里就地写一遍，两处都是「先 guid 再 id」。
 */
function metaOf(metas: AssetMetas, image: ImageLookup | undefined): AssetMetaDoc | undefined {
  if (image === undefined) {
    return undefined;
  }

  const byGuid = image.guid === undefined ? undefined : metas.byGuid[image.guid];
  return byGuid ?? (image.id === undefined ? undefined : metas.byId[image.id]);
}

/**
 * 这张图的切分（**没有 meta / 没开精灵 / 没切时就是整图**）。
 *
 * 「没有表项 = 1×1」这条语义只在这里判：调用方一律拿一份合法的 `SpriteSheetDoc`，
 * 不必到处 `?? DEFAULT_SPRITE_SHEET`。
 */
export function spriteSheetOf(metas: AssetMetas, image: ImageLookup | undefined): SpriteSheetDoc {
  const sheet = metaOf(metas, image)?.sprite?.sheet;
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
  metas: AssetMetas,
): ResolvedSprite | undefined {
  const sprite = image?.sprite;
  if (image === undefined || sprite === undefined) {
    return undefined;
  }

  const sheet = spriteSheetOf(metas, image);
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
  object: GameObjectDoc,
  metas: AssetMetas,
): ResolvedSprite | undefined {
  // 带网格的贴图的格子按整张贴图算：取一块会让已有标注的含义静默改变
  if (mapDataOf(object) !== undefined) {
    return undefined;
  }

  return resolvedSpriteOf(imageOf(object), metas);
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
 * 推送时写进载荷的**路径 ID**：有 guid 就以索引里的路径为准。
 *
 * `ImageRef.id` 只是「上次见到的路径」：素材与 `.meta` 成对改名之后它已经过期，而 guid
 * 还是对的——`byId` 的键就是当前路径（`createAssetMetas` 那两向索引指向同一份 meta），
 * 所以反查一次即得。名字没改时 `byId[id]` 就是那一份，不必扫（改名是少数）。
 */
function payloadIdOf(metas: AssetMetas, image: ImageRef): string {
  if (image.guid === undefined) {
    return image.id;
  }

  const meta = metaOf(metas, image);
  if (meta === undefined || metas.byId[image.id] === meta) {
    return image.id;
  }

  for (const [id, candidate] of Object.entries(metas.byId)) {
    if (candidate === meta) {
      return id;
    }
  }

  // 索引里只有 guid 那一份（这张图没进 byId）：路径无从得知，保留引用上写的那个
  return image.id;
}

/**
 * 把场景解析成**推给前端的那一份**：对象身上的子图引用多一项 `spriteGrid`（这张图几列几行）。
 *
 * 为什么要在推送时解析：切分在编辑器这边**只有一份**（素材自己的 `.meta`），而前端
 * 手上没有 `.meta`——所以「几行几列」必须随载荷走。这是「文档 → 线上形状」的**唯一**转换点：
 * 载荷与文档的差别只有两处，其余逐字相同（协议包的 `sceneSchema` 因此也只是把
 * `imageRefSchema` 多写一项 `spriteGrid`，两份 schema 仍然对得上）：
 *
 * - **多一项** `spriteGrid`（几行几列）；
 * - **少一项** `guid`、并把 `id` 写成索引里的当前路径——协议与前端只认路径 ID，
 *   所以 guid 在这里换算回路径下发（这正是「wire 保持路径 ID」那条口径的落点）。
 *
 * 两件事在这里做干净：
 * - **夹格子**：切分被改小之后，老对象可能指向越界的格子——推送时统一夹到最后一格
 *   （协议 schema 会拒越界值，前端也不必自己防）；
 * - **摘掉地图贴图上的误写**：地图的格子按整张贴图算，子图引用会被两边忽略
 *   （编辑器画布走 `displaySpriteOf`）——这里顺手从载荷里摘掉，免得前端收到一个它不该理会的字段。
 *
 * 返回的是**新对象**（不改输入文档）：推送路径上同时要文本比对，按值比较才不会产生假变更。
 */
export function resolveSceneSprites(scene: SceneDoc, metas: AssetMetas): SceneDoc {
  let changed = false;
  const objects = scene.objects.map((object) => {
    const withImage = resolveObjectImageSprites(object, metas);
    const withMagnifier = resolveMagnifierSprites(withImage, metas);
    changed ||= withMagnifier !== object;
    return withMagnifier;
  });

  return changed ? { ...scene, objects } : scene;
}

/**
 * **对象自己那张图**的子图引用（`ImageLayer` / `SpriteLayer`）——上面的主转换里的一趟。
 *
 * 两件事在这里做干净：
 * - **夹格子**：切分被改小之后，老对象可能指向越界的格子——推送时统一夹到最后一格
 *   （协议 schema 会拒越界值，前端也不必自己防）；
 * - **摘掉地图贴图上的误写**：地图的格子按整张贴图算，子图引用会被两边忽略
 *   （编辑器画布走 `displaySpriteOf`）——这里顺手从载荷里摘掉，免得前端收到一个它不该理会的字段。
 */
function resolveObjectImageSprites(object: GameObjectDoc, metas: AssetMetas): GameObjectDoc {
  // 对象自己那份图片的子图（带网格的贴图一律没有——`displaySpriteOf` 是那条口径的唯一判据）
  const sprite = displaySpriteOf(object, metas);
  const image = imageOf(object);
  // 带网格的贴图不该有子图：手写文件里误写了一个时，顺手从载荷里摘掉
  const stripGridSprite = mapDataOf(object) !== undefined && image?.sprite !== undefined;
  if (sprite === undefined && !stripGridSprite) {
    return object;
  }

  const components = object.components.map((component) => {
    // 图片槽位有两种组件（精灵 `SpriteLayer` / 贴图 `ImageLayer`）——**有格子要写回的那个**
    // 只可能是其中实际存在的那一种，所以按组件自报的 slot 匹配，不再按 kind 判一次
    if (findComponentType(component.type)?.slot !== "image" || image === undefined) {
      return component;
    }

    // 显示顺序住在图片层数据里（v26）：这里整份重写 data，必须带上它，否则推送一份
    // 就把它抹成缺省 0（与 `setObjectImage` 的写洞同一类）。guid 不下发（载荷只有路径 ID）。
    const sortingOrder = (component.data as { sortingOrder?: number }).sortingOrder;
    const base = {
      id: payloadIdOf(metas, image),
      width: image.width,
      height: image.height,
      ...(sortingOrder === undefined ? {} : { sortingOrder }),
    };

    // 带网格的贴图上的误写子图：摘掉（格子按整张算）
    if (sprite === undefined) {
      return { ...component, data: base };
    }

    // 格子按解析结果写回（越界的已夹），切分一并带上；路径按索引里的当前值写、
    // guid 不下发（载荷只有路径 ID 这一种身份）
    return {
      ...component,
      data: {
        ...base,
        sprite: { column: sprite.column, row: sprite.row },
        spriteGrid: { columns: sprite.columns, rows: sprite.rows },
      },
    };
  });

  return { ...object, components };
}

/**
 * **放大镜（v30）的图片列表**：逐条把「第几格」解析成 `sprite` + `spriteGrid`——上面的主转换里的一趟。
 *
 * 与图片层那一条同一套理由（切分只有一份、住在素材 `.meta` 里，前端手上没有它，所以必须随载荷
 * 走、越界的格子在这里统一夹）。差别只有一处：列表项**没有 `sortingOrder`**（它不渲染在世界里，
 * 是弹出来的一扇窗），所以不需要图片层那份「整份重写、别把显示顺序抹掉」的小心。
 */
function resolveMagnifierSprites(object: GameObjectDoc, metas: AssetMetas): GameObjectDoc {
  const component = object.components.find((item) => findComponentType(item.type)?.slot === "magnifier");
  const images = component === undefined ? undefined : (component.data as { images?: unknown }).images;
  if (component === undefined || !Array.isArray(images)) {
    return object;
  }

  let changed = false;
  const next = images.map((item) => {
    if (typeof item !== "object" || item === null) {
      return item;
    }

    const payload = payloadImageOf(item as ImageRef, metas);
    if (payload === null) {
      return item;
    }

    changed = true;
    return payload;
  });

  if (!changed) {
    return object;
  }

  return {
    ...object,
    components: object.components.map((item) =>
      item === component ? { ...item, data: { ...item.data, images: next } } : item,
    ),
  };
}

/**
 * 把一份图片引用改写成**载荷形状**：`id` 用索引里的当前路径、摘掉 `guid`（载荷只有路径 ID 这
 * 一种身份）、有格子时补上 `spriteGrid`（几行几列，越界的已夹）。
 *
 * 已经是载荷形状时返回 `null`——推送路径上要按值比对，别每次造一堆等价的新对象
 * （与 `resolveObjectImageSprites` 开头那两个提前返回同一条取舍）。
 */
function payloadImageOf(image: ImageRef, metas: AssetMetas): Record<string, unknown> | null {
  const sprite = resolvedSpriteOf(image, metas);
  const id = payloadIdOf(metas, image);
  const cell = sprite === undefined ? undefined : { column: sprite.column, row: sprite.row };
  const grid = sprite === undefined ? undefined : { columns: sprite.columns, rows: sprite.rows };
  const current = image as unknown as Record<string, unknown>;

  if (
    id === image.id &&
    current.guid === undefined &&
    samePlainObject(current.sprite, cell) &&
    samePlainObject(current.spriteGrid, grid)
  ) {
    return null;
  }

  return {
    id,
    width: image.width,
    height: image.height,
    ...(cell === undefined ? {} : { sprite: cell, spriteGrid: grid }),
  };
}

/** 两个「小对象」逐键相同（`undefined` 与缺失同义）——只用来判「载荷要不要重写」。 */
function samePlainObject(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }

  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] !== b[key]) {
      return false;
    }
  }

  return true;
}
