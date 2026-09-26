/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 视频混合（贴图）：两条通道（A 盖住 / B 擦开露出）的列表与选中，以及**播放记账**。
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
import {
  withVideoBlendPaused,
  withVideoBlendPlaying,
  withVideoBlendStopped,
  type VideoBlendPlaybackEntry,
} from "../../services/video-blend-playback";
import {
  pruneVideoBlendReveal,
  withVideoBlendEraseBatch,
} from "../../services/video-blend-reveal";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { makeLog, findSceneByName } from "../store-core";
import { type StoreContext } from "../store-context";

/** 手写文件里可能整份 data 都没有：按空通道显示。 */
const EMPTY_CHANNEL: VideoBlendChannelDoc = { clips: [] };

/** 取对象上某条通道（读口；对象没有这个组件也返回空通道）。 */
function channelOf(object: GameObjectDoc, channel: VideoBlendChannel): VideoBlendChannelDoc {
  const data = videoBlendDataOf(object);
  return (channel === "a" ? data?.a : data?.b) ?? EMPTY_CHANNEL;
}

/** 两条通道当前选中的视频（没选的就不列进来）——下发记账的快照与日志都用它。 */
function pickedClipsOf(object: GameObjectDoc): string[] {
  const data = videoBlendDataOf(object);
  return [data?.a.picked, data?.b.picked].filter((clip): clip is string => clip !== undefined);
}

export function createVideoBlendSlice(
  set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "playVideoBlend"
  | "pauseVideoBlend"
  | "resumeVideoBlend"
  | "stopVideoBlend"
  | "flushVideoBlendPlayback"
  | "openVideoBlendMask"
  | "eraseVideoBlendMask"
  | "flushVideoBlendReveal"
  | "addVideoBlendClip"
  | "removeVideoBlendClip"
  | "selectVideoBlendClip"
  | "clearVideoBlendClips"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const {
    pushLog,
    applyActiveScene,
    objectWithFeature,
    videoBlendTargetOf,
    deliverVideo,
    deliverVideoMaskErase,
    canRevealVideoBlend,
    frontendReady,
    runtimeClient,
  } = ctx;

  return {
    // ---------------------------------------------------------------- 视频混合（贴图）

    playVideoBlend(objectId) {
      const object = videoBlendTargetOf(objectId, "播放混合视频");
      if (object === null) {
        return undefined;
      }

      const clips = pickedClipsOf(object);
      if (clips.length === 0) {
        // `videoBlendTargetOf` 已经拦过这种情况，这里只是把类型收窄（同时兜住手写文件的坏数据）
        pushLog(makeLog("warn", `播放混合视频失败：「${object.name}」还没选要放哪一条视频`));
        return undefined;
      }

      // 先记账（「这个对象现在该混合放什么」），再尽力下发——所以编辑器没连服务端 / 前端不在
      // 也点得动：状态记着，等前端连上补发
      const blend = videoBlendDataOf(object);
      const entry: Omit<VideoBlendPlaybackEntry, "paused"> = {
        objectId,
        clips,
        loop: blend?.loop ?? false,
        audio: blend?.audio ?? "none",
      };
      set({ videoBlendPlayback: withVideoBlendPlaying(get().videoBlendPlayback, entry) });

      return deliverVideo("play_video", objectId, `播放混合视频（${clips.join(" + ")}）`);
    },

    pauseVideoBlend(objectId) {
      const object = videoBlendTargetOf(objectId, "暂停混合视频");
      if (object === null) {
        return undefined;
      }

      // 没在记账里 = 这个对象没在放：写明白，别发一条注定被前端拒的命令
      if (get().videoBlendPlayback.objects[objectId] === undefined) {
        pushLog(makeLog("warn", `暂停混合视频失败：「${object.name}」没在放视频`));
        return undefined;
      }

      set({ videoBlendPlayback: withVideoBlendPaused(get().videoBlendPlayback, objectId, true) });
      return deliverVideo("pause_video", objectId, "暂停混合视频");
    },

    resumeVideoBlend(objectId) {
      const object = videoBlendTargetOf(objectId, "继续播放混合视频");
      if (object === null) {
        return undefined;
      }

      if (get().videoBlendPlayback.objects[objectId] === undefined) {
        pushLog(makeLog("warn", `继续播放混合视频失败：「${object.name}」没在放视频（先点「播放」）`));
        return undefined;
      }

      set({ videoBlendPlayback: withVideoBlendPaused(get().videoBlendPlayback, objectId, false) });
      return deliverVideo("resume_video", objectId, "继续播放混合视频");
    },

    stopVideoBlend(objectId) {
      // 停**不要求**还选着视频 / 还是贴图：对象被改成别的类型之后，前端那一层还挂着，
      // 「停止」得照样能拆掉它
      const object = findSceneByName(get().scenes, get().activeSceneName)?.objects.find(
        (item) => item.id === objectId,
      );

      const tracked = get().videoBlendPlayback.objects[objectId] !== undefined;
      if (object === undefined && !tracked) {
        pushLog(makeLog("warn", `停止混合视频失败：找不到这个对象（${objectId}）`));
        return undefined;
      }

      set({ videoBlendPlayback: withVideoBlendStopped(get().videoBlendPlayback, objectId) });
      return deliverVideo("stop_video", objectId, "停止混合视频");
    },

    flushVideoBlendPlayback() {
      const { runtime, videoBlendPlayback } = get();
      if (!runtimeClient.connected || runtime.client === null) {
        return 0;
      }

      const entries = Object.values(videoBlendPlayback.objects);
      for (const entry of entries) {
        // 补发不发日志（逐条写会把运行日志刷屏），末尾汇总一条
        deliverVideo("play_video", entry.objectId, "补发混合视频", true);

        // 暂停态：先放再暂停，前端才回到同一帧（只发 pause 的话它根本没在放）
        if (entry.paused) {
          deliverVideo("pause_video", entry.objectId, "补发混合视频（暂停）", true);
        }
      }

      if (entries.length > 0) {
        const paused = entries.filter((entry) => entry.paused).length;
        pushLog(
          makeLog(
            "info",
            `补发混合视频：${entries.length} 个对象${paused === 0 ? "" : `（其中 ${paused} 个是暂停态）`}` +
              "（前端刚连上，把它还没看到的那些放送补过去）",
          ),
        );
      }

      return entries.length;
    },

    // ---------------------------------------------------------------- 视频混合（Mask 窗口）

    openVideoBlendMask(objectId) {
      set({ videoBlendMask: objectId !== null, videoBlendMaskTarget: objectId });
    },

    eraseVideoBlendMask(objectId, points, done) {
      // 编辑态：Mask 窗口只是预览（擦了不写文档、也不下发），与「运行」之前完全一样
      if (get().mode !== "run" || points.length === 0) {
        return undefined;
      }

      // 擦遮罩只要求「挂着视频混合组件」——选没选视频是**播放**的事，与遮罩无关
      const object = objectWithFeature(objectId, DEFAULT_SLOT_COMPONENT.videoBlend);
      if (object === undefined) {
        pushLog(makeLog("warn", `擦除视频混合遮罩失败：「${objectId}」没有视频混合组件`));
        return undefined;
      }

      // 逐批记账：拖动中的相邻批次在记账里并成**一条完整轨迹**（补发时要的是整笔）
      set({ videoBlendReveal: withVideoBlendEraseBatch(get().videoBlendReveal, objectId, points) });

      const requestId = deliverVideoMaskErase(objectId, points);
      if (!done) {
        return requestId;
      }

      const entry = get().videoBlendReveal.objects[objectId];
      const strokes = (entry?.ops ?? []).filter((op) => op.kind === "stroke").length;
      const total = (entry?.ops ?? []).reduce(
        (count, op) => count + (op.kind === "stroke" ? op.stroke.points.length : 0),
        0,
      );
      const what = `「${object.name}」第 ${strokes} 笔（${total} 个落点）`;

      pushLog(
        frontendReady()
          ? makeLog("info", `下发擦除：${what}（请前端沿轨迹擦掉混合遮罩）`)
          : makeLog(
              "info",
              `已记录擦除：${what}（${
                runtimeClient.connected
                  ? "前端未连接，等它连上后自动补发"
                  : "编辑器还没连上服务端，连上后自动补发"
              }）`,
            ),
      );

      return requestId;
    },

    flushVideoBlendReveal() {
      const { videoBlendReveal } = get();
      if (!frontendReady()) {
        return 0;
      }

      // 先按当前文档筛掉没意义的记录（对象被删了 / 组件摘了），免得补发一堆注定失败的命令
      const pruned = pruneVideoBlendReveal(videoBlendReveal, canRevealVideoBlend);
      const entries = Object.entries(pruned.objects).map(([objectId, entry]) => ({ objectId, entry }));

      let steps = 0;
      for (const { objectId, entry } of entries) {
        for (const op of entry.ops) {
          if (op.kind === "stroke") {
            deliverVideoMaskErase(objectId, op.stroke.points);
            steps += 1;
          }
        }
      }

      if (pruned !== videoBlendReveal) {
        set({ videoBlendReveal: pruned });
      }

      if (steps === 0) {
        return 0;
      }

      pushLog(
        makeLog(
          "info",
          `补发视频混合：${entries.length} 张贴图 / ${steps} 步（前端刚连上，把它还没看到的擦除补过去）`,
        ),
      );
      return steps;
    },

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
