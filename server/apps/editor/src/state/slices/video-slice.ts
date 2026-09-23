/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 视频（地图 / 贴图）：列表、选中、开关与下发播放。
 */
import {
  FEATURE_COMPONENT,
  videoDataOf,
  setVideoAudio as setSceneVideoAudio,
  setVideoAutoPlay as setSceneVideoAutoPlay,
  setVideoClipName as setSceneVideoClipName,
  setVideoClips as setSceneVideoClips,
  setVideoEnabled as setSceneVideoEnabled,
  setVideoLoop as setSceneVideoLoop,
  setVideoPicked as setSceneVideoPicked,
} from "@dts/document";
import {
  withVideoPaused,
  withVideoPlaying,
  withVideoStopped,
  type VideoPlaybackEntry,
} from "../../services/video-playback";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { makeLog, findSceneByName } from "../store-core";
import { type StoreContext } from "../store-context";

export function createVideoSlice(
  set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "playVideo"
  | "pauseVideo"
  | "resumeVideo"
  | "stopVideo"
  | "flushVideoPlayback"
  | "openVideoEditor"
  | "setVideoEnabled"
  | "addVideoClip"
  | "removeVideoClip"
  | "selectVideoClip"
  | "setVideoClipName"
  | "setVideoLoop"
  | "setVideoAudio"
  | "setVideoAutoPlay"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const { pushLog, runtimeClient, videoTargetOf, objectWithFeature, deliverVideo } = ctx;

  return {
    // ---------------------------------------------------------------- 视频（地图 / 贴图）

    playVideo(objectId) {
      const object = videoTargetOf(objectId, "播放视频");
      if (object === null) {
        return undefined;
      }

      const video = videoDataOf(object);
      const clip = video?.picked;
      if (clip === undefined) {
        // `videoTargetOf` 已经拦过这种情况，这里只是把类型收窄（同时兜住手写文件的坏数据）
        pushLog(makeLog("warn", `播放视频失败：「${object.name}」还没选要放哪一条视频`));
        return undefined;
      }

      // 先记账（「这个对象现在该放什么」），再尽力下发——所以编辑器没连服务端 / 前端不在
      // 也点得动：状态记着，等前端连上补发
      const entry: Omit<VideoPlaybackEntry, "paused"> = {
        objectId,
        clip,
        loop: video?.loop ?? false,
        audio: video?.audio ?? false,
      };
      set({ videoPlayback: withVideoPlaying(get().videoPlayback, entry) });

      return deliverVideo("play_video", objectId, `播放视频（${clip}）`);
    },

    pauseVideo(objectId) {
      const object = videoTargetOf(objectId, "暂停视频");
      if (object === null) {
        return undefined;
      }

      // 没在记账里 = 这个对象没在放：写明白，别发一条注定被前端拒的命令
      if (get().videoPlayback.objects[objectId] === undefined) {
        pushLog(makeLog("warn", `暂停视频失败：「${object.name}」没在放视频`));
        return undefined;
      }

      set({ videoPlayback: withVideoPaused(get().videoPlayback, objectId, true) });
      return deliverVideo("pause_video", objectId, "暂停视频");
    },

    resumeVideo(objectId) {
      const object = videoTargetOf(objectId, "继续播放视频");
      if (object === null) {
        return undefined;
      }

      if (get().videoPlayback.objects[objectId] === undefined) {
        pushLog(makeLog("warn", `继续播放失败：「${object.name}」没在放视频（先点「播放」）`));
        return undefined;
      }

      set({ videoPlayback: withVideoPaused(get().videoPlayback, objectId, false) });
      return deliverVideo("resume_video", objectId, "继续播放视频");
    },

    stopVideo(objectId) {
      // 停**不要求**还选着一条视频 / 还是地图或贴图：对象被改成别的类型之后，
      // 前端那一层还挂着，「停止」得照样能拆掉它
      const object = findSceneByName(get().scenes, get().activeSceneName)?.objects.find(
        (item) => item.id === objectId,
      );

      const tracked = get().videoPlayback.objects[objectId] !== undefined;
      if (object === undefined && !tracked) {
        pushLog(makeLog("warn", `停止视频失败：找不到这个对象（${objectId}）`));
        return undefined;
      }

      set({ videoPlayback: withVideoStopped(get().videoPlayback, objectId) });
      return deliverVideo("stop_video", objectId, "停止视频");
    },

    flushVideoPlayback() {
      const { runtime, videoPlayback } = get();
      if (!runtimeClient.connected || runtime.client === null) {
        return 0;
      }

      const entries = Object.values(videoPlayback.objects);
      for (const entry of entries) {
        // 补发不发日志（逐条写会把运行日志刷屏），末尾汇总一条
        deliverVideo("play_video", entry.objectId, "补发视频", true);

        // 暂停态：先放再暂停，前端才回到同一帧（只发 pause 的话它根本没在放）
        if (entry.paused) {
          deliverVideo("pause_video", entry.objectId, "补发视频（暂停）", true);
        }
      }

      if (entries.length > 0) {
        const paused = entries.filter((entry) => entry.paused).length;
        pushLog(
          makeLog(
            "info",
            `补发视频：${entries.length} 个对象${paused === 0 ? "" : `（其中 ${paused} 个是暂停态）`}` +
              "（前端刚连上，把它还没看到的那些放送补过去）",
          ),
        );
      }

      return entries.length;
    },

    // ------------------------------------------------------------ 视频（地图 / 贴图）

    openVideoEditor(objectId) {
      set({ videoEditor: objectId !== null, videoEditorTarget: objectId });
      if (objectId !== null) {
        // 与「选择音频」同一条规矩：素材由外部提交进 Assets/video/，打开时刷一次目录
        void get().refreshTree();
      }
    },

    setVideoEnabled(objectId, enabled) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const changed = get().applyScenes(enabled ? "启用视频" : "关闭视频", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneVideoEnabled(scene, objectId, enabled);
        }
      });

      // 关掉了：正开着的「编辑视频」窗口跟着关（那一组已经收起来了）
      if (!enabled && get().videoEditorTarget === objectId) {
        set({ videoEditor: false, videoEditorTarget: null });
      }

      return changed;
    },

    addVideoClip(objectId, clipId) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const object = objectWithFeature(objectId, FEATURE_COMPONENT.video);
      if (object === undefined) {
        return false;
      }

      const video = videoDataOf(object);
      const already = (video?.clips ?? []).includes(clipId);
      // 原来选中的那条要是还在，就不抢（正放着 A 加一条 B，选择不该被顶掉）
      const hadPicked = video?.picked;

      return get().applyScenes("添加视频", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene === undefined) {
          return;
        }

        if (!already) {
          setSceneVideoClips(scene, objectId, [...(video?.clips ?? []), clipId]);
        }

        if (hadPicked === undefined) {
          // 之前一条都没选（或列表本来是空的）：加进来的这条就是现在要放的
          setSceneVideoPicked(scene, objectId, clipId);
        }
      });
    },

    removeVideoClip(objectId, clipId) {
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

      const clips = videoDataOf(object)?.clips ?? [];
      if (!clips.includes(clipId)) {
        return false;
      }

      // 名字与「选中的那条」由 `setVideoClips` 一起收拾（见 `syncVideoSideData`）
      return get().applyScenes("移除视频", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneVideoClips(
            scene,
            objectId,
            clips.filter((id) => id !== clipId),
          );
        }
      });
    },

    selectVideoClip(objectId, clip) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      if (objectWithFeature(objectId, FEATURE_COMPONENT.video) === undefined) {
        return false;
      }

      // 单选：只能选**加进来的**那几条（`setVideoPicked` 会把不在列表里的拒掉）。
      // 名字按文件记，换选不动它。
      return get().applyScenes("选择视频", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneVideoPicked(scene, objectId, clip);
        }
      });
    },

    setVideoClipName(objectId, clipId, name) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes("修改视频名字", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneVideoClipName(scene, objectId, clipId, name);
        }
      });
    },

    setVideoLoop(objectId, loop) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes("修改视频循环", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneVideoLoop(scene, objectId, loop);
        }
      });
    },

    setVideoAudio(objectId, audio) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes("修改视频声音", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneVideoAudio(scene, objectId, audio);
        }
      });
    },

    setVideoAutoPlay(objectId, autoPlay) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) return false;

      return get().applyScenes("修改视频自动播放", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) setSceneVideoAutoPlay(scene, objectId, autoPlay);
      }, { coalesceKey: `video-autoplay:${objectId}` });
    },
  };
}
