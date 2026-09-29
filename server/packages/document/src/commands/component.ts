// 本文件从属于 `commands/`：可选组件的**添加 / 移除统一入口**（属性面板底部的 Add Component）。
import type { Draft } from "immer";
import type { ComponentType } from "../components";
import type { SceneDoc } from "../types";
import { addObjectGridMap, removeObjectGridMap, repairObjectComponent } from "./object";
import { addObjectVideo, removeObjectVideo } from "./video";
import { addObjectVideoBlend, removeObjectVideoBlend } from "./video-blend";

/**
 * 「添加 / 修复组件、移除可选组件」的**统一入口**。
 *
 * 与 Unity 的 Add Component 同理：界面只按**组件类型**说「加这个 / 修复这个 / 摘这个」，具体怎么初始化
 * （网格按当前图尺寸建空网格、视频写一份 `enabled: true` 的默认壳）仍住在各自的命令里，
 * 这里只做一层分派。加第三种可选组件时，在这里加一条 `case` 即可。
 *
 * 判据由被分派的命令自己把关（组件槽位、可选标记及互斥关系），所以这里对
 * 「类型不认识 / 槽位冲突 / 本来就是这个状态」一律返回 `false`（无变更，不入撤销栈）。
 */
export function addObjectComponent(
  scene: Draft<SceneDoc>,
  objectId: string,
  type: ComponentType,
): boolean {
  switch (type) {
    case "ImageLayer":
    case "SpriteLayer":
    case "PlaySound":
    case "Teleport":
    case "Magnifier":
    case "FogOfWar":
      return repairObjectComponent(scene, objectId, type);
    case "GridMap":
      return addObjectGridMap(scene, objectId);
    case "VideoOverlay":
      return addObjectVideo(scene, objectId);
    case "VideoBlend":
      return addObjectVideoBlend(scene, objectId);
    default:
      return false;
  }
}

/** 把对象上的一个**可选组件**摘掉（组件头上的「移除组件」）。与 `addObjectComponent` 对称。 */
export function removeObjectComponent(
  scene: Draft<SceneDoc>,
  objectId: string,
  type: ComponentType,
): boolean {
  switch (type) {
    case "GridMap":
      return removeObjectGridMap(scene, objectId);
    case "VideoOverlay":
      return removeObjectVideo(scene, objectId);
    case "VideoBlend":
      return removeObjectVideoBlend(scene, objectId);
    default:
      return false;
  }
}
