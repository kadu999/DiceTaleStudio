import { useEffect, useRef, useState } from "react";
import {
  mapFogMask,
  objectImage,
  objectsInDrawOrder,
  type SceneDoc,
  type SceneObjectDoc,
  type WorldPosition,
} from "@dts/document";
import {
  createCanvasSceneRenderer,
  hitTestRect,
  screenToWorld,
  type SceneLayer,
  type SceneRenderer,
} from "@dts/renderer";
import {
  worldRectBottom,
  worldRectLeft,
  worldRectOf,
  type WorldRect,
} from "@dts/grid";
import { sceneImage, sceneImageError, subscribeSceneImage } from "../../services/scene-image";
import { useEditorStore } from "../../state/editor-store";
import { EmptyState } from "../EmptyState";
import { cellColorsOf, decodeCellsCached, fogPreviewLayer } from "./grid-paint";

/**
 * 没有图片的对象（刚建出来的精灵）的**碰撞体**尺寸：世界里的一块 64×64。
 *
 * 拾取与选中框都按矩形来，所以每个对象都得有一块矩形；没有图片时不能是零面积
 * （零面积的框看不见、也点不到）。它**与缩放无关**：拉远了也是一个对象该有的大小，
 * 不会像按屏幕像素算的命中区那样忽大忽小。
 */
const COLLIDER_SIZE = { width: 64, height: 64 } as const;

/**
 * 指针按键：只有**主键（鼠标左键 / 触摸 / 笔尖）**拾取与拖动；**中键只平移摄像机**；
 * 右键 / 侧键一律不参与（右键要留给将来的上下文菜单）。
 *
 * 触摸与笔的 `button` 也是 0，所以平板手势不受影响。判断时机只能是 `pointerdown`：
 * `pointermove` 的 `button` 恒为 -1，分不出按的是哪个键。
 */
const PRIMARY_BUTTON = 0;
const MIDDLE_BUTTON = 1;

/**
 * 对象在画布上占据的世界矩形 —— 拾取（碰撞体）、选中框、贴图铺的那块**共用这一个**。
 *
 * 尺寸 = 「贴图里声明的尺寸（没有图片就用 `COLLIDER_SIZE`）× **对象的缩放**」：
 * 三件事只要有一件用了别的尺寸，就会出现「看着在那儿、点不到」或「框和图片不重合」。
 * 地图也是走这条路，所以**缩放地图 = 贴图与它的网格一起缩放**（格子尺寸是
 * `贴图尺寸 ÷ 列数` 算出来的，矩形一变它跟着变）。
 *
 * 缩放值坏掉时（0 / 负数 / NaN，只可能来自手写文件）按 `1` 画：渲染不能因为一个坏数字
 * 就把整块对象画没，那种数据由 `validateScene` 报错。
 */
export function displayRectOf(object: SceneObjectDoc): WorldRect | undefined {
  if (object.position === null) {
    return undefined;
  }

  const base = objectImage(object) ?? COLLIDER_SIZE;
  const scale = Number.isFinite(object.scale) && object.scale > 0 ? object.scale : 1;
  return worldRectOf(object.position, { width: base.width * scale, height: base.height * scale });
}

/**
 * 贴图实际尺寸与地图数据声明尺寸不一致时的提醒：**每张贴图只提醒一次**。
 *
 * 绘制循环每秒跑 60 次，不能每次都往控制台写。
 */
const warnedImageSize = new Set<string>();
function warnImageSizeOnce(id: string, message: string): void {
  if (warnedImageSize.has(id)) {
    return;
  }

  warnedImageSize.add(id);
  console.warn(`[scene] ${message}`);
}

/** DPR 上限：平板上 3x DPR 会把填充率吃光，限制到 2 已足够清晰。 */
const MAX_DPR = 2;

/**
 * 棋盘底纹对齐到哪一点：**第一张画在画布上的地图**的左下角。
 *
 * 地图的网格就是从它自己那块矩形的左下角起算的（见 `@dts/grid`），底纹用同一个锚点，
 * 于是「底纹的格子」和「地图的格子」分成同一套，拖动 / 缩放地图时底纹跟着走。
 * 没有地图（纯精灵场景 / 地图没激活）时退回世界原点——底纹总得有个相位。
 *
 * 锚点取**显示矩形**（`displayRectOf`）而不是贴图声明的尺寸：地图被缩放过时，
 * 画在画布上的那块（以及它的网格）已经跟着缩放了，底纹必须跟同一个矩形对齐。
 *
 * `objects` 必须是**画布上的对象**（已按显示顺序排好、且只剩激活的）。
 */
export function checkerOriginOf(objects: readonly SceneObjectDoc[]): WorldPosition {
  for (const object of objects) {
    if (object.kind !== "Map") {
      continue;
    }

    const rect = displayRectOf(object);
    if (rect !== undefined) {
      return { x: worldRectLeft(rect), y: worldRectBottom(rect) };
    }
  }

  return { x: 0, y: 0 };
}

/**
 * 场景视口（中间区域）。
 *
 * 坐标只有**世界坐标**一套：场景中心 `(0, 0)`，x 向右、y 向上，单位像素。
 * 屏幕坐标（canvas 的 CSS 像素）是相机，指针 → 世界只做一次换算；
 * 绘制、命中测试、拖动落点**共用同一个场景尺寸**，否则会出现「点哪儿不在哪儿」。
 *
 * 性能约定：指针事件只改 store，**不触发 React 重渲染**；
 * 绘制在 rAF 循环里通过 `getState()` 直读最新值。
 */
export function ScenePanel(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);

  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const scenes = useEditorStore((state) => state.scenes);
  const setActiveScene = useEditorStore((state) => state.setActiveScene);
  const openObjectDialog = useEditorStore((state) => state.openObjectDialog);
  const resetViewport = useEditorStore((state) => state.resetViewport);

  // 当前场景里所有要显示的图片（地图贴图 + 精灵图片），一张场景可以有任意多张
  const imageIds =
    scenes
      .find((scene) => scene.name === activeSceneName)
      ?.objects.filter((object) => object.active) // 没激活的对象不画，也不用去加载它的图
      .flatMap((object) => {
        const ref = objectImage(object);
        return ref === undefined ? [] : [ref.id];
      }) ?? [];

  // 图片读不到（素材还没提交 / 文件名不匹配）时明确写出来，否则那块地方只有棋盘格
  const imageError =
    imageIds
      .map((id) => sceneImageError(id))
      .filter((error) => error !== undefined)
      .join("；") || undefined;

  /**
   * 图片加载完成信号。
   *
   * 绘制循环是 rAF、读的是 `getState()`（不参与 React 重渲染），而图片是异步加载的，
   * 所以加载完必须**主动触发一次重渲染**：订阅图片加载完成的事件即可。
   */
  const [imageReady, setImageReady] = useState(false);
  const subscribeKey = imageIds.join("|");
  useEffect(() => {
    if (subscribeKey.length === 0) {
      setImageReady(false);
      return;
    }

    const unsubscribe = subscribeKey
      .split("|")
      .map((id) => subscribeSceneImage(id, () => setImageReady(true)));
    return () => {
      for (const off of unsubscribe) {
        off();
      }
    };
  }, [subscribeKey]);

  // 渲染器生命周期
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }

    const renderer = createCanvasSceneRenderer(canvas);
    rendererRef.current = renderer;
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  // 尺寸同步
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    const apply = (width: number, height: number): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      rendererRef.current?.resize(width, height, dpr);
      useEditorStore.getState().setViewportSize({ width, height });
    };

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) {
        return;
      }

      apply(entry.contentRect.width, entry.contentRect.height);
    });

    observer.observe(container);
    apply(container.clientWidth, container.clientHeight);
    return () => {
      observer.disconnect();
    };
  }, []);

  // 视口手势：拖拽平移、滚轮/双指缩放
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDistance = 0;
    let pinchMid: { x: number; y: number } | null = null;
    /** 正在拖动的对象：命中对象矩形后进入拖动，这一下就不再平移画布。 */
    let dragging: { pointerId: number; objectId: string } | null = null;

    /**
     * 空白处按下的那一下：**是拖（平移画布）还是点（取消选中）**，要等抬手才知道。
     *
     * 按下就取消选中是不行的——那样「选中一个对象后从空白处开始平移」会顺手把选中丢
     * （而这正是最常用的手势）。所以按下只记位置，抬手时看有没有移动过：
     * 没移动过才算「点空白 = 取消选中」。
     */
    let blankPress: { pointerId: number; x: number; y: number } | null = null;

    /** 点空白处允许的抖动（屏幕像素）：手抖 / 触摸都会有几像素，超过就算拖动。 */
    const CLICK_SLOP = 4;

    /** 当前选中的对象 id（多选时是多个）。 */
    const currentSelection = (): readonly string[] => useEditorStore.getState().selectedObjectIds;

    /** Ctrl/⌘ 点选：已选中就取消，否则追加。 */
    const toggleSelection = (selection: readonly string[], id: string): readonly string[] =>
      selection.includes(id) ? selection.filter((item) => item !== id) : [...selection, id];

    /** 没有场景时画布不可交互：能拖能缩会让人以为「这里有个东西」。 */
    const hasScene = (): boolean => useEditorStore.getState().activeSceneName !== null;

    const toLocal = (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = container.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const currentScene = (): SceneDoc | undefined => {
      const store = useEditorStore.getState();
      return store.scenes.find((item) => item.name === store.activeSceneName);
    };

    /** 屏幕点 → 世界坐标（越界由 store 统一夹回场景）。 */
    const toWorld = (local: { x: number; y: number }): WorldPosition =>
      screenToWorld(useEditorStore.getState().viewport, local);

    /**
     * 命中测试：指针下那个对象的 id（画布上看得见的对象才可能被命中）。
     *
     * 每个对象用**它自己那块矩形**当碰撞体（和选中框、贴图同一块），不是中心点周围的小圆；
     * 指针落进矩形就算命中。**从后往前**找（`objectsInDrawOrder` 里靠后的画在上面），
     * 于是重叠时点到的永远是**显示顺序最大**的那一个——和眼睛看到的一致。
     * 没激活的、没落位的（`position: null`）对象根本不参与。
     */
    const hitTestObject = (local: { x: number; y: number }): string | undefined => {
      const scene = currentScene();
      if (scene === undefined) {
        return undefined;
      }

      const viewport = useEditorStore.getState().viewport;
      const world = screenToWorld(viewport, local);
      const drawOrder = objectsInDrawOrder(scene);

      for (let index = drawOrder.length - 1; index >= 0; index -= 1) {
        const object = drawOrder[index];
        if (object === undefined || !object.active) {
          continue;
        }

        const rect = displayRectOf(object);
        if (rect !== undefined && hitTestRect(world, rect, object.rotation)) {
          return object.id;
        }
      }

      return undefined;
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (!hasScene()) {
        return;
      }

      // 中键 = 只平移摄像机：不拾取、不改选中（手势与绘图工具一致）。
      // 位置进 `pointers`，于是 onPointerMove 里那条平移分支直接生效。
      if (event.button === MIDDLE_BUTTON) {
        container.setPointerCapture(event.pointerId);
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        return;
      }

      // 其余非主键（右键 / 侧键）一律不参与：右键留给将来的上下文菜单
      if (event.button !== PRIMARY_BUTTON) {
        return;
      }

      const local = toLocal(event.clientX, event.clientY);

      const hit = hitTestObject(local);
      if (hit !== undefined) {
        // 修饰键点选 = 多选（和列表里 Ctrl/⌘ 点行一个意思）；不加修饰就是单选
        const additive = event.ctrlKey || event.metaKey || event.shiftKey;
        useEditorStore
          .getState()
          .setSelection(additive ? toggleSelection(currentSelection(), hit) : [hit]);

        // 锁定的对象**点得到、选得中，就是拖不走**：不进拖动状态。
        // 按住它拖动 = 平移画布（和从空白处拖一样），于是手势仍然有用、
        // 也不会因为「点在对象上」而变成什么都不发生。
        const target = currentScene()?.objects.find((item) => item.id === hit);
        if (target?.locked === true) {
          container.setPointerCapture(event.pointerId);
          pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
          return;
        }

        dragging = { pointerId: event.pointerId, objectId: hit };
        container.setPointerCapture(event.pointerId);
        return;
      }

      container.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      blankPress = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!hasScene()) {
        return;
      }

      const store = useEditorStore.getState();

      if (dragging !== null && dragging.pointerId === event.pointerId) {
        useEditorStore
          .getState()
          .moveObject(dragging.objectId, toWorld(toLocal(event.clientX, event.clientY)));
        return;
      }

      const previous = pointers.get(event.pointerId);
      if (previous === undefined) {
        return;
      }

      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        if (a === undefined || b === undefined) {
          return;
        }

        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = toLocal((a.x + b.x) / 2, (a.y + b.y) / 2);

        if (pinchDistance > 0 && distance > 0) {
          store.zoomAtScreen(mid, distance / pinchDistance);
        }

        if (pinchMid !== null) {
          store.panByScreen(mid.x - pinchMid.x, mid.y - pinchMid.y);
        }

        pinchDistance = distance;
        pinchMid = mid;
        return;
      }

      store.panByScreen(event.clientX - previous.x, event.clientY - previous.y);
    };

    /**
     * 抬手 / 取消。`isClick` 只有真正的 pointerup 才为真：`pointercancel`（第二根手指
     * 插进来时第一根会被取消）不该被当成「点了一下空白」，否则双指缩放会顺手清掉选中。
     */
    const endPointer = (event: PointerEvent, isClick = false): void => {
      if (dragging !== null && dragging.pointerId === event.pointerId) {
        // 一次拖动结束：断开撤销合并，下一次拖动成为独立记录
        useEditorStore.getState().endObjectDrag();
        dragging = null;
        return;
      }

      // 空白处**点一下**（按下到抬手没怎么动）= 取消选中；
      // 动了就是平移画布，选中保持不动
      if (blankPress !== null && blankPress.pointerId === event.pointerId) {
        const moved = Math.hypot(event.clientX - blankPress.x, event.clientY - blankPress.y);
        if (isClick && moved <= CLICK_SLOP) {
          useEditorStore.getState().setSelection([]);
        }

        blankPress = null;
      }

      pointers.delete(event.pointerId);
      if (pointers.size < 2) {
        pinchDistance = 0;
        pinchMid = null;
      }
    };

    const onWheel = (event: WheelEvent): void => {
      if (!hasScene()) {
        return;
      }

      event.preventDefault();
      const store = useEditorStore.getState();
      const factor = Math.exp(-event.deltaY * 0.0015);
      store.zoomAtScreen(toLocal(event.clientX, event.clientY), factor);
    };

    /** pointerup = 可能是一次点击；pointercancel = 手势被打断，绝不能当成点击。 */
    const onPointerUp = (event: PointerEvent): void => endPointer(event, true);
    const onPointerCancel = (event: PointerEvent): void => endPointer(event, false);

    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("pointercancel", onPointerCancel);
    container.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerCancel);
      container.removeEventListener("wheel", onWheel);
    };
  }, []);

  // 绘制循环
  useEffect(() => {
    let frame = 0;

    const loop = (): void => {
      frame = requestAnimationFrame(loop);
      const renderer = rendererRef.current;
      if (renderer === null) {
        return;
      }

      const { viewport, viewportSize, scenes, activeSceneName, selectedObjectIds, gridPaint } =
        useEditorStore.getState();
      if (viewportSize.width <= 0 || viewportSize.height <= 0) {
        return;
      }

      // 地图只是场景里的对象；没有它也能在场景里放对象
      const scene = scenes.find((item) => item.name === activeSceneName);
      if (scene === undefined) {
        // **没有场景时不铺底纹**（只留纯色）：底纹是「这里是空的」的标记，
        // 铺满屏幕会让人以为「有个空场景」，而画面上的占位写得明明白白「没有场景」
        renderer.draw({
          viewport,
          cssWidth: viewportSize.width,
          cssHeight: viewportSize.height,
          checker: false,
        });
        return;
      }

      // 画布上只画**激活**的对象；**按显示顺序**排队（顺序大的后画 = 盖在上面），
      // 相同顺序保持场景文件里的先后，所以没调过顺序的场景看起来和以前一样
      const drawOrder = objectsInDrawOrder(scene).filter((object) => object.active);

      // 每张图片各画各的：地图的贴图（带网格）与精灵的图片走同一条路。
      // **每个对象都要出一层**（哪怕没有图片）：没有图片的对象只画选中框 + 当碰撞体，
      // 否则「刚建出来的精灵」在画布上就既看不见也点不到。
      // 显式标注成 `SceneLayer[]`：地图图层之后还要追加战争雾预览层（它也是同一张「图层」）
      const layers = drawOrder.flatMap<SceneLayer>((object) => {
        const rect = displayRectOf(object);
        if (rect === undefined) {
          return [];
        }

        const ref = objectImage(object);
        const image = ref === undefined ? null : sceneImage(ref.id);

        // 图片实际像素与引用里声明的尺寸不一致时说一声：画面会被拉伸到声明的尺寸
        if (
          ref !== undefined &&
          image !== null &&
          (image.naturalWidth !== ref.width || image.naturalHeight !== ref.height)
        ) {
          warnImageSizeOnce(
            ref.id,
            `图片实际尺寸 ${image.naturalWidth}×${image.naturalHeight} 与数据里声明的 ${ref.width}×${ref.height} 不一致，已按声明尺寸拉伸`,
          );
        }

        const map = object.map;
        const grid = map?.grid;
        // 「网格标注」总开关：关掉就整层不着色（只是不画，格子数据不动）
        const colored = map !== undefined && gridPaint.showAnnotations;
        return [
          {
            image,
            rect,
            grid,
            // 「网格线」总开关：关了就不画线（只是不画，格子数据不动）
            showGrid: grid !== undefined && gridPaint.showGridLines,
            // 格子着色：掩码位 → 一串颜色逐层叠加（隐藏的类型不画，但数据不动）
            cells: colored
              ? decodeCellsCached(map.cells.runs, map.grid.width * map.grid.height)
              : undefined,
            cellColors: colored
              ? (mask: number) => cellColorsOf(mask, gridPaint.hiddenMask, gridPaint.colors)
              : undefined,
            // 选中 = 在这块矩形上画框（4 个角点 + 4 条边中点，没有中心点）；
            // 锁住的对象用灰框：一眼看出「为什么拖不动」
            selected: selectedObjectIds.includes(object.id),
            locked: object.locked,
          },
        ];
      });

      // 战争雾预览：**盖在自己那张地图的图层之后**（运行时也是雾压在贴图之上）。
      // 每张地图各追加一层，一张场景有多张地图时互不干扰。
      // 「显示 → 战争雾」是纯显示开关：关了就不加这一层，格子数据不动。
      if (gridPaint.showFog) {
        for (const object of drawOrder) {
          const map = object.map;
          const rect = displayRectOf(object);
          if (map === undefined || rect === undefined) {
            continue;
          }

          const fogMask = mapFogMask(map);
          if (fogMask === 0) {
            continue;
          }

          const overlay = fogPreviewLayer(
            rect,
            map.grid,
            decodeCellsCached(map.cells.runs, map.grid.width * map.grid.height),
            fogMask,
            gridPaint.colors,
          );
          if (overlay !== undefined) {
            layers.push(overlay);
          }
        }
      }

      renderer.draw({
        viewport,
        cssWidth: viewportSize.width,
        cssHeight: viewportSize.height,
        layers,
        showOrigin: true,
        // 棋盘底纹与**第一张地图**的左下角对齐：格子与地图的网格分成同一套，
        // 拖动地图时底纹跟着走。没有地图（纯精灵场景）就退回世界原点
        checkerOrigin: checkerOriginOf(drawOrder),
      });
    };

    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
    };
    // imageReady：贴图是异步加载的，加载完成要重跑循环把贴图画上
  }, [imageReady]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="panel-header">
        <span>场景</span>
        {scenes.length === 0 ? null : (
          // 当前场景要看得见、也能切：否则多场景时根本不知道自己在哪一个
          <select
            data-testid="scene-switcher"
            aria-label="当前场景"
            value={activeSceneName ?? ""}
            onChange={(event) => setActiveScene(event.target.value)}
            className="min-w-0 max-w-[40%] rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 text-[11px] outline-none"
          >
            {scenes.map((scene) => (
              <option key={scene.name} value={scene.name}>
                {scene.name}
              </option>
            ))}
          </select>
        )}
        {activeSceneName === null ? null : (
          // 放最右：平板竖屏下左边 340px 可能被抽屉盖住，靠右才一定点得到
          <div className="ml-auto flex flex-none items-center gap-1">
            <button
              type="button"
              data-testid="reset-viewport"
              title="视图复位：缩放回 1:1，世界原点 (0,0) 回到画布正中"
              className="toolbar-button hover:toolbar-button-hover"
              onClick={() => resetViewport()}
            >
              复位
            </button>
            <button
              type="button"
              data-testid="new-object"
              title="新建对象（Ctrl/⌘+Shift+N）"
              className="toolbar-button hover:toolbar-button-hover"
              onClick={() => openObjectDialog(true)}
            >
              新建对象
            </button>
          </div>
        )}
      </div>

      <div
        ref={containerRef}
        data-testid="scene-viewport"
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{
          touchAction: "none",
          cursor: activeSceneName === null ? "default" : "grab",
        }}
      >
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: 画布需要接受指针与触摸手势 */}
        <canvas ref={canvasRef} className="block h-full w-full" />

        {imageError === undefined ? null : (
          // 贴图读不到时说清楚原因，否则画面只有棋盘格，看不出是「没贴图」还是「贴图坏了」
          <div
            data-testid="scene-image-error"
            className="pointer-events-none absolute left-0 top-0 rounded-br border-b border-r border-[var(--color-editor-border)] bg-black/70 px-2 py-1 text-[11px] text-[var(--color-editor-warn)]"
          >
            地图贴图未显示：{imageError}
          </div>
        )}

        {activeSceneName === null ? (
          // 占位本身可点（点一下新建场景），所以这一层**不能** pointer-events-none；
          // 没有场景时画布本来也不响应手势，不会互相干扰
          <div data-testid="no-scene-canvas" className="absolute inset-0">
            <EmptyState />
          </div>
        ) : null}
      </div>
    </div>
  );
}
