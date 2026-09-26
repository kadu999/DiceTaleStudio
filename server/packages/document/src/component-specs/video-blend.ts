import { defineComponent } from "../component-spec";
import { DEFAULT_VIDEO_BLEND_AUDIO, DEFAULT_VIDEO_AUTO_PLAY, DEFAULT_VIDEO_LOOP } from "../presets";
import { VIDEO_BLEND_AUDIO, type VideoBlendAudio, type VideoBlendDataDoc } from "../types";

/** 声音来源的中文名（只有这里写中文；取值顺序由 `VIDEO_BLEND_AUDIO` 定）。 */
const AUDIO_LABELS: Record<VideoBlendAudio, string> = {
  none: "静音",
  a: "视频 A",
  b: "视频 B",
};

/**
 * `VideoBlend` 的组件规格。
 *
 * **只有两个标量进规格**（循环 / 声音来源）：它们是无条件简单行、写入没有副作用。
 *
 * 刻意**不进来**的字段，以及各自留在哪条路径上：
 * - 两条通道的 `clips` / `picked`：写入要同步副作用（`setVideoBlendClips` 会顺手收拾
 *   `picked`），与 `VideoOverlay` 同一套理由，继续走 `commands/video-blend.ts`；
 * - **遮罩**：根本不在文档里（纯运行态，由 `erase_video_mask` 命令驱动），没有字段可登记。
 *
 * `defaultData` 给的是**完整**形状（含那两条不归规格管的通道）：补壳出来的组件必须与
 * `validateScene` 的预期一致，少一个字段就会在别处露出来。
 */
export const videoBlendSpec = defineComponent<VideoBlendDataDoc>({
  type: "VideoBlend",
  fields: [
    {
      key: "loop",
      label: "循环",
      kind: "boolean",
      default: DEFAULT_VIDEO_LOOP,
      testId: "video-blend-loop",
      order: 30,
      tooltip: "两条一起循环放；关着 = 各放到最后一帧就停住",
    },
    {
      key: "audio",
      label: "声音",
      kind: "enum",
      // 候选与文档类型同一处（`types.ts` 的 `VIDEO_BLEND_AUDIO`）：加一档只改那一个常量。
      options: VIDEO_BLEND_AUDIO.map((value) => ({ value, label: AUDIO_LABELS[value] })),
      default: DEFAULT_VIDEO_BLEND_AUDIO,
      testId: "video-blend-audio",
      order: 40,
      tooltip: "两条同时放时声音只出一路；默认静音（现场别不小心轰一声）",
    },
    {
      key: "autoPlay",
      label: "自动播放",
      kind: "boolean",
      default: DEFAULT_VIDEO_AUTO_PLAY,
      testId: "video-blend-auto-play",
      order: 50,
      tooltip: "场景激活时自动混合播放选中的两条（与「视频」那个开关同义）",
    },
  ],
  defaultData: () => ({
    a: { clips: [] },
    b: { clips: [] },
    loop: DEFAULT_VIDEO_LOOP,
    autoPlay: DEFAULT_VIDEO_AUTO_PLAY,
    audio: DEFAULT_VIDEO_BLEND_AUDIO,
  }),
});
