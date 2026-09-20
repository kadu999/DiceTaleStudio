import { describe, expect, it } from "vitest";
import { MAX_OBJECT_SCALE, MIN_OBJECT_SCALE } from "@dts/document";
import { ROTATION_SNAP_DEGREES, resolveTransform, type TransformStart } from "../src/panels/scene/transform";

/**
 * 手柄拖拽的**纯计算**：指针位置 + 按下快照 → 新的位置 / 角度 / 缩放。
 *
 * 这里覆盖三件事，它们各自都有「看着对、其实错」的写法：
 * - **移动**是轴约束的（拖 X 箭头不该动 y）；
 * - **旋转**按方位角增量算，符号与世界坐标系一致（正角 = 世界坐标里逆时针）；
 * - **缩放**以对侧锚点为固定点，锚点固定在世界上不动（于是中心会跟着移），
 *   角手柄等比、边手柄单轴，且两轴都夹在 0.01 ~ 100。
 */

/** 一个 200×100（半宽 100 / 半高 50）的等比对象，中心在世界原点。 */
function start(patch: Partial<TransformStart> = {}): TransformStart {
  return {
    id: "door",
    mode: "move",
    base: { x: 0, y: 0 },
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    halfWidth: 100,
    halfHeight: 50,
    pointerAngle: 0,
    center: { x: 0, y: 0 },
    anchor: { x: 0, y: 0 },
    corner: true,
    ...patch,
  };
}

describe("移动（轴约束）", () => {
  it("拖 X 轴只改 x，y 保持按下时的值", () => {
    const result = resolveTransform({
      start: start({ mode: "move", base: { x: 10, y: 20 } }),
      pointer: { x: 300, y: 400 },
      axis: "x",
    });

    expect(result.position).toEqual({ x: 300, y: 20 });
  });

  it("拖 Y 轴只改 y", () => {
    const result = resolveTransform({
      start: start({ mode: "move", base: { x: 10, y: 20 } }),
      pointer: { x: 300, y: 400 },
      axis: "y",
    });

    expect(result.position).toEqual({ x: 10, y: 400 });
  });

  it("移动不碰角度与缩放", () => {
    const result = resolveTransform({
      start: start({ mode: "move", rotation: 0.5, scaleX: 2, scaleY: 3 }),
      pointer: { x: 1, y: 1 },
      axis: "x",
    });

    expect(result.rotation).toBe(0.5);
    expect(result.scaleX).toBe(2);
    expect(result.scaleY).toBe(3);
  });
});

describe("旋转", () => {
  it("从正右方拖到正上方 = +90°（世界坐标 y 向上 = 逆时针）", () => {
    const result = resolveTransform({
      start: start({ mode: "rotate", pointerAngle: 0 }),
      pointer: { x: 0, y: 100 },
    });

    expect(result.rotation).toBeCloseTo(Math.PI / 2, 6);
  });

  it("反向拖 = 负角", () => {
    const result = resolveTransform({
      start: start({ mode: "rotate", pointerAngle: 0 }),
      pointer: { x: 0, y: -100 },
    });

    expect(result.rotation).toBeCloseTo(-Math.PI / 2, 6);
  });

  it("叠加在起始角度上（不是从 0 开始算）", () => {
    const result = resolveTransform({
      start: start({ mode: "rotate", rotation: Math.PI, pointerAngle: 0 }),
      pointer: { x: 0, y: 100 },
    });

    // π + π/2 = 3π/2 → 归一化到 -π/2
    expect(result.rotation).toBeCloseTo(-Math.PI / 2, 6);
  });

  it("旋转不改位置与缩放", () => {
    const result = resolveTransform({
      start: start({ mode: "rotate", base: { x: 7, y: -3 }, scaleX: 2, scaleY: 4 }),
      pointer: { x: 0, y: 100 },
    });

    expect(result.position).toEqual({ x: 7, y: -3 });
    expect(result.scaleX).toBe(2);
    expect(result.scaleY).toBe(4);
  });

  it("Shift 吸附到 15° 的整数倍（Unity 的手感）", () => {
    // 34° 的位移 → 吸到 30°
    const degrees34 = (34 * Math.PI) / 180;
    const result = resolveTransform({
      start: start({ mode: "rotate", pointerAngle: 0 }),
      pointer: { x: Math.cos(degrees34) * 100, y: Math.sin(degrees34) * 100 },
      snapAngle: true,
    });

    expect((result.rotation * 180) / Math.PI).toBeCloseTo(ROTATION_SNAP_DEGREES * 2, 6);
  });
});

describe("缩放", () => {
  /**
   * 缩放用例统一用一块 **200×200 的正方形**（半边 100），中心在原点。
   *
   * 为什么是正方形：倍率是相对**锚点**算的——`指针到锚点的距离 ÷ 半尺寸`。
   * 只有两轴半尺寸相等时，「拖到锚点的对角」才同时给出 2 倍的 x 与 2 倍的 y，
   * 用例里的数字才能一眼看懂而不必先解一道题。
   *
   * 锚点固定这条约定也由此好验证：锚点 (100,-100) 到中心 (0,0) 的距离是一个半边；
   * 尺寸翻倍后中心离锚点变成两个半边，也就是 (100,-100) + 2×(-100,100) = (-100,100)，
   * 于是**中心 = 锚点与指针的中点**。
   */
  const SQUARE = start({ mode: "scale", halfWidth: 100, halfHeight: 100 });
  const cornerStart = { ...SQUARE, anchor: { x: 100, y: -100 }, corner: true };

  it("角手柄等比：锚点固定不动，中心移到锚点与指针的中点", () => {
    // 指针 (-100, 100) 到锚点 (100,-100) 的距离是两个半边 → 尺寸翻倍
    const result = resolveTransform({ start: cornerStart, pointer: { x: -100, y: 100 } });

    expect(result.scaleX).toBeCloseTo(2, 6);
    expect(result.scaleY).toBeCloseTo(2, 6);
    // 「锚点不动」= 中心与锚点的相对位置按倍率伸缩：
    // (100,-100) + 2 × (原点 - (100,-100)) = (-100, 100)，正是锚点与指针的中点
    expect(result.position.x).toBeCloseTo(-100, 6);
    expect(result.position.y).toBeCloseTo(100, 6);
  });

  it("等比时中心与锚点的相对位置正好翻倍（锚点固定这条性质）", () => {
    const anchor = { x: 100, y: -100 };
    const result = resolveTransform({
      start: { ...SQUARE, anchor },
      pointer: { x: -100, y: 100 },
    });

    // 起始中心在原点 → 放大 2 倍后中心 = 锚点 + 2×(原点 − 锚点)
    expect(result.position.x).toBeCloseTo(anchor.x * -1, 6);
    expect(result.position.y).toBeCloseTo(anchor.y * -1, 6);
  });

  it("边手柄只改一个轴（另一轴原样不动，哪怕指针在另一轴上偏很远）", () => {
    // 宽 400（半边 200）：右边中点 (200,0)，锚点是左边中点 (-200,0)。
    // 指针到 (0,100) 时到锚点的距离正好是一个半边 → 宽度不变（ratio 1）；
    // y 偏了 100 完全不该参与
    const rightEdge = start({
      mode: "scale",
      halfWidth: 200,
      halfHeight: 100,
      anchor: { x: -200, y: 0 },
      corner: false,
      axis: "x",
    });
    const result = resolveTransform({ start: rightEdge, pointer: { x: 0, y: 100 } });

    expect(result.scaleX).toBeCloseTo(1, 6);
    expect(result.scaleY).toBe(1);

    // 拉到 (600,9999)：800 / 半边 200 = 4 个半边 → 宽度翻到 4 倍，高度仍然一点不动
    const wider = resolveTransform({ start: rightEdge, pointer: { x: 600, y: 9999 } });

    expect(wider.scaleX).toBeCloseTo(4, 6);
    expect(wider.scaleY).toBe(1);
    // 宽度翻到 4 倍、高度不动 → 中心与锚点的相对位置横向伸 4 倍 = (600, 0)
    expect(wider.position.x).toBeCloseTo(600, 6);
    expect(wider.position.y).toBeCloseTo(0, 6);
  });

  it("按住 Shift 时角手柄也锁等比", () => {
    // x 的倍率是 2、y 只有 1.2；锁等比后两轴都取大的那个
    const result = resolveTransform({
      start: { ...SQUARE, anchor: { x: 100, y: -100 }, corner: true },
      pointer: { x: -100, y: 20 },
      uniform: true,
    });

    expect(result.scaleX).toBeCloseTo(2, 6);
    expect(result.scaleY).toBeCloseTo(2, 6);
  });

  it("拉到超出上限 / 下限都夹在 0.01 ~ 100", () => {
    const huge = resolveTransform({
      start: cornerStart,
      pointer: { x: -1e6, y: 1e6 },
    });
    expect(huge.scaleX).toBe(MAX_OBJECT_SCALE);
    expect(huge.scaleY).toBe(MAX_OBJECT_SCALE);

    const tiny = resolveTransform({
      start: cornerStart,
      pointer: { x: 100, y: -100 },
    });
    expect(tiny.scaleX).toBe(MIN_OBJECT_SCALE);
    expect(tiny.scaleY).toBe(MIN_OBJECT_SCALE);
  });

  it("矩形转过 90° 后，边手柄改的仍是对象**自己**的轴", () => {
    // 200×200 转 90°：矩形在世界里还是 200×200，但对象**自己**的 x 轴指向世界的 y。
    // 「右边中点」在局部是 (100,0)，转到世界是 (0,100)；它的对面（左边中点）落在世界 (0,-100)。
    // 指针给到世界 (0,100)：在局部坐标里正好是沿它自己的 +x 走了 200 = 两个半边
    // → 宽度翻倍、高度一点不动。判的正是「轴没串」——
    // 转过角度后把世界位移直接当成对象自己的轴，是这里最容易犯的错
    const result = resolveTransform({
      start: {
        ...SQUARE,
        rotation: Math.PI / 2,
        anchor: { x: 0, y: -100 },
        corner: false,
        axis: "x",
      },
      pointer: { x: 0, y: 100 },
    });

    expect(result.scaleX).toBeCloseTo(2, 6);
    expect(result.scaleY).toBeCloseTo(1, 6);
  });
});
