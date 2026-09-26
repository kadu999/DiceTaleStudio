import { defineComponent } from "../component-spec";
import {
  DEFAULT_VIDEO_AUDIO,
  DEFAULT_VIDEO_AUTO_PLAY,
  DEFAULT_VIDEO_ENABLED,
  DEFAULT_VIDEO_LOOP,
} from "../presets";
import type { VideoDataDoc } from "../types";

/**
 * `VideoOverlay` 的组件规格。
 *
 * **只有三个开关进规格**（循环 / 声音 / 自动播放）：它们是无条件简单行、写入没有副作用——
 * 是这个机制要照顾的典型形状。
 *
 * 刻意**不进来**的字段，以及各自留在哪条路径上：
 * - `enabled`：关掉且一条视频都没加时，`setVideoEnabled` 会把**整个组件摘掉**
 *   （「与从没开过同义，文件里不留空壳」是这个仓库守的不变量）。泛型写入只会留下一个空壳，
 *   所以它继续走自己的专用命令，由面板的 `VideoSwitch`（带早返回）渲染；
 * - `clips` / `picked` / `names`：列表 + 单选 + 按项记名字，写入要同步副作用
 *   （`setVideoClips` 会顺手收拾 `names` 与 `picked`），继续走 `commands/video.ts`。
 *
 * `defaultData` 给的是**完整**形状（含上面那几个不归规格管的字段）：补壳出来的组件必须与
 * `createGridMapObject` 走的工厂、以及 `validateScene` 的预期一致，少一个字段就会在别处露出来。
 */
export const videoSpec = defineComponent<VideoDataDoc>({
  type: "VideoOverlay",
  fields: [
    {
      key: "loop",
      label: "循环",
      kind: "boolean",
      default: false,
      testId: "video-loop",
      order: 20,
      tooltip: "打开 = 一直循环放（背景视频）；关着 = 放到最后一帧就停住（过场视频）",
    },
    {
      key: "audio",
      label: "声音",
      kind: "boolean",
      default: false,
      testId: "video-audio",
      order: 30,
      tooltip: "视频自带音轨：默认静音，要出声才打开（现场别不小心轰一声）",
    },
    {
      key: "autoPlay",
      label: "自动播放",
      kind: "boolean",
      default: false,
      testId: "video-auto-play",
      order: 40,
      tooltip: "场景激活时自动播放当前选中的视频",
    },
  ],
  // 与 `ensureVideoData` 过去那份内联默认值逐字一致（缺一项就会与工厂 / 校验的口径分叉）；
  // 具体数值仍读 `presets.ts` 的常量，规格只负责「形状 + 是哪几个键」。
  defaultData: () => ({
    enabled: DEFAULT_VIDEO_ENABLED,
    autoPlay: DEFAULT_VIDEO_AUTO_PLAY,
    clips: [],
    loop: DEFAULT_VIDEO_LOOP,
    audio: DEFAULT_VIDEO_AUDIO,
  }),
});
