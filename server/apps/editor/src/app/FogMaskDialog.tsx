import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ALL_MASK,
  CellMask,
  MAX_BRUSH_SIZE,
  MIN_BRUSH_SIZE,
  brushEffectiveSize,
  isInsideGrid,
  maskToLabel,
  regionsToMask,
  worldRectOf,
  worldToGridPoint,
  type GridPoint,
  type WorldRect,
} from "@dts/grid";
import {
  createCanvasSceneRenderer,
  fitViewport,
  screenToWorld,
  type SceneLayer,
  type SceneRenderer,
  type Viewport,
} from "@dts/renderer";
import { sceneImage, sceneImageError, subscribeSceneImage } from "../services/scene-image";
import { useEditorStore } from "../state/editor-store";
import { cellColorsOf, decodeCellsCached } from "../panels/scene/grid-paint";

/**
 * 「战争雾 Mask 窗口」：在贴图上**按雾区**涂 / 擦。
 *
 * 交互对照参考实现（`backend_diceTale` 的 `MaskEditorDialog` + `useMaskEditor`：贴图铺底、
 * 画布上按住涂抹），但落到本项目的坐标系上——**格子级**而不是像素级：
 *
 * - 画布用与场景同一个渲染器（`@dts/renderer`），贴图 + 网格线 + 雾区着色一起画，
 *   屏幕 → 格子走 `screenToWorld` → `worldToGridPoint`（与画布上标注用的是同一套）；
 * - 画笔**只有已指定的雾区**可选（哪个区域算雾是属性面板指定的事，窗口里不重复决定）；
 * - 一格里可以同时有多个区域位，所以**橡皮只擦已指定的雾区位**，不整格清零；
 * - 一整笔（按下 → 抬手的若干次 pointermove）合并成一条撤销记录，落盘走既有的自动存。
 *
 * 与画布上那个「网格标注」模式互不干扰：这是模态窗口，编辑的是同一份格子数据，但
 * 不要求地图已激活 / 已落位（窗口自带视口，不靠拾取）。
 */

/** 设备像素比上限，与场景画布一致（再高只是白烧 GPU）。 */
const MAX_DPR = 2;

/** 视口四周留的边距（CSS 像素）：别让地图贴着窗口边。 */
const VIEW_PADDING = 12;

interface FogMaskDialogProps {
  readonly open: boolean;
  /** 正在编辑的地图对象 id；null 表示窗口没打开 */
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
  const paintFogStroke = useEditorStore((state) => state.paintFogStroke);
  const endFogStroke = useEditorStore((state) => state.endFogStroke);
  const clearFog = useEditorStore((state) => state.clearFog);

  // 目标对象现查一次：它可能已经被删掉（删了窗口就该关，这里只是兜底不崩）
  const object =
    objectId === null
      ? undefined
      : scenes
          .find((scene) => scene.name === activeSceneName)
          ?.objects.find((item) => item.id === objectId);
  const map = object?.map;
  const grid = map?.grid;
  const imageRef = map?.image;

  const regions = map?.fog?.regions ?? [];
  const fogMask = regionsToMask(regions);

  /**
   * 窗口自己的世界矩形：以贴图尺寸为基准、中心在世界原点。
   *
   * 故意**不用**对象在场景里的位置与缩放——窗口是这张地图的独立视图，视口由 `fitViewport`
   * 自己算（贴图铺满窗口）。绘制与「指针 → 格子」用**同一个矩形**，所以两者永远对得上。
   */
  const rect = useMemo<WorldRect | undefined>(
    () =>
      imageRef === undefined
        ? undefined
        : worldRectOf({ x: 0, y: 0 }, { width: imageRef.width, height: imageRef.height }),
    [imageRef?.id, imageRef?.width, imageRef?.height],
  );

  const rendererRef = useRef<SceneRenderer | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  /** 这一笔的上一格：用来把两次 pointermove 之间的格子补齐（快拖不断线）。 */
  const strokeFromRef = useRef<GridPoint | null>(null);

  /** 画布 / 容器节点（callback ref 存 state，见下面那条渲染器 effect 的说明）。 */
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [imageReady, setImageReady] = useState(false);
  /** 选中的雾区画笔；null = 还没选过（默认落在第一个已指定的雾区上）。 */
  const [picked, setPicked] = useState<number | null>(null);
  const [erasing, setErasing] = useState(false);
  const [brushSize, setBrushSize] = useState(1);

  // 每次打开都回到「第一个雾区、画笔 1、涂抹模式」：窗口是临时工具，不留上一次的怪状态
  useEffect(() => {
    if (open) {
      setPicked(null);
      setErasing(false);
      setBrushSize(1);
      strokeFromRef.current = null;
    }
  }, [open]);

  /**
   * 渲染器 + 尺寸：**按节点驱动，而不是按 `open`**。
   *
   * 窗口内容由 Radix 在 `open` 变真的**下一次提交**才挂上来（Presence / Portal），
   * 所以依赖 `open` 的 effect 跑起来时 ref 还是 null——渲染器与尺寸就永远建不起来
   * （画布一直是 300×150 的后备缓冲，视口算不出来，落笔也就画不上）。
   * 两个节点进 state（callback ref），挂载/卸载都会重跑这一条，顺序问题自然消失。
   */
  useEffect(() => {
    if (canvas === null) {
      rendererRef.current = null;
      viewportRef.current = null;
      return;
    }

    const renderer = createCanvasSceneRenderer(canvas);
    rendererRef.current = renderer;

    const apply = (width: number, height: number): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      renderer.resize(width, height, dpr);
      setSize({ width, height });
    };

    // 尺寸只从容器量（画布撑满容器）；容器还没挂上时留到下一次 effect
    let observer: ResizeObserver | null = null;
    if (container !== null) {
      observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry === undefined) {
          return;
        }

        apply(entry.contentRect.width, entry.contentRect.height);
      });
      observer.observe(container);
      apply(container.clientWidth, container.clientHeight);
    }

    return () => {
      observer?.disconnect();
      renderer.dispose();
      rendererRef.current = null;
      viewportRef.current = null;
      // 卸载时把尺寸归零：下次打开别拿上一次的尺寸算视口
      setSize({ width: 0, height: 0 });
    };
  }, [canvas, container]);

  // 贴图是异步加载的：加载完成（或失败）要主动重画一次
  useEffect(() => {
    if (imageRef === undefined) {
      setImageReady(false);
      return;
    }

    return subscribeSceneImage(imageRef.id, () => setImageReady(true));
  }, [imageRef?.id]);

  const image = imageRef === undefined ? null : sceneImage(imageRef.id);
  const imageError = imageRef === undefined ? undefined : sceneImageError(imageRef.id);

  // 绘制：贴图 + 网格线 + **只有已指定雾区**的格子着色（别的区域位不在这里显示）
  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer === null || size.width <= 0 || size.height <= 0) {
      return;
    }

    if (map === undefined || grid === undefined || rect === undefined) {
      viewportRef.current = null;
      renderer.draw({
        viewport: { scale: 1, tx: 0, ty: 0 },
        cssWidth: size.width,
        cssHeight: size.height,
        layers: [],
      });
      return;
    }

    const viewport = fitViewport([rect], { width: size.width, height: size.height }, VIEW_PADDING);
    viewportRef.current = viewport;

    const layer: SceneLayer = {
      image,
      rect,
      grid,
      cells: decodeCellsCached(map.cells.runs, grid.width * grid.height),
      // 隐藏掉所有**没指定**的区域位：它们不是雾，画上颜色只会挡住底图
      cellColors: (mask) => cellColorsOf(mask, ALL_MASK & ~fogMask, colors),
      // 窗口里要看清自己在改哪一格，网格线一直画（不受画布上那个显示开关影响）
      showGrid: true,
    };

    renderer.draw({
      viewport,
      cssWidth: size.width,
      cssHeight: size.height,
      layers: [layer],
    });
    // map / colors 每次文档或配色变化都是新对象，正好触发重画；
    // canvas 进依赖是为了「窗口内容刚挂上」那一次也能画出来（渲染器在更早的 effect 里建好）
  }, [map, grid, rect, fogMask, colors, size, image, imageReady, canvas]);

  const activeBit = picked !== null && regions.includes(picked) ? picked : (regions[0] ?? null);
  const paintMask = erasing || activeBit === null ? CellMask.Empty : activeBit;
  const paintable = object !== undefined && map !== undefined && fogMask !== 0;

  /** 指针落在哪一格；在网格外返回 `undefined`（与画布标注同一条规矩：外面点一下不画）。 */
  const cellAt = (event: React.PointerEvent<HTMLCanvasElement>): GridPoint | undefined => {
    const viewport = viewportRef.current;
    if (canvas === null || viewport === null || grid === undefined || rect === undefined) {
      return undefined;
    }

    const box = canvas.getBoundingClientRect();
    const cell = worldToGridPoint(
      screenToWorld(viewport, { x: event.clientX - box.left, y: event.clientY - box.top }),
      grid,
      rect,
    );
    return isInsideGrid(cell, grid) ? cell : undefined;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    // 只认主键：右键留给将来的上下文菜单（与画布上的约定一致）
    if (event.button !== 0 || object === undefined || !paintable) {
      return;
    }

    const cell = cellAt(event);
    if (cell === undefined) {
      return;
    }

    // 捕获指针：拖出画布也照样收得到 move / up，一笔不会断
    event.currentTarget.setPointerCapture(event.pointerId);
    strokeFromRef.current = cell;
    paintFogStroke(object.id, cell, cell, { mask: paintMask, brushSize });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const from = strokeFromRef.current;
    if (from === null || object === undefined) {
      return;
    }

    // 划出网格的那些事件跳过，但这一笔继续（回到网格里接着画）
    const cell = cellAt(event);
    if (cell === undefined) {
      return;
    }

    paintFogStroke(object.id, from, cell, { mask: paintMask, brushSize });
    strokeFromRef.current = cell;
  };

  const onPointerEnd = (): void => {
    if (strokeFromRef.current === null) {
      return;
    }

    strokeFromRef.current = null;
    // 断开撤销合并：下一笔才是新的一条记录
    endFogStroke();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid="fog-mask-dialog"
          className="fixed left-1/2 top-1/2 z-50 flex h-[560px] w-[820px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">
            战争雾 Mask
          </Dialog.Title>

          {map === undefined || grid === undefined ? (
            <div
              data-testid="fog-mask-missing"
              className="flex min-h-0 flex-1 items-center justify-center rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]"
            >
              找不到这张地图（可能已经被删掉了）
            </div>
          ) : (
            <>
              {/* 画笔工具条：只有**已指定的雾区**可选；擦除只擦这些位 */}
              <div className="mb-2 flex flex-none flex-wrap items-center gap-1.5 rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] px-2 py-1 text-[11px]">
                <span className="text-[var(--color-editor-text-dim)]">画笔</span>
                {regions.length === 0 ? (
                  <span className="text-[var(--color-editor-warn)]">
                    还没有指定雾区：先关掉窗口，在属性面板的「战争雾 → 指定雾区」里点几个区域
                  </span>
                ) : (
                  regions.map((bit) => {
                    const selected = !erasing && bit === activeBit;
                    return (
                      <button
                        key={bit}
                        type="button"
                        data-testid={`fog-brush-bit-${bit}`}
                        data-active={selected}
                        aria-pressed={selected}
                        className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${
                          selected
                            ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                            : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel)]"
                        }`}
                        onClick={() => {
                          setPicked(bit);
                          setErasing(false);
                        }}
                      >
                        <span
                          aria-hidden="true"
                          className="h-2.5 w-2.5 flex-none rounded-sm border border-black/40"
                          style={{ background: colors[bit] ?? "#ffffff" }}
                        />
                        {maskToLabel(bit)}
                      </button>
                    );
                  })
                )}

                <button
                  type="button"
                  data-testid="fog-brush-erase"
                  data-active={erasing}
                  aria-pressed={erasing}
                  disabled={fogMask === 0}
                  className={`rounded border px-1.5 py-0.5 disabled:opacity-40 ${
                    erasing
                      ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                      : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel)]"
                  }`}
                  onClick={() => setErasing(true)}
                >
                  橡皮擦
                </button>

                <span className="ml-auto flex items-center gap-1.5">
                  <span className="text-[var(--color-editor-text-dim)]">大小</span>
                  <input
                    type="range"
                    data-testid="fog-brush-size"
                    aria-label="画笔大小"
                    min={MIN_BRUSH_SIZE}
                    max={MAX_BRUSH_SIZE}
                    step={1}
                    value={brushSize}
                    className="w-24 accent-[var(--color-editor-accent)]"
                    onChange={(event) => setBrushSize(Number(event.target.value))}
                  />
                  <span className="font-mono" data-testid="fog-brush-size-label">
                    {brushSize}（{brushEffectiveSize(brushSize)}×{brushEffectiveSize(brushSize)} 格）
                  </span>
                </span>
              </div>

              <div ref={setContainer} className="relative min-h-0 flex-1 rounded bg-black/30">
                <canvas
                  ref={setCanvas}
                  data-testid="fog-mask-canvas"
                  className="h-full w-full touch-none"
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerEnd}
                  onPointerCancel={onPointerEnd}
                />
                {imageError === undefined ? null : (
                  <div
                    data-testid="fog-mask-image-error"
                    className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-2 py-1 font-mono text-[10px] text-[var(--color-editor-warn)]"
                  >
                    {imageError}
                  </div>
                )}
              </div>

              <div className="mt-2 flex flex-none items-center gap-2 text-[10px] text-[var(--color-editor-text-dim)]">
                <span>左键涂抹、拖动连成一片；橡皮只擦掉已指定的雾区（同格的其它区域保留）</span>
                <button
                  type="button"
                  data-testid="fog-clear"
                  disabled={fogMask === 0}
                  title="清空已指定雾区的格子（可撤销）"
                  className="toolbar-button ml-auto flex-none hover:toolbar-button-hover disabled:opacity-40"
                  onClick={() => object !== undefined && clearFog(object.id)}
                >
                  全部清除
                </button>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    data-testid="fog-mask-close"
                    className="toolbar-button flex-none hover:toolbar-button-hover"
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
