/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 视频混合（贴图）：两条通道（A 盖住 / B 擦开露出）的列表与选中。
 *
 * 只管**文档数据**：播放记账、Mask 窗口与运行态下发的下一批（与 `video-slice` 同一分工）。
 */
import {
  DEFAULT_SLOT_COMPONENT,
  setVideoBlendClips as setSceneVideoBlendClips,
  setVideoBlendPicked as setSceneVideoBlendPicked,
  videoBlendDataOf,
  type GameObjectDoc,
  type VideoBlendChannel,
  type VideoBlendChannelDoc,
} from "@dts/document";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { findSceneByName } from "../store-core";
import { type StoreContext } from "../store-context";

/** 手写文件里可能整份 data 都没有：按空通道显示。 */
const EMPTY_CHANNEL: VideoBlendChannelDoc = { clips: [] };

/** 取对象上某条通道（读口；对象没有这个组件也返回空通道）。 */
function channelOf(object: GameObjectDoc, channel: VideoBlendChannel): VideoBlendChannelDoc {
  const data = videoBlendDataOf(object);
  return (channel === "a" ? data?.a : data?.b) ?? EMPTY_CHANNEL;
}

export function createVideoBlendSlice(
  _set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "addVideoBlendClip"
  | "removeVideoBlendClip"
  | "selectVideoBlendClip"
  | "clearVideoBlendClips"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const { applyActiveScene, objectWithFeature } = ctx;

  return {
    // ------------------------------------------------------------ 视频混合（贴图）

    addVideoBlendClip(objectId, channel, clipId) {
      const object = objectWithFeature(objectId, DEFAULT_SLOT_COMPONENT.videoBlend);
      if (object === undefined) {
        return false;
      }

      const channelData = channelOf(object, channel);
      const already = channelData.clips.includes(clipId);
      // 原来选中的那条要是还在，就不抢（正放着 A 加一条 B，选择不该被顶掉）
      const hadPicked = channelData.picked;

      return applyActiveScene("添加混合视频", (scene) => {
        if (!already) {
          setSceneVideoBlendClips(scene, objectId, channel, [...channelData.clips, clipId]);
        }

        if (hadPicked === undefined) {
          // 之前一条都没选（或这条通道本来是空的）：加进来的这条就是现在要放的
          setSceneVideoBlendPicked(scene, objectId, channel, clipId);
        }
      });
    },

    removeVideoBlendClip(objectId, channel, clipId) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const object = findSceneByName(get().scenes, sceneName)?.objects.find(
        (item) => item.id === objectId,
      );
      if (object === undefined) {
        return false;
      }

      const clips = channelOf(object, channel).clips;
      if (!clips.includes(clipId)) {
        return false;
      }

      // 「选中的那条」由 `setVideoBlendClips` 一起收拾（见 `shared.ts` 的 `syncMediaSideData`）
      return applyActiveScene("移除混合视频", (scene) => {
        setSceneVideoBlendClips(
          scene,
          objectId,
          channel,
          clips.filter((id) => id !== clipId),
        );
      });
    },

    selectVideoBlendClip(objectId, channel, clip) {
      if (objectWithFeature(objectId, DEFAULT_SLOT_COMPONENT.videoBlend) === undefined) {
        return false;
      }

      // 单选：只能选**这条通道加进来的**那几条（`setVideoBlendPicked` 会把不在列表里的拒掉）
      return applyActiveScene("选择混合视频", (scene) => {
        setSceneVideoBlendPicked(scene, objectId, channel, clip);
      });
    },

    clearVideoBlendClips(objectId, channel) {
      return applyActiveScene("清空混合视频列表", (scene) => {
        setSceneVideoBlendClips(scene, objectId, channel, []);
      });
    },
  };
}
