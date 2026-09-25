// 本文件从 `commands.ts` 拆出（纯搬运，行为不变）：命令模块共用的常量、查找工具与媒体列表骨架。
import type { Draft } from "immer";
import { mapDataOf } from "../access";
import type { SceneDoc, GameObjectDoc } from "../types";

let idCounter = 0;

/**
 * 新建对象的默认显示顺序（v26 起它住在渲染组件里，这里只剩缺省语义）。
 *
 * 普通对象（精灵 / 玩家 / 道具 / 事件）是 `0`；地图当底图，默认排在下面（`-10`）。
 * 谁盖住谁是**画布上的事**，这两个默认值只是让「新场景一建出来就是对的」。
 * **没有渲染层的对象不写它**（动作对象 / 还没挑图的实体本就不该有这个参数）。
 */
export const DEFAULT_SORTING_ORDER = 0;
export const MAP_DEFAULT_SORTING_ORDER = -10;

/**
 * 显示顺序的取值范围：足够表达「垫底 / 顶层」，又不至于让界面上的数字失控。
 *
 * 写入一律取整 + 夹在 `±SORTING_ORDER_LIMIT`（`setRenderSortingOrder` 唯一的写入口径）。
 */
export const SORTING_ORDER_LIMIT = 9999;

/**
 * 缩放的取值范围与默认值**住在 `scale.ts`**（那里还管着等比与单轴的换算关系），
 * 这里原样再导出一次：`DEFAULT_OBJECT_SCALE` 等一直是 `@dts/document` 的公开名字，
 * 老调用方不该因为一次内部搬家而改 import。
 */
export { DEFAULT_OBJECT_SCALE, MAX_OBJECT_SCALE, MIN_OBJECT_SCALE } from "../scale";

/** 生成稳定前缀 + 递增 + 随机后缀的 id（避免同毫秒内碰撞）。 */
export function createId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function findObject(scene: Draft<SceneDoc>, objectId: string): Draft<GameObjectDoc> | undefined {
  return scene.objects.find((object) => object.id === objectId);
}

/** 场景里的地图对象（可能没有，也可能有多个；取第一个用于渲染底图）。 */
export function findMapObject(scene: SceneDoc): GameObjectDoc | undefined {
  return scene.objects.find((object) => mapDataOf(object) !== undefined);
}

/** 场景里所有地图对象。 */
export function listMapObjects(scene: SceneDoc): GameObjectDoc[] {
  return scene.objects.filter((object) => mapDataOf(object) !== undefined);
}

// ---------------------------------------------------------------- 媒体列表命令的公共骨架
//
// 声音 / 视频 / 传送阵是**同一套形状**（「加进来的列表 + 当前选中的那一个（+ 按项记的名字）」），
// 命令的逐字段语义逐字一致，只有数据类型与列表字段名不同——那一部分归这里，唯一一份。

/** 「列表 + 选中」那份数据的公共形状（声音 / 视频逐字一致的那部分）。 */
export interface MediaListSideData {
  readonly clips: readonly string[];
  /** 取消选中是 `delete` 语义（optional 字段整个摘掉，不留空壳）。 */
  picked?: string;
}

/**
 * 找到对象就交给 `fn`；找不到对象返回 false（数据对不上：静默拒绝、不入撤销栈）。
 *
 * 文档命令的公共前奏：布尔约定是「无变更 → false」，由 `fn` 原样带出来。
 */
export function withObject(
  scene: Draft<SceneDoc>,
  objectId: string,
  fn: (object: Draft<GameObjectDoc>) => boolean,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  return fn(object);
}

/**
 * `withObject` 的媒体版：对象的数据缺就先用 `ensure` 补一份可用的（与 schema 同一个兜底口径），
 * 补不出（对象根本不带这个槽位）返回 false。`fn` 拿到数据 draft，需要动对象本身时
 * （比如「组件整个摘掉」）第二个参数就是那份对象 draft。
 */
export function withMediaData<T>(
  scene: Draft<SceneDoc>,
  objectId: string,
  ensure: (object: Draft<GameObjectDoc>) => T | undefined,
  fn: (data: T, object: Draft<GameObjectDoc>) => boolean,
): boolean {
  return withObject(scene, objectId, (object) => {
    const data = ensure(object);
    if (data === undefined) {
      return false;
    }

    return fn(data, object);
  });
}

/** 去空、去重后的列表（保序：重复项留在第一次出现的位置，即用户加进来的顺序）。 */
export function dedupeItems(items: readonly string[]): string[] {
  const next: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed.length > 0 && !next.includes(trimmed)) {
      next.push(trimmed);
    }
  }

  return next;
}

/** 两个列表逐项相等（长度相同、每个位置都一样）。 */
export function sameItemList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * 列表变更后收拾副作用：选中的那条还在列表里就行。
 *
 * 兜底「没选就默认选第一条」是**故意的**：加进来一条却没被选上时，面板上看着有东西、
 * 「播放 / 传送」却是灰的，很容易以为是坏的。
 */
export function syncMediaSideData(data: MediaListSideData): void {
  const fallback = data.clips[0];
  if (data.picked === undefined) {
    if (fallback !== undefined) {
      data.picked = fallback;
    }

    return;
  }

  if (!data.clips.includes(data.picked)) {
    // 移出去的正好是选中的那条：顺到剩下的第一条；一条不剩就不留这个字段
    if (fallback === undefined) {
      delete data.picked;
    } else {
      data.picked = fallback;
    }
  }
}

/**
 * 选中 / 取消选中「加进来的里用哪一条」（`null` = 取消选中）。
 *
 * 只能选列表里的（不在列表里 = 数据对不上，直接拒掉，不悄悄把它加进去）；
 * 值没变返回 false，于是连点同一条不会往撤销栈里塞空记录。
 */
export function setMediaPicked<T extends { picked?: string }>(
  scene: Draft<SceneDoc>,
  objectId: string,
  ensure: (object: Draft<GameObjectDoc>) => T | undefined,
  listOf: (data: T) => readonly string[],
  value: string | null,
): boolean {
  return withMediaData(scene, objectId, ensure, (data) => {
    if (value === null) {
      if (data.picked === undefined) {
        return false;
      }

      delete data.picked;
      return true;
    }

    if (!listOf(data).includes(value) || data.picked === value) {
      return false;
    }

    data.picked = value;
    return true;
  });
}
