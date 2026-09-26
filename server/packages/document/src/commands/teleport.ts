// 本文件从 `commands.ts` 拆出（纯搬运，行为不变）：传送阵（动作对象）命令。
import type { Draft } from "immer";
// 特性的读写一律走访问器（「数据存在哪个组件里」只有 access.ts 知道）
import { ensureTeleportData } from "../access";
import { setMediaList, setMediaPicked } from "./shared";
import type { SceneDoc } from "../types";

// ---------------------------------------------------------------- 传送阵（动作对象）

/**
 * 替换传送阵的**候选目标场景**（「传送目标」窗口里勾 / 取消勾就是这件事）。
 *
 * 只保证内容是**去空、去重**后的场景名，不排序——顺序是用户勾进来的顺序，没有别的语义
 * （与 `setSoundClips` 同一个口径）。
 *
 * 列表一变，**选中的那一个跟着走**（见 `shared.ts` 的 `syncMediaSideData`）：移出去的正好是选中的，
 * 就顺到剩下的第一条；一条不剩就把 `picked` 整个删掉。
 */
export function setTeleportTargets(
  scene: Draft<SceneDoc>,
  objectId: string,
  targets: readonly string[],
): boolean {
  return setMediaList(
    scene,
    objectId,
    ensureTeleportData,
    (teleport) => teleport,
    (teleport) => teleport.targets,
    (teleport, next) => {
      teleport.targets = next;
    },
    targets,
  );
}

/**
 * 选中 / 取消选中「候选里传送到哪一个」（`null` = 取消选中）。
 *
 * 只能选 `targets` 里的（不在列表里 = 数据对不上，直接拒掉，不悄悄把它加进去）；
 * 值没变返回 false，于是连点同一个小方块不会往撤销栈里塞空记录。
 */
export function setTeleportPicked(
  scene: Draft<SceneDoc>,
  objectId: string,
  target: string | null,
): boolean {
  return setMediaPicked(scene, objectId, ensureTeleportData, (teleport) => teleport, (teleport) => teleport.targets, target);
}
