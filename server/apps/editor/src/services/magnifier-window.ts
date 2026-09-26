/**
 * 放大镜的**窗口记账**：编辑器记着「前端那扇放大镜窗现在为哪个对象开着」。
 *
 * 与 `soundPlayback` / `bgmPlayback` 同一档：**不写文档、不进撤销栈**（运行态）。
 * 它只记**一个对象 id**（前端的窗全场只有一扇，`UIManager` 一个类型一个实例），
 * 开 / 关各一条命令（`open_magnifier` / `close_magnifier`）：
 * - 编辑器还没连上服务端或前端不在 → 只记账，写明白原因；
 * - 等**前端连上**的那一刻补发一次，所以「开的时候前端不在」也不会丢（重开 Unity 也能补回来）。
 *
 * **换图不在这份记账里**：展示哪一张是**文档数据**（`magnifier.picked`）——运行态下文档一改
 * 就整份 `scene_push` 下去，前端跟着换。所以「换图」没有命令，也就没有需要补发的状态。
 */

/**
 * **前端刚连上时要补发的窗口**（`null` / 之前就连着 → 一条都不发）。
 *
 * 只在「之前没连 → 现在连上了」那一刻补（与 `fogRevealResendPlan` 同一条规矩）：
 * 已经连着的时候不重复发，否则 `editor_state` 每来一份都会重开一次窗。
 */
export function magnifierWindowResendPlan(input: {
  readonly wasClientConnected: boolean;
  readonly isClientConnected: boolean;
  readonly shown: string | null;
}): readonly string[] {
  if (input.wasClientConnected || !input.isClientConnected || input.shown === null) {
    return [];
  }

  return [input.shown];
}
