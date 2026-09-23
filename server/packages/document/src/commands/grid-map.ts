// 本文件从 `commands.ts` 拆出（纯搬运，行为不变）：地图数据、战争雾、网格与标注命令。
import type { Draft } from "immer";
import {
  CellMask,
  applyBrushStroke,
  decodeRle,
  encodeRle,
  isInsideGrid,
  normalizeRegions,
  regionsToMask,
  removeMask,
  type GridPoint,
  type RleRun,
} from "@dts/grid";
import { DEFAULT_SLOT_COMPONENT, carriesComponent } from "../presets";
// 特性的读写一律走访问器（「数据存在哪个组件里」只有 access.ts 知道）
import { mapDraftOf, writeFeature } from "../access";
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

// ---------------------------------------------------------------- 战争雾（地图）

/**
 * 这张地图的战争雾**开着没有**（v13 起的总开关）。
 *
 * 判据只有这一处，编辑器与校验都走它：`fog` 整个不在 = 没开（也没雾区）；
 * `fog` 在就按 `enabled` 算——`enabled` **缺省算开**，那是 v10–v12 的文件
 * （schema 会把 `true` 补进去，这里的兜底只是给内存里手写的对象用）。
 */
export function isMapFogEnabled(map: MapDataDoc): boolean {
  return map.fog !== undefined && map.fog.enabled !== false;
}

/**
 * 地图指定的雾区 → 掩码（`0` = 一个雾区都没指定）。
 *
 * 「这一格算不算雾」只有这一个判断入口：绘制预览、数雾格、擦除范围全走它，
 * 免得每处各写一遍「遍历 regions 再看有没有这一位」。
 */
export function mapFogMask(map: MapDataDoc): number {
  return regionsToMask(map.fog?.regions ?? []);
}

/**
 * 打开 / 关掉战争雾的**总开关**（v13 起）。
 *
 * 关掉**不清雾区绑定**——「先关掉看看效果、再打开」不该逼人重新指定一遍；
 * 前端（`FogOfWar`）按这个开关决定建不建那一层雾，所以关掉 = 这张地图现在没有战争雾。
 *
 * - 打开：`fog` 先在（只是关着）就把 `enabled` 翻回来，绑定原样留着；`fog` 不在
 *   （新地图）就写一份 `{ enabled: true, regions: [] }`——**开关状态本身也是要存的数据**，
 *   不落盘的话下次打开项目开关又变回关着。雾区一个都没指定时**不会有雾**（也不会建层），
 *   由 `validateScene` 提醒。
 * - 关掉：还有雾区绑定就写 `{ enabled: false, regions }`；一个雾区都没指定时
 *   **把 `fog` 整个删掉**（与「从没开过」同义，文件里不留空壳）。
 *
 * 返回 `false` 表示没有变更（不是地图对象、或开关本来就是这个状态）。
 */
export function setMapFogEnabled(
  scene: Draft<SceneDoc>,
  mapObjectId: string,
  enabled: boolean,
): boolean {
  const map = mapDraftOfId(scene, mapObjectId);
  if (map === undefined) {
    return false;
  }

  const current = map.fog;
  if (enabled) {
    if (current !== undefined && isMapFogEnabled(map)) {
      return false;
    }

    map.fog = { enabled: true, regions: current?.regions ?? [] };
    return true;
  }

  if (current === undefined || !isMapFogEnabled(map)) {
    return false;
  }

  if (current.regions.length === 0) {
    delete map.fog;
    return true;
  }

  map.fog = { enabled: false, regions: current.regions };
  return true;
}

/**
 * 指定哪些区域算战争雾。
 *
 * 格子上的类型位是**中性区域**，所以「哪个区域是雾」是地图自己的配置，不是类型自带的语义。
 * 写入前先规范化（只留可绘制位、去重、升序），保证同一份选择永远写出同一个文件内容。
 *
 * 规范化后为空时：**开关开着**就留一份 `{ enabled: true, regions: [] }`（「开着但还没指定雾区」，
 * 属性面板那一组与开关状态都还在）；**开关关着**才把 `fog` 整个删掉（没有内容要记了，
 * 与「从没开过」同义——文件里不留空壳）。
 *
 * **只改绑定，不动格子数据**：解除绑定不会连带清掉已经画好的雾格子，改回来还在。
 * **也不动总开关**：关着的时候指定雾区照样写得进去（绑定与开关是两件事）。
 *
 * 返回 `false` 表示没有变更（不是地图对象、或绑定没变）。
 */
export function setMapFogRegions(
  scene: Draft<SceneDoc>,
  mapObjectId: string,
  regions: readonly number[],
): boolean {
  const map = mapDraftOfId(scene, mapObjectId);
  if (map === undefined) {
    return false;
  }

  const next = normalizeRegions(regions);
  const current = normalizeRegions(map.fog?.regions ?? []);
  if (next.length === current.length && next.every((bit, index) => bit === current[index])) {
    return false;
  }

  if (next.length === 0) {
    // （走到这里 `fog` 一定在：`next` 与 `current` 都是空数组的话，上面那条「没变更」已经拦住了。）
    // 开关**开着**：留着字段（`{ enabled: true, regions: [] }` = 「开着但还没指定雾区」）——
    // 取消最后一个雾区不该把属性面板那一组整个塌掉，开关状态也得有地方记。
    // 关着：没有内容要记了，字段整个摘掉，与「从没开过」同义。
    if (map.fog?.enabled === false) {
      delete map.fog;
      return true;
    }

    map.fog = { enabled: true, regions: [] };
    return true;
  }

  // 开关状态原样保留（关着的时候绑定也写得进去）；本来没有 `fog`（新建地图）时按**开着**建——
  // 会走到「指定雾区」这一步，本来就是想用战争雾；写成关着只会让人以为没生效
  map.fog = { enabled: map.fog?.enabled !== false, regions: next };
  return true;
}

/**
 * 清空战争雾：只清掉**已指定的雾区位**，其它区域位原样保留。
 *
 * 与 `clearMapCells` 的区别就是「只清绑定位」：一格若是「区域1 + 区域4」而只指定了区域4，
 * 清雾之后它仍是区域1 的格子。没指定任何雾区时什么都不做（返回 `false`）。
 */
export function clearMapFog(scene: Draft<SceneDoc>, mapObjectId: string): boolean {
  const map = mapDraftOfId(scene, mapObjectId);
  if (map === undefined) {
    return false;
  }

  const fogMask = mapFogMask(map);
  if (fogMask === 0) {
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

  return changed && setMapCells(scene, mapObjectId, encodeRle(next));
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

/** 替换地图对象的地图数据（换贴图 / 改网格尺寸时用）。 */
export function setMapData(
  scene: Draft<SceneDoc>,
  mapObjectId: string,
  map: MapDataDoc,
): boolean {
  const object = findObject(scene, mapObjectId);
  if (object === undefined || !carriesComponent(DEFAULT_SLOT_COMPONENT.map, object.kind)) {
    return false;
  }

  writeFeature(object, DEFAULT_SLOT_COMPONENT.map, map);
  return true;
}
