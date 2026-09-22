// 本文件从 `commands.ts` 拆出（纯搬运，行为不变）：命令模块共用的常量与查找工具。
import type { Draft } from "immer";
import { FEATURE_COMPONENT, carriesKind } from "../features";
import type { ComponentDoc, SceneDoc, SceneObjectDoc } from "../types";

let idCounter = 0;

/**
 * 新建对象的默认显示顺序。
 *
 * 普通对象（精灵 / 玩家 / 道具 / 事件）是 `0`；地图当底图，默认排在下面（`-10`）。
 * 谁盖住谁是**画布上的事**，这两个默认值只是让「新场景一建出来就是对的」。
 */
export const DEFAULT_SORTING_ORDER = 0;
export const MAP_DEFAULT_SORTING_ORDER = -10;

/**
 * 缩放的取值范围与默认值**住在 `scale.ts`**（那里还管着等比与单轴的换算关系），
 * 这里原样再导出一次：`DEFAULT_OBJECT_SCALE` 等一直是 `@dts/document` 的公开名字，
 * 老调用方不该因为一次内部搬家而改 import。
 */
export { DEFAULT_OBJECT_SCALE, MAX_OBJECT_SCALE, MIN_OBJECT_SCALE } from "../scale";

/**
 * 角度的归一化区间：`(-180, 180]`（**度**）。
 *
 * 文档里存的是**弧度**（`SceneObjectDoc.rotation`），面板上按**度**编辑——
 * Unity 的 Inspector 也是度数，策划对着两边看才不会算错。
 * 转 370° 和转 10° 是同一个姿态，归一化后数字才不会失控。
 */
export const MIN_OBJECT_ROTATION_DEGREES = -180;
export const MAX_OBJECT_ROTATION_DEGREES = 180;

/** 生成稳定前缀 + 递增 + 随机后缀的 id（避免同毫秒内碰撞）。 */
export function createId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function findObject(scene: Draft<SceneDoc>, objectId: string): Draft<SceneObjectDoc> | undefined {
  return scene.objects.find((object) => object.id === objectId);
}

export function findComponent(
  scene: Draft<SceneDoc>,
  objectId: string,
  componentId: string,
): Draft<ComponentDoc> | undefined {
  return findObject(scene, objectId)?.components.find((component) => component.id === componentId);
}

/** 场景里的地图对象（可能没有，也可能有多个；取第一个用于渲染底图）。 */
export function findMapObject(scene: SceneDoc): SceneObjectDoc | undefined {
  return scene.objects.find((object) => carriesKind(FEATURE_COMPONENT.map, object.kind));
}

/** 场景里所有地图对象。 */
export function listMapObjects(scene: SceneDoc): SceneObjectDoc[] {
  return scene.objects.filter((object) => carriesKind(FEATURE_COMPONENT.map, object.kind));
}

/** 收集某场景内全部动作 id（校验唯一性用）。 */
export function collectActionIds(scene: SceneDoc): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const object of scene.objects) {
    for (const component of object.components) {
      for (const action of component.actions) {
        const owners = byId.get(action.id) ?? [];
        owners.push(`${object.id}/${component.id}`);
        byId.set(action.id, owners);
      }
    }
  }

  return byId;
}
