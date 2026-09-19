import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ALL_MASK,
  isInsideGrid,
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
 * 「格子编辑窗口」的**公共外壳**：贴图铺底 + 在上面按格子涂 / 擦。
 *
 * 两个窗口共用它（各自的工具条与工具状态由调用方给）：
 * - **战争雾 Mask 窗口**：画笔只列已绑定的雾区，橡皮只擦绑定位；
 * - **网格编辑窗口**：画笔是 8 个区域 + 橡皮擦，橡皮整格清零。
 *
 * 界面与交互对照参考实现（`backend_diceTale` 的 `MaskEditorDialog` + `useMaskEditor`：
 * 贴图铺底、按住涂抹），落到本项目的坐标系上是**格子级**的：
 *
 * - 画布用与场景同一个渲染器（`@dts/renderer`），屏幕 → 格子走
 *   `screenToWorld` → `worldToGridPoint`（与画布上标注同一套），网格外落笔不画；
 * - 窗口自带视口（`fitViewport` 把这张地图装满），所以**不要求地图已激活 / 已落位**；
 * - 指针捕获 + 补齐两个事件点之间的格子（快拖不断线），一整笔由调用方合并成一条撤销记录。
 *
 * 两个刻意的地方：
 * 1. 渲染器与尺寸**按节点驱动**（callback ref + state），不依赖 `open`——窗口内容由 Radix 在
 *    `open` 变真的**下一次提交**才挂上来，依赖 `open` 的 effect 跑起来时 ref 还是 null；
 * 2. 着色只给 `visibleMask` 里的位（窗口是**编辑视图**：没在编辑的东西别抢戏）。
 */

/** 设备像素比上限，与场景画布一致（再高只是白烧 GPU）。 */
const MAX_DPR = 2;

/** 视口四周留的边距（CSS 像素）：别让地图贴着窗口边。 */
const VIEW_PADDING = 12;

export interface CellPaintDialogProps {
  readonly open: boolean;
  /** 正在编辑的地图对象 id；null 表示窗口没打开 */
  readonly objectId: string | null;
  readonly onClose: () => void;
  /**
   * testid 前缀：`{slug}-dialog` / `-canvas` / `-clear` / `-close` / `-missing` / `-image-error`。
   *
   * 两个窗口同时在 DOM 里（只是没打开），所以 testid 必须分得开——e2e 靠它定位。
   */
  readonly slug: string;
  readonly title: string;
  /** 画布上给哪些格子位着色（`ALL_MASK` 里要显示的那部分）。 */
  readonly visibleMask: number;
  /** 工具条（画笔 / 大小…）：两个窗口差别都在这里，所以由调用方渲染。 */
  readonly toolbar: React.ReactNode;
  /** 底部那句说明。 */
  readonly hint: string;
  readonly clearDisabled?: boolean;
  readonly onClear: () => void;
  /** 一笔：`from → to`（含两端）经过的格子；`from` 为 null 表示起点就是 `to`。 */
  readonly onStroke: (from: GridPoint | null, to: GridPoint) => void;
  /** 抬手：断开撤销合并，使下一笔成为独立记录。 */
  readonly onStrokeEnd: () => void;
}

export function CellPaintDialog({
  open,
  objectId,
  onClose,
  slug,
  title,
  visibleMask,
  toolbar,
  hint,
  clearDisabled = false,
  onClear,
  onStroke,
  onStrokeEnd,
}: CellPaintDialogProps): React.JSX.Element {
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
  const grid = map?.grid;
  const imageRef = map?.image;

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

  /** 画布 / 容器节点（callback ref 存 state，见文件头第 1 条）。 */
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [imageReady, setImageReady] = useState(false);

  /** 渲染器 + 尺寸：两者都要有节点才谈得上（一个 canvas 一个渲染器，卸载时释放）。 */
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

  // 绘制：贴图 + 网格线 + **只给 visibleMask 里的位**着色
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
      // 藏掉不在 visibleMask 里的位：它们不是这个窗口在编辑的东西，画上颜色只会挡住底图
      cellColors: (mask) => cellColorsOf(mask, ALL_MASK & ~visibleMask, colors),
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
  }, [map, grid, rect, visibleMask, colors, size, image, imageReady, canvas]);

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
    if (event.button !== 0) {
      return;
    }

    const cell = cellAt(event);
    if (cell === undefined) {
      return;
    }

    // 捕获指针：拖出画布也照样收得到 move / up，一笔不会断
    event.currentTarget.setPointerCapture(event.pointerId);
    strokeFromRef.current = cell;
    onStroke(cell, cell);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const from = strokeFromRef.current;
    if (from === null) {
      return;
    }

    // 划出网格的那些事件跳过，但这一笔继续（回到网格里接着画）
    const cell = cellAt(event);
    if (cell === undefined) {
      return;
    }

    onStroke(from, cell);
    strokeFromRef.current = cell;
  };

  const onPointerEnd = (): void => {
    if (strokeFromRef.current === null) {
      return;
    }

    strokeFromRef.current = null;
    onStrokeEnd();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid={`${slug}-dialog`}
          className="fixed left-1/2 top-1/2 z-50 flex h-[560px] w-[820px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">{title}</Dialog.Title>

          {map === undefined || grid === undefined ? (
            <div
              data-testid={`${slug}-missing`}
              className="flex min-h-0 flex-1 items-center justify-center rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]"
            >
              找不到这张地图（可能已经被删掉了）
            </div>
          ) : (
            <>
              {toolbar}

              <div ref={setContainer} className="relative min-h-0 flex-1 rounded bg-black/30">
                <canvas
                  ref={setCanvas}
                  data-testid={`${slug}-canvas`}
                  className="h-full w-full touch-none"
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerEnd}
                  onPointerCancel={onPointerEnd}
                />
                {imageError === undefined ? null : (
                  <div
                    data-testid={`${slug}-image-error`}
                    className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-2 py-1 font-mono text-[10px] text-[var(--color-editor-warn)]"
                  >
                    {imageError}
                  </div>
                )}
              </div>

              <div className="mt-2 flex flex-none items-center gap-2 text-[10px] text-[var(--color-editor-text-dim)]">
                <span>{hint}</span>
                <button
                  type="button"
                  data-testid={`${slug}-clear`}
                  disabled={clearDisabled}
                  title="清空这张地图的格子（可撤销）"
                  className="toolbar-button ml-auto flex-none hover:toolbar-button-hover disabled:opacity-40"
                  onClick={onClear}
                >
                  全部清除
                </button>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    data-testid={`${slug}-close`}
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
