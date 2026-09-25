/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 声音对象：音频列表、选中与下发播放。
 */
import {
  DEFAULT_SOUND_LAYER,
  DEFAULT_SLOT_COMPONENT,
  soundDataOf,
  SOUND_LAYER_LABELS,
  setSoundClips as setSceneSoundClips,
  setSoundLayer as setSceneSoundLayer,
  setSoundPicked as setSceneSoundPicked,
} from "@dts/document";
import {
  withPlaying,
  withSoundPaused,
  withStopped,
  type SoundPlaybackEntry,
} from "../../services/sound-playback";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { makeLog } from "../store-core";
import { type StoreContext } from "../store-context";

export function createSoundSlice(
  set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "playSound"
  | "stopSound"
  | "pauseSound"
  | "resumeSound"
  | "flushSoundPlayback"
  | "selectSoundClip"
  | "addSoundClip"
  | "removeSoundClip"
  | "setSoundLayer"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const {
    pushLog,
    applyActiveScene,
    runtimeClient,
    deliverSoundPlay,
    deliverSoundControl,
    objectWithFeature,
    requireSoundObject,
  } = ctx;

  return {
    // ---------------------------------------------------------------- 声音对象

    playSound(objectId) {
      const object = requireSoundObject(objectId);
      if (object === undefined) {
        return undefined;
      }

      const sound = soundDataOf(object);
      const clips = sound?.clips ?? [];
      if (clips.length === 0) {
        pushLog(makeLog("error", `${object.name}：还没有加音频，先在「编辑声音」窗口里加一条`));
        return undefined;
      }

      // 播的就是**选中的那一条**（面板上点小方块切）。手写文件里 `picked` 可能不在列表里，
      // 那种按「还没选」处理，别拿一条对不上的音频去播。
      const picked = sound?.picked;
      if (picked === undefined || !clips.includes(picked)) {
        pushLog(makeLog("error", `${object.name}：还没选声音，先选一条`));
        return undefined;
      }

      /*
        背景音乐不再属于对象（它走顶栏「音乐」弹框 + `play_bgm` 那一组命令）。
        老文件里写着 `layer: "bgm"` 的对象**照样读得回来**，但播放会被前端明确拒掉——
        与其让它走一趟注定失败的下发，不如在这里就说清楚该去哪儿（前端那边也有一份同样的说法）。
      */
      const objectLayer = sound?.layer ?? DEFAULT_SOUND_LAYER;
      if (objectLayer === "bgm") {
        pushLog(
          makeLog(
            "warn",
            `「${object.name}」用的是背景音乐层：背景音乐已改成顶栏「音乐」弹框（点项目音频），` +
              "请把这条改成音效或旁白",
          ),
        );
        return undefined;
      }

      // 先记账（「这一层现在该播什么」），再尽力下发——所以编辑器没连服务端 / 前端不在
      // 也点得动：状态记着，等前端连上补发
      const entry: Omit<SoundPlaybackEntry, "paused"> = {
        objectId,
        layer: objectLayer,
        clips: [picked],
      };
      set({ soundPlayback: withPlaying(get().soundPlayback, entry) });

      return deliverSoundPlay(entry);
    },

    stopSound(objectId) {
      const object = requireSoundObject(objectId);
      if (object === undefined) {
        return undefined;
      }

      const layer = soundDataOf(object)?.layer ?? DEFAULT_SOUND_LAYER;
      set({ soundPlayback: withStopped(get().soundPlayback, layer) });

      return deliverSoundControl("stop_sound", layer, "停止");
    },

    pauseSound(objectId) {
      const object = requireSoundObject(objectId);
      if (object === undefined) {
        return undefined;
      }

      const layer = soundDataOf(object)?.layer ?? DEFAULT_SOUND_LAYER;
      const label = `层级 ${SOUND_LAYER_LABELS[layer]}`;

      // 同层只响一条：这一层不是它在响时，暂停无从谈起——写明是谁在响，别发一条注定没意义的命令
      const holder = get().soundPlayback.layers[layer];
      if (holder === undefined || holder.objectId !== objectId) {
        pushLog(
          makeLog(
            "warn",
            `暂停失败：「${object.name}」所在的${label}没在播它（${
              holder === undefined ? "这一层没在播" : "这一层是别的对象在响"
            }）`,
          ),
        );
        return undefined;
      }

      set({ soundPlayback: withSoundPaused(get().soundPlayback, layer, true) });
      return deliverSoundControl("pause_sound", layer, "暂停");
    },

    resumeSound(objectId) {
      const object = requireSoundObject(objectId);
      if (object === undefined) {
        return undefined;
      }

      const layer = soundDataOf(object)?.layer ?? DEFAULT_SOUND_LAYER;
      const entry = get().soundPlayback.layers[layer];
      if (entry === undefined || entry.objectId !== objectId) {
        pushLog(
          makeLog("warn", `继续播放失败：「${object.name}」所在的层级 ${SOUND_LAYER_LABELS[layer]} 没在播它`),
        );
        return undefined;
      }

      set({ soundPlayback: withSoundPaused(get().soundPlayback, layer, false) });
      return deliverSoundControl("resume_sound", layer, "继续播放");
    },

    flushSoundPlayback() {
      const { runtime, soundPlayback } = get();
      if (!runtimeClient.connected || runtime.client === null) {
        return 0;
      }

      const entries = Object.values(soundPlayback.layers);
      for (const entry of entries) {
        runtimeClient.sendCommand({
          kind: "play_sound",
          objectId: entry.objectId,
          layer: entry.layer,
        });

        // 暂停态：先播再暂停，前端才停在原处（只发 pause 的话它根本没在响）——与视频同一套
        if (entry.paused) {
          runtimeClient.sendCommand({ kind: "pause_sound", layer: entry.layer });
        }

        pushLog(
          makeLog(
            "info",
            `补发播放：层级 ${SOUND_LAYER_LABELS[entry.layer]}（${entry.clips[0] ?? "(空)"}${
              entry.paused ? "，暂停态" : ""
            }）`,
          ),
        );
      }

      return entries.length;
    },

    // ------------------------------------------------------------ 声音对象（动作对象）

    selectSoundClip(objectId, clip) {
      if (objectWithFeature(objectId, DEFAULT_SLOT_COMPONENT.sound) === undefined) {
        return false;
      }

      // 单选：只能选**加进来的**那几条（`setSoundPicked` 会把不在列表里的拒掉）。
      // 名字按文件记，换选不动它。
      return applyActiveScene("选择声音", (scene) => {
        setSceneSoundPicked(scene, objectId, clip);
      });
    },

    addSoundClip(objectId, clipId) {
      const object = objectWithFeature(objectId, DEFAULT_SLOT_COMPONENT.sound);
      if (object === undefined) {
        return false;
      }

      const sound = soundDataOf(object);
      const already = (sound?.clips ?? []).includes(clipId);
      // 原来选中的那条要是还在，就不抢（正听着 A 加一条 B，选择不该被顶掉）
      const hadPicked = sound?.picked;

      return applyActiveScene("添加声音", (scene) => {
        if (!already) {
          setSceneSoundClips(scene, objectId, [...(sound?.clips ?? []), clipId]);
        }

        if (hadPicked === undefined) {
          // 之前一条都没选（或列表本来是空的）：加进来的这条就是现在要播的
          setSceneSoundPicked(scene, objectId, clipId);
        }
      });
    },

    removeSoundClip(objectId, clipId) {
      const object = objectWithFeature(objectId, DEFAULT_SLOT_COMPONENT.sound);
      if (object === undefined) {
        return false;
      }

      const clips = soundDataOf(object)?.clips ?? [];
      if (!clips.includes(clipId)) {
        return false;
      }

      // 名字与「选中的那条」由 `setSoundClips` 一起收拾（见 `shared.ts` 的 `syncMediaSideData`）
      return applyActiveScene("移除声音", (scene) => {
        setSceneSoundClips(
          scene,
          objectId,
          clips.filter((id) => id !== clipId),
        );
      });
    },

    setSoundLayer(objectId, layer) {
      return applyActiveScene("修改声音层级", (scene) => {
        setSceneSoundLayer(scene, objectId, layer);
      });
    },
  };
}
