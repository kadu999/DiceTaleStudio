import { entryOf, type FogRevealState } from "./fog-reveal";

/**
 * 视频混合的**擦除记账**：与战争雾的揭示记账（`fog-reveal.ts`）**同一份实现**。
 *
 * 两者形状完全一样——「按对象 id 记一串**有序**的操作，前端连上时按同一顺序补发」，
 * 所以状态与批处理那几个函数都从那边原样借过来（读代码时不会误以为视频混合用了雾那套字段）。
 * 差别只在**有哪几档操作**：雾是 `stroke | region`（按区域位整片开合），
 * 视频混合是 `stroke | fill`（整张只有 1 / 0 两个状态）——`fill` 的那个构造器就住在这里。
 */
export type {
  FogRevealPoint as VideoBlendRevealPoint,
  FogRevealState as VideoBlendRevealState,
} from "./fog-reveal";

export {
  emptyFogReveal as emptyVideoBlendReveal,
  withEraseBatch as withVideoBlendEraseBatch,
  fogRevealResendPlan as videoBlendRevealResendPlan,
  pruneFogReveal as pruneVideoBlendReveal,
} from "./fog-reveal";

/**
 * 记下「**整张**遮罩盖住 / 擦开」（Mask 窗口右边那两个按钮）。
 *
 * 与雾的 `withRegion` 同一套：连着点同一个状态不必重复记（幂等）；不同状态**按顺序追加**，
 * 于是「擦一笔 → 整张盖住 → 再擦一笔」重放出来就是这三步的结果（盖住会抹掉它之前擦开的）。
 */
export function withVideoBlendFill(
  state: FogRevealState,
  objectId: string,
  covered: boolean,
): FogRevealState {
  const entry = entryOf(state, objectId);
  const last = entry.ops[entry.ops.length - 1];
  if (last !== undefined && last.kind === "fill" && last.covered === covered) {
    return state;
  }

  return {
    objects: {
      ...state.objects,
      [objectId]: { ops: [...entry.ops, { kind: "fill", covered }] },
    },
  };
}
