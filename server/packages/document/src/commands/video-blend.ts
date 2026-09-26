// 本文件从属于 `commands/`：视频混合（`VideoBlend`）命令——两路素材的「种类 + 素材」。
import type { Draft } from "immer";
import { ensureVideoBlendData, removeFeature, videoBlendDataOf } from "../access";
import { DEFAULT_SLOT_COMPONENT } from "../presets";
import { withObject } from "./shared";
import type { SceneDoc, VideoBlendChannelDoc, VideoBlendKind } from "../types";

/** 两路：`a` = 盖在上面的那一路，`b` = 被盖住（擦开露出）的那一路。 */
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
 * 改某一路的**素材种类**（面板上的「图片 / 视频」开关）。
 *
 * 换种类会把这一路**已选的素材清掉**——旧素材的 ID 属于另一种类型，留着只会得到一个解不出来的
 * 引用（「图片」那一路指着一段视频）。换回原来那一档也要重新选，这是有意的：种类与素材是一体的，
 * 宁可多一次点击，也不要留下一个看着选好了、实际放不出来的状态。
 */
export function setVideoBlendChannelKind(
  scene: Draft<SceneDoc>,
  objectId: string,
  channel: VideoBlendChannel,
  kind: VideoBlendKind,
): boolean {
  return withObject(scene, objectId, (object) => {
    const data = ensureVideoBlendData(object);
    if (data === undefined) {
      return false;
    }

    const target = channel === "a" ? data.a : data.b;
    if (target.kind === kind) {
      return false;
    }

    const next: VideoBlendChannelDoc = { kind };
    if (channel === "a") {
      data.a = next;
    } else {
      data.b = next;
    }

    return true;
  });
}

/**
 * 选 / 取消选某一路要放的**素材**（`null` = 清掉）。
 *
 * 素材是图片还是视频由那一路的 `kind` 说了算，这里只认资源逻辑 ID；面板保证弹出来的是
 * 对的那一种选择框（见 `VideoBlendFields`）。
 */
export function setVideoBlendChannelId(
  scene: Draft<SceneDoc>,
  objectId: string,
  channel: VideoBlendChannel,
  id: string | null,
): boolean {
  return withObject(scene, objectId, (object) => {
    const data = ensureVideoBlendData(object);
    if (data === undefined) {
      return false;
    }

    const target = channel === "a" ? data.a : data.b;
    const next = id === null || id.length === 0 ? undefined : id;
    if (target.id === next) {
      return false;
    }

    const updated: VideoBlendChannelDoc =
      next === undefined ? { kind: target.kind } : { kind: target.kind, id: next };
    if (channel === "a") {
      data.a = updated;
    } else {
      data.b = updated;
    }

    return true;
  });
}
