// 本文件从属于 `commands/`：视频混合（`VideoBlend`）命令——两条通道的「列表 + 选中」。
import type { Draft } from "immer";
import { ensureVideoBlendData, removeFeature, videoBlendDataOf } from "../access";
import { DEFAULT_SLOT_COMPONENT } from "../presets";
import { setMediaList, setMediaPicked, withObject } from "./shared";
import type { SceneDoc } from "../types";

/** 两条通道：`a` = 盖在上面的那条，`b` = 被盖住（擦开露出）的那条。 */
export type VideoBlendChannel = "a" | "b";

/**
 * 添加视频混合（属性面板底部 Add Component）。
 *
 * 写一份默认组件（两条空通道 + 不循环 + 静音，见 `component-specs/video-blend.ts`）；
 * 不满足准入（不是贴图 / kind 不一致 / 已经挂过）时返回 `false`（无变更，不入撤销栈）。
 */
export function addObjectVideoBlend(scene: Draft<SceneDoc>, objectId: string): boolean {
  return withObject(scene, objectId, (object) => {
    if (videoBlendDataOf(object) !== undefined) {
      return false;
    }

    return ensureVideoBlendData(object) !== undefined;
  });
}

/**
 * 把对象上的**视频混合组件摘掉**（属性面板「视频混合」那一组的组头移除）。
 *
 * 与 `removeObjectVideo` 同一套：可选组件**组件在 = 在用**，摘掉 = 这个对象不再混合视频；
 * 两条通道的列表随组件一起删掉。素材文件不受影响。
 */
export function removeObjectVideoBlend(scene: Draft<SceneDoc>, objectId: string): boolean {
  return withObject(scene, objectId, (object) => {
    if (videoBlendDataOf(object) === undefined) {
      return false;
    }

    return removeFeature(object, DEFAULT_SLOT_COMPONENT.videoBlend);
  });
}

/**
 * 替换某条通道的视频列表（资源逻辑 ID）。
 *
 * 与 `setVideoClips` 同一套（同一份 `setMediaList` 骨架）：去空去重、不排序；列表一变，
 * 那条通道的 `picked` 跟着走（`syncMediaSideData`）。
 */
export function setVideoBlendClips(
  scene: Draft<SceneDoc>,
  objectId: string,
  channel: VideoBlendChannel,
  clips: readonly string[],
): boolean {
  return setMediaList(
    scene,
    objectId,
    ensureVideoBlendData,
    (data) => (channel === "a" ? data.a : data.b),
    (media) => media.clips,
    (media, next) => {
      media.clips = next;
    },
    clips,
  );
}

/**
 * 选中 / 取消选中某条通道里放哪一条（`null` = 取消选中）。只认那条通道 `clips` 里的。
 */
export function setVideoBlendPicked(
  scene: Draft<SceneDoc>,
  objectId: string,
  channel: VideoBlendChannel,
  clipId: string | null,
): boolean {
  return setMediaPicked(
    scene,
    objectId,
    ensureVideoBlendData,
    (data) => (channel === "a" ? data.a : data.b),
    (media) => media.clips,
    clipId,
  );
}
