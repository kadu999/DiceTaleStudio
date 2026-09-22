import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  mapDataOf,
  objectsInDrawOrder,
  type SceneDoc,
  type SceneObjectDoc,
  type WorldPosition,
} from "@dts/document";
import {
  createCanvasSceneRenderer,
  gizmoScreenGeometry,
  hitTestGizmoHandles,
  hitTestRect,
  screenToWorld,
  type GizmoHandle,
  type GizmoScreenHandles,
  type SceneLayer,
  type SceneRenderer,
  type SceneToolHandles,
  type TransformTool,
  type Viewport,
} from "@dts/renderer";
import {
  worldRectBottom,
  worldRectLeft,
} from "@dts/grid";
import { sceneImage, sceneImageError, subscribeSceneImage } from "../../services/scene-image";
import { useEditorStore } from "../../state/editor-store";
import { EmptyState } from "../EmptyState";
import { badgeIconOf } from "../object-kinds";
import { displayImageOf, displayRectOf, displaySizeOf } from "./display";
import { cellColorsOf, decodeCellsCached } from "./grid-paint";

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
 * 画布上给某个对象算出一份**屏幕手柄几何**（移动轴 / 旋转环 / 缩放块）。
 *
 * **绘制与命中测试都只走这一个函数**：手柄画在哪、点在哪，坐标从同一个源头出，
 * 于是「看得见的柄点不中」这类问题在结构上不可能再出现（它们曾经各算一套而分叉）。
 *
 * 用的是**对象自己的矩形**（`displayRectOf`）+ `object.rotation`：缩放手柄于是落在对象
 * 真正的四个角上，旋转环与移动轴条的间距也不随角度变化（见 `gizmoScreenGeometry`）。
 */
function gizmoGeometryOf(
  object: SceneObjectDoc,
  viewport: Viewport,
): GizmoScreenHandles | undefined {
  const rect = displayRectOf(object);
  return rect === undefined ? undefined : gizmoScreenGeometry(rect, object.rotation, viewport);
}

/**
 * 把几何包成渲染器要的形状（补上工具名、锁定与「画不画」）。
 *
 * 几何本身来自 `gizmoGeometryOf`——与命中测试同一个函数，所以画出来的就是点得到的。
 */
function buildToolHandles(
  object: SceneObjectDoc,
  tool: TransformTool,
  viewport: Viewport,
): SceneToolHandles | undefined {
  const geometry = gizmoGeometryOf(object, viewport);
  if (geometry === undefined) {
    return undefined;
  }

  return {
    tool,
    center: geometry.center,
    corners: geometry.corners,
    axes: geometry.axes,
    scale: geometry.scale,
    ringRadius: geometry.ringRadius,
    locked: object.locked,
    drawable: geometry.drawable,
  };
}

/**
 * 对象的**局部**半宽 / 半高（世界单位，未旋转）。
 *
 * 缩放锚点要用它：四角、对边中点都定义在对象自己的轴上。
 */
function localHalfSizeOf(object: SceneObjectDoc): { readonly width: number; readonly height: number } {
  const size = displaySizeOf(object);
  return { width: size.width / 2, height: size.height / 2 };
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

/** 这一根移动柄约束的是哪个轴；旋转 / 缩放柄与「拖对象本体」返回 `undefined`（不受轴约束）。 */
function moveAxisOf(handle: GizmoHandle | null): "x" | "y" | undefined {
  if (handle === "move-x") {
    return "x";
  }

  return handle === "move-y" ? "y" : undefined;
}

/**
 * 一次手柄拖拽的最新指针位置。
 *
 * **指针事件只记这个，不写文档**：鼠标 1000Hz 轮询 / 高刷屏下一秒钟能有几千个事件，
 * 每个事件写一次文档 = 每毫秒一次全应用重渲染（拖拽卡顿的主要来源）。真正落盘在绘制
 * 循环里做，每个动画帧一次（见 `applyPendingTransform`）。
 */
interface PendingDragPointer {
  readonly clientX: number;
  readonly clientY: number;
  /** Shift 的当前状态：吸附 15° / 锁等比都按它算，所以每帧取最新那次的。 */
  readonly shiftKey: boolean;
}

/** 正在拖的手柄（一次只有一个）。`handle: null` = **拖的是对象本体**（自由移动）。 */
interface HandleDrag {
  readonly pointerId: number;
  readonly handle: GizmoHandle | null;
  readonly rect: DOMRect;
}

/** DPR 上限：平板上 3x DPR 会把填充率吃光，限制到 2 已足够清晰。 */
const MAX_DPR = 2;

/**
 * 一个场景里**当前要显示的图片 id**（只算激活的对象）。
 *
 * 抽成纯函数是为了让面板能用一个**窄选择器**订阅它：拖手柄时文档每帧都在变，
 * 但这个数组不变——`useShallow` 一比就跳过重渲染，画布那边照旧每帧重画。
 */
function activeSceneImageIds(
  scenes: readonly SceneDoc[],
  activeSceneName: string | null,
): readonly string[] {
  return (
    scenes
      .find((scene) => scene.name === activeSceneName)
      ?.objects.filter((object) => object.active) // 没激活的对象不画，也不用去加载它的图
      .flatMap((object) => {
        const ref = displayImageOf(object);
        return ref === undefined ? [] : [ref.id];
      }) ?? []
  );
}

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
 * 性能约定：指针事件只**记下最新位置**（每个动画帧落一次盘，见 `applyPendingTransform`），
 * 不触发 React 重渲染；绘制在 rAF 循环里通过 `getState()` 直读最新值。
 * 一次手柄拖拽因此最多每帧一次文档写入、一次 React 重渲染，与 pointermove 的事件数无关。
 */
export function ScenePanel(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);

  /* ------------------------------------------------------------------ 手柄拖拽
   *
   * 拖拽状态放在 **ref** 里而不是 local state：绘制循环（另一个 effect）要读它，
   * 而指针事件不该触发 React 重渲染——画布本来就每帧重画。
   */

  /** 正在拖的手柄（一次只有一个）。移动轴 / 旋转环 / 缩放块都归它。 */
  const dragRef = useRef<HandleDrag | null>(null);
  /** 最新一次的指针（还没落盘的那一次）。 */
  const pendingDragRef = useRef<PendingDragPointer | null>(null);
  /** 光标悬停的手柄（绘制循环每帧算一次，用来画高亮 + 换光标）。 */
  const hoverRef = useRef<GizmoHandle | null>(null);
  /** 最后一次指针位置（clientX/Y）：悬停命中测试按帧做一次就够。 */
  const lastPointerRef = useRef<{ readonly x: number; readonly y: number } | null>(null);

  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  // 视口订阅：只用来把当前变换写进 DOM 属性（给 E2E 精确换算手柄位置用）。
  // 绘制循环本来每帧从 getState() 直读，这个订阅不参与绘制路径
  const viewport = useEditorStore((state) => state.viewport);
  const openObjectDialog = useEditorStore((state) => state.openObjectDialog);
  const fitToViewport = useEditorStore((state) => state.fitToViewport);

  /**
   * 场景切换器要的是**场景名**，不是整个场景列表。
   *
   * 拖手柄时文档每帧都在变（`scenes` 每帧都是新数组），而场景名一个都没换——
   * 用 `useShallow` 比这一层的字符串数组，这个面板就不会因为一次拖拽而重渲染。
   * 绘制循环读的是 `getState()`，一点不受影响。
   */
  const sceneNames = useEditorStore(
    useShallow((state) => state.scenes.map((scene) => scene.name)),
  );

  // 当前场景里所有要显示的图片（地图贴图 + 精灵图片），一张场景可以有任意多张。
  // 同样只比「需要哪些图」：位置 / 角度 / 缩放怎么变都不换这个数组
  const imageIds = useEditorStore(
    useShallow((state) => activeSceneImageIds(state.scenes, state.activeSceneName)),
  );

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

      // 布局变了：拖拽期间缓存的容器矩形作废（下一次换算重新量一次）
      if (dragRef.current !== null) {
        dragRef.current = { ...dragRef.current, rect: container.getBoundingClientRect() };
      }

      apply(entry.contentRect.width, entry.contentRect.height);
    });

    observer.observe(container);
    apply(container.clientWidth, container.clientHeight);
    return () => {
      observer.disconnect();
    };
  }, []);

  /* ------------------------------------------------------------------ 手柄拖拽 */

  /**
   * 屏幕坐标（clientX/Y）→ 画布内的 CSS 像素。
   *
   * 拖拽期间用**按下那一刻量好的**容器矩形：属性面板里的数字每帧都在变，DOM 一变
   * `getBoundingClientRect()` 就可能触发一次同步布局，而每帧都做这件事正是拖拽卡顿
   * 的来源之一。布局真的变了（窗口 / 分栏拖动）由 ResizeObserver 刷新。
   */
  const toLocal = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const rect = dragRef.current?.rect ?? containerRef.current?.getBoundingClientRect() ?? null;
    if (rect === null) {
      return { x: clientX, y: clientY };
    }

    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  /**
   * 把「最新一次指针」落进文档——**每个动画帧最多一次**。
   *
   * 由绘制循环在绘制之前调用，于是画面用的永远是这一帧最新的值（不慢一帧）；
   * 抬手时也会显式调一次（见 `endPointer`），拖得再快也不会丢掉终点。
   */
  const applyPendingTransform = useCallback((): void => {
    const pending = pendingDragRef.current;
    const drag = dragRef.current;
    if (pending === null || drag === null) {
      return;
    }

    pendingDragRef.current = null;
    const store = useEditorStore.getState();
    // 快照已经清了（Esc 取消 / 拖拽已结束）：残余的 pending 必须丢掉，
    // 否则下一帧会把「刚取消掉的那次变换」又写回去
    if (store.transformStart === null) {
      return;
    }

    const axis = moveAxisOf(drag.handle);
    const world = screenToWorld(store.viewport, toLocal(pending.clientX, pending.clientY));
    store.applyObjectTransform(world, {
      // 轴约束：X 箭头只改 x、Y 箭头只改 y（另一个轴保持按下时的值）
      ...(axis === undefined ? {} : { axis }),
      // Shift：旋转吸附 15°、缩放锁等比（与 Unity 一致的修饰键用法）
      snapAngle: pending.shiftKey,
      uniform: pending.shiftKey,
    });
  }, [toLocal]);

  /**
   * 光标下有没有手柄（有就画高亮、光标也变成手）。
   *
   * 拖拽进行中不参与：那时候高亮由「正在拖的那一个」负责，比悬停更重要。
   */
  const resolveHoveredHandle = useCallback(
    (local: { readonly x: number; readonly y: number }): GizmoHandle | null => {
      const store = useEditorStore.getState();
      if (
        dragRef.current !== null ||
        store.transformStart !== null ||
        store.selectedObjectIds.length !== 1
      ) {
        return null;
      }

      const scene = store.scenes.find((item) => item.name === store.activeSceneName);
      const object = scene?.objects.find((item) => item.id === store.selectedObjectIds[0]);
      // 锁定 / 未落位的对象没有可点的把手（手柄照画，只是点不到）——不给「能点」的假提示
      if (object === undefined || object.position === null || object.locked) {
        return null;
      }

      const geometry = gizmoGeometryOf(object, store.viewport);
      return geometry === undefined
        ? null
        : (hitTestGizmoHandles(local, store.ui.tool, geometry) ?? null);
    },
    [],
  );

  // 视口手势：拖拽平移、滚轮/双指缩放
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDistance = 0;
    let pinchMid: { x: number; y: number } | null = null;

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

    /** 当前**单选**的那个对象；多选 / 没选 / 没落位都返回 `undefined`（手柄只作用于单选）。 */
    const singleSelectedObject = (): SceneObjectDoc | undefined => {
      const store = useEditorStore.getState();
      if (store.selectedObjectIds.length !== 1) {
        return undefined;
      }

      const scene = currentScene();
      const id = store.selectedObjectIds[0];
      return scene?.objects.find((object) => object.id === id);
    };

    /**
     * 按下点是不是落在手柄上——是就进入变换拖拽并返回 `true`。
     *
     * 手柄几何与绘制**共用 `gizmoGeometryOf`**：两边各算一套就会变成
     * 「看得见的手柄点不中、点得中的地方没有手柄」——曾经真的发生过（绘制用旋转后的外框、
     * 命中用局部矩形，一转过角度就完全错位）。
     *
     * 锁定的对象**手柄画着但点不到**：它照样有手柄（画成灰的，说明「为什么拖不动」），
     * 但按下去等于按在对象上，走后面的老逻辑。
     */
    const tryBeginHandleDrag = (event: PointerEvent, local: { x: number; y: number }): boolean => {
      const object = singleSelectedObject();
      if (object === undefined || object.position === null || object.locked) {
        return false;
      }

      const store = useEditorStore.getState();
      const geometry = gizmoGeometryOf(object, store.viewport);
      if (geometry === undefined) {
        return false;
      }

      const handle = hitTestGizmoHandles(local, store.ui.tool, geometry);
      if (handle === undefined) {
        return false;
      }

      const half = localHalfSizeOf(object);
      // 快照记的是**按下那一刻指针的真实世界坐标**（不是手柄中心）：移动按指针位移算、
      // 旋转按指针方位角增量算、缩放按指针相对锚点的偏移比例算，三者都拿它当基准。
      // 若把起点吸到对象中心或手柄中心，第一次移动就会跳一下（实测：拖旋转环会直接跳到 90°）
      const start = store.beginObjectTransform(
        object.id,
        handle,
        toWorld(local),
        half.width,
        half.height,
      );
      if (start === undefined) {
        return false;
      }

      dragRef.current = {
        pointerId: event.pointerId,
        handle,
        // 画布框在按下这一刻量一次：拖拽期间不再每帧 `getBoundingClientRect()`
        // （那一刻之后属性面板里的数字每帧都在改，每量一次都可能触发一次同步布局）
        rect: container.getBoundingClientRect(),
      };
      pendingDragRef.current = null;
      // 抓住的那一个立刻高亮：这就是「按下去有反馈」里最要紧的那一下
      hoverRef.current = handle;
      container.setPointerCapture(event.pointerId);
      return true;
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (!hasScene()) {
        return;
      }

      // **画布上的浮层控件（左下角的工具开关）要能正常点**。
      // 这个监听挂在容器上，按钮按下时事件同样会冒泡到这里；若照常 `setPointerCapture`，
      // 指针就被容器抢走了——`pointerup` / `click` 都不会再发给按钮，表现是「按钮点了没反应」。
      // 所以只接管**落在画布本身**的按压：`<canvas>` 撑满容器、也是唯一的绘图面，
      // 其余 target（浮层控件）一律放行。
      if (!(event.target instanceof HTMLCanvasElement)) {
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
      lastPointerRef.current = { x: event.clientX, y: event.clientY };

      // 1) **手柄优先**：手柄压在对象上（甚至压到别的对象上），必须先判它。
      //    只在「单选 + 未锁 + 对象已落位」时才有手柄——多选不下发变换（见文件顶部说明）。
      if (tryBeginHandleDrag(event, local)) {
        return;
      }

      const hit = hitTestObject(local);
      if (hit !== undefined) {
        // 修饰键点选 = 多选（和列表里 Ctrl/⌘ 点行一个意思）；不加修饰就是单选
        const additive = event.ctrlKey || event.metaKey || event.shiftKey;
        useEditorStore
          .getState()
          .setSelection(additive ? toggleSelection(currentSelection(), hit) : [hit]);

        const target = currentScene()?.objects.find((item) => item.id === hit);

        // 1) **「移动」工具下拖对象本体 = 自由移动**（两个轴一起跟手走）。
        //    这是摆位置最顺手的一条路：不必先对准箭头，抓住对象就能挪。
        //    只有「真的拖了」才改文档——点一下仍然只是选中（`applyObjectTransform`
        //    只在指针动过之后才被调用，见 `applyPendingTransform`）。
        //    修饰键点选（多选）不进拖动：那一下的意图是「选中」，不是「挪走」。
        if (
          !additive &&
          useEditorStore.getState().ui.tool === "move" &&
          target !== undefined &&
          !target.locked &&
          target.position !== null
        ) {
          const half = localHalfSizeOf(target);
          // `handle = null`：没有手柄，于是没有轴约束（自由移动）、也没有缩放锚点
          const start = useEditorStore
            .getState()
            .beginObjectTransform(hit, null, toWorld(local), half.width, half.height);
          if (start !== undefined) {
            dragRef.current = {
              pointerId: event.pointerId,
              handle: null,
              rect: container.getBoundingClientRect(),
            };
            pendingDragRef.current = null;
            hoverRef.current = null;
            container.setPointerCapture(event.pointerId);
            return;
          }
        }

        // 2) 锁定的对象**点得到、选得中，就是拖不走**：不进拖动状态。
        //    按住它拖动 = 平移画布（和从空白处拖一样），于是手势仍然有用、
        //    也不会因为「点在对象上」而变成什么都不发生。
        if (target?.locked === true) {
          container.setPointerCapture(event.pointerId);
          pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
          return;
        }

        // 3) 其余情形（「拖动 / 旋转 / 缩放」三个工具，或多选）：对象本体**不跟手拖走**，
        //    点它只是选中它。旋转 / 缩放下手柄优先命中已经在上面判过了；按住对象拖动 = 平移画布。
        //    于是「在转角度的时候顺手把对象碰歪」这件事不会发生，手势也仍然有用。
        container.setPointerCapture(event.pointerId);
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
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
      // 悬停命中测试按帧做（绘制循环里），这里只记下最后一次位置
      lastPointerRef.current = { x: event.clientX, y: event.clientY };

      const drag = dragRef.current;
      if (drag !== null && drag.pointerId === event.pointerId) {
        // **只记下最新位置，不在这里写文档**：1000Hz 鼠标下每个事件写一次 = 每毫秒一次
        // 全应用重渲染。落盘交给绘制循环（每个动画帧一次，见 `applyPendingTransform`），
        // 于是画面用的永远是这一帧最新的指针位置
        pendingDragRef.current = {
          clientX: event.clientX,
          clientY: event.clientY,
          shiftKey: event.shiftKey,
        };
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
      const drag = dragRef.current;
      if (drag !== null && drag.pointerId === event.pointerId) {
        // **抬手前先把最后一帧落进去**：拖得快时最后几个 pointermove 可能还没等到 rAF，
        // 少了这一下对象的终点会比光标差一截。顺序必须是「落盘 → 清快照」，
        // 反过来的话 `applyPendingTransform` 会认为这次拖拽已经结束而把 pending 丢掉
        lastPointerRef.current = { x: event.clientX, y: event.clientY };
        applyPendingTransform();

        // 一次手柄拖拽结束：清掉快照（画布靠它画手柄、store 靠它算增量），
        // 并断开撤销合并——下一次拖拽因此成为独立记录
        useEditorStore.getState().endObjectTransform();
        dragRef.current = null;
        pendingDragRef.current = null;
        hoverRef.current = null;
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

    /** 指针离开画布：悬停高亮（以及「能点」的光标）必须跟着消失。 */
    const onPointerLeave = (): void => {
      lastPointerRef.current = null;
      hoverRef.current = null;
    };

    /**
     * **双击传送阵的徽标 = 传送**（鼠标上的快路径；平板没有可靠的双击，走属性面板的按钮）。
     *
     * 命中用的是同一个 `hitTestObject`（与单击选中同一条逻辑），所以「双击到的就是你看见的
     * 那一个」。只认传送阵：双击别的对象仍然什么都不做。
     *
     * 两个容易踩的点：
     * 1. **target 未必是 `<canvas>`**：`pointerdown` 里对容器调了 `setPointerCapture`，
     *    而捕获生效时 `click` / `dblclick` 会派发给**捕获元素（容器）**，不是指针底下的
     *    canvas。所以这里同时接受容器与 canvas——而「画布左上角浮着的工具开关」是别的元素，
     *    隔着它双击不会触发它下面那个对象（与 `pointerdown` 那条护栏同一个意思）。
     * 2. 命中用**指针坐标**（不是事件 target）：与单击、拖拽同一套换算。
     */
    const onDoubleClick = (event: MouseEvent): void => {
      const target = event.target;
      if (target !== container && !(target instanceof HTMLCanvasElement)) {
        return;
      }

      const id = hitTestObject(toLocal(event.clientX, event.clientY));
      if (id === undefined) {
        return;
      }

      const object = currentScene()?.objects.find((item) => item.id === id);
      if (object?.kind !== "Teleport") {
        return;
      }

      event.preventDefault();
      useEditorStore.getState().teleport(id);
    };

    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("pointercancel", onPointerCancel);
    container.addEventListener("pointerleave", onPointerLeave);
    container.addEventListener("dblclick", onDoubleClick);
    container.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerCancel);
      container.removeEventListener("pointerleave", onPointerLeave);
      container.removeEventListener("dblclick", onDoubleClick);
      container.removeEventListener("wheel", onWheel);
    };
  }, [applyPendingTransform, toLocal]);

  // 绘制循环
  useEffect(() => {
    let frame = 0;

    const loop = (): void => {
      frame = requestAnimationFrame(loop);

      // **先落最新一次的指针，再绘制**：顺序反过来的话，这一帧画出来的还是上一帧的位置，
      // 对象就会永远慢光标一帧（快速拖动时看得出来）。每帧最多一次文档写入也由这里保证
      applyPendingTransform();

      const renderer = rendererRef.current;
      if (renderer === null) {
        return;
      }

      const {
        viewport,
        viewportSize,
        scenes,
        activeSceneName,
        selectedObjectIds,
        gridPaint,
        soundPlayback,
        ui,
      } = useEditorStore.getState();

      // 光标：悬停手柄 = 手；拖拽中 = 抓住（拖本体也算，那一下同样是「抓住了东西」）。
      // 悬停命中按帧算一次（指针事件里不算），于是提示既不慢也不额外触发重渲染
      const container = containerRef.current;
      const dragging = dragRef.current !== null;
      const activeHandle = dragRef.current?.handle ?? null;
      if (!dragging) {
        const lastPointer = lastPointerRef.current;
        hoverRef.current =
          lastPointer === null ? null : resolveHoveredHandle(toLocal(lastPointer.x, lastPointer.y));
      }

      if (container !== null) {
        const hovered = activeHandle ?? hoverRef.current;
        const cursor =
          activeSceneName === null ? "default" : dragging ? "grabbing" : hovered !== null ? "pointer" : "grab";
        if (container.style.cursor !== cursor) {
          container.style.cursor = cursor;
        }
      }

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

      // 哪些声音对象**正在播**（记账里「本层该响的就是它」）：画布上的音频徽标要画成活的。
      // 记账是运行态，改它不会触发重渲染——好在这个循环本来就每帧重绘，所以下帧就变。
      const playingSounds = new Set(
        Object.values(soundPlayback.layers).map((entry) => entry.objectId),
      );

      // 每张图片各画各的：地图的贴图（带网格）与精灵的图片走同一条路。
      // **每个对象都要出一层**（哪怕没有图片）：没有图片的对象只画选中框 + 当碰撞体，
      // 否则「刚建出来的精灵」在画布上就既看不见也点不到。
      //
      // **画布上只有「区域」这一套格子着色**（`map.cells` 的 8 个区域位）：战争雾用的是
      // 同一份区域数据（`map.fog.regions` 只是「哪几个区域算雾」的绑定），所以这里**不再**
      // 追加什么雾罩图层——雾的呈现全在它自己的 Mask 窗口里（见 `app/FogMaskDialog.tsx`）。
      const layers = drawOrder.flatMap<SceneLayer>((object) => {
        const rect = displayRectOf(object);
        if (rect === undefined) {
          return [];
        }

        // 声音对象不认贴图（图标是内置的），所以它既不加载图片、也不走下面那条尺寸核对
        const ref = displayImageOf(object);
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

        const map = mapDataOf(object);
        const grid = map?.grid;
        // 「网格标注」总开关：关掉就整层不着色（只是不画，格子数据不动）
        const colored = map !== undefined && gridPaint.showAnnotations;
        return [
          {
            image,
            rect,
            // 角度（弧度）：绘制绕矩形中心旋转，与拾取（`hitTestRect(point, rect, rotation)`）
            // 用同一个值，所以「看到的」与「点得到的」始终是同一块
            rotation: object.rotation,
            grid,
            // 动作对象画**内置徽标**（固定图形，不能换）：有它在，场景里才看得见、
            // 点得到、拖得动；播放声音正在播时徽标会动（一圈圈声波 + 喇叭呼吸）
            icon: badgeIconOf(object.kind),
            playing: playingSounds.has(object.id),
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

      // 变换手柄：只在**单选**时出现（多选不下发变换，见文件顶部说明）。
      //
      // **拖拽途中照样画**：手柄就是用户手指底下的那个东西，抓住它之后它消失 / 停在原地
      // 都会让人以为「没抓上」。这里读的是本帧**已经落盘**的值（`applyPendingTransform`
      // 在这一帧开头跑过了），所以手柄与对象、与光标三者同帧，不存在「慢一帧地追」。
      const gizmoObject =
        selectedObjectIds.length === 1
          ? drawOrder.find((object) => object.id === selectedObjectIds[0])
          : undefined;

      const handles =
        gizmoObject === undefined ? undefined : buildToolHandles(gizmoObject, ui.tool, viewport);
      // 「按下去 / 悬停」的那个手柄单独高亮：拖拽中读的是正在拖的那一个（比悬停更重要）
      const gizmo =
        handles === undefined
          ? undefined
          : {
              ...handles,
              activeHandle,
              hoveredHandle: activeHandle === null ? hoverRef.current : null,
            };

      renderer.draw({
        viewport,
        cssWidth: viewportSize.width,
        cssHeight: viewportSize.height,
        layers,
        showOrigin: true,
        // 正在播的声音徽标按这个时刻出动画：循环本来就每帧跑，把时刻传进去就够了
        animationTimeMs: performance.now(),
        // 棋盘底纹与**第一张地图**的左下角对齐：格子与地图的网格分成同一套，
        // 拖动地图时底纹跟着走。没有地图（纯精灵场景）就退回世界原点
        checkerOrigin: checkerOriginOf(drawOrder),
        ...(gizmo === undefined ? {} : { tools: gizmo }),
      });
    };

    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
    };
    // imageReady：贴图是异步加载的，加载完成要重跑循环把贴图画上。
    // 其余三个是稳定的 useCallback（只读 ref 与 getState），列出来是为了满足依赖检查
  }, [imageReady, applyPendingTransform, resolveHoveredHandle, toLocal]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="panel-header">
        {/*
          顶栏只写**场景名**（不写「场景」标签）：这一栏下面就是画布，除了当前这张图叫什么，
          没有别的需要说明的东西；多一个标签只会挤掉长场景名的显示宽度。
          没有场景时用一个占位（免得整条标题栏只剩右侧按钮，看着像坏了）。
        */}
        <span
          data-testid="scene-current"
          className="min-w-0 truncate text-[11px] text-[var(--color-editor-text)]"
        >
          {activeSceneName ?? "（没有场景）"}
        </span>
        {activeSceneName === null ? null : (
          // 放最右：平板竖屏下左边 340px 可能被抽屉盖住，靠右才一定点得到
          <div className="ml-auto flex flex-none items-center gap-1">
            <button
              type="button"
              data-testid="reset-viewport"
              title="视图复位：把当前场景里的对象全部装进画布（与「视图 → 适配视口」同一件事）"
              className="toolbar-button hover:toolbar-button-hover"
              onClick={() => fitToViewport()}
            >
              复位
            </button>
            <button
              type="button"
              data-testid="new-object"
              // 按钮上只写「对象」：它旁边就是场景名，这一栏讲的就是「当前场景」，
              // 「新建」由弹框自己说（打开的窗口标题也是「新建对象」）
              title="新建对象（Ctrl/⌘+Shift+N）"
              className="toolbar-button hover:toolbar-button-hover"
              onClick={() => openObjectDialog(true)}
            >
              对象
            </button>
          </div>
        )}
      </div>

      {/* 场景切换条：一格一张图，**点一下即切**。只有一个场景时不占地方 */}
      {sceneNames.length < 2 ? null : (
        <SceneBar names={sceneNames} active={activeSceneName} />
      )}

      <div
        ref={containerRef}
        data-testid="scene-viewport"
        // 当前视口变换（scale / tx / ty）暴露成 DOM 属性，**只给 E2E 用**：
        // 手柄的位置由视口算出来，用例要精确点到 X 箭头或某个角，就必须知道真实的
        // 「世界原点落在屏幕哪儿」。靠「画布中心 = 世界原点」去猜是错的——画布会被
        // 左右面板挤窄，而属性面板宽度随断点与内容变
        data-viewport-scale={viewport.scale}
        data-viewport-tx={viewport.tx}
        data-viewport-ty={viewport.ty}
        className="relative min-h-0 flex-1 overflow-hidden"
        // `cursor` 不写在这里：它按「悬停 / 拖拽手柄」每帧变（绘制循环里 imperative 地写），
        // 走 React 的话每次重渲染都会把它盖回 grab
        style={{ touchAction: "none" }}
      >
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: 画布需要接受指针与触摸手势 */}
        <canvas ref={canvasRef} className="block h-full w-full" />

        {/* 变换工具开关放在**画布左上角**：它改的是「在画布上拖动会发生什么」，
            贴在画布上比塞进标题栏更容易理解 */}
        {activeSceneName === null ? null : (
          <div className="pointer-events-none absolute left-2 top-2 z-10">
            <div className="pointer-events-auto">
              <ToolSwitch />
            </div>
          </div>
        )}

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

/**
 * 变换工具开关（画布左上角）：拖动 / 移动 / 旋转 / 缩放。
 *
 * **「拖动」是默认，它只动摄像机**：拖对象只是选中它、拖哪儿都是平移画布。
 * **「移动」既动对象本体**（拖对象 = 自由移动，最顺手）**也动轴线**（拖 X / Y 箭头沿单轴挪）；
 * 旋转与缩放只认手柄，拖本体仍然是平移画布——**在转角度的时候顺手把地图碰歪**是最烦人的
 * 一种意外，这两个工具下宁可让那一下什么都不改。
 *
 * 四个是**互斥的当前工具**，不是四个独立开关——所以用分段按钮而不是复选框，
 * 与菜单栏那个「编辑 / 运行」开关同一套画法。
 *
 * 平板没有键盘快捷键，所以这里必须是看得见、点得到的按钮（菜单里也各有一份）。
 */
function ToolSwitch(): React.JSX.Element {
  const tool = useEditorStore((state) => state.ui.tool);
  const setTool = useEditorStore((state) => state.setTool);

  return (
    // **不透明底 + 描边 + 投影**：这一条浮在画布上，底下可能是任何颜色的贴图。
    // 曾经它是透明底 + 暗字（`text-dim`），压在一张亮地图上就直接看不见了——
    // 所以底色用**面板色**（不跟着画面走），字用正常亮度的正文色，选中态才是强调色。
    <div
      data-testid="tool-switch"
      className="flex flex-none items-center divide-x divide-[var(--color-editor-border)] overflow-hidden rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] shadow-lg"
    >
      {TOOL_OPTIONS.map((option) => (
        <button
          key={option.tool}
          type="button"
          data-testid={`tool-${option.tool}`}
          data-active={tool === option.tool}
          title={option.title}
          onClick={() => setTool(option.tool)}
          className={`px-2 py-1 text-[12px] transition-colors active:bg-[var(--color-editor-warn)] active:text-black ${
            tool === option.tool
              ? "bg-[var(--color-editor-accent)] font-semibold text-black"
              : "text-[var(--color-editor-text)] hover:bg-[var(--color-editor-panel-alt)]"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 场景切换条（画布标题栏下面那条）：一格一个场景，**点一下即切**。
 *
 * 为什么不是下拉框：跑团现场 DM 是**边讲边切**的，一次点击和两次点击的差别很大，而且
 * 「这一局有哪几张图」本身就该一直看得见。场景多到放不下时横向滚动，并把**当前那一格
 * 自动滚进可视区**；再多的场景靠 `1`-`9` 直选（序号画在前九格上）与 `[` / `]` 前后翻。
 *
 * 顺序只有一个来源（`scenes` 数组，装载时按 `compareSceneNames` 排好），所以这里画出来的
 * 第 N 格与 `openSceneByIndex(N-1)` 必然对得上——序号不是装饰，是**快捷键的说明书**。
 */
function SceneBar({
  names,
  active,
}: {
  readonly names: readonly string[];
  readonly active: string | null;
}): React.JSX.Element {
  const openScene = useEditorStore((state) => state.openScene);
  const openAdjacentScene = useEditorStore((state) => state.openAdjacentScene);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());

  const index = active === null ? -1 : names.indexOf(active);

  // 切场景后把当前格滚进可视区：场景多时横向滚动条停在别处，当前格看不见就失去意义了
  useEffect(() => {
    if (active === null) {
      return;
    }

    chipRefs.current.get(active)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, names]);

  return (
    <div
      data-testid="scene-bar"
      data-scene={active ?? ""}
      className="flex flex-none items-stretch gap-1 border-b border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] px-1 py-1"
    >
      <StepButton
        testId="scene-prev"
        label="上一场"
        title="上一场（[）"
        disabled={index <= 0}
        onClick={() => openAdjacentScene(-1)}
      >
        ‹
      </StepButton>

      <div className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto">
        {names.map((name, order) => (
          <button
            key={name}
            type="button"
            ref={(node) => {
              if (node === null) {
                chipRefs.current.delete(name);
                return;
              }

              chipRefs.current.set(name, node);
            }}
            data-testid="scene-chip"
            data-scene={name}
            data-active={name === active}
            data-index={order + 1}
            title={
              order < 9
                ? `第 ${order + 1} 场：${name}（按 ${order + 1} 直选）`
                : `第 ${order + 1} 场：${name}`
            }
            onClick={() => openScene(name)}
            className={`flex flex-none items-center gap-1 rounded border px-2 py-0.5 text-[12px] transition-colors ${
              name === active
                ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent)] font-semibold text-black"
                : "border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] text-[var(--color-editor-text)] hover:border-[var(--color-editor-accent-dim)]"
            }`}
          >
            {/* 序号只画前九个：有对应快捷键的才编号，免得第 10 格上写个「10」引人去按 */}
            {order < 9 ? (
              <span
                className={`font-mono text-[10px] ${
                  name === active ? "text-black/60" : "text-[var(--color-editor-text-dim)]"
                }`}
              >
                {order + 1}
              </span>
            ) : null}
            <span className="max-w-40 truncate">{name}</span>
          </button>
        ))}
      </div>

      <StepButton
        testId="scene-next"
        label="下一场"
        title="下一场（]）"
        disabled={index < 0 || index >= names.length - 1}
        onClick={() => openAdjacentScene(1)}
      >
        ›
      </StepButton>
    </div>
  );
}

/** 切换条两端的前后按钮（平板上「下一场」就靠它，所以要有文字无障碍名）。 */
function StepButton({
  testId,
  label,
  title,
  disabled,
  onClick,
  children,
}: {
  readonly testId: string;
  readonly label: string;
  readonly title: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex w-6 flex-none items-center justify-center rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] leading-none text-[var(--color-editor-text)] hover:bg-[var(--color-editor-panel-alt)] disabled:opacity-30 disabled:hover:bg-[var(--color-editor-panel)]"
    >
      {children}
    </button>
  );
}

/** 三个工具的名字、提示与快捷键（菜单、状态栏、快捷键都从这里取，免得各写一份）。 */
export const TOOL_OPTIONS: readonly {
  readonly tool: TransformTool;
  readonly label: string;
  readonly title: string;
}[] = [
  {
    tool: "none",
    label: "拖动",
    title: "拖动场景（Q）：只平移画布——拖对象只是选中它，不会把它碰歪",
  },
  {
    tool: "move",
    label: "移动",
    title: "移动（W）：拖对象本体自由移动；拖 X / Y 箭头只沿单轴移动",
  },
  { tool: "rotate", label: "旋转", title: "旋转（E）：沿圆环拖动，Shift 吸附 15°" },
  {
    tool: "scale",
    label: "缩放",
    title: "缩放（R）：拖角等比、拖边单轴，Shift 锁等比",
  },
];
