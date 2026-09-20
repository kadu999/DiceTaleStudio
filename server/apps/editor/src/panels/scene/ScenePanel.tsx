import { useEffect, useRef, useState } from "react";
import {
  effectiveScaleX,
  effectiveScaleY,
  objectImage,
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
  isDrawableFrame,
  screenToWorld,
  type GizmoHandle,
  type SceneLayer,
  type SceneRenderer,
  type SceneToolHandles,
  type TransformTool,
  type Viewport,
} from "@dts/renderer";
import {
  worldRectBottom,
  worldRectLeft,
  worldRectOf,
  type ImageSize,
  type WorldRect,
} from "@dts/grid";
import { sceneImage, sceneImageError, subscribeSceneImage } from "../../services/scene-image";
import { useEditorStore } from "../../state/editor-store";
import { EmptyState } from "../EmptyState";
import { cellColorsOf, decodeCellsCached } from "./grid-paint";

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
 * 尺寸 = 「贴图里声明的尺寸（没有图片就用 `COLLIDER_SIZE`）× **该轴的有效缩放**」。
 * 有效缩放走 `effectiveScaleX` / `effectiveScaleY`：文档里等比只写 `scale`，
 * 单轴（v11 起的 `scaleX` / `scaleY`）才写两个轴——直接读字段会漏掉「缺省 = 用等比值」。
 *
 * **返回的是「旋转之后」的外框**（轴对齐包围盒），不是原始矩形：
 *
 * - 拾取走 `hitTestRect(point, rect, rotation)`（反向旋转后比半宽半高），而「把原始矩形转一下」
 *   与「把外框转一下」覆盖的是同一块区域（`|cos|²+|sin|²=1`），所以拾取与旋转前完全一致；
 * - 选中框与缩放手柄画在这个外框上并同样转 `rotation`，于是「看到的框」与「点得到的范围」
 *   依旧是同一块——这正是这条注释开头那句约定要的东西。
 *
 * 等比 + 不旋转时结果与以前**逐值相同**（外框就是矩形本身），所以老场景的样子一点不变。
 *
 * 缩放值坏掉时（0 / 负数 / NaN，只可能来自手写文件）按 `1` 画：渲染不能因为一个坏数字
 * 就把整块对象画没，那种数据由 `validateScene` 报错（`effectiveScale*` 已经兜过底）。
 */
export function displayRectOf(object: SceneObjectDoc): WorldRect | undefined {
  if (object.position === null) {
    return undefined;
  }

  return worldRectOf(object.position, displaySizeOf(object));
}

/** 显示矩形（**旋转后的外框**）的尺寸；`displayRectOf` 与手柄几何共用它。 */
function displaySizeOf(object: SceneObjectDoc): ImageSize {
  // 声音对象画的是**固定的内置图标**（不允许改贴图），所以它那块矩形就是图标的大小：
  // 手写文件里万一挂了 `image` 也不认（`validateScene` 会警告），
  // 免得出现「选中框按贴图算、画出来的却是徽标」这种对不上的情况
  const base = object.kind === "PlaySound" ? COLLIDER_SIZE : objectImage(object) ?? COLLIDER_SIZE;
  const width = base.width * effectiveScaleX(object);
  const height = base.height * effectiveScaleY(object);

  const rotation = Number.isFinite(object.rotation) ? object.rotation : 0;
  return rotatedBoundsOf(width, height, rotation);
}

/**
 * 画布上给某个对象算出一份**屏幕手柄几何**（移动轴 / 旋转环 / 缩放块）。
 *
 * 与命中测试用的是同一个 `gizmoScreenGeometry`，所以「画出来的」与「点得到的」
 * 必然是同一份坐标——这也是把它抽成函数而不是各写一遍的理由。
 *
 * 缩放柄的位置取自 `displayRectOf`（旋转后的外框）：它与选中框、与拾取范围同一块矩形。
 */
function buildToolHandles(
  object: SceneObjectDoc,
  tool: TransformTool,
  viewport: Viewport,
): SceneToolHandles | undefined {
  const position = object.position;
  if (position === null) {
    return undefined;
  }

  const local = localHalfSizeOf(object);
  const bounds = rotatedBoundsOf(local.width * 2, local.height * 2, object.rotation);
  const frame: WorldRect = worldRectOf(position, bounds);
  const geometry = gizmoScreenGeometry(frame, object.rotation, viewport);

  return {
    tool,
    center: geometry.center,
    corners: geometry.corners,
    axes: geometry.axes,
    scale: geometry.scale,
    ringRadius: geometry.ringRadius,
    locked: object.locked,
    drawable: isDrawableFrame(frame, viewport),
  };
}

/**
 * 一个「宽 × 高」的矩形绕中心转 `rotation` 之后的**轴对齐外框**尺寸。
 *
 * 拾取与选中框都按它来（见 `displayRectOf` 的说明），旋转中的手柄也要用它——
 * 否则拖旋转环时手柄会立刻跳一下（外框还没跟上新的角度）。
 */
function rotatedBoundsOf(
  width: number,
  height: number,
  rotation: number,
): { width: number; height: number } {
  if (rotation === 0) {
    return { width, height };
  }

  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  return { width: width * cos + height * sin, height: width * sin + height * cos };
}

/**
 * 对象的**局部**半宽 / 半高（世界单位，未旋转）。
 *
 * 手柄几何与缩放锚点都要用它：外框（`displayRectOf`）是旋转后的包围盒，
 * 而手柄、四角、对侧锚点都定义在对象自己的轴上，拿外框去算会算到别处去。
 */
function localHalfSizeOf(object: SceneObjectDoc): { readonly width: number; readonly height: number } {
  const base = object.kind === "PlaySound" ? COLLIDER_SIZE : objectImage(object) ?? COLLIDER_SIZE;
  return {
    width: (base.width * effectiveScaleX(object)) / 2,
    height: (base.height * effectiveScaleY(object)) / 2,
  };
}

/**
 * 这个对象要画的贴图：**声音对象的图标是内置的**，所以它不看 `image`（那个字段对它没有意义）。
 *
 * 只在场景面板里用（加载图片与出图层各一次）：要把「不认贴图」这条规矩收在一处。
 */
function displayImageOf(object: SceneObjectDoc) {
  return object.kind === "PlaySound" ? undefined : objectImage(object);
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
  // 订阅视口：只用来把当前变换写进 DOM 属性（给 E2E 精确换算手柄位置用）。
  // 绘制循环本来每帧从 getState() 直读，这个订阅不参与绘制路径
  const viewport = useEditorStore((state) => state.viewport);
  const setActiveScene = useEditorStore((state) => state.setActiveScene);
  const openObjectDialog = useEditorStore((state) => state.openObjectDialog);
  const resetViewport = useEditorStore((state) => state.resetViewport);

  // 当前场景里所有要显示的图片（地图贴图 + 精灵图片），一张场景可以有任意多张
  const imageIds =
    scenes
      .find((scene) => scene.name === activeSceneName)
      ?.objects.filter((object) => object.active) // 没激活的对象不画，也不用去加载它的图
      .flatMap((object) => {
        const ref = displayImageOf(object);
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
    /**
     * 正在拖的手柄（一次只有一个）。移动轴 / 旋转环 / 缩放块都归它，
     * 一切都相对按下那一刻的快照算（快照在 store 里，见 `beginObjectTransform`）。
     *
     * **对象本体不进这里**：对象不跟手拖走，点它只是选中它。
     *
     * 手柄拖拽期间也**不再平移画布**：这一下已经被手柄接管了。
     */
    let drag: { readonly pointerId: number; readonly handle: GizmoHandle } | null = null;

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

    /** 这一根移动柄约束的是哪个轴；旋转 / 缩放柄返回 `undefined`（它们不受轴约束）。 */
    const moveAxisOf = (handle: GizmoHandle): "x" | "y" | undefined => {
      if (handle === "move-x") {
        return "x";
      }

      return handle === "move-y" ? "y" : undefined;
    };

    /**
     * 按下点是不是落在手柄上——是就进入变换拖拽并返回 `true`。
     *
     * 手柄几何与绘制**共用 `gizmoScreenGeometry`**：两边各算一套迟早会变成
     * 「看得见的手柄点不中、点得中的地方没有手柄」。
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
      const half = localHalfSizeOf(object);
      // **尺寸要用整宽整除**：`localHalfSizeOf` 给的是半宽半高，而矩形收的是整尺寸。
      // 少了这个 ×2，命中区会缩成视觉手柄的一半——画在 ±60 的手柄只在 ±30 内可点，
      // 于是「明明点在手柄上却没反应」。这正是绘制（`buildToolHandles`）与命中必须
      // 共用同一份几何的原因，也是这条注释留在这里的原因
      const geometry = gizmoScreenGeometry(
        worldRectOf(object.position, { width: half.width * 2, height: half.height * 2 }),
        object.rotation,
        store.viewport,
      );
      const handle = hitTestGizmoHandles(local, store.ui.tool, geometry);
      if (handle === undefined) {
        return false;
      }

      // 快照记的是**按下那一刻指针的真实世界坐标**（不是手柄中心）：
      // - 旋转按「指针方位角的变化量」算，基准必须是按下时的真实方位角；
      //   若把起点吸到对象中心，`pointerAngle` 恒为 0，第一次移动就会把对象
      //   猛地拽到「指针绝对角度」上（实测：从环上按下再拖会直接跳到 90°）；
      // - 缩放也按「指针相对锚点的距离比例」算，起点同样必须是真实指针位置。
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

      drag = { pointerId: event.pointerId, handle };
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

        // 锁定的对象**点得到、选得中，就是拖不走**：不进拖动状态。
        // 按住它拖动 = 平移画布（和从空白处拖一样），于是手势仍然有用、
        // 也不会因为「点在对象上」而变成什么都不发生。
        const target = currentScene()?.objects.find((item) => item.id === hit);
        if (target?.locked === true) {
          container.setPointerCapture(event.pointerId);
          pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
          return;
        }

        // **对象一律不跟手拖走**：点它就只是选中它。
        // 想摆位置用「移动」工具的 X / Y 箭头——于是「拖一下把对象碰歪」这件事
        // 在任何工具下都不会发生（手柄模式下这一条同样成立，手柄优先命中已经在上面判过了）。
        // 按住对象拖动 = 平移画布（与锁定对象同一套待遇），手势仍然有用。
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

      if (drag !== null && drag.pointerId === event.pointerId) {
        const world = toWorld(toLocal(event.clientX, event.clientY));
        const axis = moveAxisOf(drag.handle);
        store.applyObjectTransform(world, {
          // 轴约束：X 箭头只改 x、Y 箭头只改 y（另一个轴保持按下时的值）
          ...(axis === undefined ? {} : { axis }),
          // Shift：旋转吸附 15°、缩放锁等比（与 Unity 一致的修饰键用法）
          snapAngle: event.shiftKey,
          uniform: event.shiftKey,
        });
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
      if (drag !== null && drag.pointerId === event.pointerId) {
        // 一次手柄拖拽结束：清掉快照（画布靠它画手柄、store 靠它算增量），
        // 并断开撤销合并——下一次拖拽因此成为独立记录
        useEditorStore.getState().endObjectTransform();
        drag = null;
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

      const {
        viewport,
        viewportSize,
        scenes,
        activeSceneName,
        selectedObjectIds,
        gridPaint,
        soundPlayback,
        ui,
        transformStart,
      } = useEditorStore.getState();
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

        const map = object.map;
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
            // 声音对象画**内置的音频徽标**（固定图标，不能换）：有它在，场景里才看得见、
            // 点得到、拖得动；正在播时徽标会动（一圈圈声波 + 喇叭呼吸）
            icon: object.kind === "PlaySound" ? "audio" : undefined,
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
      // 拖拽途中改用快照里的角度与缩放——对象正在被改，文档里那一份是「上一步」的值，
      // 拿它算手柄会让手柄慢一帧（旋转时尤其明显：手柄会一跳一跳地追）。
      const gizmoObject =
        selectedObjectIds.length === 1 && transformStart === null
          ? drawOrder.find((object) => object.id === selectedObjectIds[0])
          : undefined;

      const gizmo =
        gizmoObject === undefined
          ? undefined
          : buildToolHandles(gizmoObject, ui.tool, viewport);

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
        // 当前视口变换（scale / tx / ty）暴露成 DOM 属性，**只给 E2E 用**：
        // 手柄的位置由视口算出来，用例要精确点到 X 箭头或某个角，就必须知道真实的
        // 「世界原点落在屏幕哪儿」。靠「画布中心 = 世界原点」去猜是错的——画布会被
        // 左右面板挤窄，而属性面板宽度随断点与内容变
        data-viewport-scale={viewport.scale}
        data-viewport-tx={viewport.tx}
        data-viewport-ty={viewport.ty}
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{
          touchAction: "none",
          cursor: activeSceneName === null ? "default" : "grab",
        }}
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
 * **「移动」才动对象**（X / Y 轴箭头）；旋转与缩放同理。
 *
 * 这也是为什么**对象一律不跟手拖走**：想摆位置就用「移动」工具，
 * 于是「顺手把对象碰歪」在任何工具下都不会发生。
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
    <div className="flex flex-none items-center overflow-hidden rounded border border-[var(--color-editor-border)]">
      {TOOL_OPTIONS.map((option) => (
        <button
          key={option.tool}
          type="button"
          data-testid={`tool-${option.tool}`}
          data-active={tool === option.tool}
          title={option.title}
          onClick={() => setTool(option.tool)}
          className={`px-1.5 py-0.5 text-[11px] ${
            tool === option.tool
              ? "bg-[var(--color-editor-accent)] text-black"
              : "text-[var(--color-editor-text-dim)] hover:bg-[var(--color-editor-accent-dim)]"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
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
  { tool: "move", label: "移动", title: "移动（W）：拖 X / Y 箭头沿单轴移动对象" },
  { tool: "rotate", label: "旋转", title: "旋转（E）：沿圆环拖动，Shift 吸附 15°" },
  { tool: "scale", label: "缩放", title: "缩放（R）：拖角等比、拖边单轴，Shift 锁等比" },
];
