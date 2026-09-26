import { useEffect, useMemo, useRef, useState } from "react";
import { videoBlendDataOf } from "@dts/document";
import { assetThumbnailUrl } from "../panels/asset-picker";
import { useAssetSize } from "../hooks/useAssetSize";
import {
  VIDEO_BLEND_MASK_SOFTNESS,
  applyEraseToPixels,
  brushRadiusFor,
  fillMaskAlpha,
  fillOpaqueMaskPixels,
  previewMaskSizeFor,
  strokeStampCenters,
  type MaskPoint,
} from "../services/mask-math";
import { useEditorStore } from "../state/editor-store";
import { shouldFlushBatch, splitStrokeBatch } from "../services/fog-reveal";
import type { VideoBlendRevealPoint } from "../services/video-blend-reveal";
import { MapDialogShell, useSceneObject } from "./map-dialog-shell";
import { useFittedBox } from "./dialog-size";

/**
 * 「视频混合 Mask 窗口」：**只有擦除**，擦的是**混合遮罩这张图**。
 *
 * 与「战争雾 Mask 窗口」同一套骨架（同一份 `mask-math` 像素运算、同一批批处理、同一个外壳）：
 * - 初始状态 = 运行时那份：**整张不透明**（视频 A 整张盖住，B 完全看不见）；
 * - 底图是 **B 的首帧缩略图**（擦开要露出的就是它）——编辑器不解码视频，缩略图即所见；
 *   盖层是 A（这里统一画成一块深色，运行时那边是 A 的视频画面）——与雾窗口「按区域配色」
 *   同一套取舍：**形状一致、颜色不同**；
 * - 擦除只改遮罩的 alpha（软边圆刷、`min` 幂等），**不碰文档、不进撤销栈、不落盘**；
 *   关掉再打开就回到初始（整张盖住）；
 * - 遮罩纹理宽度与运行时**同一张**（`previewMaskSizeFor`：960 宽、高度按**视频像素尺寸**推，
 *   尺寸经后端 `?info=1` 探测），笔刷 48 texel —— 于是归一化半径 = 宽度 5%，两端擦出同一片纹素；
 * - **软边比例是 0.5**（雾是 1）：得留一个**实心核**，擦到的地方才是真的 0（完全露出 B）。
 *   用雾那档 `1` 会擦不到底，擦完的区域永远糊着一层 A 的残影（看着还是「两条视频混合」）——
 *   见 `VIDEO_BLEND_MASK_SOFTNESS`；
 * - 右边两个「整张」按钮：一次把整张遮罩填成 **1**（A 重新盖满，连之前擦开的一起盖回去）
 *   或 **0**（完全露出 B）——对应命令 `fill_video_mask`，与擦一笔共用**同一条有序操作序列**。
 * - **运行态下顺手下发**：拖动中按批把**轨迹**发给前端（`erase_video_mask`），抬手补最后一批；
 *   整张按钮各发一条 `fill_video_mask`。编辑态什么都不发——那时这一窗口就是纯粹的预览。
 */
interface VideoBlendMaskDialogProps {
  readonly open: boolean;
  /** 正在预览的贴图对象 id；null 表示窗口没打开。 */
  readonly objectId: string | null;
  readonly onClose: () => void;
}

/** 盖层颜色（代表「A 还盖着」）：深色压住底下的 B；擦除只降 alpha。 */
const COVER_RGBA = [16, 18, 24, 235] as const;

/**
 * 「整张」两个按钮的样子：**一眼要看出能按**。
 *
 * 右侧那一栏的底是 `panel-alt`，而 `toolbar-button` 是「透明底 + 透明边」、只在 hover 时才浮出
 * 同样是 `panel-alt` 的底——放在这一栏上就等于两行纯文字（截图确认过，hover 也几乎没变化）。
 * 所以这里走**播放键那一档**（`fields.tsx` 的 `PLAYBACK_BUTTON_CLASS`）：常态就有边框 +
 * 比栏底亮两档的底（`bar` 色），hover 再亮一档并描上强调色边框；尺寸也按「现场真的在按的键」
 * 放大到 30px。按钮里那个小方块是**遮罩状态**的提示（实心 = 1、空心 = 0）。
 */
const FILL_BUTTON_CLASS =
  "inline-flex min-h-[30px] w-full flex-none items-center justify-center gap-1.5 rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-bar)] px-2 text-[12px] text-[var(--color-editor-text)] hover:border-[var(--color-editor-accent)] hover:bg-[var(--color-editor-bar-hover)] hover:text-white";

/** 视频尺寸还没探到时的兜底长宽比（16:9）。 */
const FALLBACK_SIZE = { width: 16, height: 9 } as const;

export function VideoBlendMaskDialog({
  open,
  objectId,
  onClose,
}: VideoBlendMaskDialogProps): React.JSX.Element {
  /** 运行态：擦了会下发给前端（编辑态只是预览）——底部那句话按它换。 */
  const running = useEditorStore((state) => state.mode === "run");

  // 目标对象（**贴图**）现查一次：它可能已经被删掉（删了窗口就该关，这里只是兜底不崩）
  const object = useSceneObject(objectId);
  const blend = object === undefined ? undefined : videoBlendDataOf(object);
  const pickedA = blend?.a.id;
  const pickedB = blend?.b.id;

  // 遮罩尺寸按**素材像素尺寸**推（A 优先，其次 B；都没有用 16:9）——图片与视频同一路（`?info=1` 两种都认）
  const size = useAssetSize(pickedA ?? pickedB);
  const maskSize = useMemo(
    () => previewMaskSizeFor(size ?? FALLBACK_SIZE),
    [size?.width, size?.height],
  );

  const imageDataRef = useRef<ImageData | null>(null);
  const lastPointRef = useRef<MaskPoint | null>(null);

  /** 这一笔还没下发的落点（归一化坐标，与画布预览用的纹理像素分开两份）。 */
  const pendingStrokeRef = useRef<readonly VideoBlendRevealPoint[]>([]);
  const lastSentAtRef = useRef(0);

  /**
   * 画布节点（callback ref 存 state）。
   *
   * **不能只依赖 `open`**：窗口内容由 Radix 在 `open` 变真的**下一次提交**才挂上来，
   * 依赖 `open` 的 effect 跑起来时 ref 还是 null——那样遮罩永远不会被初始化。节点进 state 后，
   * 挂载 / 卸载都会重跑初始化，于是「关掉再打开就回到初始」也就是同一件事。
   */
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);

  // 初始化遮罩像素：**整张不透明**（A 全盖住；擦开露出 B）
  useEffect(() => {
    if (!open || canvas === null) {
      return;
    }

    canvas.width = maskSize.width;
    canvas.height = maskSize.height;

    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }

    const imageData = context.createImageData(maskSize.width, maskSize.height);
    fillOpaqueMaskPixels(imageData.data, maskSize.width, maskSize.height, COVER_RGBA);
    context.putImageData(imageData, 0, 0);
    imageDataRef.current = imageData;
    lastPointRef.current = null;
  }, [open, canvas, maskSize]);

  const aspect = (size ?? FALLBACK_SIZE).width / Math.max(1, (size ?? FALLBACK_SIZE).height);
  const [stageBox, setStageNode] = useFittedBox(aspect);

  const ready = open && object !== undefined;
  // 笔刷半径（纹理像素）：与前端 `ApplyEraseStroke` 的 `radiusTex` 同式（归一化半径 × 遮罩宽）
  const radius = brushRadiusFor(maskSize.width);

  /** 指针位置 → 遮罩的**纹理像素坐标**（左上原点、y 向下；前端收到后再翻转 y）。 */
  const toTexelPoint = (event: React.PointerEvent<HTMLCanvasElement>): MaskPoint => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - box.left) / Math.max(1, box.width)));
    const y = Math.max(0, Math.min(1, (event.clientY - box.top) / Math.max(1, box.height)));
    return { x: x * maskSize.width, y: y * maskSize.height };
  };

  /** 纹理像素坐标 → **归一化坐标**（下发给前端的就是这个：`[0,1]`、y 向下）。 */
  const toNormalized = (point: MaskPoint): VideoBlendRevealPoint => ({
    x: point.x / Math.max(1, maskSize.width),
    y: point.y / Math.max(1, maskSize.height),
  });

  /** 把攒下的落点按批发给前端（运行态；编辑态 store 那边什么都不做）。 */
  const flushStroke = (done: boolean): void => {
    const pending = pendingStrokeRef.current;
    const now = Date.now();
    if (
      objectId === null ||
      !shouldFlushBatch({
        pendingPoints: pending.length,
        now,
        lastSentAt: lastSentAtRef.current,
        done,
      })
    ) {
      return;
    }

    // 留下的最后一个点会成为下一批的第一个点：接缝处不会断一段
    const batch = splitStrokeBatch(pending, done);
    pendingStrokeRef.current = batch.pending;
    if (batch.sent.length === 0) {
      return;
    }

    lastSentAtRef.current = now;
    useEditorStore.getState().eraseVideoBlendMask(objectId, batch.sent, done);
  };

  /** 在纹理像素坐标的一个点上擦一下（就地改遮罩像素并回写画布）。 */
  const eraseAt = (point: MaskPoint): void => {
    const imageData = imageDataRef.current;
    const context = canvas?.getContext("2d") ?? null;
    if (imageData === null || context === null) {
      return;
    }

    applyEraseToPixels(imageData.data, maskSize.width, maskSize.height, point, radius, VIDEO_BLEND_MASK_SOFTNESS);
    context.putImageData(imageData, 0, 0);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    // 只认主键（与画布上的约定一致）
    if (event.button !== 0 || !ready) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    // 按下 = 前端「单点」那一支：只在这一处打一个圆
    const point = toTexelPoint(event);
    lastPointRef.current = point;
    eraseAt(point);

    // 这一笔从这里开始攒点（上一笔如果没被抬手收尾，剩下的点就丢掉——它已经不是这一笔了）
    pendingStrokeRef.current = [toNormalized(point)];
    lastSentAtRef.current = Date.now();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const last = lastPointRef.current;
    if (last === null || !ready) {
      return;
    }

    const point = toTexelPoint(event);
    // 补点与前端同式：step = max(1, 半径 / 2) 纹理像素，两端各打一个圆
    for (const center of strokeStampCenters(last, point, radius)) {
      eraseAt(center);
    }

    lastPointRef.current = point;

    // 攒点：够了（或过一会儿了）就发一批——前端那边是边拖边擦的
    pendingStrokeRef.current = [...pendingStrokeRef.current, toNormalized(point)];
    flushStroke(false);
  };

  const onPointerEnd = (): void => {
    lastPointRef.current = null;
    flushStroke(true);
  };

  /**
   * 右边两个「整张」按钮：一次把整张遮罩填成 1 / 0。
   *
   * 预览这边只改 alpha（RGB 留着盖层本色）：`1` = 盖层不透明（与初始态一模一样）、
   * `0` = 整张透明（完全露出 B）。运行态下顺手下发一条 `fill_video_mask`——
   * 前端按**同一顺序**重放（盖住会连带抹掉之前擦开的），与这里看到的一致。
   */
  const fillAll = (covered: boolean): void => {
    // 预览能画就画；画布没就绪也不挡下发——两者互不依赖
    const imageData = imageDataRef.current;
    const context = canvas?.getContext("2d") ?? null;
    if (imageData !== null && context !== null) {
      fillMaskAlpha(imageData.data, maskSize.width, maskSize.height, covered ? COVER_RGBA[3] : 0);
      context.putImageData(imageData, 0, 0);
    }

    // 攒着还没发出去的那半笔不要了：它属于「填之前」的那一版
    pendingStrokeRef.current = [];
    lastPointRef.current = null;

    if (objectId !== null) {
      useEditorStore.getState().fillVideoBlendMask(objectId, covered);
    }
  };

  // 目标对象缺了（不是贴图 / 没这个组件）：交给外壳渲染「找不到」占位
  if (object === undefined || blend === undefined) {
    return (
      <MapDialogShell open={open} onClose={onClose} prefix="video-blend-mask" title="视频混合 Mask" found={false}>
        {null}
      </MapDialogShell>
    );
  }

  return (
    <MapDialogShell
      open={open}
      onClose={onClose}
      prefix="video-blend-mask"
      title="视频混合 Mask"
      found
      footer={
        <span>
          {running
            ? "擦了 / 整张填了都会下发给前端（拖动中分批发）"
            : "擦了不写文档：关掉重开就回到初始（A 整张盖住）"}
        </span>
      }
    >
      <div className="flex min-h-0 flex-1 gap-2">
        <div
          ref={setStageNode}
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        >
          <div
            data-testid="video-blend-mask-stage"
            className="relative bg-black"
            style={{ width: stageBox.width, height: stageBox.height }}
          >
            {pickedB === undefined ? (
              <div className="absolute left-0 top-0 flex h-full w-full items-center justify-center border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]">
                B 还没选素材（擦开要露出的是它）
              </div>
            ) : (
              <img
                src={assetThumbnailUrl(pickedB)}
                alt="B 素材缩略图"
                className="absolute left-0 top-0 h-full w-full object-contain"
              />
            )}
            <canvas
              ref={setCanvas}
              data-testid="video-blend-mask-canvas"
              className="absolute left-0 top-0 h-full w-full touch-none"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
            />
          </div>
        </div>

        {/* 右侧：**整张遮罩**——一次填满（1）或清空（0）。原来那几行说明写的都是同一件事，删了 */}
        <div
          data-testid="video-blend-mask-panel"
          className="flex w-36 flex-none flex-col gap-1.5 overflow-auto rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] p-2"
        >
          <span className="text-[10px] text-[var(--color-editor-text-dim)]">整张遮罩</span>
          <button
            type="button"
            data-testid="video-blend-mask-fill-covered"
            title="整张填成 1：A 重新盖满（连之前擦开的一起盖回去）"
            className={FILL_BUTTON_CLASS}
            onClick={() => fillAll(true)}
          >
            {/* 实心方块 = 遮罩 1（整张盖住） */}
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 flex-none rounded-[2px] border border-[var(--color-editor-text)] bg-[var(--color-editor-text)]"
            />
            整张盖住（1）
          </button>
          <button
            type="button"
            data-testid="video-blend-mask-fill-revealed"
            title="整张填成 0：完全露出 B（连还没擦的地方一起露出来）"
            className={FILL_BUTTON_CLASS}
            onClick={() => fillAll(false)}
          >
            {/* 空心方块 = 遮罩 0（整张擦开） */}
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 flex-none rounded-[2px] border border-[var(--color-editor-text)]"
            />
            整张擦开（0）
          </button>
        </div>
      </div>
    </MapDialogShell>
  );
}
