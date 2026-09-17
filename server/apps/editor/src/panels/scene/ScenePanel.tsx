import { useEffect, useRef } from "react";
import { createCanvasSceneRenderer, type SceneRenderer } from "@dts/renderer";
import { gridSizeFromImage } from "@dts/grid";
import { useEditorStore } from "../../state/editor-store";

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

  const mode = useEditorStore((state) => state.mode);
  const hasMapObject = useEditorStore(
    (state) =>
      state.doc.scenes
        .find((scene) => scene.id === state.activeMapId)
        ?.objects.some((object) => object.kind === "Map") ?? false,
  );

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

    const toLocal = (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = container.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const onPointerDown = (event: PointerEvent): void => {
      container.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    };

    const onPointerMove = (event: PointerEvent): void => {
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

      const { viewport, viewportSize, doc, activeMapId } = useEditorStore.getState();
      if (viewportSize.width <= 0 || viewportSize.height <= 0) {
        return;
      }

      // 地图只是场景里的一个对象；没有它也能在场景里放对象
      const scene = doc.scenes.find((item) => item.id === activeMapId);
      const mapObject = scene?.objects.find((object) => object.kind === "Map");
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
        <span className="text-[10px]">
          {mode === "run" ? "运行状态（只读）" : "编辑状态"} · 拖拽平移 / 滚轮或双指缩放
        </span>
      </div>

      <div
        ref={containerRef}
        data-testid="scene-viewport"
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{ touchAction: "none", cursor: "grab" }}
      >
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: 画布需要接受指针与触摸手势 */}
        <canvas ref={canvasRef} className="block h-full w-full" />

        {!hasMapObject ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded border border-[var(--color-editor-border)] bg-black/55 px-4 py-3 text-center">
              <div className="text-[12px] text-[var(--color-editor-text)]">当前场景还没有地图对象</div>
              <div className="mt-1 text-[11px] text-[var(--color-editor-text-dim)]">
                这里显示的是默认画布区域（1920×1080 / 64×36 格）；对象不依赖地图，可直接添加
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
