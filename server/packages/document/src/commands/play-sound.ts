// 本文件从 `commands.ts` 拆出（纯搬运，行为不变）：声音对象（动作对象）命令。
import type { Draft } from "immer";
// 特性的读写一律走访问器（「数据存在哪个组件里」只有 access.ts 知道）
import { ensureSoundData } from "../access";
import { findObject } from "./shared";
import type { SceneDoc, SoundDataDoc, SoundLayer } from "../types";

// ---------------------------------------------------------------- 声音对象（动作对象）

/**
 * 替换声音对象的音频列表（资源逻辑 ID）。
 *
 * 这是「**加进来 / 移出去**」那件事（界面上在「编辑声音」窗口里做）：只保证内容是去空、
 * 去重后的逻辑 ID，不排序——顺序是用户加进来的顺序，没有语义。
 *
 * 列表一变，**挂在具体文件上的东西跟着走**（见 `syncSoundSideData`）。
 */
export function setSoundClips(
  scene: Draft<SceneDoc>,
  objectId: string,
  clips: readonly string[],
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const sound = ensureSoundData(object);
  if (sound === undefined) {
    return false;
  }

  const next: string[] = [];
  for (const clip of clips) {
    const trimmed = clip.trim();
    if (trimmed.length > 0 && !next.includes(trimmed)) {
      next.push(trimmed);
    }
  }

  if (next.length === sound.clips.length && next.every((id, index) => id === sound.clips[index])) {
    return false;
  }

  sound.clips = next;
  syncSoundSideData(sound);
  return true;
}

/**
 * 列表变更后收拾「按文件记」的副作用：移出去的名字不留（不然文件里攒下一堆看不见的孤儿
 * 名字），选中的那条还在列表里就行。
 *
 * 兜底「没选就默认选第一条」是**故意的**：加进来一条音频却没被选上时，面板上看着有东西、
 * 「播放」却是灰的，很容易以为是坏的。
 */
function syncSoundSideData(sound: Draft<SoundDataDoc>): void {
  if (sound.names !== undefined) {
    for (const clipId of Object.keys(sound.names)) {
      if (!sound.clips.includes(clipId)) {
        delete sound.names[clipId];
      }
    }

    if (Object.keys(sound.names).length === 0) {
      // 一条名字都不剩：字段整个删掉，不留空壳
      delete sound.names;
    }
  }

  const fallback = sound.clips[0];
  if (sound.picked === undefined) {
    if (fallback !== undefined) {
      sound.picked = fallback;
    }

    return;
  }

  if (!sound.clips.includes(sound.picked)) {
    // 移出去的正好是选中的那条：顺到剩下的第一条；一条不剩就不留这个字段
    if (fallback === undefined) {
      delete sound.picked;
    } else {
      sound.picked = fallback;
    }
  }
}

/**
 * 选中 / 取消选中「加进来的音频里播哪一条」（`null` = 取消选中）。
 *
 * 只能选 `clips` 里的（不在列表里 = 数据对不上，直接拒掉，不悄悄把它加进去）；
 * 值没变返回 false，于是连点同一条不会往撤销栈里塞空记录。
 */
export function setSoundPicked(
  scene: Draft<SceneDoc>,
  objectId: string,
  clipId: string | null,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const sound = ensureSoundData(object);
  if (sound === undefined) {
    return false;
  }

  if (clipId === null) {
    if (sound.picked === undefined) {
      return false;
    }

    delete sound.picked;
    return true;
  }

  if (!sound.clips.includes(clipId) || sound.picked === clipId) {
    return false;
  }

  sound.picked = clipId;
  return true;
}

/** 改声音层级（同层同时只响一条的那「一层」）。 */
export function setSoundLayer(
  scene: Draft<SceneDoc>,
  objectId: string,
  layer: SoundLayer,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const sound = ensureSoundData(object);
  if (sound === undefined || sound.layer === layer) {
    return false;
  }

  sound.layer = layer;
  return true;
}

/**
 * 给**某一个音频文件**起显示名（空 = 删掉这个名字，退回素材文件名）。
 *
 * 名字按文件记（`names[clipId]`），所以加进来的哪条都能起名、选不选中都一样；它只是编辑器里
 * 给人看的标签：不参与播放、不进协议。`sound` 字段缺失时先补出来（与其它声音命令同一个兜底）。
 */
export function setSoundClipName(
  scene: Draft<SceneDoc>,
  objectId: string,
  clipId: string,
  name: string,
): boolean {
  const object = findObject(scene, objectId);
  if (object === undefined) {
    return false;
  }

  const sound = ensureSoundData(object);
  if (sound === undefined) {
    return false;
  }

  const trimmed = name.trim();
  if (!sound.clips.includes(clipId)) {
    // 名字挂在**加进来的音频**上：不在列表里就是数据对不上（列表变更时这类名字也会被清掉）
    return false;
  }

  const current = sound.names?.[clipId] ?? "";
  if (trimmed === current) {
    return false;
  }

  if (trimmed.length === 0) {
    // 留空 = 不要这个自定义名（文件里不留空字符串）
    if (sound.names !== undefined) {
      delete sound.names[clipId];
      if (Object.keys(sound.names).length === 0) {
        // 一条名字都没有了：字段整个删掉，不留空壳
        delete sound.names;
      }
    }
  } else {
    sound.names = { ...(sound.names ?? {}), [clipId]: trimmed };
  }

  return true;
}
