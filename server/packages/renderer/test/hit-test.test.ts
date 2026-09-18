import { describe, expect, it } from "vitest";
import { worldRectOf } from "@dts/grid";
import { hitTestRect } from "../src/scene-renderer";

/**
 * 拾取对象的碰撞体：**矩形**（不是中心点周围的小圆）。
 *
 * 这块矩形必须和选中框、和贴图铺的那块**完全一致**，否则会出现「看着在那儿、点不到」
 * 或者「框在一处、点的是另一处」。所以这里钉住三件事：边内边外的判定、含边界、
 * 以及旋转之后仍然按矩形判（而不是退回轴对齐的包围盒）。
 */

/** 中心 (0, 0)、100×60 的矩形。 */
const RECT = worldRectOf({ x: 0, y: 0 }, { width: 100, height: 60 });

describe("矩形碰撞体", () => {
  it("矩形内部命中：离中心多远都在，不再要求靠近中心", () => {
    expect(hitTestRect({ x: 0, y: 0 }, RECT)).toBe(true);
    expect(hitTestRect({ x: 49, y: 29 }, RECT)).toBe(true);
    expect(hitTestRect({ x: -49, y: -29 }, RECT)).toBe(true);
    // 角上也算（旧的中心点 + 12px 半径根本点不到这里）
    expect(hitTestRect({ x: 49.5, y: 29.5 }, RECT)).toBe(true);
  });

  it("边界含在内、出去一点就不算", () => {
    expect(hitTestRect({ x: 50, y: 0 }, RECT)).toBe(true);
    expect(hitTestRect({ x: 0, y: 30 }, RECT)).toBe(true);
    expect(hitTestRect({ x: 50.01, y: 0 }, RECT)).toBe(false);
    expect(hitTestRect({ x: 0, y: 30.01 }, RECT)).toBe(false);
  });

  it("中心不在世界原点的矩形按自己的中心判", () => {
    const offset = worldRectOf({ x: -300, y: 200 }, { width: 40, height: 20 });

    expect(hitTestRect({ x: -300, y: 200 }, offset)).toBe(true);
    expect(hitTestRect({ x: -281, y: 200 }, offset)).toBe(true);
    // 世界原点离它很远，绝不能命中
    expect(hitTestRect({ x: 0, y: 0 }, offset)).toBe(false);
    expect(hitTestRect({ x: -279, y: 200 }, offset)).toBe(false);
  });

  it("旋转 90°：长边转到竖直方向，判定跟着转（不是轴对齐包围盒）", () => {
    const rotated = Math.PI / 2;

    // 转 90° 后：世界 y 方向的可达范围变成 50，x 方向变成 30
    expect(hitTestRect({ x: 0, y: 45 }, RECT, rotated)).toBe(true);
    expect(hitTestRect({ x: 0, y: 55 }, RECT, rotated)).toBe(false);
    // x 方向原来的 49（未旋转时命中）现在出界
    expect(hitTestRect({ x: 49, y: 0 }, RECT, rotated)).toBe(false);
    expect(hitTestRect({ x: 25, y: 0 }, RECT, rotated)).toBe(true);
  });
});
