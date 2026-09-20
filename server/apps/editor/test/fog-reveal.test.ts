import { describe, expect, it } from "vitest";
import { MASK_BRUSH_RATIO } from "../src/services/mask-math";
import {
  emptyFogReveal,
  entryOf,
  fogRevealResendPlan,
  pruneFogReveal,
  shouldFlushBatch,
  splitStrokeBatch,
  withEraseBatch,
  withRegion,
  type FogRevealPoint,
} from "../src/services/fog-reveal";

/**
 * 战争雾的揭示记账（纯函数）：**一笔一条轨迹、整区开合有序记、前端连上补发**。
 *
 * 这里钉住四件事：
 * 1. 拖动中分批下发的点，记账里要**并成一条**（补发时是一条完整轨迹，不是一串碎笔画）；
 * 2. 整区开合与笔画**按顺序**记——「盖回」要能盖掉它之前的笔画；
 * 3. 分批的阈值与切法（相邻两批共享一个落点，接缝处不能断）；
 * 4. 补发只在「前端刚连上」那一刻发生一次，且按当前文档筛掉没意义的对象。
 */

const POINT = (x: number, y: number): FogRevealPoint => ({ x, y });

/** 一个对象那一串操作的简写（测试里读起来清楚些）。 */
const opsOf = (state: ReturnType<typeof emptyFogReveal>, objectId: string) =>
  entryOf(state, objectId).ops;

describe("战争雾记账：擦除轨迹", () => {
  it("一开始什么都没有；没记过的对象读出来是空记录", () => {
    const state = emptyFogReveal();
    expect(state.objects).toEqual({});
    expect(entryOf(state, "map-1").ops).toEqual([]);
  });

  it("一批点 = 一条笔画，半径/软边取画笔的默认值", () => {
    const state = withEraseBatch(emptyFogReveal(), "map-1", [POINT(0.1, 0.2), POINT(0.3, 0.4)]);

    expect(opsOf(state, "map-1")).toEqual([
      {
        kind: "stroke",
        stroke: { radius: MASK_BRUSH_RATIO, softness: 1, points: [POINT(0.1, 0.2), POINT(0.3, 0.4)] },
      },
    ]);
  });

  it("空点集不动记账（连引用都不换）", () => {
    const state = withEraseBatch(emptyFogReveal(), "map-1", [POINT(0.1, 0.1)]);
    expect(withEraseBatch(state, "map-1", [])).toBe(state);
  });

  it("同一笔的相邻批次并成一条：补发时是一条完整轨迹", () => {
    const first = withEraseBatch(emptyFogReveal(), "map-1", [POINT(0.1, 0.1), POINT(0.2, 0.2)]);
    const second = withEraseBatch(first, "map-1", [POINT(0.2, 0.2), POINT(0.3, 0.3)]);

    const ops = opsOf(second, "map-1");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      kind: "stroke",
      stroke: {
        radius: MASK_BRUSH_RATIO,
        softness: 1,
        points: [POINT(0.1, 0.1), POINT(0.2, 0.2), POINT(0.2, 0.2), POINT(0.3, 0.3)],
      },
    });
  });

  it("换了半径就另起一条；换对象各记各的", () => {
    const first = withEraseBatch(emptyFogReveal(), "map-1", [POINT(0.1, 0.1)]);
    const second = withEraseBatch(first, "map-1", [POINT(0.2, 0.2)], 0.1);

    expect(opsOf(second, "map-1")).toHaveLength(2);
    expect(opsOf(withEraseBatch(second, "map-2", [POINT(0.5, 0.5)]), "map-2")).toHaveLength(1);
    expect(opsOf(withEraseBatch(second, "map-2", [POINT(0.5, 0.5)]), "map-1")).toHaveLength(2);
  });
});

describe("战争雾记账：整区开关", () => {
  it("开 / 关都记，且与笔画**按顺序**排在一起", () => {
    const state = withRegion(
      withEraseBatch(emptyFogReveal(), "map-1", [POINT(0.1, 0.1)]),
      "map-1",
      8,
      true,
    );

    expect(opsOf(state, "map-1")).toEqual([
      {
        kind: "stroke",
        stroke: { radius: MASK_BRUSH_RATIO, softness: 1, points: [POINT(0.1, 0.1)] },
      },
      { kind: "region", region: 8, revealed: true },
    ]);

    // 关掉：跟在后面记一条——前端重放时它会盖掉这一区里之前擦掉的部分
    const closed = withRegion(state, "map-1", 8, false);
    expect(opsOf(closed, "map-1").at(-1)).toEqual({ kind: "region", region: 8, revealed: false });
  });

  it("同一个区连着记同一个状态是幂等的（不重复记账、不换引用）", () => {
    const state = withRegion(emptyFogReveal(), "map-1", 1, true);
    expect(withRegion(state, "map-1", 1, true)).toBe(state);

    // 换一个区 / 换一个状态照样记
    expect(opsOf(withRegion(state, "map-1", 2, true), "map-1")).toHaveLength(2);
    expect(opsOf(withRegion(state, "map-1", 1, false), "map-1")).toHaveLength(2);
  });
});

describe("战争雾记账：拖动中的分批", () => {
  it("抬手一定发（只要还有攒下的点）", () => {
    expect(shouldFlushBatch({ pendingPoints: 1, now: 0, lastSentAt: 0, done: true })).toBe(true);
    expect(shouldFlushBatch({ pendingPoints: 0, now: 0, lastSentAt: 0, done: true })).toBe(false);
  });

  it("攒够 4 个点就发；只有一个点时不发（等下一个点或抬手）", () => {
    expect(shouldFlushBatch({ pendingPoints: 4, now: 0, lastSentAt: 0, done: false })).toBe(true);
    expect(shouldFlushBatch({ pendingPoints: 1, now: 10_000, lastSentAt: 0, done: false })).toBe(false);
  });

  it("慢速拖动：距上次下发 150ms 且已攒下 2 个点以上就发", () => {
    expect(shouldFlushBatch({ pendingPoints: 2, now: 149, lastSentAt: 0, done: false })).toBe(false);
    expect(shouldFlushBatch({ pendingPoints: 2, now: 150, lastSentAt: 0, done: false })).toBe(true);
  });

  it("切批：留下的最后一个点会成为下一批的第一个点（接缝处不断）", () => {
    const pending = [POINT(0, 0), POINT(0.1, 0), POINT(0.2, 0)];

    expect(splitStrokeBatch(pending, false)).toEqual({
      sent: pending,
      pending: [POINT(0.2, 0)],
    });

    // 抬手：全发，一点不留
    expect(splitStrokeBatch(pending, true)).toEqual({ sent: pending, pending: [] });
  });

  it("只有一个点时不切出去（发了也是半截轨迹）", () => {
    expect(splitStrokeBatch([POINT(0, 0)], false)).toEqual({ sent: [], pending: [POINT(0, 0)] });
  });
});

describe("战争雾记账：前端连上补发", () => {
  it("只在「没连 → 连上」那一刻给补发计划", () => {
    const reveal = withEraseBatch(emptyFogReveal(), "map-1", [POINT(0.1, 0.1)]);

    expect(
      fogRevealResendPlan({ wasClientConnected: false, isClientConnected: true, reveal }),
    ).toEqual([{ objectId: "map-1", entry: entryOf(reveal, "map-1") }]);

    // 已经连着：不重复发（editor_state 到得很频繁）
    expect(
      fogRevealResendPlan({ wasClientConnected: true, isClientConnected: true, reveal }),
    ).toEqual([]);
    // 前端不在：没什么可发的
    expect(
      fogRevealResendPlan({ wasClientConnected: false, isClientConnected: false, reveal }),
    ).toEqual([]);
  });

  it("按当前文档筛掉已经没意义的对象（删了 / 不是地图 / 解绑了雾区）", () => {
    const reveal = withEraseBatch(
      withEraseBatch(emptyFogReveal(), "map-1", [POINT(0.1, 0.1)]),
      "gone",
      [POINT(0.2, 0.2)],
    );

    const pruned = pruneFogReveal(reveal, (objectId) => objectId === "map-1");
    expect(Object.keys(pruned.objects)).toEqual(["map-1"]);

    // 全都在时不动引用（省得每次补发都造一份新的）
    expect(pruneFogReveal(reveal, () => true)).toBe(reveal);
  });
});
