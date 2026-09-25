// 本文件从 `commands/grid-map.ts` 拆出（v25）：战争雾命令——雾自 v25 起是独立的
// `FogOfWar` 组件（v25 前住在 `GridMap` 的 data.fog 里，行为不变）。
import type { Draft } from "immer";
import { normalizeRegions, regionsToMask } from "@dts/grid";
import { DEFAULT_SLOT_COMPONENT } from "../presets";
// 特性的读写一律走访问器（「数据存在哪个组件里」只有 access.ts 知道）
import {
  ensureFogData,
  fogOf,
  mapDataOf,
  removeFeature,
  writeFeature,
} from "../access";
import { withObject } from "./shared";
import type { GameObjectDoc, SceneDoc } from "../types";

// ---------------------------------------------------------------- 战争雾（FogOfWar 组件，从属 GridMap）

/**
 * 对象指定的雾区 → 掩码（`0` = 一个雾区都没指定）。
 *
 * 「这一格算不算雾」只有这一个判断入口：绘制预览、数雾格、擦除范围全走它，
 * 免得每处各写一遍「遍历 regions 再看有没有这一位」。
 */
export function fogMaskOf(object: GameObjectDoc): number {
  return regionsToMask(fogOf(object)?.regions ?? []);
}

/**
 * 打开 / 关掉战争雾的**总开关**。
 *
 * 关掉**不清雾区绑定**——「先关掉看看效果、再打开」不该逼人重新指定一遍；
 * 前端（`FogOfWar`）按这个开关决定建不建那一层雾，所以关掉 = 这张地图现在没有战争雾。
 *
 * - 打开：`FogOfWar` 组件先在（只是关着）就把 `enabled` 翻回来，绑定原样留着；不在
 *   （新地图）就补一份 `{ enabled: true, regions: [] }`——**开关状态本身也是要存的数据**，
 *   不落盘的话下次打开项目开关又变回关着。雾区一个都没指定时**不会有雾**（也不会建层），
 *   由 `validateScene` 提醒。
 * - 关掉：还有雾区绑定就写 `{ enabled: false, regions }`；一个雾区都没指定时
 *   **把组件整个摘掉**（与「从没开过」同义，文件里不留空壳）。
 *
 * 雾从属 `GridMap`：对象没有地图数据时返回 `false`（与 v25 前「没有 map draft 就不动」
 * 同一条口径）。
 *
 * 返回 `false` 表示没有变更（不是带地图数据的对象、或开关本来就是这个状态）。
 */
export function setFogEnabled(
  scene: Draft<SceneDoc>,
  objectId: string,
  enabled: boolean,
): boolean {
  return withObject(scene, objectId, (object) => {
    if (mapDataOf(object) === undefined) {
      return false;
    }

    const fog = fogOf(object);
    if (enabled) {
      if (fog !== undefined && fog.enabled !== false) {
        return false;
      }

      if (fog === undefined) {
        const created = ensureFogData(object);
        if (created === undefined) return false;
        created.enabled = true;
        return true;
      }

      writeFeature(object, DEFAULT_SLOT_COMPONENT.fog, { ...fog, enabled: true });
      return true;
    }

    if (fog === undefined || fog.enabled === false) {
      return false;
    }

    if (fog.regions.length === 0) {
      return removeFeature(object, DEFAULT_SLOT_COMPONENT.fog);
    }

    writeFeature(object, DEFAULT_SLOT_COMPONENT.fog, { ...fog, enabled: false });
    return true;
  });
}

/**
 * 指定哪些区域算战争雾。
 *
 * 格子上的类型位是**中性区域**，所以「哪个区域是雾」是地图自己的配置，不是类型自带的语义。
 * 写入前先规范化（只留可绘制位、去重、升序），保证同一份选择永远写出同一个文件内容。
 *
 * 规范化后为空时：**开关开着**就留一份 `{ enabled: true, regions: [] }`（「开着但还没指定雾区」，
 * 属性面板那一组与开关状态都还在）；**开关关着**才把组件整个摘掉（没有内容要记了，
 * 与「从没开过」同义——文件里不留空壳）。
 *
 * **只改绑定，不动格子数据**：解除绑定不会连带清掉已经画好的雾格子，改回来还在。
 * **也不动总开关**：关着的时候指定雾区照样写得进去（绑定与开关是两件事）。
 *
 * 返回 `false` 表示没有变更（对象没有地图数据、或绑定没变）。
 */
export function setFogRegions(
  scene: Draft<SceneDoc>,
  objectId: string,
  regions: readonly number[],
): boolean {
  return withObject(scene, objectId, (object) => {
    if (mapDataOf(object) === undefined) {
      return false;
    }

    const fog = fogOf(object);
    const next = normalizeRegions(regions);
    const current = normalizeRegions(fog?.regions ?? []);
    if (next.length === current.length && next.every((bit, index) => bit === current[index])) {
      return false;
    }

    if (next.length === 0) {
      // （走到这里组件一定在：`next` 与 `current` 都是空数组的话，上面那条「没变更」已经拦住了。）
      // 开关**开着**：留着组件（`{ enabled: true, regions: [] }` = 「开着但还没指定雾区」）——
      // 取消最后一个雾区不该把属性面板那一组整个塌掉，开关状态也得有地方记。
      // 关着：没有内容要记了，组件整个摘掉，与「从没开过」同义。
      if (fog !== undefined && fog.enabled === false) {
        removeFeature(object, DEFAULT_SLOT_COMPONENT.fog);
        return true;
      }

      writeFeature(object, DEFAULT_SLOT_COMPONENT.fog, { enabled: true, regions: [] });
      return true;
    }

    // 开关状态原样保留（关着的时候绑定也写得进去）；本来没有组件（新地图）时按**开着**建——
    // 会走到「指定雾区」这一步，本来就是想用战争雾；写成关着只会让人以为没生效
    writeFeature(object, DEFAULT_SLOT_COMPONENT.fog, {
      enabled: fog?.enabled !== false,
      regions: next,
    });
    return true;
  });
}
