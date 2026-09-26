import { useState } from "react";
import {
  videoBlendDataOf,
  videoBlendSpec,
  type GameObjectDoc,
  type VideoBlendChannel,
  type VideoBlendChannelDoc,
} from "@dts/document";
import { assetDisplayPath, findAssetByReference } from "../asset-picker";
import { ResourcePickerDialog } from "../../app/ResourcePickerDialog";
import { useEditorStore, type EditorMode } from "../../state/editor-store";
import { deliveryHint } from "../../services/delivery-hint";
import type { RuntimeStatus } from "../../services/runtime-client";
import {
  FieldRow,
  PLAYBACK_BUTTON_ACTIVE_CLASS,
  PLAYBACK_BUTTON_CLASS,
  PlaybackRow,
  PlaybackStatus,
  type PlaybackState,
} from "./fields";
import { componentFields, descriptorRows, sortInspectorRows } from "./DescriptorRows";
import { mediaClipName, videoFormatHint } from "./VideoFields";

/** 「播放」现在能不能点：两条通道一条都没选 → 先选一条。 */
export function blendPlayBlockedReason(input: { readonly picks: number }): string | undefined {
  return input.picks === 0 ? "先在 A / B 里选一条视频（点小方块）" : undefined;
}

/**
 * 点下去会发生什么：没连上时**照样记账**，只是要等连上才补发——把这件事写在按钮的 tooltip 上。
 *
 * 返回 `undefined` 表示「现在就能发下去」。与 `videoDeliveryHint` 同一套措辞。
 */
export function blendDeliveryHint(input: {
  readonly mode: EditorMode;
  readonly status: RuntimeStatus;
  readonly clientConnected: boolean;
}): string | undefined {
  return deliveryHint(input);
}

/**
 * 贴图的「视频混合」组：**循环 / 声音（规格自动出行）→ 视频 A（盖住）/ 视频 B（擦开露出）**。
 *
 * 视频混合是**可选能力，像「网格 / 视频」一样可加可移除**：没挂上时不出现这一组，
 * 入口在面板底部的「添加组件」；挂上之后用组头的「移除组件」摘掉。所以这里没有「启用」开关
 * ——组件在 = 在用。
 *
 * 两条通道**各自是一份「列表 + 选中」**（与「视频」那一组同一套：小方块 = 加进来的视频，
 * 点一下决定放哪一条，`×` 移出一条，「清空」一次移出，「＋」从项目素材里添加）。
 * A 是**盖在上面**的那条、B 是**被盖住**的那条；`loop` / `audio` 是组件自己的设置，
 * 清空列表也不会被抹掉。
 *
 * 遮罩（擦除形状）**不在这里**：它是纯运行态，在「Mask 窗口」里擦（下一批接上）。
 */
export function VideoBlendFields({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
  const tree = useEditorStore((state) => state.project.tree);
  const assetMetas = useEditorStore((state) => state.assetMetas);
  const metaTable = useEditorStore((state) => state.assetMetaTable);
  const playback = useEditorStore((state) => state.videoBlendPlayback);
  const playVideoBlend = useEditorStore((state) => state.playVideoBlend);
  const pauseVideoBlend = useEditorStore((state) => state.pauseVideoBlend);
  const resumeVideoBlend = useEditorStore((state) => state.resumeVideoBlend);
  const stopVideoBlend = useEditorStore((state) => state.stopVideoBlend);
  const mode = useEditorStore((state) => state.mode);
  const status = useEditorStore((state) => state.runtime.status);
  const clientConnected = useEditorStore((state) => state.runtime.client !== null);

  const data = videoBlendDataOf(object);
  const picks = [data?.a.picked, data?.b.picked].filter(
    (clip): clip is string => clip !== undefined,
  );
  const pickedLabel = picks
    .map((clip) => mediaClipName(tree, assetMetas, metaTable, clip))
    .join(" + ");

  /** 「播放」现在能不能点（两条通道一条都没选时先选）。 */
  const playBlocked = blendPlayBlockedReason({ picks: picks.length });
  const delivery = blendDeliveryHint({ mode, status, clientConnected });

  /*
    点下去要有**看得见的变化**：记账里就是这个对象 → 按钮写成「播放中 / 已暂停」并高亮。
    记账是运行态（不写文档），所以切场景 / 换项目后会回到「没在播放」。
  */
  const entry = playback.objects[object.id];
  const playingHere = entry !== undefined && !entry.paused;
  const pausedHere = entry !== undefined && entry.paused;
  const playbackState: PlaybackState = playingHere ? "playing" : pausedHere ? "paused" : "idle";
  const playbackNote = playingHere
    ? `正在混合播放：${pickedLabel}`
    : pausedHere
      ? `已暂停：${pickedLabel}`
      : "没在播放";

  return (
    <>
      {sortInspectorRows(
        descriptorRows(object, videoBlendSpec, componentFields(videoBlendSpec.type)),
      ).map((row) => row.node)}

      <BlendChannelRow
        object={object}
        channel="a"
        label="视频 A（盖住）"
        emptyNote="Mask 整张不透明时只看见 A"
      />
      <BlendChannelRow
        object={object}
        channel="b"
        label="视频 B（擦开露出）"
        emptyNote="Mask 擦开的地方露出 B"
      />

      {/*
        播放 / 暂停 · 继续 / 停止：与「视频」那一组**完全同一套**（同一个 `PlaybackRow`、
        同一套按钮类名与状态措辞）。命令复用 `play_video` 等四条——前端见 `VideoBlend`
        就同时起停两条通道。
      */}
      <PlaybackRow>
        <button
          type="button"
          data-testid="video-blend-play"
          data-playing={playingHere}
          disabled={playBlocked !== undefined}
          title={
            playBlocked ??
            (playingHere
              ? `正在混合播放「${pickedLabel}」；再点一次让前端从头放一遍`
              : (delivery ?? `让前端在「${object.name}」上混合放「${pickedLabel}」`))
          }
          className={playingHere ? PLAYBACK_BUTTON_ACTIVE_CLASS : PLAYBACK_BUTTON_CLASS}
          onClick={() => playVideoBlend(object.id)}
        >
          {playingHere ? "▶ 播放中" : "▶ 播放"}
        </button>

        <button
          type="button"
          data-testid="video-blend-pause"
          data-paused={pausedHere}
          disabled={entry === undefined}
          title={
            entry === undefined
              ? "这个对象没在放视频（先点「播放」）"
              : (delivery ??
                (pausedHere ? "从暂停的那一帧继续放" : "暂停在当前帧（再点一次继续）"))
          }
          className={pausedHere ? PLAYBACK_BUTTON_ACTIVE_CLASS : PLAYBACK_BUTTON_CLASS}
          onClick={() => (pausedHere ? resumeVideoBlend(object.id) : pauseVideoBlend(object.id))}
        >
          {pausedHere ? "▶ 继续" : "⏸ 暂停"}
        </button>

        <button
          type="button"
          data-testid="video-blend-stop"
          title={delivery ?? `让前端停掉「${object.name}」上的混合视频（露出它自己的贴图）`}
          className={PLAYBACK_BUTTON_CLASS}
          onClick={() => stopVideoBlend(object.id)}
        >
          ■ 停止
        </button>
      </PlaybackRow>

      <PlaybackStatus testId="video-blend-status" state={playbackState} note={playbackNote} />
    </>
  );
}

/** 一条通道的行：列表 + 选中 + 添加 / 移出 / 清空（与「视频」那一行同骨架）。 */
function BlendChannelRow({
  object,
  channel,
  label,
  emptyNote,
}: {
  readonly object: GameObjectDoc;
  readonly channel: VideoBlendChannel;
  readonly label: string;
  readonly emptyNote: string;
}): React.JSX.Element {
  const tree = useEditorStore((state) => state.project.tree);
  const assetMetas = useEditorStore((state) => state.assetMetas);
  const metaTable = useEditorStore((state) => state.assetMetaTable);
  const addClip = useEditorStore((state) => state.addVideoBlendClip);
  const removeClip = useEditorStore((state) => state.removeVideoBlendClip);
  const selectClip = useEditorStore((state) => state.selectVideoBlendClip);
  const clearClips = useEditorStore((state) => state.clearVideoBlendClips);

  /** 「选择视频」弹框开着没有（换个对象就收起来）。 */
  const [picking, setPicking] = useState(false);

  const data = videoBlendDataOf(object);
  // 手写文件里可能整份数据都没有：按空通道显示
  const channelData: VideoBlendChannelDoc = (channel === "a" ? data?.a : data?.b) ?? { clips: [] };
  const clips = channelData.clips;
  const picked = channelData.picked;

  return (
    <>
      <FieldRow label={label}>
        <div
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
          data-testid={`video-blend-${channel}-clips`}
        >
          {clips.length === 0 ? (
            <span
              data-testid={`video-blend-${channel}-empty`}
              className="text-[11px] text-[var(--color-editor-text-dim)]"
              title={`点「＋」从项目里的视频素材里挑；${emptyNote}`}
            >
              还没加视频
            </span>
          ) : (
            clips.map((clip) => {
              const selected = clip === picked;
              const hint = videoFormatHint(clip);
              const name = mediaClipName(tree, assetMetas, metaTable, clip);
              return (
                <span
                  key={clip}
                  data-testid={`video-blend-${channel}-clip`}
                  data-clip={clip}
                  data-selected={selected}
                  title={[
                    selected
                      ? `${assetDisplayPath(findAssetByReference(tree, clip, assetMetas)?.id ?? clip)}（就是它会被放；再点一下取消选中）`
                      : `${assetDisplayPath(findAssetByReference(tree, clip, assetMetas)?.id ?? clip)}（点一下改成放它）`,
                    hint,
                  ]
                    .filter((line) => line !== undefined)
                    .join("\n")}
                  className={`flex max-w-[9rem] items-center overflow-hidden rounded border text-[10px] ${
                    selected
                      ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                      : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel-alt)]"
                  }`}
                >
                  <button
                    type="button"
                    aria-pressed={selected}
                    className="min-w-0 flex-1 truncate px-1.5 py-0.5 text-left"
                    onClick={() => selectClip(object.id, channel, selected ? null : clip)}
                  >
                    {name}
                  </button>
                  {/*
                    × 用 CSS 画（::after content）：不进 textContent，e2e 对小方块
                    `toHaveText(name)` 的断言才不会被这个符号弄脏。
                  */}
                  <button
                    type="button"
                    data-testid={`video-blend-${channel}-remove`}
                    data-clip={clip}
                    aria-label={`移出 ${name}`}
                    title="移出这一条（素材文件不会被删）"
                    className="flex-none self-stretch px-1 text-[var(--color-editor-text-dim)] after:content-['×'] hover:text-[var(--color-editor-danger)]"
                    onClick={() => removeClip(object.id, channel, clip)}
                  />
                </span>
              );
            })
          )}

          <button
            type="button"
            data-testid={`video-blend-${channel}-add`}
            title="从项目里的视频素材里挑（选中一条，点「添加」加入）"
            aria-label={`给${label}添加视频`}
            className="flex h-6 w-6 flex-none items-center justify-center rounded border border-dashed border-[var(--color-editor-border)] text-[13px] leading-none text-[var(--color-editor-text-dim)] hover:border-[var(--color-editor-accent)] hover:text-[var(--color-editor-text)]"
            onClick={() => setPicking(true)}
          >
            ＋
          </button>
          {clips.length === 0 ? null : (
            <button
              type="button"
              data-testid={`video-blend-${channel}-clear`}
              title="全部移出（素材文件不会被删）"
              className="flex-none rounded border border-[var(--color-editor-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-editor-text-dim)] hover:border-[var(--color-editor-accent)] hover:text-[var(--color-editor-text)]"
              onClick={() => clearClips(object.id, channel)}
            >
              清空
            </button>
          )}
        </div>
      </FieldRow>

      {/* 选择视频：选中一条 → 点「添加」加入（一次一条），取消 / 关窗回到面板 */}
      <ResourcePickerDialog
        kind="video"
        open={picking}
        onPick={(id) => addClip(object.id, channel, id)}
        onClose={() => setPicking(false)}
      />
    </>
  );
}
