import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ALL_MASK,
  cellMaskRgba,
  defaultCellMaskStyle,
  maskToLabel,
  regionsToMask,
  visibleMaskBits,
  type GridSize,
} from "@dts/grid";
import { fogOf, mapDataOf } from "@dts/document";
import { assetRawUrl } from "../panels/asset-picker";
import { decodeCellsCached } from "../panels/scene/grid-paint";
import {
  MASK_BRUSH_SOFTNESS,
  MASK_PREVIEW_WIDTH,
  applyEraseToPixels,
  brushRadiusFor,
  fillFogMaskPixels,
  paintRegionPixels,
  previewMaskSizeFor,
  strokeStampCenters,
  type MaskColorOf,
  type MaskPoint,
} from "../services/mask-math";
import { useEditorStore } from "../state/editor-store";
import {
  shouldFlushBatch,
  splitStrokeBatch,
  type FogRevealPoint,
} from "../services/fog-reveal";
import { MapDialogShell, useSceneObject } from "./map-dialog-shell";
import { fitBox } from "./dialog-size";

/**
 * 「战争雾 Mask 窗口」：**只有擦除**，而且擦的是**遮罩这张图**，不是格子。
 *
 * 对照参考实现（`backend_diceTale` 的 `MaskEditorDialog.vue` + `composables/useMaskEditor.ts` +
 * `services/maskMath.ts`：贴图铺底、遮罩、按住擦、软边圆刷；后端把 `erase_mask` 笔画转给前端，
 * 前端 `MaskImage` 用同一套公式在 GPU 上擦）——这块遮罩是**运行时**的东西，编辑器里这份是**预览**：
 *
 * - 初始状态 = 运行时那份：**已指定雾区的格子**盖着颜色，其余透明（`fillFogMaskPixels`）；
 *   运行时那边雾是黑的，编辑器里**按区域配色**（一眼看出哪块是哪区）——前端重构后再对齐；
 * - 擦除只改遮罩的 alpha（软边圆刷、`min` 幂等），**不碰 `map.cells`、不进撤销栈、不落盘**；
 * - 每次打开都按当前文档重画一遍，所以**关掉再打开就恢复原样**；
 * - 遮罩纹理 **960 宽**（参考实现的默认遮罩宽度）、高度按贴图比例推；笔刷 48 texel
 *   ——于是归一化半径 = 宽度 5%，正是参考实现下发给前端的值（详见 `previewMaskSizeFor`）；
 * - 没有「画笔 / 画回去 / 全部清除」：运行时那边也只有擦除（雾只会被揭示，不会被重新盖上）；
 * - **运行态下还顺手下发**：拖动中按批（攒够几个点或过一会儿）把**轨迹**发给前端，
 *   抬手再补最后一批（`eraseFogMask`）；整区开关同样下发（`setFogRegionRevealed`）。
 *   编辑态什么都不发——那时候这一窗口就是纯粹的预览。
 *
 * 雾区格子（哪几个区域算雾）在属性面板指定，涂格子走「编辑 → 打开编辑窗口…」。
 */
interface FogMaskDialogProps {
  readonly open: boolean;
  /** 正在预览的地图对象 id；null 表示窗口没打开 */
  readonly objectId: string | null;
  readonly onClose: () => void;
}


export function FogMaskDialog({
  open,
  objectId,
  onClose,
}: FogMaskDialogProps): React.JSX.Element {
  const colors = useEditorStore((state) => state.gridPaint.colors);
  /** 运行态：擦了会下发给前端（编辑态只是预览）——底部那句话按它换。 */
  const running = useEditorStore((state) => state.mode === "run");

  // 目标对象现查一次：它可能已经被删掉（删了窗口就该关，这里只是兜底不崩）
  const object = useSceneObject(objectId);
  const map = object === undefined ? undefined : mapDataOf(object);
  const imageRef = map?.image;

  // 雾区绑定自 v25 起住在独立的 `FogOfWar` 组件里
  const regions = object === undefined ? [] : (fogOf(object)?.regions ?? []);
  const fogMask = regionsToMask(regions);

  /**
   * 遮罩纹理的尺寸：**960 宽**（参考实现的默认遮罩宽度）、高度按贴图比例推。
   *
   * 用**像素**尺寸而不是格数：运行时那块遮罩就是一张纹理，GM 擦的是软边圆刷
   * （用格数会把擦除变成「擦格子」）。宽度钉在 960 是为了让 48 texel 的笔刷重新等于
   * 「宽度的 5%」——参考实现下发给前端的归一化半径（详见 `previewMaskSizeFor`）。
   */
  const maskSize = useMemo(
    () => (imageRef === undefined ? undefined : previewMaskSizeFor(imageRef)),
    [imageRef?.id, imageRef?.width, imageRef?.height],
  );

  const imageDataRef = useRef<ImageData | null>(null);
  const stageObserverRef = useRef<ResizeObserver | null>(null);
  const lastPointRef = useRef<MaskPoint | null>(null);

  /**
   * 这一笔还没下发的落点（**归一化坐标**，与画布预览用的纹理像素分开两份）。
   *
   * 拖动中按批下发（见 `shouldFlushBatch`）：攒下来的点交给 `eraseFogMask`，
   * 它会记进 store 并在有前端时发一条 `erase_mask`。
   */
  const pendingStrokeRef = useRef<readonly FogRevealPoint[]>([]);
  const lastSentAtRef = useRef(0);

  /**
   * 画布节点（callback ref 存 state）。
   *
   * **不能只依赖 `open`**：窗口内容由 Radix 在 `open` 变真的**下一次提交**才挂上来，
   * 依赖 `open` 的 effect 跑起来时 ref 还是 null——那样遮罩永远不会被初始化，
   * 画布一直是空白的（擦也没得擦）。节点进 state 后，挂载 / 卸载都会重跑初始化，
   * 于是「关掉再打开就回到未探索的样子」也就是同一件事。
   */
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  /** 左侧画布区的实测尺寸：贴图那块长宽比盒子按它等比装（见 `fitBox`）。 */
  const [stage, setStage] = useState({ width: 0, height: 0 });
  /** 已打开的雾区（整区开关）：只在本窗口里有效，关掉重开就复位。 */
  const [revealedRegions, setRevealedRegions] = useState<readonly number[]>([]);

  const grid: GridSize | undefined = map?.grid;
  const cells =
    map === undefined || grid === undefined
      ? undefined
      : decodeCellsCached(map.cells.runs, grid.width * grid.height);

  /** 一格的区域配色（只算**已指定雾区**的位，按位逐层叠加）——初始化与整区开关共用。 */
  const colorOf = useCallback<MaskColorOf>(
    (mask) =>
      visibleMaskBits(mask, ALL_MASK & ~fogMask).map((bit) => {
        const style = defaultCellMaskStyle(bit);
        return cellMaskRgba(colors[bit] ?? style.hex, style.alpha);
      }),
    [colors, fogMask],
  );
  // 初始化遮罩像素：只给**已指定雾区**的格子按区域配色上色，其余全透明
  useEffect(() => {
    if (!open || canvas === null || maskSize === undefined || grid === undefined || cells === undefined) {
      return;
    }

    canvas.width = maskSize.width;
    canvas.height = maskSize.height;

    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }

    const imageData = context.createImageData(maskSize.width, maskSize.height);
    // 罩子按**区域颜色**画（编辑器里要一眼看出哪块是哪区）；运行时那边统一是黑的，
    // 那是前端重构后的事——配色与画布上的「网格标注」共用同一份偏好
    fillFogMaskPixels(imageData.data, maskSize.width, maskSize.height, cells, grid, fogMask, colorOf);
    context.putImageData(imageData, 0, 0);
    imageDataRef.current = imageData;
    lastPointRef.current = null;
    // 遮罩重画了 → 整区开关也回到「都没打开」
    setRevealedRegions([]);
  }, [open, canvas, maskSize, grid, cells, fogMask, colorOf]);


  // 贴图那块长宽比盒子的实际尺寸：等比装进左侧可用区域（窗口大小一变就重算）
  const stageBox =
    imageRef === undefined
      ? { width: 0, height: 0 }
      : fitBox(stage, imageRef.width / Math.max(1, imageRef.height));

  const ready = open && maskSize !== undefined && grid !== undefined;
  // 笔刷半径（纹理像素）：与前端 `ApplyEraseStroke` 的 `radiusTex` 同式（归一化半径 × 遮罩宽）
  const radius = brushRadiusFor(maskSize?.width ?? MASK_PREVIEW_WIDTH);

  /** 左侧画布区的节点（callback ref 存 state：窗口一挂上/变尺寸就重新量，见 `fitBox`）。 */
  const setStageNode = useCallback((node: HTMLDivElement | null) => {
    stageObserverRef.current?.disconnect();
    stageObserverRef.current = null;
    if (node === null) {
      setStage({ width: 0, height: 0 });
      return;
    }

    const apply = (width: number, height: number): void => setStage({ width, height });
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) {
        apply(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(node);
    stageObserverRef.current = observer;
    apply(node.clientWidth, node.clientHeight);
  }, []);

  /** 指针位置 → 遮罩的**纹理像素坐标**（左上原点、y 向下；前端收到后再翻转 y）。 */
  const toTexelPoint = (event: React.PointerEvent<HTMLCanvasElement>): MaskPoint => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - box.left) / Math.max(1, box.width)));
    const y = Math.max(0, Math.min(1, (event.clientY - box.top) / Math.max(1, box.height)));
    return { x: x * (maskSize?.width ?? 1), y: y * (maskSize?.height ?? 1) };
  };

  /** 纹理像素坐标 → **归一化坐标**（下发给前端的就是这个：`[0,1]`、y 向下）。 */
  const toNormalized = (point: MaskPoint): FogRevealPoint => ({
    x: point.x / Math.max(1, maskSize?.width ?? 1),
    y: point.y / Math.max(1, maskSize?.height ?? 1),
  });

  /**
   * 把攒下的落点按批发给前端（运行态；编辑态 store 那边什么都不做）。
   *
   * `done` = 抬手 / 取消那一批：剩下的点一起发。拖动中每批都会有回执，
   * 但成功回执不写日志（`eraseFogMask` 里静默），所以运行日志不会被刷屏。
   */
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
    useEditorStore.getState().eraseFogMask(objectId, batch.sent, done);
  };

  /** 在纹理像素坐标的一个点上擦一下（就地改遮罩像素并回写画布）。 */
  const eraseAt = (point: MaskPoint): void => {
    const imageData = imageDataRef.current;
    const context = canvas?.getContext("2d") ?? null;
    if (imageData === null || context === null || maskSize === undefined) {
      return;
    }

    applyEraseToPixels(
      imageData.data,
      maskSize.width,
      maskSize.height,
      point,
      radius,
      MASK_BRUSH_SOFTNESS,
    );
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
   * 整区开 / 关：把这一区的格子一次性揭示或盖回去（与前端「玩家进区 → 整片揭示」同一个意思）。
   *
   * 只改这一窗口里的遮罩：不写文档、不进撤销栈；关掉重开回到未探索的样子。
   * 手动擦掉的零散部分**不会**让开关跟着变——开关管的是「整区」，不是「擦过没有」。
   *
   * 运行态下顺手下发一条 `reveal_fog_region`：前端按**同一顺序**重放（盖回会连带盖掉
   * 这一区里之前擦掉的部分），与这里看到的一致。
   */
  const toggleRegion = (bit: number, revealed: boolean): void => {
    const imageData = imageDataRef.current;
    const context = canvas?.getContext("2d") ?? null;
    if (
      imageData === null ||
      context === null ||
      maskSize === undefined ||
      grid === undefined ||
      cells === undefined
    ) {
      return;
    }

    paintRegionPixels(
      imageData.data,
      maskSize.width,
      maskSize.height,
      cells,
      grid,
      bit,
      colorOf,
      revealed,
    );
    context.putImageData(imageData, 0, 0);
    setRevealedRegions((previous) =>
      revealed ? [...previous, bit] : previous.filter((value) => value !== bit),
    );

    if (objectId !== null) {
      useEditorStore.getState().setFogRegionRevealed(objectId, bit, revealed);
    }
  };

  // 目标对象缺了（不是地图 / 没贴图 / 没网格）：交给外壳渲染「找不到这张地图」占位
  if (map === undefined || imageRef === undefined || grid === undefined) {
    return (
      <MapDialogShell open={open} onClose={onClose} prefix="fog-mask" title="战争雾 Mask" found={false}>
        {null}
      </MapDialogShell>
    );
  }

  return (
    <MapDialogShell
      open={open}
      onClose={onClose}
      prefix="fog-mask"
      title="战争雾 Mask"
      found
      // 用法不写（软边圆刷 / 整区开关一眼就懂），只留这条会让人意外的语义
      footer={
        <span>
          {running
            ? "擦了会下发给前端（拖动中分批发）"
            : "擦了不写文档：关掉重开就回到未探索的样子"}
        </span>
      }
    >
      <div className="flex min-h-0 flex-1 gap-2">
        <div
          ref={setStageNode}
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        >
          {/*
            长宽比盒子：尺寸由 JS 按**可用区域**算（`fitBox`），所以窗口变大变小时
            既铺得开、又不会被挤出可视区（挤出的话那部分既看不见也点不到）。
            贴图与遮罩都铺满它，两块永远严丝合缝——落点换算也才准。
          */}
          <div
            data-testid="fog-mask-stage"
            className="relative bg-black"
            style={{ width: stageBox.width, height: stageBox.height }}
          >
            <img
              src={assetRawUrl(imageRef.id)}
              alt="地图"
              className="absolute left-0 top-0 h-full w-full object-contain"
            />
            <canvas
              ref={setCanvas}
              data-testid="fog-mask-canvas"
              className="absolute left-0 top-0 h-full w-full touch-none"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
            />
          </div>
        </div>

        {/* 右侧：**整区开关**——一区一个，打开 = 整片揭示、关闭 = 整片盖回去 */}
        <div
          data-testid="fog-region-panel"
          className="flex w-40 flex-none flex-col gap-1 overflow-auto rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] p-2"
        >
          <span className="text-[10px] text-[var(--color-editor-text-dim)]">整区开关</span>
          {regions.length === 0 ? (
            <span className="text-[10px] text-[var(--color-editor-warn)]">还没有指定雾区</span>
          ) : (
            regions.map((bit) => (
              <label
                key={bit}
                className="flex items-center gap-1.5 text-[11px]"
                title={`${maskToLabel(bit)}：打开 = 整区揭示，关闭 = 整片盖回去（只在本窗口里，不写文档）`}
              >
                <input
                  type="checkbox"
                  data-testid={`fog-region-toggle-${bit}`}
                  checked={revealedRegions.includes(bit)}
                  className="h-3.5 w-3.5 flex-none accent-[var(--color-editor-accent)]"
                  onChange={(event) => toggleRegion(bit, event.target.checked)}
                />
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 flex-none rounded-sm border border-black/40"
                  style={{ background: colors[bit] ?? "#ffffff" }}
                />
                <span className="truncate">{maskToLabel(bit)}</span>
              </label>
            ))
          )}
          <span className="mt-auto text-[10px] leading-relaxed text-[var(--color-editor-text-dim)]">
            开关只管整区；手动擦的零散部分不跟着变
          </span>
        </div>
      </div>
    </MapDialogShell>
  );
}
