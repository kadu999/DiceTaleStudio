import { describe, expect, it } from "vitest";
import { worldRectOf } from "@dts/grid";
import {
  GIZMO_AXIS_GAP,
  GIZMO_AXIS_LENGTH,
  GIZMO_HANDLE_HIT_SIZE,
  GIZMO_RING_GAP,
  SCALE_HANDLES,
  angleAround,
  gizmoScreenGeometry,
  hitTestGizmoHandles,
  isCornerScaleHandle,
  isDrawableFrame,
  rectCorners,
  rotatePointAround,
  scaleAnchorFor,
  scaleHandlePoints,
  toolHasGizmo,
} from "../src/gizmo";
import { hitTestRect } from "../src/scene-renderer";
import { createViewport } from "../src/viewport";

/**
 * 变换手柄的几何与命中测试。
 *
 * 这里钉住的是「绘制与命中所用的同一份坐标」：手柄画在哪、点在哪，
 * 都由 `gizmoScreenGeometry` 产出，所以本文件既验证几何本身，也验证
 * 「旋转过的对象，手柄跟着转」这条约定（对齐 Unity）。
 */

/** 默认视口：世界原点在画布正中、1 世界像素 = 1 CSS 像素，于是世界坐标 + 画布中心 = 屏幕点。 */
const VIEW = createViewport(1, 400, 300);
const RECT = worldRectOf({ x: 0, y: 0 }, { width: 100, height: 60 });

describe("矩形四角", () => {
  it("不旋转时就是四个角，从左上起顺时针", () => {
    expect(rectCorners(RECT)).toEqual([
      { x: -50, y: 30 },
      { x: 50, y: 30 },
      { x: 50, y: -30 },
      { x: -50, y: -30 },
    ]);
  });

  it("转 90° 后四角互换：短边变成水平方向", () => {
    // 绕中心逆时针转 90°（世界坐标 y 向上）：(-50,30) → (-30,-50)、(50,30) → (-30,50)。
    // x 都变成 -30 是对的——转 90° 后矩形横跨的是原来的**高**，而两个上角落到同一竖线上。
    // 这套「世界坐标里逆时针」正对应文档 / Unity 里正的 Y 轴旋转，不是屏幕上的逆时针
    const [topLeft, topRight, bottomRight, bottomLeft] = rectCorners(RECT, Math.PI / 2);

    expect(topLeft?.x).toBeCloseTo(-30, 6);
    expect(topLeft?.y).toBeCloseTo(-50, 6);
    expect(topRight?.x).toBeCloseTo(-30, 6);
    expect(topRight?.y).toBeCloseTo(50, 6);
    expect(bottomRight?.x).toBeCloseTo(30, 6);
    expect(bottomLeft?.y).toBeCloseTo(-50, 6);
  });
  it("旋转后的四角仍落在 `hitTestRect` 认可的边界上（拾取与手柄同一块矩形）", () => {
    const rotation = 0.6;
    const corners = rectCorners(RECT, rotation);

    for (const corner of corners) {
      // 沿外法线（角相对中心的方向）往内挪一点必须命中、往外挪一点必须不命中。
      // 直接拿角点本身去判会踩浮点边界（`|x| <= 半宽` 在边界上差 1e-14 就翻），
      // 所以两侧各让开半像素——判的是「边界就在这儿」，不依赖最后一次舍入
      const dx = corner.x - RECT.center.x;
      const dy = corner.y - RECT.center.y;
      const length = Math.hypot(dx, dy);

      expect(
        hitTestRect({ x: corner.x - (dx / length) * 0.5, y: corner.y - (dy / length) * 0.5 }, RECT, rotation),
      ).toBe(true);
      expect(
        hitTestRect({ x: corner.x + (dx / length) * 0.5, y: corner.y + (dy / length) * 0.5 }, RECT, rotation),
      ).toBe(false);
    }
  });
});

describe("绕枢轴旋转", () => {
  it("转 0 度返回原点本身", () => {
    expect(rotatePointAround({ x: 3, y: 4 }, { x: 1, y: 1 }, 0)).toEqual({ x: 3, y: 4 });
  });

  it("绕原点转 90°：(1,0) → (0,1)（正角 = 屏幕逆时针）", () => {
    const rotated = rotatePointAround({ x: 1, y: 0 }, { x: 0, y: 0 }, Math.PI / 2);

    expect(rotated.x).toBeCloseTo(0, 6);
    expect(rotated.y).toBeCloseTo(1, 6);
  });

  it("方位角与旋转互逆：转过去的点的方位角 = 原方位角 + 旋转角", () => {
    const pivot = { x: 10, y: -5 };
    const point = { x: 13, y: -1 };
    const rotation = 0.9;

    const rotated = rotatePointAround(point, pivot, rotation);
    expect(angleAround(rotated, pivot)).toBeCloseTo(angleAround(point, pivot) + rotation, 6);
  });
});

describe("缩放手柄", () => {
  it("八个方位齐全，顺序与 `SCALE_HANDLES` 一致", () => {
    const points = scaleHandlePoints(RECT);

    expect(points).toHaveLength(8);
    expect(points.map((entry) => entry.handle)).toEqual([...SCALE_HANDLES]);
  });

  it("边中点是相邻两角的平均（不另算一条会与四角对不上的路径）", () => {
    const points = new Map(scaleHandlePoints(RECT).map((entry) => [entry.handle, entry.world]));

    expect(points.get("scale-top")).toEqual({ x: 0, y: 30 });
    expect(points.get("scale-right")).toEqual({ x: 50, y: 0 });
    expect(points.get("scale-bottom")).toEqual({ x: 0, y: -30 });
    expect(points.get("scale-left")).toEqual({ x: -50, y: 0 });
  });

  it("锚点是对侧：角对对角、边对边", () => {
    // 拖左上角 → 右下角不动
    expect(scaleAnchorFor("scale-top-left", RECT)).toEqual({ x: 50, y: -30 });
    // 拖右边中点 → 左边中点不动
    expect(scaleAnchorFor("scale-right", RECT)).toEqual({ x: -50, y: 0 });
  });

  it("锚点也随旋转一起转（对象转过角度后，对面依然是「对面」）", () => {
    // 右边中点 (50,0) 转 90° → (0,50)，它的对面（左边中点）自然是 (0,-50)
    const anchor = scaleAnchorFor("scale-right", RECT, Math.PI / 2);

    expect(anchor?.x).toBeCloseTo(0, 6);
    expect(anchor?.y).toBeCloseTo(-50, 6);
  });

  it("角手柄 = 等比、边手柄 = 单轴", () => {
    expect(isCornerScaleHandle("scale-top-left")).toBe(true);
    expect(isCornerScaleHandle("scale-right")).toBe(false);
  });
});

describe("屏幕几何", () => {
  it("世界原点在画布正中：中心点就是视口平移量", () => {
    const geometry = gizmoScreenGeometry(RECT, 0, VIEW);

    expect(geometry.center).toEqual({ x: 400, y: 300 });
  });

  it("缩放柄落在矩形的角与边中点上（1:1 视口下直接相加）", () => {
    const geometry = gizmoScreenGeometry(RECT, 0, VIEW);
    const topLeft = geometry.scale.find((entry) => entry.handle === "scale-top-left");

    expect(topLeft?.point).toEqual({ x: 350, y: 270 });
  });

  it("矩形太小时不可绘制（手柄会比对象本身还大）", () => {
    const tiny = worldRectOf({ x: 0, y: 0 }, { width: 4, height: 4 });

    expect(isDrawableFrame(tiny, VIEW)).toBe(false);
    expect(gizmoScreenGeometry(tiny, 0, VIEW).drawable).toBe(false);
    expect(isDrawableFrame(RECT, VIEW)).toBe(true);
  });

  it("移动轴**贴着对象**长：从外框外一段距离起、再向外一段", () => {
    const geometry = gizmoScreenGeometry(RECT, 0, VIEW);
    const x = geometry.axes.find((axis) => axis.handle === "move-x");

    // 矩形 100×60 → 屏幕半边是 50 / 30；轴从 50+GAP 处起、到 50+GAP+LENGTH
    expect(x?.root.x).toBeCloseTo(geometry.center.x + 50 + GIZMO_AXIS_GAP, 6);
    expect(x?.tip.x).toBeCloseTo(geometry.center.x + 50 + GIZMO_AXIS_GAP + GIZMO_AXIS_LENGTH, 6);
  });

  it("对象变大时移动轴跟着往外挪（不是固定在离中心多远处）", () => {
    const small = gizmoScreenGeometry(worldRectOf({ x: 0, y: 0 }, { width: 100, height: 60 }), 0, VIEW);
    const big = gizmoScreenGeometry(worldRectOf({ x: 0, y: 0 }, { width: 400, height: 60 }), 0, VIEW);

    const smallTip = small.axes.find((axis) => axis.handle === "move-x")?.tip.x ?? 0;
    const bigTip = big.axes.find((axis) => axis.handle === "move-x")?.tip.x ?? 0;

    expect(bigTip - smallTip).toBeCloseTo(150, 6);
  });

  it("旋转环包住整个对象：半径 = 外框对角线 + 一段间距", () => {
    const geometry = gizmoScreenGeometry(RECT, 0, VIEW);

    expect(geometry.ringRadius).toBeCloseTo(Math.hypot(50, 30) + GIZMO_RING_GAP, 6);
  });

  it("外框半宽半高按旋转后的极值算（旋转时手柄仍然贴住对象）", () => {
    const rotated = gizmoScreenGeometry(RECT, Math.PI / 2, VIEW);

    // 转 90° 后外框变成 60×100 → 半宽半高互换
    expect(rotated.bounds.halfWidth).toBeCloseTo(30, 6);
    expect(rotated.bounds.halfHeight).toBeCloseTo(50, 6);
  });
});

describe("有没有手柄（工具过滤的唯一来源）", () => {
  it("拖动场景没有手柄；移动 / 旋转 / 缩放都有", () => {
    expect(toolHasGizmo("none")).toBe(false);
    expect(toolHasGizmo("move")).toBe(true);
    expect(toolHasGizmo("rotate")).toBe(true);
    expect(toolHasGizmo("scale")).toBe(true);
  });

  it("它与命中测试的口径一致：有手柄才可能点得到", () => {
    const geometry = gizmoScreenGeometry(RECT, 0, VIEW);
    const xTip = geometry.axes.find((axis) => axis.handle === "move-x")?.tip ?? { x: 0, y: 0 };

    for (const tool of ["none", "move", "rotate", "scale"] as const) {
      const hit = hitTestGizmoHandles(xTip, tool, geometry);
      if (!toolHasGizmo(tool)) {
        expect(hit, `${tool} 不该有手柄却命中了 ${hit ?? ""}`).toBeUndefined();
      }
    }
  });
});

describe("命中测试", () => {
  const geometry = gizmoScreenGeometry(RECT, 0, VIEW);

  it("缩放手柄：中心命中、偏出容差就不命中", () => {
    const corner = geometry.scale.find((entry) => entry.handle === "scale-top-left");
    const point = corner?.point ?? { x: 0, y: 0 };

    expect(hitTestGizmoHandles(point, "scale", geometry)).toBe("scale-top-left");
    expect(
      hitTestGizmoHandles(
        { x: point.x + GIZMO_HANDLE_HIT_SIZE + 1, y: point.y },
        "scale",
        geometry,
      ),
    ).toBeUndefined();
  });

  it("旋转环：环上命中、环内与环外都不命中", () => {
    const onRing = { x: geometry.center.x + geometry.ringRadius, y: geometry.center.y };

    expect(hitTestGizmoHandles(onRing, "rotate", geometry)).toBe("rotate");
    expect(hitTestGizmoHandles(geometry.center, "rotate", geometry)).toBeUndefined();
    expect(
      hitTestGizmoHandles(
        { x: geometry.center.x + geometry.ringRadius * 2, y: geometry.center.y },
        "rotate",
        geometry,
      ),
    ).toBeUndefined();
  });

  it("移动轴：X 轴条落在右侧、Y 轴条落在上方，且**只认自己的轴**", () => {
    const xTip = geometry.axes.find((axis) => axis.handle === "move-x")?.tip ?? { x: 0, y: 0 };
    const yTip = geometry.axes.find((axis) => axis.handle === "move-y")?.tip ?? { x: 0, y: 0 };

    expect(hitTestGizmoHandles(xTip, "move", geometry)).toBe("move-x");
    expect(hitTestGizmoHandles(yTip, "move", geometry)).toBe("move-y");
    // 轴条只在自己的方向上延伸：X 轴末端往上一段不该命中任何东西
    expect(hitTestGizmoHandles({ x: xTip.x, y: xTip.y - 60 }, "move", geometry)).toBeUndefined();
  });

  it("**没选工具（拖动模式）时一个手柄都点不到**", () => {
    const corner = geometry.scale.find((entry) => entry.handle === "scale-top-left")?.point ?? {
      x: 0,
      y: 0,
    };
    const onRing = { x: geometry.center.x + geometry.ringRadius, y: geometry.center.y };
    const xTip = geometry.axes.find((axis) => axis.handle === "move-x")?.tip ?? { x: 0, y: 0 };

    expect(hitTestGizmoHandles(corner, "none", geometry)).toBeUndefined();
    expect(hitTestGizmoHandles(onRing, "none", geometry)).toBeUndefined();
    expect(hitTestGizmoHandles(xTip, "none", geometry)).toBeUndefined();
  });

  it("工具决定哪些手柄**可交互**：点同一个位置上，不同工具认出不同手柄", () => {
    // X 轴末端（离中心 50+GAP+LENGTH = 135）：移动模式下它就是移动柄，
    // 换个工具就什么都不是——同一个点、同一份几何，答案只由当前工具决定
    const point = geometry.axes.find((axis) => axis.handle === "move-x")?.tip ?? { x: 0, y: 0 };

    expect(hitTestGizmoHandles(point, "move", geometry)).toBe("move-x");
    expect(hitTestGizmoHandles(point, "rotate", geometry)).toBeUndefined();
    expect(hitTestGizmoHandles(point, "scale", geometry)).toBeUndefined();
  });

  it("对象的**边中点**在旋转模式下不算缩放块（缩放块只在 scale 下可点）", () => {
    // 边中点离中心的距离由矩形尺寸决定（这里半高 30），与旋转环半径无关——
    // 于是它同时验证了「边手柄认得出来」和「换个工具就点不到」
    const bottom = geometry.scale.find((entry) => entry.handle === "scale-bottom")?.point ?? {
      x: 0,
      y: 0,
    };

    expect(hitTestGizmoHandles(bottom, "scale", geometry)).toBe("scale-bottom");
    expect(hitTestGizmoHandles(bottom, "rotate", geometry)).toBeUndefined();
    expect(hitTestGizmoHandles(bottom, "move", geometry)).toBeUndefined();
  });

  it("太小的矩形一律不给命中（即使正好点在某个柄的坐标上）", () => {
    const tiny = worldRectOf({ x: 0, y: 0 }, { width: 4, height: 4 });
    const tinyGeometry = gizmoScreenGeometry(tiny, 0, VIEW);
    const corner = tinyGeometry.scale[0]?.point ?? { x: 0, y: 0 };

    expect(hitTestGizmoHandles(corner, "scale", tinyGeometry)).toBeUndefined();
  });
});
