import { useEffect, useMemo, useRef, useState } from "react";
import {
  ALL_MASK,
  CellMask,
  MAX_BRUSH_SIZE,
  MIN_BRUSH_SIZE,
  PAINTABLE_MASKS,
  brushEffectiveSize,
  hasMask,
  isInsideGrid,
  maskToLabel,
  worldRectOf,
  worldToGridPoint,
  type GridPoint,
  type WorldRect,
} from "@dts/grid";
import { mapDataOf } from "@dts/document";
import {
  createCanvasSceneRenderer,
  fitViewport,
  screenToWorld,
  type SceneLayer,
  type SceneRenderer,
  type Viewport,
} from "@dts/renderer";
import { sceneImage, sceneImageError, subscribeSceneImage } from "../services/scene-image";
import { MapDialogShell, useSceneObject } from "./map-dialog-shell";
import { useEditorStore } from "../state/editor-store";
import { cellColorsOf, countCellsWithMask, decodeCellsCached } from "../panels/scene/grid-paint";

/**
 * 「网格编辑窗口」：在贴图上**按区域**涂 / 擦格子。
 *
 * 这是**唯一**的格子编辑入口（画布上那套标注模式已经去掉）。工具状态（画笔类型 / 大小 /
 * 配色 / 每类显示开关）仍然是那套浏览器本地偏好（`gridPaint`，见
 * `services/grid-paint-prefs`），文档里只落 `map.cells`。好处是不用在地图上对准格子——
 * 窗口把这张地图装满，落笔就落在格子上。
 *
 * 几件事是刻意的：
 * - **格子级**：落笔吸附到格子上（与 Unity 的 `GridMapEditorWindow` 同一套），
 *   所以这里的画布用与场景同一个渲染器（`@dts/renderer`），屏幕 → 格子走
 *   `screenToWorld` → `worldToGridPoint`；网格外落笔不画。**软边像素遮罩是另一件事**——
 *   那是运行时的「战争雾 Mask 窗口」。
 * - **每类一个显示开关**：与画布**共用**同一份偏好，关掉只是不画这一层——
 *   数据不动，画笔也照样能画它（同 Unity）。
 * - 每个区域名字前是它的颜色（点一下即可改；透明度跟类型绑定，与 Unity 的 `ColorField` 一致）。
 * - 窗口自带视口（`fitViewport` 把这张地图装满），所以**不要求地图已激活 / 已落位**。
 * - 指针捕获 + 补齐两个事件点之间的格子（快拖不断线），一整笔一条撤销记录。
 *
 * 渲染器与尺寸**按节点驱动**（callback ref + state），不依赖 `open`——窗口内容由 Radix 在
 * `open` 变真的**下一次提交**才挂上来，依赖 `open` 的 effect 跑起来时 ref 还是 null。
 */

/** 设备像素比上限，与场景画布一致（再高只是白烧 GPU）。 */
const MAX_DPR = 2;

/** 视口四周留的边距（CSS 像素）：别让地图贴着窗口边。 */
const VIEW_PADDING = 12;

interface GridEditDialogProps {
  readonly open: boolean;
  /** 正在编辑的地图对象 id；null 表示窗口没打开 */
  readonly objectId: string | null;
  readonly onClose: () => void;
}

export function GridEditDialog({
  open,
  objectId,
  onClose,
}: GridEditDialogProps): React.JSX.Element {
  const colors = useEditorStore((state) => state.gridPaint.colors);
  const gridPaint = useEditorStore((state) => state.gridPaint);
  const setGridBrush = useEditorStore((state) => state.setGridBrush);
  const setGridBrushSize = useEditorStore((state) => state.setGridBrushSize);
  const toggleGridTypeVisible = useEditorStore((state) => state.toggleGridTypeVisible);
  const setGridTypeColor = useEditorStore((state) => state.setGridTypeColor);
  const paintGridStroke = useEditorStore((state) => state.paintGridStroke);
  const endGridStroke = useEditorStore((state) => state.endGridStroke);
  const clearGrid = useEditorStore((state) => state.clearGrid);

  // 目标对象现查一次：它可能已经被删掉（删了窗口就该关，这里只是兜底不崩）
  const object = useSceneObject(objectId);
  const map = object === undefined ? undefined : mapDataOf(object);
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

  const annotated =
    map === undefined
      ? 0
      : countCellsWithMask(
          decodeCellsCached(map.cells.runs, map.grid.width * map.grid.height),
          ALL_MASK,
        );

  const rendererRef = useRef<SceneRenderer | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  /** 这一笔的上一格：用来把两次 pointermove 之间的格子补齐（快拖不断线）。 */
  const strokeFromRef = useRef<GridPoint | null>(null);

  /** 画布 / 容器节点（callback ref 存 state，见文件头最后一条）。 */
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

  // 绘制：贴图 + 网格线 + 8 个区域的着色
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
      // 窗口**不转**：这里的坐标是「第几列第几行」，转起来落笔就得跟着换算，
      // 而这扇窗只服务「涂格子」这一件事。画布上的地图按它的角度正常显示。
      rotation: 0,
      grid,
      cells: decodeCellsCached(map.cells.runs, grid.width * grid.height),
      // 关掉的那几类不画（只影响显示：数据与画笔都不受影响）
      cellColors: (mask) => cellColorsOf(mask, gridPaint.hiddenMask, colors),
      // 窗口里要看清自己在改哪一格，网格线一直画（不受画布上那个显示开关影响）
      showGrid: true,
    };

    renderer.draw({
      viewport,
      cssWidth: size.width,
      cssHeight: size.height,
      layers: [layer],
    });
    // map / gridPaint 每次文档或偏好变化都是新对象，正好触发重画；
    // canvas 进依赖是为了「窗口内容刚挂上」那一次也能画出来（渲染器在更早的 effect 里建好）
  }, [map, grid, rect, gridPaint, colors, size, image, imageReady, canvas]);

  /** 指针落在哪一格；在网格外返回 `undefined`（与 Unity 同一条规矩：外面点一下不画）。 */
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

  const onStroke = (from: GridPoint | null, to: GridPoint): void => {
    if (objectId === null) {
      return;
    }

    // 画笔与大小在 store 里取：就是右侧面板里选中的那一套
    paintGridStroke(objectId, from, to);
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
    // 断开撤销合并：下一笔才是新的一条记录
    endGridStroke();
  };

  return (
    <MapDialogShell
      open={open}
      onClose={onClose}
      prefix="grid-editor"
      title="网格编辑"
      found={map !== undefined && grid !== undefined}
      footer={
        <button
          type="button"
          data-testid="grid-editor-clear"
          disabled={annotated === 0}
          title="清空这张地图的格子（可撤销）"
          className="toolbar-button ml-auto flex-none hover:toolbar-button-hover disabled:opacity-40"
          onClick={() => objectId !== null && clearGrid(objectId)}
        >
          全部清除
        </button>
      }
    >
      <div className="flex min-h-0 flex-1 gap-2">
        <div ref={setContainer} className="relative min-h-0 flex-1 rounded bg-black/30">
          <canvas
            ref={setCanvas}
            data-testid="grid-editor-canvas"
            className="h-full w-full touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
          />
          {imageError === undefined ? null : (
            <div
              data-testid="grid-editor-image-error"
              className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-2 py-1 font-mono text-[10px] text-[var(--color-editor-warn)]"
            >
              {imageError}
            </div>
          )}
        </div>

        {/* 右侧：**标记类型**（橡皮擦 + 8 个区域）+ 画笔大小，与战争雾窗口同一套布局 */}
        <div
          data-testid="grid-editor-type-panel"
          className="flex w-40 flex-none flex-col gap-1 overflow-auto rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] p-2 text-[11px]"
        >
          <span className="text-[10px] text-[var(--color-editor-text-dim)]">标记类型</span>

          {/* 橡皮擦：对齐 Unity 的「橡皮擦 (0)」——掩码 0 就是把整格清掉 */}
          <div className="flex items-center gap-1">
            {/* 与下面的类型行对齐：色块与显示开关的位置都留空 */}
            <span aria-hidden="true" className="h-5 w-6 flex-none" />
            <button
              type="button"
              data-testid={`grid-editor-brush-${CellMask.Empty}`}
              data-active={gridPaint.mask === CellMask.Empty}
              aria-pressed={gridPaint.mask === CellMask.Empty}
              className={`min-w-0 flex-1 truncate rounded border px-1.5 py-0.5 text-left ${
                gridPaint.mask === CellMask.Empty
                  ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                  : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel)]"
              }`}
              onClick={() => setGridBrush(CellMask.Empty)}
            >
              橡皮擦
            </button>
            <span aria-hidden="true" className="h-3.5 w-3.5 flex-none" />
          </div>

          {PAINTABLE_MASKS.map((bit) => {
            const selected = gridPaint.mask === bit;
            // 显示开关与画布共用：关掉的那类在这里也不画（数据与画笔不受影响）
            const visible = !hasMask(gridPaint.hiddenMask, bit);
            return (
              <div key={bit} className="flex items-center gap-1">
                <input
                  type="color"
                  data-testid={`grid-editor-color-${bit}`}
                  aria-label={`${maskToLabel(bit)}颜色`}
                  title={`${maskToLabel(bit)}的颜色（透明度由类型决定）`}
                  value={colors[bit] ?? "#ffffff"}
                  className="h-5 w-6 flex-none rounded border border-[var(--color-editor-border)] bg-transparent"
                  onChange={(event) => setGridTypeColor(bit, event.target.value)}
                />
                <button
                  type="button"
                  data-testid={`grid-editor-brush-${bit}`}
                  data-active={selected}
                  aria-pressed={selected}
                  className={`min-w-0 flex-1 truncate rounded border px-1.5 py-0.5 text-left ${
                    selected
                      ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                      : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel)]"
                  }`}
                  onClick={() => setGridBrush(bit)}
                >
                  {maskToLabel(bit)}
                </button>
                {/* 显示开关：只影响画（本窗口与画布一起），数据不动、也照样能画它 */}
                <input
                  type="checkbox"
                  data-testid={`grid-editor-visible-${bit}`}
                  aria-label={`显示${maskToLabel(bit)}`}
                  title={`${visible ? "不再显示" : "显示"}${maskToLabel(bit)}（只影响显示，数据不动）`}
                  checked={visible}
                  className="h-3.5 w-3.5 flex-none accent-[var(--color-editor-accent)]"
                  onChange={() => toggleGridTypeVisible(bit)}
                />
              </div>
            );
          })}

          <span className="mt-1 text-[10px] text-[var(--color-editor-text-dim)]">
            画笔大小
          </span>
          <input
            type="range"
            data-testid="grid-editor-brush-size"
            aria-label="画笔大小"
            min={MIN_BRUSH_SIZE}
            max={MAX_BRUSH_SIZE}
            step={1}
            value={gridPaint.brushSize}
            className="w-full accent-[var(--color-editor-accent)]"
            onChange={(event) => setGridBrushSize(Number(event.target.value))}
          />
          <span className="font-mono text-[10px]" data-testid="grid-editor-brush-size-label">
            {gridPaint.brushSize}（{brushEffectiveSize(gridPaint.brushSize)}×
            {brushEffectiveSize(gridPaint.brushSize)} 格）
          </span>
        </div>
      </div>
    </MapDialogShell>
  );
}
