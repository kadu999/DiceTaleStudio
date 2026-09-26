import { useState } from "react";
import {
  DEFAULT_VIDEO_BLEND_KIND,
  VIDEO_BLEND_KINDS,
  videoBlendDataOf,
  videoBlendSpec,
  type GameObjectDoc,
  type VideoBlendChannel,
  type VideoBlendChannelDoc,
  type VideoBlendKind,
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

/** 「播放」现在能不能点：两路都没选 → 先选一路。 */
export function blendPlayBlockedReason(input: { readonly picks: number }): string | undefined {
  return input.picks === 0 ? "先在 A / B 里选一个素材（图片 / 视频）" : undefined;
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

/** 每路的素材种类：面板上的开关显示这两档（`VIDEO_BLEND_KINDS` 是唯一取值处）。 */
const KIND_LABELS: Record<VideoBlendKind, string> = {
  image: "图片",
  video: "视频",
};

/** 手写文件里可能整份 data 都没有：按「空着的视频那一路」显示。 */
const EMPTY_CHANNEL: VideoBlendChannelDoc = { kind: DEFAULT_VIDEO_BLEND_KIND };

/**
 * 贴图的「视频混合」组：**循环 / 声音 / 自动播放（规格自动出行）→ A（盖住）/ B（擦开露出）**。
 *
 * 视频混合是**可选能力，像「网格 / 视频」一样可加可移除**：没挂上时不出现这一组，
 * 入口在面板底部的「添加组件」；挂上之后用组头的「移除组件」摘掉。所以这里没有「启用」开关
 * ——组件在 = 在用。
 *
 * **每路只放一个素材**（v29 起），可以是**图片或视频**：面板上先有「图片 / 视频」开关，
 * 再点「选择」弹现有通用选择框（`ResourcePickerDialog`）。A 是**盖在上面**的那一路、
 * B 是**被盖住**的那一路；`loop` / `autoPlay` / `audio` 只对**视频**那一路有意义。
 *
 * 遮罩（擦除形状）**不在这里**：它是纯运行态，在「Mask 窗口」里擦。
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
  const openVideoBlendMask = useEditorStore((state) => state.openVideoBlendMask);
  const mode = useEditorStore((state) => state.mode);
  const status = useEditorStore((state) => state.runtime.status);
  const clientConnected = useEditorStore((state) => state.runtime.client !== null);

  const data = videoBlendDataOf(object);
  const picks = [data?.a.id, data?.b.id].filter((id): id is string => id !== undefined);
  const pickedLabel = picks.map((clip) => mediaClipName(tree, assetMetas, metaTable, clip)).join(" + ");

  /** 「播放」现在能不能点（两路一个都没选时先选）。 */
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

      <BlendChannelRow object={object} channel="a" label="A（盖住）" emptyNote="Mask 整张不透明时只看见 A" />
      <BlendChannelRow object={object} channel="b" label="B（擦开露出）" emptyNote="Mask 擦开的地方露出 B" />

      {/* 入口：真正擦遮罩在 Mask 窗口里做（编辑态只预览，运行态下发给前端） */}
      <FieldRow label="Mask">
        <button
          type="button"
          data-testid="video-blend-mask-open"
          title="打开 Mask 窗口：初始整张盖住 A，擦开的地方露出 B（不写文档）"
          className="flex-none rounded bg-[var(--color-editor-accent)] px-2 py-0.5 text-[11px] text-black hover:opacity-90"
          onClick={() => openVideoBlendMask(object.id)}
        >
          编辑
        </button>
      </FieldRow>

      {/*
        播放 / 暂停 · 继续 / 停止：与「视频」那一组**完全同一套**（同一个 `PlaybackRow`、
        同一套按钮类名与状态措辞）。命令复用 `play_video` 等四条——前端见 `VideoBlend`
        就同时起停两路里能放的那种。
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
              ? "这个对象没在放（先点「播放」）"
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
          title={delivery ?? `让前端停掉「${object.name}」上的混合（露出它自己的贴图）`}
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

/**
 * 一路素材：**种类开关（图片 / 视频）+ 选择按钮 + 当前素材 + 清除**。
 *
 * 一路只放一个素材（v29）：「选择」弹的是现有通用选择框，按当前种类给（图片走 `kind="image"`
 * 的「选中 + 确认」、视频走 `kind="video"` 的「选中 + 添加」），选中即刻写回文档。
 *
 * 图片那一路**不需要宽高**：混合层铺满对象自己的矩形，尺寸只影响 Mask 的像素维度，
 * 那个由后端 `?info=1` 探（图片与视频同一路，见 `VideoBlendMaskDialog`）。
 */
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
  const setKind = useEditorStore((state) => state.setVideoBlendChannelKind);
  const setId = useEditorStore((state) => state.setVideoBlendChannelId);

  /** 「选择素材」弹框开着没有（换个对象就收起来）。 */
  const [picking, setPicking] = useState(false);

  const data = videoBlendDataOf(object);
  // 手写文件里可能整份数据都没有：按空通道显示
  const channelData = (channel === "a" ? data?.a : data?.b) ?? EMPTY_CHANNEL;
  const kind = channelData.kind;
  const id = channelData.id;
  const name = id === undefined ? undefined : mediaClipName(tree, assetMetas, metaTable, id);
  const path =
    id === undefined
      ? undefined
      : assetDisplayPath(findAssetByReference(tree, id, assetMetas)?.id ?? id);
  const hint = kind === "video" && id !== undefined ? videoFormatHint(id) : undefined;

  return (
    <>
      <FieldRow label={label}>
        <div
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
          data-testid={`video-blend-${channel}-media`}
        >
          {/* 种类开关：图片 / 视频。换种类会把这一路已选的素材清掉（见文档命令的说明） */}
          <span className="flex flex-none overflow-hidden rounded border border-[var(--color-editor-border)]">
            {VIDEO_BLEND_KINDS.map((option) => {
              const active = kind === option;
              return (
                <button
                  key={option}
                  type="button"
                  data-testid={`video-blend-${channel}-kind-${option}`}
                  data-active={active}
                  aria-pressed={active}
                  title={`这一路放${KIND_LABELS[option]}（换种类会清掉已选的素材）`}
                  className={`px-1.5 py-0.5 text-[10px] ${
                    active
                      ? "bg-[var(--color-editor-accent-dim)] text-white"
                      : "text-[var(--color-editor-text-dim)] hover:bg-[var(--color-editor-panel-alt)]"
                  }`}
                  onClick={() => setKind(object.id, channel, option)}
                >
                  {KIND_LABELS[option]}
                </button>
              );
            })}
          </span>

          <button
            type="button"
            data-testid={`video-blend-${channel}-pick`}
            title={`从项目里的${KIND_LABELS[kind]}素材里挑一个；${emptyNote}`}
            className="flex-none rounded border border-dashed border-[var(--color-editor-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-editor-text-dim)] hover:border-[var(--color-editor-accent)] hover:text-[var(--color-editor-text)]"
            onClick={() => setPicking(true)}
          >
            {kind === "image" ? "选择图片…" : "选择视频…"}
          </button>

          {id === undefined || name === undefined ? (
            <span
              data-testid={`video-blend-${channel}-empty`}
              className="text-[11px] text-[var(--color-editor-text-dim)]"
            >
              还没选
            </span>
          ) : (
            <span
              data-testid={`video-blend-${channel}-current`}
              data-id={id}
              title={[path, hint].filter((line) => line !== undefined).join("\n")}
              className="flex max-w-[12rem] items-center overflow-hidden rounded border border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-[10px] text-white"
            >
              <span className="min-w-0 flex-1 truncate px-1.5 py-0.5">{name}</span>
              {/*
                × 用 CSS 画（::after content）：不进 textContent，e2e 对当前素材
                `toHaveText(name)` 的断言才不会被这个符号弄脏。
              */}
              <button
                type="button"
                data-testid={`video-blend-${channel}-clear`}
                aria-label={`清除 ${name}`}
                title="清除这一路选的素材（素材文件不会被删）"
                className="flex-none self-stretch px-1 text-white/70 after:content-['×'] hover:text-[var(--color-editor-danger)]"
                onClick={() => setId(object.id, channel, null)}
              />
            </span>
          )}
        </div>
      </FieldRow>

      {/* 选择素材：按当前种类弹通用选择框 */}
      {kind === "image" ? (
        <ResourcePickerDialog
          kind="image"
          allowSprite={false}
          open={picking}
          currentId={id}
          onPick={(image) => setId(object.id, channel, image.id)}
          onClose={() => setPicking(false)}
        />
      ) : (
        <ResourcePickerDialog
          kind="video"
          open={picking}
          onPick={(clipId) => setId(object.id, channel, clipId)}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}
