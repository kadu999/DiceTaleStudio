import { useEffect, useRef, useState } from "react";
import type { SceneDoc, WorldPosition } from "@dts/document";
import {
  createCanvasSceneRenderer,
  screenToWorld,
  worldToScreen,
  type SceneRenderer,
} from "@dts/renderer";
import { worldRectOf } from "@dts/grid";
import { sceneImage, sceneImageError, subscribeSceneImage } from "../../services/scene-image";
import { useEditorStore } from "../../state/editor-store";
import { EmptyState } from "../EmptyState";

/** 标记点的命中半径（屏幕像素）：比渲染半径略大，手指也点得中。 */
const MARKER_HIT_RADIUS = 12;

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

  // 当前场景里所有地图的贴图：一张场景可以有任意多张地图，各自带贴图
  const mapImageIds = (
    scenes.find((scene) => scene.name === activeSceneName)?.objects ?? []
  ).flatMap((object) =>
    object.kind === "Map" && object.map !== undefined ? [object.map.image.id] : [],
  );

  // 贴图读不到（素材还没提交 / 文件名不匹配）时明确写出来，否则那块地方只有棋盘格
  const imageError =
    mapImageIds
      .map((id) => sceneImageError(id))
      .filter((error) => error !== undefined)
      .join("；") || undefined;

  /**
   * 贴图加载完成信号。
   *
   * 绘制循环是 rAF、读的是 `getState()`（不参与 React 重渲染），而贴图是异步加载的，
   * 所以加载完必须**主动触发一次重渲染**：订阅贴图加载完成的事件即可。
   */
  const [imageReady, setImageReady] = useState(false);
  const subscribeKey = mapImageIds.join("|");
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
    /** 正在拖动的对象：命中标记点后进入拖动，这一下就不再平移画布。 */
    let dragging: { pointerId: number; objectId: string } | null = null;

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

    /** 命中测试：指针下那个对象的 id（画布上看得见的对象才可能被命中）。 */
    const hitTestObject = (local: { x: number; y: number }): string | undefined => {
      const scene = currentScene();
      if (scene === undefined) {
        return undefined;
      }

      const store = useEditorStore.getState();
      for (const object of scene.objects) {
        if (object.position === null) {
          continue;
        }

        const screen = worldToScreen(store.viewport, object.position);

        if (Math.hypot(screen.x - local.x, screen.y - local.y) <= MARKER_HIT_RADIUS) {
          return object.id;
        }
      }

      return undefined;
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (!hasScene()) {
        return;
      }

      const local = toLocal(event.clientX, event.clientY);
      const hit = hitTestObject(local);
      if (hit !== undefined) {
        useEditorStore.getState().setSelection([hit]);
        dragging = { pointerId: event.pointerId, objectId: hit };
        container.setPointerCapture(event.pointerId);
        return;
      }

      container.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!hasScene()) {
        return;
      }

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
      const store = useEditorStore.getState();

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

    const endPointer = (event: PointerEvent): void => {
      if (dragging !== null && dragging.pointerId === event.pointerId) {
        // 一次拖动结束：断开撤销合并，下一次拖动成为独立记录
        useEditorStore.getState().endObjectDrag();
        dragging = null;
        return;
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

    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", endPointer);
    container.addEventListener("pointercancel", endPointer);
    container.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", endPointer);
      container.removeEventListener("pointercancel", endPointer);
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

      const { viewport, viewportSize, scenes, activeSceneName, selectedObjectIds } =
        useEditorStore.getState();
      if (viewportSize.width <= 0 || viewportSize.height <= 0) {
        return;
      }

      // 地图只是场景里的对象；没有它也能在场景里放对象
      const scene = scenes.find((item) => item.name === activeSceneName);
      if (scene === undefined) {
        renderer.draw({ viewport, cssWidth: viewportSize.width, cssHeight: viewportSize.height });
        return;
      }

      // 每张地图各画各的：它自己的矩形（位置 + 贴图尺寸）+ 自己的网格
      const maps = scene.objects.flatMap((object) => {
        if (object.kind !== "Map" || object.map === undefined || object.position === null) {
          return [];
        }

        const { image, grid } = object.map;
        const mapImage = sceneImage(image.id);

        // 贴图实际像素与声明尺寸不一致时说一声：画面会被拉伸，但网格仍按声明尺寸对齐
        if (
          mapImage !== null &&
          (mapImage.naturalWidth !== image.width || mapImage.naturalHeight !== image.height)
        ) {
          warnImageSizeOnce(
            image.id,
            `贴图实际尺寸 ${mapImage.naturalWidth}×${mapImage.naturalHeight} 与地图数据里声明的 ${image.width}×${image.height} 不一致，已按声明尺寸拉伸铺满`,
          );
        }

        return [{ image: mapImage, rect: worldRectOf(object.position, image), grid, showGrid: true }];
      });

      // 每个对象在画布上画成标记点：看得见、能点、能拖，位置就是它的世界坐标
      const markers = scene.objects.flatMap((object) =>
        object.position === null
          ? []
          : [
              {
                id: object.id,
                position: object.position,
                kind: object.kind,
                label: object.name,
                selected: selectedObjectIds.includes(object.id),
              },
            ],
      );

      renderer.draw({
        viewport,
        cssWidth: viewportSize.width,
        cssHeight: viewportSize.height,
        maps,
        showOrigin: true,
        markers,
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
        style={{ touchAction: "none", cursor: activeSceneName === null ? "default" : "grab" }}
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
