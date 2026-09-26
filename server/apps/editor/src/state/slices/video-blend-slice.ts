/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 视频混合（贴图）：两条通道（A 盖住 / B 擦开露出）的列表与选中，以及**播放记账**。
 */
import {
  DEFAULT_SLOT_COMPONENT,
  setVideoBlendChannelId as setSceneVideoBlendChannelId,
  setVideoBlendChannelKind as setSceneVideoBlendChannelKind,
  videoBlendDataOf,
  type GameObjectDoc,
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
  withVideoBlendFill,
} from "../../services/video-blend-reveal";
import { MASK_BRUSH_RATIO, VIDEO_BLEND_MASK_SOFTNESS } from "../../services/mask-math";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { makeLog, findSceneByName } from "../store-core";
import { type StoreContext } from "../store-context";

/** 两路当前选中的素材（没选的就不列进来）——下发记账的快照与日志都用它。 */
function pickedIdsOf(object: GameObjectDoc): string[] {
  const data = videoBlendDataOf(object);
  return [data?.a.id, data?.b.id].filter((id): id is string => id !== undefined);
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
  | "fillVideoBlendMask"
  | "flushVideoBlendReveal"
  | "setVideoBlendChannelKind"
  | "setVideoBlendChannelId"
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

      const sources = pickedIdsOf(object);
      if (sources.length === 0) {
        // `videoBlendTargetOf` 已经拦过这种情况，这里只是把类型收窄（同时兜住手写文件的坏数据）
        pushLog(makeLog("warn", `播放混合视频失败：「${object.name}」还没选要放的素材（图片 / 视频）`));
        return undefined;
      }

      // 先记账（「这个对象现在该混合放什么」），再尽力下发——所以编辑器没连服务端 / 前端不在
      // 也点得动：状态记着，等前端连上补发
      const blend = videoBlendDataOf(object);
      const entry: Omit<VideoBlendPlaybackEntry, "paused"> = {
        objectId,
        sources,
        loop: blend?.loop ?? false,
        audio: blend?.audio ?? "none",
      };
      set({ videoBlendPlayback: withVideoBlendPlaying(get().videoBlendPlayback, entry) });

      return deliverVideo("play_video", objectId, `播放混合视频（${sources.join(" + ")}）`);
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
      // 笔刷参数与 `deliverVideoMaskErase` 下发的那份一致（半径同雾、软边 0.5 有实心核）
      set({
        videoBlendReveal: withVideoBlendEraseBatch(
          get().videoBlendReveal,
          objectId,
          points,
          MASK_BRUSH_RATIO,
          VIDEO_BLEND_MASK_SOFTNESS,
        ),
      });

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

    fillVideoBlendMask(objectId, covered) {
      // 编辑态：Mask 窗口只是预览（不写文档、也不下发），与擦一笔同一条规矩
      if (get().mode !== "run") {
        return undefined;
      }

      // 与擦一笔同一档：只要求「挂着视频混合组件」（选没选素材是**播放**的事，与遮罩无关）
      const object = objectWithFeature(objectId, DEFAULT_SLOT_COMPONENT.videoBlend);
      if (object === undefined) {
        pushLog(
          makeLog(
            "warn",
            `整张${covered ? "盖住" : "擦开"}视频混合遮罩失败：「${objectId}」没有视频混合组件`,
          ),
        );
        return undefined;
      }

      // 与擦一笔记在**同一条有序序列**里：盖住要抹掉它之前擦开的，顺序不能丢
      set({ videoBlendReveal: withVideoBlendFill(get().videoBlendReveal, objectId, covered) });

      const what = `「${object.name}」整张${covered ? "盖住（遮罩 = 1）" : "擦开（遮罩 = 0）"}`;
      if (!frontendReady()) {
        pushLog(
          makeLog(
            "info",
            `已记录整张${covered ? "盖住" : "擦开"}：${what}（${
              runtimeClient.connected
                ? "前端未连接，等它连上后自动补发"
                : "编辑器还没连上服务端，连上后自动补发"
            }）`,
          ),
        );
        return undefined;
      }

      const requestId = runtimeClient.sendCommand({ kind: "fill_video_mask", objectId, covered });
      pushLog(makeLog("info", `下发整张${covered ? "盖住" : "擦开"}：${what}`));
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
          } else if (op.kind === "fill") {
            // 整张盖住 / 擦开（Mask 窗口右边那两个「整张」按钮）
            runtimeClient.sendCommand({ kind: "fill_video_mask", objectId, covered: op.covered });
          } else {
            // 雾的「整区」那一档不该出现在视频混合的记账里：跳过，宁可不发也别发错命令
            continue;
          }

          steps += 1;
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

    setVideoBlendChannelKind(objectId, channel, kind) {
      if (objectWithFeature(objectId, DEFAULT_SLOT_COMPONENT.videoBlend) === undefined) {
        return false;
      }

      // 换种类会把这一路已选的素材清掉（见 `commands/video-blend.ts` 的说明）
      return applyActiveScene("切换混合素材种类", (scene) => {
        setSceneVideoBlendChannelKind(scene, objectId, channel, kind);
      });
    },

    setVideoBlendChannelId(objectId, channel, id) {
      if (objectWithFeature(objectId, DEFAULT_SLOT_COMPONENT.videoBlend) === undefined) {
        return false;
      }

      return applyActiveScene(id === null ? "清除混合素材" : "选择混合素材", (scene) => {
        setSceneVideoBlendChannelId(scene, objectId, channel, id);
      });
    },
  };
}
