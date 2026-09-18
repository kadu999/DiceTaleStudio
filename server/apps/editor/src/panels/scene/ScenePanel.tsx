import { useEffect, useRef } from "react";
import { createCanvasSceneRenderer, type SceneRenderer } from "@dts/renderer";
import { gridSizeFromImage } from "@dts/grid";
import { useEditorStore } from "../../state/editor-store";
import { EmptyState } from "../EmptyState";
/** 尚未创建地图时用于演示视口交互的默认画布尺寸（与 DiceTale 现有地图一致）。 */
const PLACEHOLDER_IMAGE = { width: 1920, height: 1080 };

/** DPR 上限：平板上 3x DPR 会把填充率吃光，限制到 2 已足够清晰。 */
const MAX_DPR = 2;

/**
 * 场景视口（中间区域）。
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

    /** 没有场景时画布不可交互：能拖能缩会让人以为「这里有个东西」。 */
    const hasScene = (): boolean => useEditorStore.getState().activeSceneName !== null;

    const toLocal = (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = container.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (!hasScene()) {
        return;
      }

      container.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!hasScene()) {
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

      const { viewport, viewportSize, scenes, activeSceneName } = useEditorStore.getState();
      if (viewportSize.width <= 0 || viewportSize.height <= 0) {
        return;
      }

      // 地图只是场景里的一个对象；没有它也能在场景里放对象
      const scene = scenes.find((item) => item.name === activeSceneName);
      if (scene === undefined) {
        // 没有场景就画空：不要凭空画出一个「看起来像地图」的区域
        renderer.draw({ viewport, cssWidth: viewportSize.width, cssHeight: viewportSize.height });
        return;
      }

      const mapObject = scene.objects.find((object) => object.kind === "Map");
      const imageSize = mapObject?.map?.image ?? PLACEHOLDER_IMAGE;
      const grid = mapObject?.map?.grid ?? {
        width: gridSizeFromImage(PLACEHOLDER_IMAGE).width,
        height: gridSizeFromImage(PLACEHOLDER_IMAGE).height,
        cellSize: 1,
      };

      renderer.draw({
        viewport,
        cssWidth: viewportSize.width,
        cssHeight: viewportSize.height,
        image: null,
        imageSize,
        grid: { width: grid.width, height: grid.height },
        showGrid: true,
      });
    };

    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

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
          <span className="ml-auto text-[10px]">拖拽平移 / 滚轮或双指缩放</span>
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
