// 本文件从 `commands.ts` 拆出（照 `teleport.ts` 的样子）：放大镜（动作对象）命令。
import type { Draft } from "immer";
// 特性的读写一律走访问器（「数据存在哪个组件里」只有 access.ts 知道）
import { ensureMagnifierData } from "../access";
import type { ImageRef, ImageSpriteRef, SceneDoc } from "../types";
import { withMediaData } from "./shared";

// ---------------------------------------------------------------- 放大镜（动作对象）

/**
 * 放大镜的图片列表：**一条一条加 / 移出 + 换当前展示的那一张**。
 *
 * 与声音 / 视频 / 传送阵那三份「列表 + 选中」的差别只有一处：**选中是下标**（`picked: number`），
 * 因为它们那份列表的元素是字符串（可以当键），而这里的元素是「一张图 + 可选的一格」——
 * **同一张图的两个不同格子是两条**，拿 id 当键会撞车，所以下标才是这把列表里的位置。
 * 代价就是「移出一条」要顺手把 `picked` 调一格（`removeMagnifierImage` 里集中处理）。
 */

/**
 * 往列表末尾加一条（同一张图的**同一个格子**已经在列表里就不重复加，改成选中那一条）。
 *
 * 列表原来是空的（或者坏数据里 `picked` 没写）→ 选中新加的这一条：面板上「一条都没选」
 * 看着像坏了，而「加进来就是想看它」是最省事的解释（与 `createSoundObject` 给第一条选中同义）。
 */
export function addMagnifierImage(
  scene: Draft<SceneDoc>,
  objectId: string,
  image: ImageRef,
): boolean {
  const next = normalizeMagnifierImage(image);

  return withMediaData(scene, objectId, ensureMagnifierData, (data) => {
    const existing = data.images.findIndex((item) => sameMagnifierImage(item, next));
    if (existing >= 0) {
      if (data.picked === existing) {
        return false;
      }

      data.picked = existing;
      return true;
    }

    data.images.push(next);
    if (data.picked === undefined) {
      data.picked = data.images.length - 1;
    }

    return true;
  });
}

/**
 * 移出第 `index` 条（越界 / 不是整数 → 无变更），并**收拾 `picked`**：
 *
 * - 移出的正好是当前展示那张 → 留在同一个下标（也就是原来它后面那张）；后面没有了就退到最后一个；
 * - 比它大的下标都减一（列表短了一格）；
 * - 一条不剩 → `picked` 整个删掉（不留空壳，与 `syncMediaSideData` 同一条规矩）。
 */
export function removeMagnifierImage(
  scene: Draft<SceneDoc>,
  objectId: string,
  index: number,
): boolean {
  if (!Number.isInteger(index) || index < 0) {
    return false;
  }

  return withMediaData(scene, objectId, ensureMagnifierData, (data) => {
    if (index >= data.images.length) {
      return false;
    }

    data.images.splice(index, 1);

    if (data.picked !== undefined) {
      if (data.images.length === 0) {
        delete data.picked;
      } else if (data.picked === index) {
        // 原来它后面那张补了上来；移出的是最后一张时退到新的最后一个
        data.picked = Math.min(index, data.images.length - 1);
      } else if (data.picked > index) {
        data.picked -= 1;
      }
    }

    return true;
  });
}

/**
 * 改「当前展示第几张」（`null` = 取消选中）；越界的下标拒掉（不悄悄夹到最后一格——
 * 那是渲染 / 推送对**格子**的兜底口径，不是对「用户点了哪一条」的）。
 */
export function setMagnifierPicked(
  scene: Draft<SceneDoc>,
  objectId: string,
  index: number | null,
): boolean {
  return withMediaData(scene, objectId, ensureMagnifierData, (data) => {
    if (index === null) {
      if (data.picked === undefined) {
        return false;
      }

      delete data.picked;
      return true;
    }

    if (!Number.isInteger(index) || index < 0 || index >= data.images.length || data.picked === index) {
      return false;
    }

    data.picked = index;
    return true;
  });
}

/**
 * 收干净一条图片引用：格子取整 + 非负（越界要不要夹由渲染那条链路统一做，这里只保证是整数），
 * 并把 `guid` / `sprite` 的「没写」落实成**不留字段**（别用 `undefined` 去污染 JSON）。
 */
function normalizeMagnifierImage(image: ImageRef): ImageRef {
  const base = {
    id: image.id,
    ...(image.guid === undefined ? {} : { guid: image.guid }),
    width: image.width,
    height: image.height,
  };

  return image.sprite === undefined ? base : { ...base, sprite: normalizeSpriteRef(image.sprite) };
}

/** 取整 + 非负（与 `commands/object.ts` 的 `normalizeSpriteRef` 同一个口径）。 */
function normalizeSpriteRef(sprite: ImageSpriteRef): ImageSpriteRef {
  return {
    column: Number.isFinite(sprite.column) ? Math.max(0, Math.round(sprite.column)) : 0,
    row: Number.isFinite(sprite.row) ? Math.max(0, Math.round(sprite.row)) : 0,
  };
}

/**
 * 两条是不是「同一张图的同一个格子」：身份优先 guid（素材改过名之后 `id` 是旧路径）、
 * 退回 `id`；再比格子。**不比宽高**——同一格的声明尺寸只可能有一个值，比它没有意义。
 */
function sameMagnifierImage(left: ImageRef, right: ImageRef): boolean {
  const leftKey = left.guid ?? left.id;
  const rightKey = right.guid ?? right.id;
  if (leftKey !== rightKey) {
    return false;
  }

  if (left.sprite === undefined || right.sprite === undefined) {
    return left.sprite === undefined && right.sprite === undefined;
  }

  return left.sprite.column === right.sprite.column && left.sprite.row === right.sprite.row;
}
