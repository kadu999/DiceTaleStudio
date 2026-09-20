import { MAX_OBJECT_SCALE, MIN_OBJECT_SCALE } from "@dts/document";
import { angleAround } from "@dts/renderer";
import type { TransformTool } from "@dts/renderer";
import type { WorldPosition } from "@dts/document";

/**
 * 指针相对某个枢轴的方位角（弧度）。
 *
 * 直接再导出渲染器那一份：编辑器的旋转拖拽与画旋转环用的是**同一个角度函数**，
 * 两处各写一遍 `atan2` 迟早会因为参数顺序不同而反号。
 */
export { angleAround };

/**
 * 一次变换拖拽的**纯计算**：把「指针现在在哪」和「按下时的快照」换算成
 * 新的坐标 / 角度 / 缩放。
 *
 * 为什么不写在 store 或组件里：这三件事都是纯数学，能直接单测；埋在 JSX 或
 * 带副作用的状态里就只能靠 e2e 碰运气了。store 负责把结果写进文档（进撤销栈），
 * 组件负责采集指针事件，这里只算数。
 *
 * **一切以「按下时的快照」为基准**，不做逐帧累加。原因是拖拽途中每写一次文档都会
 * 重建对象，逐帧读「当前值」会把每一步的浮点误差累积起来，而且撤销栈里会留下一串
 * 互相依赖的记录。相对快照算，拖多久都不会漂。
 */

/** 按下时的快照：这一次拖拽全部计算的基准。 */
export interface TransformStart {
  readonly id: string;
  readonly mode: TransformTool;
  /** 对象中心（世界坐标）。 */
  readonly base: WorldPosition;
  /** 起始角度（弧度）。 */
  readonly rotation: number;
  /** 起始**有效**缩放（已经算过「单轴字段缺省 = 用等比 `scale`」）。 */
  readonly scaleX: number;
  readonly scaleY: number;
  /** 起始显示矩形的半宽 / 半高（世界单位）。 */
  readonly halfWidth: number;
  readonly halfHeight: number;
  /** 按下时指针相对中心的方位角（旋转用；在世界坐标里算，屏幕怎么翻都不影响）。 */
  readonly pointerAngle: number;
  /** 起始显示矩形中心（世界坐标）——手柄与缩放锚点都由它派生。 */
  readonly center: WorldPosition;
  /** 缩放拖拽的**固定点**（对角 / 对边中点，世界坐标）；移动与旋转不用。 */
  readonly anchor: WorldPosition;
  /** 拖的是不是角手柄（角 = 等比，边 = 单轴）。 */
  readonly corner: boolean;
  /** 边手柄管的是哪一轴（`x` = 左右、`y` = 上下）；角手柄为 `undefined`。 */
  readonly axis?: "x" | "y";
}

/** 旋转吸附的步长（度）：按住 Shift 时对齐到它的整数倍，与 Unity 的 15° 一致。 */
export const ROTATION_SNAP_DEGREES = 15;

/** 角度归一化区间：`(-180°, 180°]`，与文档命令同一区间。 */
function normalizeRadians(radians: number): number {
  const degrees = (radians * 180) / Math.PI;
  const wrapped = ((((degrees + 180) % 360) + 360) % 360) - 180;
  return (wrapped * Math.PI) / 180;
}

function clampScaleValue(value: number): number {
  return Math.min(MAX_OBJECT_SCALE, Math.max(MIN_OBJECT_SCALE, value));
}

/**
 * 把一次拖拽的结果算出来。
 *
 * - **移动（轴约束）**：只动一个轴——`start.mode` 为 `move` 时调用方会告诉我们是哪根轴
 *   （`axis`），另一个轴保持起始值。这正是「拖 X 箭头只沿 X 走」的实现。
 * - **旋转**：`起始角度 + (当前指针方位角 − 起始方位角)`。方位角在世界坐标里算，
 *   所以屏幕 y 向下不影响符号；结果与文档/Unity 的「正角 = 逆时针（Y 轴正向）」一致。
 * - **缩放**：以 `start.anchor` 为固定点，按指针到锚点的距离比例伸缩；角手柄等比、
 *   边手柄只改一个轴。锚点固定在缩放时会移动对象中心，所以**位置与缩放一起还回去**。
 */
export interface TransformResult {
  readonly position: WorldPosition;
  readonly rotation: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

export function resolveTransform(input: {
  readonly start: TransformStart;
  readonly pointer: WorldPosition;
  readonly axis?: "x" | "y";
  readonly snapAngle?: boolean;
  readonly uniform?: boolean;
}): TransformResult {
  const { start, pointer } = input;

  if (start.mode === "move") {
    const axis = input.axis ?? "x";
    return {
      position: {
        x: axis === "x" ? pointer.x : start.base.x,
        y: axis === "y" ? pointer.y : start.base.y,
      },
      rotation: start.rotation,
      scaleX: start.scaleX,
      scaleY: start.scaleY,
    };
  }

  if (start.mode === "rotate") {
    const delta = Math.atan2(pointer.y - start.center.y, pointer.x - start.center.x) - start.pointerAngle;
    return {
      position: start.base,
      rotation: normalizeRadians(
        start.rotation + snapAngleDelta(delta, input.snapAngle === true),
      ),
      scaleX: start.scaleX,
      scaleY: start.scaleY,
    };
  }

  // 缩放：从锚点到指针，在**局部轴**上算（对象转过角度时，边手柄改的仍是它自己的轴）
  const localPointer = rotateIntoLocal(pointer, start.anchor, start.rotation);
  const offsetX = localPointer.x - start.anchor.x;
  const offsetY = localPointer.y - start.anchor.y;

  // 角手柄（或按住 Shift）= 等比：两轴取同一个倍率，否则「角」拖出来会变成非等比，
  // 而用户抓的是角，期待的就是整体放大缩小。倍率取两轴里大的那个——往内拖时缩得更保守，
  // 不会出现「手指还在对象上、它已经缩没了」。
  const uniform = start.corner || input.uniform === true;
  const uniformRatio = Math.max(
    start.halfWidth > 0 ? Math.abs(offsetX) / start.halfWidth : 1,
    start.halfHeight > 0 ? Math.abs(offsetY) / start.halfHeight : 1,
  );

  // **边手柄只动它自己那一轴**：另一轴的倍率固定为 1。
  // 少了这一步，指针在另一轴上的偏移（比如沿 X 拖边手柄时 y 偏了几十像素）会顺手把
  // 高度也改掉——用户抓的是「右边中点」，却看到对象变高了。
  // 移动与旋转没有这个字段（`axis` 缺省），两轴都照常参与，所以只对缩放生效。
  const alongX = start.mode !== "scale" || start.axis !== "y";
  const alongY = start.mode !== "scale" || start.axis !== "x";
  const ratioX = alongX && start.halfWidth > 0 ? Math.abs(offsetX) / start.halfWidth : 1;
  const ratioY = alongY && start.halfHeight > 0 ? Math.abs(offsetY) / start.halfHeight : 1;

  const scaleX = clampScaleValue(start.scaleX * (uniform ? uniformRatio : ratioX));
  const scaleY = clampScaleValue(start.scaleY * (uniform ? uniformRatio : ratioY));

  // 锚点固定在世界上不动：中心与锚点的相对位置（**局部坐标**里的向量）按两轴倍率各自伸缩。
  //
  // 这条式子必须用**实际的起始中心**去推，不能写成「锚点 ± 半宽/2」——
  // 后者只在「锚点是对角 / 对边中点、且起始中心正好在矩形中心」时才碰巧成立
  // （试算一下：正方形、锚点取一个角时它会多算半个半宽，对象一边放大一边整体平移）。
  // 转过角度时也要先在局部坐标里算完再转回世界，否则位移方向会跟着错。
  const localBase = rotateIntoLocal(start.center, start.anchor, start.rotation);
  const localCenter = {
    x: start.anchor.x + (localBase.x - start.anchor.x) * (scaleX / start.scaleX),
    y: start.anchor.y + (localBase.y - start.anchor.y) * (scaleY / start.scaleY),
  };
  const center = rotateOutOfLocal(localCenter, start.anchor, start.rotation);

  return { position: center, rotation: start.rotation, scaleX, scaleY };
}

/** 把角度增量按 Shift 吸附到 15° 的整数倍。 */
function snapAngleDelta(delta: number, snap: boolean): number {
  if (!snap) {
    return delta;
  }

  const step = (ROTATION_SNAP_DEGREES * Math.PI) / 180;
  return Math.round(delta / step) * step;
}

/** 世界点 → 以 `pivot` 为原点、旋转 `radians` 的局部坐标（缩放手柄判轴用）。 */
export function rotateIntoLocal(point: WorldPosition, pivot: WorldPosition, radians: number): WorldPosition {
  const cos = Math.cos(-radians);
  const sin = Math.sin(-radians);
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

/** 局部坐标 → 世界坐标（与 `rotateIntoLocal` 互逆）。 */
export function rotateOutOfLocal(point: WorldPosition, pivot: WorldPosition, radians: number): WorldPosition {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}
