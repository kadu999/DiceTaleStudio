// 本文件从 `commands.ts` 拆出（纯搬运，行为不变）：视频（地图 / 精灵）命令。
import type { Draft } from "immer";
import { DEFAULT_SLOT_COMPONENT } from "../presets";
// 特性的读写一律走访问器（「数据存在哪个组件里」只有 access.ts 知道）
import { ensureVideoData, removeFeature, videoDataOf, writeFeature } from "../access";
import {
  dedupeItems,
  sameItemList,
  setMediaPicked,
  syncMediaSideData,
  withMediaData,
  withObject,
} from "./shared";
import type { SceneDoc } from "../types";

// ---------------------------------------------------------------- 视频（地图 / 精灵）

/**
 * 打开 / 关掉这个对象的**视频总开关**。
 *
 * 与战争雾的总开关（`setMapFogEnabled`）完全同一套规矩：
 * - **关掉不清列表**——「先关掉看看效果、再打开」不该逼人重新加一遍（`{ enabled: false, clips }`）；
 * - **打开**：`video` 先在（只是关着）就把 `enabled` 翻回来；不在就写一份
 *   `{ enabled: true, clips: [] }`（开关状态本身也是要存的数据）；
 * - 一个视频都没加的时候关掉：`video` 整个删掉（与「从没开过」同义，文件里不留空壳）；
 * - 关着时前端不建视频层，`play_video` 这类命令会被明确拒掉（前端读 `video.enabled`）。
 *
 * 返回 `false` 表示没有变更（对象不提供视频组件、或开关本来就是这个状态）。
 */
export function setVideoEnabled(
  scene: Draft<SceneDoc>,
  objectId: string,
  enabled: boolean,
): boolean {
  return withObject(scene, objectId, (object) => {
    const video = videoDataOf(object);
    if (enabled) {
      if (video !== undefined && video.enabled !== false) {
        return false;
      }

      // **整份留着、只把开关翻回来**：`clips` / `picked` / `loop` / `audio` 一个都不能丢
      // （`map.fog.enabled` 那边能重建是因为它只有 regions；视频字段多，重建会悄悄丢掉选中）
      if (video === undefined) {
        const created = ensureVideoData(object);
        if (created === undefined) return false;
        created.enabled = true;
      } else {
        writeFeature(object, DEFAULT_SLOT_COMPONENT.video, { ...video, enabled: true });
      }
      return true;
    }

    if (video === undefined || video.enabled === false) {
      return false;
    }

    if (video.clips.length === 0) {
      // 没加过视频：没有内容要记了，**组件整个摘掉**（与「从没开过」同义）
      return removeFeature(object, DEFAULT_SLOT_COMPONENT.video);
    }

    writeFeature(object, DEFAULT_SLOT_COMPONENT.video, { ...video, enabled: false });
    return true;
  });
}

/**
 * 替换视频列表（资源逻辑 ID）。
 *
 * 这是「**加进来 / 移出去**」那件事（界面上在「编辑视频」窗口里做）：只保证内容是去空、
 * 去重后的逻辑 ID，不排序——顺序是用户加进来的顺序，没有语义。
 *
 * 列表一变，**挂在具体文件上的东西跟着走**（见 `shared.ts` 的 `syncMediaSideData`）。
 *
 * 清空时（**开关开着**）留一份 `{ enabled: true, clips: [] }`——「开着但还没加视频」，
 * 属性面板那一组与开关状态都还在；**开关关着**才把 `video` 整个删掉（与 `setMapFogRegions`
 * 收尾雾区的方式同一条规矩）。
 */
export function setVideoClips(
  scene: Draft<SceneDoc>,
  objectId: string,
  clips: readonly string[],
): boolean {
  return withMediaData(scene, objectId, ensureVideoData, (video, object) => {
    const next = dedupeItems(clips);
    if (sameItemList(next, video.clips)) {
      return false;
    }

    if (next.length === 0 && video.enabled === false) {
      // 关着且一个都不剩：没有内容要记了，**组件整个摘掉**（与「从没开过」同义）
      removeFeature(object, DEFAULT_SLOT_COMPONENT.video);
      return true;
    }

    video.clips = next;
    syncMediaSideData(video);
    return true;
  });
}

/**
 * 选中 / 取消选中「加进来的视频里放哪一条」（`null` = 取消选中）。
 *
 * 只能选 `clips` 里的（不在列表里 = 数据对不上，直接拒掉，不悄悄把它加进去）；
 * 值没变返回 false，于是连点同一条不会往撤销栈里塞空记录。
 */
export function setVideoPicked(
  scene: Draft<SceneDoc>,
  objectId: string,
  clipId: string | null,
): boolean {
  return setMediaPicked(scene, objectId, ensureVideoData, (video) => video.clips, clipId);
}

/** 循环播放开关（前端 `VideoPlayer.isLooping`）；值没变返回 false。 */
export function setVideoLoop(
  scene: Draft<SceneDoc>,
  objectId: string,
  loop: boolean,
): boolean {
  return withMediaData(scene, objectId, ensureVideoData, (video) => {
    if (video.loop === loop) {
      return false;
    }

    video.loop = loop;
    return true;
  });
}

/** 视频自带声音的开关（前端 `VideoPlayer.audioOutputMode`）；值没变返回 false。 */
export function setVideoAudio(
  scene: Draft<SceneDoc>,
  objectId: string,
  audio: boolean,
): boolean {
  return withMediaData(scene, objectId, ensureVideoData, (video) => {
    if (video.audio === audio) {
      return false;
    }

    video.audio = audio;
    return true;
  });
}

/** Set whether this object's selected video starts when its scene activates. */
export function setVideoAutoPlay(
  scene: Draft<SceneDoc>,
  objectId: string,
  autoPlay: boolean,
): boolean {
  return withMediaData(scene, objectId, ensureVideoData, (video) => {
    if (video.autoPlay === autoPlay) {
      return false;
    }

    video.autoPlay = autoPlay;
    return true;
  });
}
