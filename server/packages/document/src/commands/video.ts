// 本文件从 `commands.ts` 拆出（纯搬运，行为不变）：视频（地图 / 精灵）命令。
import type { Draft } from "immer";
import { DEFAULT_VIDEO_AUDIO, DEFAULT_VIDEO_AUTO_PLAY, DEFAULT_VIDEO_LOOP, FEATURE_COMPONENT, carriesKind } from "../features";
// 特性的读写一律走访问器（「数据存在哪个组件里」只有 access.ts 知道）
import { ensureVideoData, removeFeature, videoDataOf, writeFeature } from "../access";
import { findObject } from "./shared";
import type { SceneDoc, VideoDataDoc } from "../types";

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
 * 返回 `false` 表示没有变更（不是地图 / 精灵、或开关本来就是这个状态）。
 */
export function setVideoEnabled(
  scene: Draft<SceneDoc>,
  objectId: string,
  enabled: boolean,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const video = videoDataOf(object);
  if (video === undefined && !carriesKind(FEATURE_COMPONENT.video, object.kind)) {
    return false;
  }

  if (enabled) {
    if (video !== undefined && video.enabled !== false) {
      return false;
    }

    // **整份留着、只把开关翻回来**：`clips` / `picked` / `names` / `loop` / `audio` 一个都不能丢
    // （`map.fog.enabled` 那边能重建是因为它只有 regions；视频字段多，重建会悄悄丢掉选中与名字）
    writeFeature(
      object,
      FEATURE_COMPONENT.video,
      video === undefined
        ? {
            enabled: true,
            autoPlay: DEFAULT_VIDEO_AUTO_PLAY,
            clips: [],
            loop: DEFAULT_VIDEO_LOOP,
            audio: DEFAULT_VIDEO_AUDIO,
          }
        : { ...video, enabled: true },
    );
    return true;
  }

  if (video === undefined || video.enabled === false) {
    return false;
  }

  if (video.clips.length === 0) {
    // 没加过视频：没有内容要记了，**组件整个摘掉**（与「从没开过」同义）
    return removeFeature(object, FEATURE_COMPONENT.video);
  }

  writeFeature(object, FEATURE_COMPONENT.video, { ...video, enabled: false });
  return true;
}

/**
 * 替换视频列表（资源逻辑 ID）。
 *
 * 这是「**加进来 / 移出去**」那件事（界面上在「编辑视频」窗口里做）：只保证内容是去空、
 * 去重后的逻辑 ID，不排序——顺序是用户加进来的顺序，没有语义。
 *
 * 列表一变，**挂在具体文件上的东西跟着走**（见 `syncVideoSideData`）。
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
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const video = ensureVideoData(object);
  if (video === undefined) {
    return false;
  }

  const next: string[] = [];
  for (const clip of clips) {
    const trimmed = clip.trim();
    if (trimmed.length > 0 && !next.includes(trimmed)) {
      next.push(trimmed);
    }
  }

  if (next.length === video.clips.length && next.every((id, index) => id === video.clips[index])) {
    return false;
  }

  if (next.length === 0 && video.enabled === false) {
    // 关着且一个都不剩：没有内容要记了，**组件整个摘掉**（与「从没开过」同义）
    removeFeature(object, FEATURE_COMPONENT.video);
    return true;
  }

  video.clips = next;
  syncVideoSideData(video);
  return true;
}

/**
 * 列表变更后收拾「按文件记」的副作用：移出去的名字不留（不然文件里攒下一堆看不见的孤儿
 * 名字），选中的那条还在列表里就行。
 *
 * 兜底「没选就默认选第一条」与声音 / 传送同一条理由：加进来一条视频却没被选上时，
 * 面板上看着有东西、「播放」却是灰的，很容易以为是坏的。
 */
function syncVideoSideData(video: Draft<VideoDataDoc>): void {
  if (video.names !== undefined) {
    for (const clipId of Object.keys(video.names)) {
      if (!video.clips.includes(clipId)) {
        delete video.names[clipId];
      }
    }

    if (Object.keys(video.names).length === 0) {
      // 一条名字都不剩：字段整个删掉，不留空壳
      delete video.names;
    }
  }

  const fallback = video.clips[0];
  if (video.picked === undefined) {
    if (fallback !== undefined) {
      video.picked = fallback;
    }

    return;
  }

  if (!video.clips.includes(video.picked)) {
    // 移出去的正好是选中的那条：顺到剩下的第一条；一条不剩就不留这个字段
    if (fallback === undefined) {
      delete video.picked;
    } else {
      video.picked = fallback;
    }
  }
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
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const video = ensureVideoData(object);
  if (video === undefined) {
    return false;
  }

  if (clipId === null) {
    if (video.picked === undefined) {
      return false;
    }

    delete video.picked;
    return true;
  }

  if (!video.clips.includes(clipId) || video.picked === clipId) {
    return false;
  }

  video.picked = clipId;
  return true;
}

/**
 * 给**某一个视频文件**起显示名（空 = 删掉这个名字，退回素材文件名）。
 *
 * 与 `setSoundClipName` 同一套：名字按文件记、只是编辑器里给人看的标签
 * （不参与播放、不进协议），`video` 字段缺失时先补出来。
 */
export function setVideoClipName(
  scene: Draft<SceneDoc>,
  objectId: string,
  clipId: string,
  name: string,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const video = ensureVideoData(object);
  if (video === undefined) {
    return false;
  }

  const trimmed = name.trim();
  if (!video.clips.includes(clipId)) {
    // 名字挂在**加进来的视频**上：不在列表里就是数据对不上（列表变更时这类名字也会被清掉）
    return false;
  }

  const current = video.names?.[clipId] ?? "";
  if (trimmed === current) {
    return false;
  }

  if (trimmed.length === 0) {
    // 留空 = 不要这个自定义名（文件里不留空字符串）
    if (video.names !== undefined) {
      delete video.names[clipId];
      if (Object.keys(video.names).length === 0) {
        delete video.names;
      }
    }
  } else {
    video.names = { ...(video.names ?? {}), [clipId]: trimmed };
  }

  return true;
}

/** 循环播放开关（前端 `VideoPlayer.isLooping`）；值没变返回 false。 */
export function setVideoLoop(
  scene: Draft<SceneDoc>,
  objectId: string,
  loop: boolean,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const video = ensureVideoData(object);
  if (video === undefined || video.loop === loop) {
    return false;
  }

  video.loop = loop;
  return true;
}

/** 视频自带声音的开关（前端 `VideoPlayer.audioOutputMode`）；值没变返回 false。 */
export function setVideoAudio(
  scene: Draft<SceneDoc>,
  objectId: string,
  audio: boolean,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const video = ensureVideoData(object);
  if (video === undefined || video.audio === audio) {
    return false;
  }

  video.audio = audio;
  return true;
}

/** Set whether this object's selected video starts when its scene activates. */
export function setVideoAutoPlay(
  scene: Draft<SceneDoc>,
  objectId: string,
  autoPlay: boolean,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) return false;

  const video = ensureVideoData(object);
  if (video === undefined || video.autoPlay === autoPlay) return false;

  video.autoPlay = autoPlay;
  return true;
}
