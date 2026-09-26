/**
 * 视频混合的**擦除记账**：与战争雾的揭示记账（`fog-reveal.ts`）**同一份实现**。
 *
 * 两者形状完全一样——「按对象 id 记一串**有序**的擦除笔画，前端连上时按同一顺序补发」，
 * 所以这里只做名字上的别名（读代码时不会误以为视频混合用了雾那套字段），没有第二份逻辑。
 * 视频混合没有「整区开合」那一档（它没有区域位），只用得到笔画那几个函数。
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
