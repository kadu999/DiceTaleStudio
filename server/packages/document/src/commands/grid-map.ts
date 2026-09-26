// 本文件从 `commands.ts` 拆出（纯搬运，行为不变）：地图数据、网格与标注命令。
// 战争雾自 v25 起是独立的 `FogOfWar` 组件，命令在 `fog.ts`。
import type { Draft } from "immer";
import {
  CellMask,
  applyBrushStroke,
  decodeRle,
  encodeRle,
  isInsideGrid,
  removeMask,
  type GridPoint,
  type RleRun,
} from "@dts/grid";
// 特性的读写一律走访问器（「数据存在哪个组件里」只有 access.ts 知道）
import { fogOf, mapDraftOf } from "../access";
import { fogMaskOf } from "./fog";
import { findObject } from "./shared";
import type { MapDataDoc, SceneDoc } from "../types";

// ---------------------------------------------------------------- 地图对象数据

/** 地图命令共用的开头：按 id 找对象、再取它的地图数据 draft（找不到就是 `undefined`）。 */
function mapDraftOfId(scene: Draft<SceneDoc>, mapObjectId: string): Draft<MapDataDoc> | undefined {
  const object = findObject(scene, mapObjectId);
  return object === undefined ? undefined : mapDraftOf(object);
}

/** 用新的网格数据替换地图对象的 cells。 */
export function setMapCells(
  scene: Draft<SceneDoc>,
  mapObjectId: string,
  runs: readonly RleRun[],
): boolean {
  const map = mapDraftOfId(scene, mapObjectId);
  if (map === undefined) {
    return false;
  }

  if (JSON.stringify(runs) === JSON.stringify(map.cells.runs)) {
    return false;
  }

  // RleRun 是 readonly 元组，draft 里需要可变元组，这里显式重建
  map.cells = {
    encoding: "rle",
    runs: runs.map((run) => [run[0], run[1]] as [number, number]),
  };
  return true;
}

/**
 * 清空地图对象的全部格子。
 *
 * 写回的是**一个空游程**（`[[Empty, 列×行]]`）而不是空数组：格子数据必须铺满整张网格
 * （校验与 `setMapGrid` 都按「展开格数 = 列 × 行」读），留空数组会被判成数据不完整。
 * 这也与新建地图对象时的写法一致——比较与元组重建交给 `setMapCells`，只有一处实现。
 */
export function clearMapCells(scene: Draft<SceneDoc>, mapObjectId: string): boolean {
  const map = mapDraftOfId(scene, mapObjectId);
  if (map === undefined) {
    return false;
  }

  return setMapCells(scene, mapObjectId, [[CellMask.Empty, map.grid.width * map.grid.height]]);
}

// ---------------------------------------------------------------- 战争雾（FogOfWar 组件）

// 战争雾的总开关 / 雾区绑定命令住在 `fog.ts`（v25 起雾是独立的 `FogOfWar` 组件）；
// 开关判断用 `isFogEnabled(object)`（access.ts），掩码用 `fogMaskOf(object)`（fog.ts）。

/**
 * 清空战争雾：只清掉**这个雾对象已指定的雾区位**，其它区域位原样保留。
 *
 * v27 起雾是独立对象：传入的是**雾对象 id**，清的是它引用的那张地图的格子。
 * 与 `clearMapCells` 的区别就是「只清绑定位」：一格若是「区域1 + 区域4」而只指定了区域4，
 * 清雾之后它仍是区域1 的格子。没指定任何雾区 / 引用的地图不存在时什么都不做（返回 `false`）。
 */
export function clearMapFog(scene: Draft<SceneDoc>, fogObjectId: string): boolean {
  const fogObject = findObject(scene, fogObjectId);
  if (fogObject === undefined) {
    return false;
  }

  const fogMask = fogMaskOf(fogObject);
  if (fogMask === 0) {
    return false;
  }

  // 雾引用一张地图：清的是那张地图的格子
  const mapId = fogOf(fogObject)?.mapId ?? "";
  const mapObject = mapId.length === 0 ? undefined : findObject(scene, mapId);
  const map = mapObject === undefined ? undefined : mapDraftOf(mapObject);
  if (mapObject === undefined || map === undefined) {
    return false;
  }

  let cells: Uint8Array;
  try {
    cells = decodeRle(map.cells.runs, map.grid.width * map.grid.height);
  } catch {
    // 与 paintMapCells 同一条规矩：坏数据不拿来当基底，也不顺手「修」成正常网格
    return false;
  }

  const next = cells.slice();
  let changed = false;
  for (let index = 0; index < next.length; index += 1) {
    const existing = next[index] ?? CellMask.Empty;
    const cleared = removeMask(existing, fogMask);
    if (cleared !== existing) {
      next[index] = cleared;
      changed = true;
    }
  }

  return changed && setMapCells(scene, mapObject.id, encodeRle(next));
}

// ---------------------------------------------------------------- 网格与标注

export interface PaintCellsOptions {
  /** 要叠加的类型位；`0` 表示橡皮擦（整格清零，对齐 Unity 的「橡皮擦 (0)」）。 */
  readonly mask: number;
  readonly brushSize: number;
  /**
   * 橡皮**只清哪些位**；缺省（不传）= 整格清零（标注调色板的橡皮就是这一档）。
   *
   * 战争雾的橡皮必须传「已指定的雾区位」：一格可能同时是「区域1 + 区域4」，
   * 擦雾只该擦掉区域4，不能顺手把区域1 也抹了。
   *
   * 注意与 `erase` 的取值约定配套：只有 `mask === 0` 时才会走到它，
   * 且传 `undefined` 与传 `0` 含义不同（后者 = 一位都不清），所以别用 `?? 0` 兜底。
   */
  readonly eraseMask?: number;
}

/**
 * 标注一笔：把 `from → to`（含两端）经过的格子按画笔刷一遍。
 *
 * 与 Unity `GridMapEditorState.ApplyBrush` 同一套语义：类型位**按位叠加**，
 * 橡皮（`mask === 0`）**整格清零**（给了 `eraseMask` 时只清指定位）；越界的格子由画笔自己裁掉。
 * 两条约束是刻意的：
 * - **落笔点必须在网格内**才动手（Unity 的 `HandleInput` 也是先判在不在网格里）——
 *   否则「在地图外面点一下」会被量化到边缘格，凭空画上一笔；
 * - 整笔**只解码 / 编码一次 RLE**：一笔有几十个格心，逐点改写会把整张网格来回搬几十遍。
 *
 * 返回 `false` 表示没有产生变更（画笔没改到任何格、落笔点越界、数据坏了）。
 */
export function paintMapCells(
  scene: Draft<SceneDoc>,
  mapObjectId: string,
  from: GridPoint,
  to: GridPoint,
  options: PaintCellsOptions,
): boolean {
  const map = mapDraftOfId(scene, mapObjectId);
  if (map === undefined || !isInsideGrid(to, map.grid)) {
    return false;
  }

  const count = map.grid.width * map.grid.height;
  let cells: Uint8Array;
  try {
    cells = decodeRle(map.cells.runs, count);
  } catch {
    // 格子数据本来就与网格尺寸对不上（坏数据）：不拿它当基底——照常理「修」一下，
    // 等于把损坏的数据悄悄换成一张看起来正常的网格
    return false;
  }

  const erase = options.mask === CellMask.Empty;
  const next = applyBrushStroke(cells, map.grid, from, to, {
    mask: options.mask,
    brushSize: options.brushSize,
    erase,
    // 只在擦除时带上「只清这些位」；`undefined` = 整格清零
    ...(erase && options.eraseMask !== undefined ? { eraseMask: options.eraseMask } : {}),
  });

  // 相同的掩码写回去时 setMapCells 会判为「无变更」并返回 false，所以重复涂抹不进撤销栈
  return setMapCells(scene, mapObjectId, encodeRle(next));
}

/**
 * 改地图网格的列数 / 行数。
 *
 * 格子数据是**按行主序铺满整张网格**的（校验要求展开格数 = 列 × 行），所以改尺寸必须把
 * 格子一起重建：左上对齐的重叠部分原样保留，多出来的格子是空（`CellMask.Empty`），
 * 被缩掉的格子丢弃。每格的像素尺寸不用记——它是 `贴图宽 ÷ 列数` 算出来的。
 */
export function setMapGrid(
  scene: Draft<SceneDoc>,
  mapObjectId: string,
  grid: { readonly width: number; readonly height: number },
): boolean {
  const map = mapDraftOfId(scene, mapObjectId);
  if (map === undefined) {
    return false;
  }

  // 非有限数（NaN / Infinity）直接拒绝：`Math.round` 会把 NaN 一路带下去写坏网格、
  // `new Uint8Array(Infinity)` 直接抛。与 `setObjectScale` / `setObjectRotation` 同一条规矩。
  if (!Number.isFinite(grid.width) || !Number.isFinite(grid.height)) {
    return false;
  }

  const width = Math.max(1, Math.round(grid.width));
  const height = Math.max(1, Math.round(grid.height));
  if (width === map.grid.width && height === map.grid.height) {
    return false;
  }

  let cells: Uint8Array;
  try {
    cells = decodeRle(map.cells.runs, map.grid.width * map.grid.height);
  } catch {
    // 格子数据本来就是坏的（展开格数对不上）：不拿它当基底，否则会把坏数据
    // 「修」成一张看起来正常的空网格，等于把错误悄悄抹掉
    return false;
  }

  const next = new Uint8Array(width * height);
  const keepColumns = Math.min(width, map.grid.width);
  const keepRows = Math.min(height, map.grid.height);
  for (let y = 0; y < keepRows; y += 1) {
    for (let x = 0; x < keepColumns; x += 1) {
      next[y * width + x] = cells[y * map.grid.width + x] ?? CellMask.Empty;
    }
  }

  map.grid = { width, height };
  map.cells = {
    encoding: "rle",
    runs: encodeRle(next).map((run) => [run[0], run[1]] as [number, number]),
  };
  return true;
}
