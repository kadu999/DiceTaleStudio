import { describe, expect, it } from "vitest";
import { MAX_OBJECT_SCALE, MIN_OBJECT_SCALE } from "@dts/document";
import { ROTATION_SNAP_DEGREES, resolveTransform, type TransformStart } from "../src/panels/scene/transform";

/**
 * 手柄拖拽的**纯计算**：指针位置 + 按下快照 → 新的位置 / 角度 / 缩放。
 *
 * 三件事共用一条规矩：**一切相对「按下时的指针位置」算**（`start.pointer`）。
 *
 * - **移动**：`位置 = 起始位置 + 指针位移`。写成「位置 = 指针的绝对坐标」会让对象在
 *   第一次 move 时跳到光标下面（用户报的「按下去目标就跑到鼠标中心」）；
 * - **旋转**：`角度 = 起始角度 + 方位角增量`；
 * - **缩放**：倍率 = `当前指针相对锚点的偏移 ÷ 按下时的同一个偏移`。
 *   分母用半尺寸（而不是按下时的偏移）会让「抓角手柄」一按就变成 1.5~2 倍、
 *   而且把手比光标跑得快一倍——两者都是「不顺滑」。
 */

/** 一块 200×100 的等比对象，中心在世界原点；按下时指针也在原点（除非用例另给）。 */
function start(patch: Partial<TransformStart> = {}): TransformStart {
  return {
    id: "door",
    mode: "move",
    base: { x: 0, y: 0 },
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    pointer: { x: 0, y: 0 },
    center: { x: 0, y: 0 },
    anchor: { x: 0, y: 0 },
    corner: true,
    ...patch,
  };
}

describe("移动（相对按下时的指针）", () => {
  it("按下不动：位置一分不变（不是把位置写成指针的绝对坐标）", () => {
    const result = resolveTransform({
      start: start({ base: { x: 10, y: 20 }, pointer: { x: 250, y: 400 } }),
      pointer: { x: 250, y: 400 },
      axis: "x",
    });

    expect(result.position).toEqual({ x: 10, y: 20 });
  });

  it("拖 X 轴：位移就是指针位移，y 保持按下时的值", () => {
    const result = resolveTransform({
      start: start({ base: { x: 10, y: 20 }, pointer: { x: 250, y: 400 } }),
      pointer: { x: 300, y: 430 },
      axis: "x",
    });

    // +50 的指针位移 → +50 的位置位移（不是「位置 = 300」）
    expect(result.position).toEqual({ x: 60, y: 20 });
  });

  it("拖 Y 轴：只沿 Y 走，x 保持按下时的值", () => {
    const result = resolveTransform({
      start: start({ base: { x: 10, y: 20 }, pointer: { x: 250, y: 400 } }),
      pointer: { x: 260, y: 380 },
      axis: "y",
    });

    expect(result.position).toEqual({ x: 10, y: 0 });
  });

  it("不传 axis = 自由移动：两个轴一起跟手走（拖对象本体那条路）", () => {
    const result = resolveTransform({
      start: start({ base: { x: 10, y: 20 }, pointer: { x: 250, y: 400 } }),
      pointer: { x: 300, y: 430 },
    });

    // 位移是 (50, 30)，两个轴都跟上——不是「缺省沿 X 走」也不是「只能走一个轴」
    expect(result.position).toEqual({ x: 60, y: 50 });
  });

  it("自由移动按下不动：位置一分不变", () => {
    const result = resolveTransform({
      start: start({ base: { x: 10, y: 20 }, pointer: { x: 250, y: 400 } }),
      pointer: { x: 250, y: 400 },
    });

    expect(result.position).toEqual({ x: 10, y: 20 });
  });

  it("移动不碰角度与缩放", () => {
    const result = resolveTransform({
      start: start({ rotation: 0.5, scaleX: 2, scaleY: 3, pointer: { x: 0, y: 0 } }),
      pointer: { x: 1, y: 1 },
      axis: "x",
    });

    expect(result.rotation).toBe(0.5);
    expect(result.scaleX).toBe(2);
    expect(result.scaleY).toBe(3);
  });
});

describe("旋转（相对按下时的方位角，**屏幕上跟手**）", () => {
  /*
    画布 y 向下、世界 y 向上，两者差一个负号：**世界里的逆时针，在屏幕上看着是顺时针**。
    所以「指针怎么转、对象就怎么转」要求增量反号：
    - 手指从对象的**正右方往屏幕上方**走（屏幕逆时针）→ 文档里是 **-90°**，
      屏幕上对象也逆时针转（它的「右边」转到上面）；
    - 反过来（正右方往屏幕下方走）是 +90°。
    这里钉的就是这个符号——它只影响手势，不影响数值本身的含义。
  */

  it("从环的正右方拖到**屏幕上方** = -90°（屏幕上跟手：逆时针）", () => {
    // 世界坐标里 +y 就是屏幕上方（画布把 y 翻了过来）
    const result = resolveTransform({
      start: start({ mode: "rotate", pointer: { x: 100, y: 0 } }),
      pointer: { x: 0, y: 100 },
    });

    expect(result.rotation).toBeCloseTo(-Math.PI / 2, 6);
  });

  it("按下不动：角度不变", () => {
    const result = resolveTransform({
      start: start({ mode: "rotate", rotation: 0.3, pointer: { x: 100, y: 0 } }),
      pointer: { x: 100, y: 0 },
    });

    expect(result.rotation).toBeCloseTo(0.3, 6);
  });

  it("往屏幕下方拖 = +90°", () => {
    const result = resolveTransform({
      start: start({ mode: "rotate", pointer: { x: 100, y: 0 } }),
      pointer: { x: 0, y: -100 },
    });

    expect(result.rotation).toBeCloseTo(Math.PI / 2, 6);
  });

  it("从环上任意一点按下都只算**增量**（起点不会被吸到对象中心）", () => {
    // 从正上方按下、拖到正右方：屏幕上是顺时针 90° → 文档里 +90°
    // （起点若被吸成 0°，这里会跳到别的角度上去）
    const result = resolveTransform({
      start: start({ mode: "rotate", pointer: { x: 0, y: 80 } }),
      pointer: { x: 80, y: 0 },
    });

    expect(result.rotation).toBeCloseTo(Math.PI / 2, 6);
  });

  it("叠加在起始角度上（不是从 0 开始算）", () => {
    const result = resolveTransform({
      start: start({ mode: "rotate", rotation: Math.PI, pointer: { x: 100, y: 0 } }),
      pointer: { x: 0, y: 100 },
    });

    // π - π/2 = π/2
    expect(result.rotation).toBeCloseTo(Math.PI / 2, 6);
  });

  it("旋转不改位置与缩放", () => {
    const result = resolveTransform({
      start: start({
        mode: "rotate",
        base: { x: 7, y: -3 },
        scaleX: 2,
        scaleY: 4,
        pointer: { x: 100, y: 0 },
      }),
      pointer: { x: 0, y: 100 },
    });

    expect(result.position).toEqual({ x: 7, y: -3 });
    expect(result.scaleX).toBe(2);
    expect(result.scaleY).toBe(4);
  });

  it("Shift 吸附到 15° 的整数倍（Unity 的手感）", () => {
    // 往屏幕上方偏 34°（世界坐标 +34° → 屏幕上 -34°）→ 吸到 -30°
    const degrees34 = (34 * Math.PI) / 180;
    const result = resolveTransform({
      start: start({ mode: "rotate", pointer: { x: 100, y: 0 } }),
      pointer: { x: Math.cos(degrees34) * 100, y: Math.sin(degrees34) * 100 },
      snapAngle: true,
    });

    expect((result.rotation * 180) / Math.PI).toBeCloseTo(-ROTATION_SNAP_DEGREES * 2, 6);
  });
});

describe("缩放（相对按下时的指针偏移）", () => {
  /**
   * 缩放用例统一用一块 **200×200 的正方形**（半边 100），中心在原点。
   *
   * 倍率的分母是「按下时指针相对锚点的偏移」。抓右下角时那个偏移正好是
   * `(200, -200)`（两倍半尺寸），于是「把指针拖到锚点之外两倍处」= 尺寸翻倍，
   * 而且**被抓住的那个角正好落在指针下**——这才是「跟手」。
   */
  const SQUARE = start({ mode: "scale" });
  /** 抓右下角：锚点是对角的左上角，按下时指针就在右下角 (100, -100)。 */
  const cornerStart: TransformStart = {
    ...SQUARE,
    anchor: { x: -100, y: 100 },
    pointer: { x: 100, y: -100 },
    corner: true,
  };

  it("按下不动：倍率恒为 1、中心不动（分母不是半尺寸，所以一按不会跳）", () => {
    const result = resolveTransform({ start: cornerStart, pointer: { x: 100, y: -100 } });

    expect(result.scaleX).toBeCloseTo(1, 6);
    expect(result.scaleY).toBeCloseTo(1, 6);
    expect(result.position.x).toBeCloseTo(0, 6);
    expect(result.position.y).toBeCloseTo(0, 6);
  });

  it("角手柄等比：锚点固定不动，被抓住的角**正好落在指针下**", () => {
    // 指针拖到锚点之外两倍（-100,100）+ 2×(200,-200) = (300,-300)
    const pointer = { x: 300, y: -300 };
    const result = resolveTransform({ start: cornerStart, pointer });

    expect(result.scaleX).toBeCloseTo(2, 6);
    expect(result.scaleY).toBeCloseTo(2, 6);
    // 中心 = 锚点 + 2 × (起始中心 − 锚点) = (-100,100) + 2×(100,-100)
    expect(result.position.x).toBeCloseTo(100, 6);
    expect(result.position.y).toBeCloseTo(-100, 6);

    // 「跟手」的判据：放大后的右下角就在指针处（缩放不改角度，所以直接相加）
    expect(result.position.x + 100 * result.scaleX).toBeCloseTo(pointer.x, 6);
    expect(result.position.y - 100 * result.scaleY).toBeCloseTo(pointer.y, 6);
  });

  it("边手柄只改一个轴（另一轴偏多远都不参与）", () => {
    // 400×200（半边 200 / 100）：右边中点 (200,0)，锚点是左边中点 (-200,0)
    const rightEdge = start({
      mode: "scale",
      anchor: { x: -200, y: 0 },
      pointer: { x: 200, y: 0 },
      corner: false,
      axis: "x",
    });

    const still = resolveTransform({ start: rightEdge, pointer: { x: 200, y: 500 } });

    expect(still.scaleX).toBeCloseTo(1, 6);
    expect(still.scaleY).toBe(1);

    // 拖到锚点之外两倍：宽度翻倍，高度一点不动
    const wider = resolveTransform({ start: rightEdge, pointer: { x: 600, y: 9999 } });

    expect(wider.scaleX).toBeCloseTo(2, 6);
    expect(wider.scaleY).toBe(1);
    // 宽度翻倍 → 中心离锚点变成两倍 = (-200,0) + 2×(200,0)
    expect(wider.position.x).toBeCloseTo(200, 6);
    expect(wider.position.y).toBeCloseTo(0, 6);
  });

  it("按住 Shift 时角手柄也锁等比（两轴取大的那个倍率）", () => {
    // x 的倍率是 2、y 只有 1.2；锁等比后两轴都取大的那个
    const result = resolveTransform({
      start: cornerStart,
      pointer: { x: 300, y: -140 },
      uniform: true,
    });

    expect(result.scaleX).toBeCloseTo(2, 6);
    expect(result.scaleY).toBeCloseTo(2, 6);
  });

  it("拉到超出上限 / 下限都夹在 0.01 ~ 100", () => {
    const huge = resolveTransform({
      start: cornerStart,
      pointer: { x: 1e6, y: -1e6 },
    });
    expect(huge.scaleX).toBe(MAX_OBJECT_SCALE);
    expect(huge.scaleY).toBe(MAX_OBJECT_SCALE);

    // 指针正好压在锚点上 → 偏移 0 → 夹到下限
    const tiny = resolveTransform({
      start: cornerStart,
      pointer: { x: -100, y: 100 },
    });
    expect(tiny.scaleX).toBe(MIN_OBJECT_SCALE);
    expect(tiny.scaleY).toBe(MIN_OBJECT_SCALE);
  });

  it("矩形转过 90° 后，边手柄改的仍是对象**自己**的轴", () => {
    // 200×200 转 90°：对象自己的 +x 轴指向世界的 +y。
    // 「右边中点」在局部是 (100,0)，转到世界是 (0,100)；它的对面（左边中点）落在世界 (0,-100)。
    // 按下时指针在把手上 (0,100)，拖到 (0,300) = 沿它自己的 +x 又走了 400（按下偏移的 2 倍）
    // → 宽度翻倍、高度一点不动。判的正是「轴没串」——转过角度后把世界位移
    // 直接当成对象自己的轴，是这里最容易犯的错
    const result = resolveTransform({
      start: start({
        mode: "scale",
        rotation: Math.PI / 2,
        anchor: { x: 0, y: -100 },
        pointer: { x: 0, y: 100 },
        corner: false,
        axis: "x",
      }),
      pointer: { x: 0, y: 300 },
    });

    expect(result.scaleX).toBeCloseTo(2, 6);
    expect(result.scaleY).toBeCloseTo(1, 6);
  });
});
