// 本文件从 `commands.ts` 拆出（纯搬运，行为不变）：声音对象（动作对象）命令。
import type { Draft } from "immer";
// 特性的读写一律走访问器（「数据存在哪个组件里」只有 access.ts 知道）
import { ensureSoundData } from "../access";
import { setMediaList, setMediaPicked, withMediaData } from "./shared";
import type { SceneDoc, SoundLayer } from "../types";

// ---------------------------------------------------------------- 声音对象（动作对象）

/**
 * 替换声音对象的音频列表（资源逻辑 ID）。
 *
 * 这是「**加进来 / 移出去**」那件事（界面上在「编辑声音」窗口里做）：只保证内容是去空、
 * 去重后的逻辑 ID，不排序——顺序是用户加进来的顺序，没有语义。
 *
 * 列表一变，**挂在具体文件上的东西跟着走**（见 `shared.ts` 的 `syncMediaSideData`）。
 */
export function setSoundClips(
  scene: Draft<SceneDoc>,
  objectId: string,
  clips: readonly string[],
): boolean {
  return setMediaList(
    scene,
    objectId,
    ensureSoundData,
    (sound) => sound,
    (sound) => sound.clips,
    (sound, next) => {
      sound.clips = next;
    },
    clips,
  );
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
  return setMediaPicked(scene, objectId, ensureSoundData, (sound) => sound, (sound) => sound.clips, clipId);
}

/** 改声音层级（同层同时只响一条的那「一层」）。 */
export function setSoundLayer(
  scene: Draft<SceneDoc>,
  objectId: string,
  layer: SoundLayer,
): boolean {
  return withMediaData(scene, objectId, ensureSoundData, (sound) => {
    if (sound.layer === layer) {
      return false;
    }

    sound.layer = layer;
    return true;
  });
}
