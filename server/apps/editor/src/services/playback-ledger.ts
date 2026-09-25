/**
 * 播放记账的**通用骨架**：声音（`sound-playback.ts`）与视频（`video-playback.ts`）两组共用。
 *
 * 它记的是「后台希望前端现在播什么」，**不写文档、不进撤销栈**（与 runtime 镜像一样属于
 * 运行态）。点「播放 / 暂停 / 继续 / 停止」只改这里 + **尽力**下发命令：
 * - 编辑器还没连上服务端（编辑态）或前端没连 → 只记账，写明白原因；
 * - 等**前端连上**的那一刻补发一次（`resendPlan`），所以「点的时候前端不在」也不会丢。
 *
 * 两组的差异只有三个：状态**外层的字段名**（声音是 `layers`、视频是 `objects`）、
 * **键的类型**（层级 slug vs 对象 id）、**条目内容**。全部交给本工厂的参数；
 * 两个调用方文件保留各自的条目类型与函数名（薄壳 re-export），调用点与测试都不动。
 *
 * 暂停是**记账里的一档状态**：补发时要「先播再暂停」，否则前端会从头开始播
 * （两组 UI 的控件行完全一致：播放 / 暂停 · 继续 / 停止）。
 *
 * 泛型里的类型断言集中在这一处（spread + 计算键组合不出精确的 `Record<K, E>`），
 * 调用方文件因此可以保持完全无断言。
 */

/** 记账状态：外层字段名 `F`（`layers` / `objects`）→ 键 → 条目。 */
type LedgerState<F extends string, K extends string, E> = Readonly<Record<F, Readonly<Record<K, E>>>>;

export interface PlaybackLedgerOps<F extends string, K extends string, E extends { readonly paused: boolean }> {
  /** 键不存在 = 这一槽应该是停着的。 */
  readonly empty: () => LedgerState<F, K, E>;
  /** 记下「这一槽要播这个」：同键再点别的就顶掉（与前端同键顶替一致）。 */
  readonly withPlaying: (state: LedgerState<F, K, E>, entry: Omit<E, "paused">) => LedgerState<F, K, E>;
  /** 没在记账里的键**什么都不做**（没播过就谈不上暂停）——返回原状态。 */
  readonly withPaused: (state: LedgerState<F, K, E>, key: K, paused: boolean) => LedgerState<F, K, E>;
  /** 记下「这一槽要停」：把那个键从记账里删掉。 */
  readonly withStopped: (state: LedgerState<F, K, E>, key: K) => LedgerState<F, K, E>;
  /**
   * **前端刚连上时要补发哪些条目**。
   *
   * 只在「之前没连 → 现在连上了」那一刻补，且每个键只补一条；
   * 已经连着的时候不重复发（`sync_state` / `editor_state` 快照到得很频繁，
   * 不能每来一张就重播一遍）。
   */
  readonly resendPlan: (input: {
    readonly wasClientConnected: boolean;
    readonly isClientConnected: boolean;
    readonly playback: LedgerState<F, K, E>;
  }) => readonly E[];
}

/**
 * 造一组记账操作。`field` 是状态外层的字段名（同时也是 TS 字面量类型，返回值形状跟着它走）；
 * `keyOf` 从条目里取出它归属的键（声音 = 层级，视频 = 对象 id）。
 */
export function createPlaybackLedger<
  const F extends string,
  K extends string,
  E extends { readonly paused: boolean },
>(input: {
  readonly field: F;
  readonly keyOf: (entry: Omit<E, "paused">) => K;
}): PlaybackLedgerOps<F, K, E> {
  const { field, keyOf } = input;
  type State = LedgerState<F, K, E>;

  return {
    empty: () => ({ [field]: {} }) as State,

    /** 记下「这一槽要播这个」：同键再点别的就顶掉（与前端同键顶替一致）。 */
    withPlaying: (state, entry) =>
      ({
        ...state,
        [field]: { ...state[field], [keyOf(entry)]: { ...entry, paused: false } },
      }) as State,

    withPaused: (state, key, paused) => {
      const existing = state[field][key];
      if (existing === undefined || existing.paused === paused) {
        return state;
      }

      return { ...state, [field]: { ...state[field], [key]: { ...existing, paused } } } as State;
    },

    withStopped: (state, key) => {
      if (state[field][key] === undefined) {
        return state;
      }

      const entries: Record<K, E> = { ...state[field] };
      delete entries[key];
      return { ...state, [field]: entries } as State;
    },

    resendPlan: ({ wasClientConnected, isClientConnected, playback }) => {
      if (wasClientConnected || !isClientConnected) {
        return [];
      }

      return Object.values(playback[field]);
    },
  };
}
