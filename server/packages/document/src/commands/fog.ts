// 本文件（v27 重写）：战争雾命令——雾是独立的 `Fog` 场景对象（引用一张地图），
// 总开关与雾区都写在它自己身上的 `FogOfWar` 组件里。
import type { Draft } from "immer";
import { normalizeRegions, regionsToMask } from "@dts/grid";
import { DEFAULT_SLOT_COMPONENT } from "../presets";
// 特性的读写一律走访问器（「数据存在哪个组件里」只有 access.ts 知道）
import {
  canRepairObjectComponent,
  componentDataOfSlot,
  fogOf,
  mapDataOf,
  writeFeature,
} from "../access";
import { withObject } from "./shared";
import type { FogOfWarDataDoc, GameObjectDoc, SceneDoc } from "../types";

// ---------------------------------------------------------------- 战争雾（Fog 对象的数据）

/**
 * 对象指定的雾区 → 掩码（`0` = 一个雾区都没指定）。
 *
 * 「这一格算不算雾」只有这一个判断入口：绘制预览、数雾格、擦除范围全走它。
 */
export function fogMaskOf(object: GameObjectDoc): number {
  return regionsToMask(fogOf(object)?.regions ?? []);
}

/**
 * 雾对象引用的地图对象（`mapId` 为空 / 解析不到 / 指向非地图对象时 `undefined`）。
 *
 * 「引用是否有效」只有这一处判据：校验、Mask 窗口、清空命令都走它。
 */
export function fogMapOf(scene: SceneDoc, fogObject: GameObjectDoc): GameObjectDoc | undefined {
  const mapId = fogOf(fogObject)?.mapId ?? "";
  if (mapId.length === 0) {
    return undefined;
  }

  const map = scene.objects.find((object) => object.id === mapId);
  return map !== undefined && mapDataOf(map) !== undefined ? map : undefined;
}

/** 这张地图的雾对象（一张地图最多一个，由迁移与校验保证）。 */
export function fogObjectOfMap(scene: SceneDoc, mapObjectId: string): GameObjectDoc | undefined {
  return scene.objects.find((object) => fogOf(object)?.mapId === mapObjectId);
}

/**
 * 雾对象上 `FogOfWar` 组件的 draft；缺组件时（损坏的手写文件）补一份默认的。
 *
 * 只有 `Fog` 对象能补（`repairKinds`）——在普通对象上凭空造一个雾组件没有意义。
 */
function ensureFogDraft(object: Draft<GameObjectDoc>): Draft<FogOfWarDataDoc> | undefined {
  const existing = componentDataOfSlot<FogOfWarDataDoc>(object, "fog");
  if (existing !== undefined) {
    return existing as Draft<FogOfWarDataDoc>;
  }

  if (!canRepairObjectComponent(object, DEFAULT_SLOT_COMPONENT.fog)) {
    return undefined;
  }

  return writeFeature(object, DEFAULT_SLOT_COMPONENT.fog, {
    mapId: "",
    enabled: true,
    regions: [],
  }).data as Draft<FogOfWarDataDoc>;
}

/**
 * 选这个雾对象引用哪张地图。
 *
 * `mapObjectId` 必须是场景里**真实存在的地图对象**（没有地图就没有雾区可谈）；
 * 其它对象 / 不存在的 id 一律拒绝。返回 `false` = 没有变更 / 目标不是地图。
 */
export function setFogMap(
  scene: Draft<SceneDoc>,
  fogObjectId: string,
  mapObjectId: string,
): boolean {
  const map = scene.objects.find((object) => object.id === mapObjectId);
  if (map === undefined || mapDataOf(map) === undefined) {
    return false;
  }

  return withObject(scene, fogObjectId, (object) => {
    const fog = ensureFogDraft(object);
    if (fog === undefined || fog.mapId === mapObjectId) {
      return false;
    }

    fog.mapId = mapObjectId;
    return true;
  });
}

/**
 * 打开 / 关掉战争雾的**总开关**。
 *
 * v27 起组件**总在**（它就是雾对象的数据本体）：关掉只是 `enabled = false`，
 * **不摘组件、也不清雾区绑定**——「先关掉看看效果、再打开」不该逼人重新指定一遍。
 * 前端（`FogOfWar`）按这个开关决定建不建那一层雾。
 *
 * 返回 `false` 表示没有变更（不是 `Fog` 对象 / 开关本来就是这个状态）。
 */
export function setFogEnabled(
  scene: Draft<SceneDoc>,
  fogObjectId: string,
  enabled: boolean,
): boolean {
  return withObject(scene, fogObjectId, (object) => {
    const fog = ensureFogDraft(object);
    if (fog === undefined || fog.enabled === enabled) {
      return false;
    }

    fog.enabled = enabled;
    return true;
  });
}

/**
 * 指定哪些区域算战争雾。
 *
 * 写入前先规范化（只留可绘制位、去重、升序），保证同一份选择永远写出同一个文件内容。
 * **只改绑定，不动格子数据**：解除绑定不会连带清掉已经画好的雾格子，改回来还在。
 * **也不动总开关**：关着的时候指定雾区照样写得进去（绑定与开关是两件事）。
 *
 * 返回 `false` 表示没有变更（不是 `Fog` 对象 / 绑定没变）。
 */
export function setFogRegions(
  scene: Draft<SceneDoc>,
  fogObjectId: string,
  regions: readonly number[],
): boolean {
  return withObject(scene, fogObjectId, (object) => {
    const fog = ensureFogDraft(object);
    if (fog === undefined) {
      return false;
    }

    const next = normalizeRegions(regions);
    const current = normalizeRegions(fog.regions ?? []);
    if (next.length === current.length && next.every((bit, index) => bit === current[index])) {
      return false;
    }

    fog.regions = next;
    return true;
  });
}
