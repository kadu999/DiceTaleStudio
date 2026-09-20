import { effectiveScaleX, effectiveScaleY, objectImage, type SceneDoc, type SceneObjectDoc } from "@dts/document";
import { rectCorners } from "@dts/renderer";
import { worldRectOf, type ImageSize, type WorldRect } from "@dts/grid";
import { badgeIconOf } from "../object-kinds";

/**
 * **对象在画布上占的那块世界矩形**（显示 / 拾取 / 选中框 / 适配视图共用一个口径）。
 *
 * 单独成文件是因为它的用户**不只有场景面板**：`state/editor-store.ts` 算「适配视图」时要问
 * 「这些东西加起来有多大」，而 store 不能反过来依赖面板（铺底图的那个组件依赖 store）。
 * 与 `transform.ts` / `grid-paint.ts` 同一类：面板目录下的**纯逻辑**模块。
 */

/**
 * 没有图片的对象（刚建出来的精灵）的**碰撞体**尺寸：世界里的一块 64×64。
 *
 * 拾取与选中框都按矩形来，所以每个对象都得有一块矩形；没有图片时不能是零面积
 * （零面积的框看不见、也点不到）。它**与缩放无关**：拉远了也是一个对象该有的大小，
 * 不会像按屏幕像素算的命中区那样忽大忽小。
 */
export const COLLIDER_SIZE = { width: 64, height: 64 } as const;

/**
 * 对象在画布上占据的世界矩形 —— 拾取（碰撞体）、选中框、贴图铺的那块**共用这一个**。
 *
 * 尺寸 = 「贴图里声明的尺寸（没有图片就用 `COLLIDER_SIZE`）× **该轴的有效缩放**」。
 * 有效缩放走 `effectiveScaleX` / `effectiveScaleY`：文档里等比只写 `scale`，
 * 单轴（v11 起的 `scaleX` / `scaleY`）才写两个轴——直接读字段会漏掉「缺省 = 用等比值」。
 *
 * **返回的是对象自己的（未旋转的）矩形**，`rotation` 由各消费方自己带上：
 *
 * - 绘制：渲染器绕矩形中心 `rotate(rotation)` 之后再 `drawImage`，贴图于是**刚体旋转**
 *   （不会因为「外框是旋转后的包围盒」而被拉成别的形状，也不会随角度改大小）；
 * - 拾取：`hitTestRect(point, rect, rotation)` 反向旋转后比半宽半高，与上面是同一块区域；
 * - 选中框 / 手柄：`rectCorners(rect, rotation)` 把这块矩形转过去，于是框、贴图、拾取一致。
 *
 * 曾经这里返回的是**旋转后的轴对齐外框**，于是两个真问题：非正方形对象转过角度后贴图被
 * 画成外框的形状（1920×1080 的地图转 45° 会变成 2121×2121），而且绘制用的手柄几何（外框）
 * 与命中测试用的几何（局部矩形）对不上——「看得见的柄点不中」。
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

/** 显示矩形的尺寸（**未旋转**）；`displayRectOf` 与手柄几何（缩放锚点）共用它。 */
export function displaySizeOf(object: SceneObjectDoc): ImageSize {
  // 动作对象画的是**固定的内置徽标**（不允许改贴图），所以它那块矩形就是徽标的大小：
  // 手写文件里万一挂了 `image` 也不认（`validateScene` 会警告），
  // 免得出现「选中框按贴图算、画出来的却是徽标」这种对不上的情况
  const base =
    badgeIconOf(object.kind) === undefined ? (objectImage(object) ?? COLLIDER_SIZE) : COLLIDER_SIZE;
  return {
    width: base.width * effectiveScaleX(object),
    height: base.height * effectiveScaleY(object),
  };
}

/**
 * 这个对象要画的贴图：**动作对象的徽标是内置的**，所以它们不看 `image`（那个字段没有意义）。
 *
 * 与 `displayRectOf` 收在一起：「不认贴图」这条规矩只在一处。
 */
export function displayImageOf(object: SceneObjectDoc): ReturnType<typeof objectImage> {
  return badgeIconOf(object.kind) === undefined ? objectImage(object) : undefined;
}

/**
 * 场景里**画布上看得见的东西**各自占的矩形（「适配视图」与默认视口都装这一份）。
 *
 * 三个口径，都是为了「装进来的 = 眼前看得到的」：
 * - 只算**激活**的对象（没激活的画布上根本不画，装进来只会白白把视野拉远）；
 * - 每块矩形就是画布上真正画出来的那块（`displayRectOf`：贴图尺寸 × 缩放 / 固定徽标）；
 * - 转过角度的对象用**四角的包围盒**：贴图是刚体旋转的，对角摆放的 1920×1080 地图
 *   实际伸到 2121×2121 那么远，只按未旋转的矩形装就会把它切掉两个角。
 */
export function sceneVisibleRects(scene: SceneDoc | undefined): WorldRect[] {
  return (scene?.objects ?? []).flatMap((object) => {
    if (!object.active) {
      return [];
    }

    const rect = displayRectOf(object);
    return rect === undefined ? [] : [boundingRectOf(rect, object.rotation)];
  });
}

/** 一块矩形绕自己的中心转过 `rotation` 之后的**轴对齐包围盒**。 */
function boundingRectOf(rect: WorldRect, rotation: number): WorldRect {
  if (rotation === 0) {
    return rect;
  }

  const corners = rectCorners(rect, rotation);
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const bottom = Math.min(...ys);
  const top = Math.max(...ys);

  return worldRectOf(
    { x: (left + right) / 2, y: (bottom + top) / 2 },
    { width: right - left, height: top - bottom },
  );
}
