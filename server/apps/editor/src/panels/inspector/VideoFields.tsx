import { assetDisplayName } from "../asset-info";
import { assetDisplayPath, findAssetByReference } from "../asset-picker";
import { useEditorStore, type EditorMode } from "../../state/editor-store";
import type { RuntimeStatus } from "../../services/runtime-client";
import { isVideoEnabled, videoDataOf, videoSpec, type GameObjectDoc } from "@dts/document";
import {
  FieldRow,
  PLAYBACK_BUTTON_ACTIVE_CLASS,
  PLAYBACK_BUTTON_CLASS,
  PlaybackRow,
  PlaybackStatus,
  type PlaybackState,
} from "./fields";
import { componentFields, descriptorRows, sortInspectorRows } from "./DescriptorRows";

/**
 * 地图 / 贴图的「视频」组：**启用 → 循环 / 声音 / 自动播放 → 视频列表 → 编辑 → 播放 / 暂停 / 停止**。
 *
 * 整组由第一行的**「启用」开关**管着（与战争雾那一组同一套）：关着时只留那一个开关，
 * 加视频 / 选哪条 / 循环 / 声音 / 自动播放都收起来——没开视频的对象不该摆一排用不上的按钮。
 * 开关是**这个对象的文档数据**（`video.enabled`），关着时前端连视频层都不建。
 *
 * 两个地方分工，别混（与「播放声音」同一套）：
 * - **这里（面板）**：把**加进来的视频全列出来**（小方块），点一下决定「放哪一条」；
 * - **「编辑视频」窗口**（`app/VideoEditDialog.tsx`，下面那行「编辑」唤出）：加视频 /
 *   移出 / 起名字——那里看得见每个文件的路径，面板太窄放不下。
 *
 * 编辑器**不播放**：没有预览、不接视频解码。点「播放」只是**记账**（哪个对象该放什么）+
 * 尽力把命令发给前端；所以按钮**不要求前端在场**，没连上时状态记着、等连上补发。
 *
 * 三条语义（前端按同一套实现）：
 * - **每个对象各自一条**：地图放着背景视频时，精灵也能同时放，互不影响；
 * - **一条视频对象一次只放一条**（面板单选）：命令里带的就是选中的那条；
 * - **「循环」「声音」是这张地图 / 贴图自己的设置**（进文档、可撤销），不是界面偏好。
 */

/** 「播放」现在能不能点：一条视频都没加 → 先去窗口里加；加了但没选 → 先选一条。 */
export function videoPlayBlockedReason(input: {
  readonly clips: number;
  readonly picked: string | undefined;
}): string | undefined {
  if (input.clips === 0) {
    return "先加一条视频（点「编辑」从项目里挑）";
  }

  return input.picked === undefined ? "先选一条视频" : undefined;
}

/**
 * 点下去会发生什么：没连上时**照样记账**，只是要等连上才补发——把这件事写在按钮的 tooltip 上。
 *
 * 返回 `undefined` 表示「现在就能发下去」。与 `soundDeliveryHint` 同一套措辞。
 */
export function videoDeliveryHint(input: {
  readonly mode: EditorMode;
  readonly status: RuntimeStatus;
  readonly clientConnected: boolean;
}): string | undefined {
  if (input.mode !== "run" || input.status !== "open") {
    return "已记录：编辑器还没连上服务端，连上后自动补发";
  }

  if (!input.clientConnected) {
    return "已记录：前端（Unity）未连接，等它连上后自动补发";
  }

  return undefined;
}

/** `.webm` 在 Windows 上多半解不了（Unity 走系统的解码器）：选择器与面板都提一句。 */
function formatHint(path: string): string | undefined {
  return path.toLowerCase().endsWith(".webm")
    ? "WebM：Windows 上多半解不了，建议改用 H.264 的 .mp4"
    : undefined;
}

export function VideoFields({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
  const tree = useEditorStore((state) => state.project.tree);
  const assetMetas = useEditorStore((state) => state.assetMetas);
  const playback = useEditorStore((state) => state.videoPlayback);
  const openVideoEditor = useEditorStore((state) => state.openVideoEditor);
  const setVideoEnabled = useEditorStore((state) => state.setVideoEnabled);
  const selectVideoClip = useEditorStore((state) => state.selectVideoClip);
  const playVideo = useEditorStore((state) => state.playVideo);
  const pauseVideo = useEditorStore((state) => state.pauseVideo);
  const resumeVideo = useEditorStore((state) => state.resumeVideo);
  const stopVideo = useEditorStore((state) => state.stopVideo);
  const mode = useEditorStore((state) => state.mode);
  const status = useEditorStore((state) => state.runtime.status);
  const clientConnected = useEditorStore((state) => state.runtime.client !== null);

  const video = videoDataOf(object);
  // 手写文件里可能整个 video 都没有：这里按「没开、还没加视频、不循环、静音」显示
  const enabled = isVideoEnabled(object);
  const clips = video?.clips ?? [];
  const picked = video?.picked;

  /** 面板上显示什么名字：自己起过就用它，否则用素材文件名（去掉扩展名）。 */
  const nameOf = (clip: string): string => {
    const fileName = findAssetByReference(tree, clip, assetMetas)?.name ?? clip;
    return video?.names?.[clip] ?? assetDisplayName(fileName);
  };

  const pickedName = picked === undefined ? "" : nameOf(picked);
  const playBlocked = videoPlayBlockedReason({ clips: clips.length, picked });
  const delivery = videoDeliveryHint({ mode, status, clientConnected });

  /*
    点下去要有**看得见的变化**：记账里就是这个对象 → 按钮写成「播放中 / 已暂停」并高亮。
    记账是运行态（不写文档），所以切场景 / 换项目后会回到「没在播放」。
  */
  const entry = playback.objects[object.id];
  const playingHere = entry !== undefined && !entry.paused;
  const pausedHere = entry !== undefined && entry.paused;
  const playbackState: PlaybackState = playingHere ? "playing" : pausedHere ? "paused" : "idle";
  // 措辞与「播放声音」那一组**完全一致**
  const playbackNote = playingHere
    ? `正在播放：${pickedName}`
    : pausedHere
      ? `已暂停：${pickedName}`
      : "没在播放";

  // 关着就只留开关：没开视频的对象不该摆一排用不上的按钮（与战争雾那一组同一套）
  if (!enabled) {
    return <VideoSwitch checked={false} onChange={(next) => setVideoEnabled(object.id, next)} />;
  }

  return (
    <>
      <VideoSwitch checked onChange={(next) => setVideoEnabled(object.id, next)} />

      {/*
        三个开关（循环 / 声音 / 自动播放）由**组件规格**自动出行（`component-specs/video.ts`）：
        它们是无条件简单行、写入没有副作用，正是那套机制要照顾的形状——加第四个这样的开关
        只需要在规格里加一行，这个文件不用动。

        它们在**列表前面**是有意的（与「播放声音」那一组同骨架：设置在上、条目在中间、控件在下）：
        都是**这张对象的文档数据**（进撤销栈、随场景存盘下发），行名在左、右边只有勾选框
        （与「基础」组的激活 / 锁定同一套），说明收进 title。

        「启用」那一个**不在这里**：关掉它要连带把整个组件摘掉（见 `setVideoEnabled`），
        有副作用，所以它继续由下面的 `VideoSwitch` 手写渲染（且关着时整组早返回）。
      */}
      {sortInspectorRows(descriptorRows(object, videoSpec, componentFields(videoSpec.type))).map(
        (row) => row.node,
      )}

      {/*
        视频那一行：**加进来的全列出来**（单选，选中的那条就是前端会放的）。
        小方块会折行，所以这里自己是一个 `flex-wrap` 容器（`FieldRow` 只管标签那一列）。
      */}
      <FieldRow label="视频">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" data-testid="video-clips">
          {clips.length === 0 ? (
            <span
              data-testid="video-empty"
              className="text-[11px] text-[var(--color-editor-text-dim)]"
              title="点下面的「编辑」从项目里的视频素材里挑"
            >
              还没加视频
            </span>
          ) : (
            clips.map((clip) => {
              const selected = clip === picked;
              const hint = formatHint(clip);
              return (
                <button
                  key={clip}
                  type="button"
                  data-testid="video-clip"
                  data-clip={clip}
                  data-selected={selected}
                  aria-pressed={selected}
                  title={[
                    selected
                      ? `${assetDisplayPath(findAssetByReference(tree, clip, assetMetas)?.id ?? clip)}（就是它会被放；再点一下取消选中）`
                      : `${assetDisplayPath(findAssetByReference(tree, clip, assetMetas)?.id ?? clip)}（点一下改成放它）`,
                    hint,
                  ]
                    .filter((line) => line !== undefined)
                    .join("\n")}
                  className={`max-w-[8rem] truncate rounded border px-1.5 py-0.5 text-[10px] ${
                    selected
                      ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                      : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel-alt)]"
                  }`}
                  onClick={() => selectVideoClip(object.id, selected ? null : clip)}
                >
                  {nameOf(clip)}
                </button>
              );
            })
          )}
        </div>
      </FieldRow>

      {/*
        开窗口的按钮**单独占一行**：它和小方块挤在一行时，想换「放哪条」很容易点到它
        （一个点错是换视频、一个点错是弹窗口）。标签留空 = 让按钮与上面那排小方块左对齐。
      */}
      <FieldRow label="">
        <button
          type="button"
          data-testid="video-edit"
          title="打开「编辑视频」窗口：加 / 删视频、看路径、给每个视频起名字"
          className="flex-none rounded bg-[var(--color-editor-accent)] px-2 py-0.5 text-[11px] text-black hover:opacity-90"
          onClick={() => openVideoEditor(object.id)}
        >
          编辑
        </button>
      </FieldRow>

      {/*
        播放 / 暂停 · 继续 / 停止：与「播放声音」那一组**完全同一套**（同一个 `PlaybackRow`、
        同一套按钮类名、同一套状态措辞）。这三个键是现场真的在按的，所以比面板里其它小按钮
        大一圈（尺寸在 `fields.tsx` 的 `PLAYBACK_BUTTON_CLASS` 里定）。
      */}
      <PlaybackRow>
        <button
          type="button"
          data-testid="video-play"
          data-playing={playingHere}
          disabled={playBlocked !== undefined}
          title={
            playBlocked ??
            (playingHere
              ? `正在播放「${pickedName}」；再点一次让前端从头放一遍`
              : (delivery ?? `让前端在「${object.name}」上放「${pickedName}」`))
          }
          className={playingHere ? PLAYBACK_BUTTON_ACTIVE_CLASS : PLAYBACK_BUTTON_CLASS}
          onClick={() => playVideo(object.id)}
        >
          {playingHere ? "▶ 播放中" : "▶ 播放"}
        </button>

        <button
          type="button"
          data-testid="video-pause"
          data-paused={pausedHere}
          disabled={entry === undefined}
          title={
            entry === undefined
              ? "这个对象没在放视频（先点「播放」）"
              : (delivery ??
                (pausedHere ? "从暂停的那一帧继续放" : "暂停在当前帧（再点一次继续）"))
          }
          className={pausedHere ? PLAYBACK_BUTTON_ACTIVE_CLASS : PLAYBACK_BUTTON_CLASS}
          onClick={() => (pausedHere ? resumeVideo(object.id) : pauseVideo(object.id))}
        >
          {pausedHere ? "▶ 继续" : "⏸ 暂停"}
        </button>

        <button
          type="button"
          data-testid="video-stop"
          title={delivery ?? `让前端停掉「${object.name}」上的视频（露出它自己的贴图）`}
          className={PLAYBACK_BUTTON_CLASS}
          onClick={() => stopVideo(object.id)}
        >
          ■ 停止
        </button>
      </PlaybackRow>

      <PlaybackStatus testId="video-status" state={playbackState} note={playbackNote} />
    </>
  );
}

/**
 * 「视频」开关：整组的闸门，也是**这个对象的文档数据**（`video.enabled`）。
 *
 * 行名在左、右边只有勾选框（与「基础」组的激活 / 锁定同一套）；关着时这一组只剩它，
 * 加视频 / 选哪条 / 循环 / 声音都收起来——**和战争雾那一组的行为完全一致**。
 *
 * 它决定的不只是显示：关着时前端不建视频层，播放类命令会被明确拒掉。
 */
function VideoSwitch({
  checked,
  onChange,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <FieldRow label="启用">
      <input
        type="checkbox"
        data-testid="video-enable"
        aria-label="启用视频"
        checked={checked}
        title="这个对象放不放视频；关掉 = 前端不建视频层（已经加的视频留着，再打开就回来）"
        className="h-3.5 w-3.5 flex-none accent-[var(--color-editor-accent)]"
        onChange={(event) => onChange(event.target.checked)}
      />
    </FieldRow>
  );
}
