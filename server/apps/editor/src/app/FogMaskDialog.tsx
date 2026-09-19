import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ALL_MASK,
  cellMaskRgba,
  defaultCellMaskStyle,
  regionsToMask,
  visibleMaskBits,
  type GridSize,
} from "@dts/grid";
import { assetRawUrl } from "../panels/asset-picker";
import { decodeCellsCached } from "../panels/scene/grid-paint";
import {
  MASK_BRUSH_SOFTNESS,
  MASK_PREVIEW_WIDTH,
  applyEraseToPixels,
  brushRadiusFor,
  fillFogMaskPixels,
  previewMaskSizeFor,
  strokeStampCenters,
  type MaskPoint,
} from "../services/mask-math";
import { useEditorStore } from "../state/editor-store";

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
 * - 没有「画笔 / 画回去 / 全部清除」：运行时那边也只有擦除（雾只会被揭示，不会被重新盖上）。
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
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const colors = useEditorStore((state) => state.gridPaint.colors);

  // 目标对象现查一次：它可能已经被删掉（删了窗口就该关，这里只是兜底不崩）
  const object =
    objectId === null
      ? undefined
      : scenes
          .find((scene) => scene.name === activeSceneName)
          ?.objects.find((item) => item.id === objectId);
  const map = object?.map;
  const imageRef = map?.image;

  const regions = map?.fog?.regions ?? [];
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
  const lastPointRef = useRef<MaskPoint | null>(null);

  /**
   * 画布节点（callback ref 存 state）。
   *
   * **不能只依赖 `open`**：窗口内容由 Radix 在 `open` 变真的**下一次提交**才挂上来，
   * 依赖 `open` 的 effect 跑起来时 ref 还是 null——那样遮罩永远不会被初始化，
   * 画布一直是空白的（擦也没得擦）。节点进 state 后，挂载 / 卸载都会重跑初始化，
   * 于是「关掉再打开就回到未探索的样子」也就是同一件事。
   */
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);

  const grid: GridSize | undefined = map?.grid;
  const cells =
    map === undefined || grid === undefined
      ? undefined
      : decodeCellsCached(map.cells.runs, grid.width * grid.height);

  // 初始化遮罩像素：只有已指定雾区的格子是不透明黑，其余全透明
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
    fillFogMaskPixels(
      imageData.data,
      maskSize.width,
      maskSize.height,
      cells,
      grid,
      fogMask,
      (mask) =>
        visibleMaskBits(mask, ALL_MASK & ~fogMask).map((bit) => {
          const style = defaultCellMaskStyle(bit);
          return cellMaskRgba(colors[bit] ?? style.hex, style.alpha);
        }),
    );
    context.putImageData(imageData, 0, 0);
    imageDataRef.current = imageData;
    lastPointRef.current = null;
  }, [open, canvas, maskSize, grid, cells, fogMask, colors]);

  const ready = open && maskSize !== undefined && grid !== undefined;
  // 笔刷半径（纹理像素）：与前端 `ApplyEraseStroke` 的 `radiusTex` 同式（归一化半径 × 遮罩宽）
  const radius = brushRadiusFor(maskSize?.width ?? MASK_PREVIEW_WIDTH);

  /** 指针位置 → 遮罩的**纹理像素坐标**（左上原点、y 向下；前端收到后再翻转 y）。 */
  const toTexelPoint = (event: React.PointerEvent<HTMLCanvasElement>): MaskPoint => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - box.left) / Math.max(1, box.width)));
    const y = Math.max(0, Math.min(1, (event.clientY - box.top) / Math.max(1, box.height)));
    return { x: x * (maskSize?.width ?? 1), y: y * (maskSize?.height ?? 1) };
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
  };

  const onPointerEnd = (): void => {
    lastPointRef.current = null;
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid="fog-mask-dialog"
          // 高度**跟着内容走**（和参考实现的卡片一样）：贴图的长宽比盒子撑多高就是多高。
          // 给死高度会把画布下部挤出窗口，那部分既看不见也点不到。
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[820px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">
            战争雾 Mask（擦除预览）
          </Dialog.Title>

          {map === undefined || imageRef === undefined || grid === undefined ? (
            <div
              data-testid="fog-mask-missing"
              className="flex min-h-0 flex-1 items-center justify-center rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]"
            >
              找不到这张地图（可能已经被删掉了）
            </div>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-auto">
                {/* 长宽比盒子：贴图与遮罩都绝对定位铺满，于是两块永远严丝合缝 */}
                <div
                  className="relative w-full bg-black"
                  style={{ paddingTop: `${(imageRef.height / imageRef.width) * 100}%` }}
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

              <div className="mt-2 flex flex-none items-center gap-2 text-[10px] text-[var(--color-editor-text-dim)]">
                <span>
                  只有擦除：按住涂抹 = 模拟运行时揭示（软边圆刷）；**不写文档**，关掉重开就回到未探索的样子
                </span>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    data-testid="fog-mask-close"
                    className="toolbar-button ml-auto flex-none hover:toolbar-button-hover"
                  >
                    关闭
                  </button>
                </Dialog.Close>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
