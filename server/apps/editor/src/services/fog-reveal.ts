import { MASK_BRUSH_RATIO, MASK_BRUSH_SOFTNESS } from "./mask-math";

/**
 * 战争雾的**揭示记账**：编辑器记着「这一次运行里，已经让前端揭示了什么」。
 *
 * 它是「后台希望前端现在是什么样」，**不写文档、不进撤销栈**（与 `soundPlayback`、`runtime` 一样
 * 属于运行态）。Mask 窗口里擦一笔 / 拨一个整区开关，就**尽力**下发一条命令：
 * - 编辑器还没连上服务端或前端不在 → 只记账，写明白原因；
 * - 等**前端连上**的那一刻补发一次，所以「擦的时候前端不在」也不会丢（重开 Unity 也能补回来）。
 *
 * 记的是**有序的操作**（擦一笔 / 整区开合），不是一张位图：前端按同一顺序重放，得到的遮罩与
 * 编辑器预览一致——包括「整区盖回」会把这一区里之前擦掉的部分一起盖掉。这也是为什么命令里
 * 只发轨迹（见 `@dts/protocol` 的 `eraseStrokeSchema`）：两边各算一遍，省掉几 MB 的位图。
 */

/** 轨迹上的一个点：归一化 `[0,1]`、**y 向下**（与 Mask 窗口画布一致）。 */
export interface FogRevealPoint {
  readonly x: number;
  readonly y: number;
}

/** 一笔擦除（一次拖动）。拖动中是分批下发的，记账里**并成一条**——补发时要的是完整轨迹。 */
export interface FogRevealStroke {
  /** 归一化半径（半径 / 遮罩宽），见 `MASK_BRUSH_RATIO`。 */
  readonly radius: number;
  /** 软边带比例（0=硬边、1=全程衰减），见 `MASK_BRUSH_SOFTNESS`。 */
  readonly softness: number;
  readonly points: readonly FogRevealPoint[];
}

/**
 * 一次操作。**有序**：
 * 「整区盖回」/「整张盖住」要盖掉它**之前**擦掉的部分，所以不能只记「最后是什么样」。
 *
 * 三个变体分属两个宿主（共用这一份是因为骨架完全一样）：
 * - `stroke`：两边都用——擦一笔；
 * - `region`：只有**战争雾**用——按区域位整片开合；
 * - `fill`：只有**视频混合**用——整张填成 1 / 0（它没有区域位，整张就两个状态）。
 */
export type FogRevealOp =
  | { readonly kind: "stroke"; readonly stroke: FogRevealStroke }
  | { readonly kind: "region"; readonly region: number; readonly revealed: boolean }
  | { readonly kind: "fill"; readonly covered: boolean };

/** 一个地图对象的揭示记录（按对象 id 记：一张地图一层雾，互不影响）。 */
export interface FogRevealEntry {
  readonly ops: readonly FogRevealOp[];
}

export interface FogRevealState {
  /** key = 地图对象 id；没有这个 key = 这个对象还没被揭示过。 */
  readonly objects: Readonly<Record<string, FogRevealEntry>>;
}

/** 拖动中一批攒够这么多点就发一次（避免一条命令一个指针事件）。 */
export const FOG_ERASE_BATCH_POINTS = 4;

/** 拖动中距上次下发超过这么久也发一次（慢速拖动时也能边拖边看）。 */
export const FOG_ERASE_BATCH_MS = 150;

export function emptyFogReveal(): FogRevealState {
  return { objects: {} };
}

/** 一个对象现有的记录（没有就返回空记录）。 */
export function entryOf(state: FogRevealState, objectId: string): FogRevealEntry {
  return state.objects[objectId] ?? { ops: [] };
}

/**
 * 记下「这一批点擦过了」。
 *
 * **同一笔的相邻批次并成一条**（上一条也是这个对象的笔画时直接往后接点）：补发要的是完整轨迹，
 * 一条命令一条轨迹才对得上；分开记会让「补发」变成一串碎笔画。
 */
export function withEraseBatch(
  state: FogRevealState,
  objectId: string,
  points: readonly FogRevealPoint[],
  radius: number = MASK_BRUSH_RATIO,
  softness: number = MASK_BRUSH_SOFTNESS,
): FogRevealState {
  if (points.length === 0) {
    return state;
  }

  const entry = entryOf(state, objectId);
  const last = entry.ops[entry.ops.length - 1];
  const ops: readonly FogRevealOp[] =
    last !== undefined &&
    last.kind === "stroke" &&
    last.stroke.radius === radius &&
    last.stroke.softness === softness
      ? [
          ...entry.ops.slice(0, -1),
          { kind: "stroke", stroke: { ...last.stroke, points: [...last.stroke.points, ...points] } },
        ]
      : [...entry.ops, { kind: "stroke", stroke: { radius, softness, points: [...points] } }];

  return { objects: { ...state.objects, [objectId]: { ops } } };
}

/** 记下「整区揭示 / 整区盖回」。同一区连点两次同一个状态时不必重复记（幂等）。 */
export function withRegion(
  state: FogRevealState,
  objectId: string,
  region: number,
  revealed: boolean,
): FogRevealState {
  const entry = entryOf(state, objectId);
  const last = entry.ops[entry.ops.length - 1];
  if (last !== undefined && last.kind === "region" && last.region === region && last.revealed === revealed) {
    return state;
  }

  return {
    objects: {
      ...state.objects,
      [objectId]: { ops: [...entry.ops, { kind: "region", region, revealed }] },
    },
  };
}

/**
 * 拖动中要不要把攒下的点发出去。
 *
 * 抬手（`done`）一定发；否则攒够 {@link FOG_ERASE_BATCH_POINTS} 个点、或距上次下发
 * {@link FOG_ERASE_BATCH_MS} 毫秒就发一批——参考实现是每个指针事件都发一条，
 * 我们这边每条命令都有回执与运行日志，节流一下才不会把日志刷屏。
 */
export function shouldFlushBatch(input: {
  readonly pendingPoints: number;
  readonly now: number;
  readonly lastSentAt: number;
  readonly done: boolean;
}): boolean {
  if (input.done) {
    return input.pendingPoints > 0;
  }

  if (input.pendingPoints >= FOG_ERASE_BATCH_POINTS) {
    return true;
  }

  return input.pendingPoints > 1 && input.now - input.lastSentAt >= FOG_ERASE_BATCH_MS;
}

/**
 * 把攒下的点切成「这一批要发的」与「留下的」。
 *
 * **留下的最后一个点会成为下一批的第一个点**：相邻两批共享一个落点，前端沿着每批的相邻点连线
 * 打点时才不会在批次接缝处漏掉一段（不然拖动轨迹上会出现一格一格的断点）。
 * 只有一个点时不必发（`sent` 为空，等下一个点或抬手）：单独一个点也算一笔，但那由抬手那批负责。
 */
export function splitStrokeBatch(
  pending: readonly FogRevealPoint[],
  flushAll: boolean,
): { readonly sent: readonly FogRevealPoint[]; readonly pending: readonly FogRevealPoint[] } {
  if (flushAll) {
    return { sent: pending, pending: [] };
  }

  if (pending.length <= 1) {
    return { sent: [], pending };
  }

  return { sent: pending, pending: [pending[pending.length - 1] as FogRevealPoint] };
}

/**
 * **前端刚连上时要补发哪些对象**。
 *
 * 只在「之前没连 → 现在连上了」那一刻补（与 `soundPlaybackResendPlan` 同一条规矩）：
 * 已经连着的时候不重复发，否则 `editor_state` 每来一份都会把整段轨迹重放一遍。
 */
export function fogRevealResendPlan(input: {
  readonly wasClientConnected: boolean;
  readonly isClientConnected: boolean;
  readonly reveal: FogRevealState;
}): readonly { readonly objectId: string; readonly entry: FogRevealEntry }[] {
  if (input.wasClientConnected || !input.isClientConnected) {
    return [];
  }

  return Object.entries(input.reveal.objects).map(([objectId, entry]) => ({ objectId, entry }));
}

/**
 * 送之前按**当前文档**筛掉已经没意义的记录：对象被删了、不再是地图、开关关着、或解绑了雾区。
 *
 * 不筛的话补发会发一堆注定失败的命令，运行日志里全是「镜像里没有这个对象」。
 * （开关关掉时前端那一层雾已经被拆了，记着的揭示自然也没了去处——与「解绑了雾区」同一档。）
 */
export function pruneFogReveal(
  state: FogRevealState,
  isRevealable: (objectId: string) => boolean,
): FogRevealState {
  const objects: Record<string, FogRevealEntry> = {};
  let dropped = false;

  for (const [objectId, entry] of Object.entries(state.objects)) {
    if (isRevealable(objectId)) {
      objects[objectId] = entry;
    } else {
      dropped = true;
    }
  }

  return dropped ? { objects } : state;
}
