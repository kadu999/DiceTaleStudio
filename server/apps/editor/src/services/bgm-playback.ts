/**
 * 全局背景音乐的**期望播放状态**：编辑器记账「现在该放哪一首、暂停了没有」。
 *
 * 与声音 / 视频那两份记账（`sound-playback` / `video-playback`）是同一个思路——运行态、
 * 不写文档、不进撤销栈，点下去只改这里 + **尽力**下发命令；前端不在时等它连上补发。
 * 三者的差别在**归属**：
 * - 声音：按**层级**记（同层只响一条）；
 * - 视频：按**对象**记（每个对象各自一条）；
 * - 背景音乐：**全局一条**——不在任何对象上，也不在项目设置里（v16 起）：
 *   曲目清单**就是项目 `Assets/audio/` 下的音频文件**，弹框里点一首就发 `play_bgm{clip}`。
 *
 * ## 为什么这里只有「哪一首 + 暂停没有」
 *
 * v16 之前这里还有 `auto`（跟着项目设置里的默认曲走）与签名去重——那是「背景音乐属于项目设置」
 * 带来的复杂度。现在播放只有一种来源（DM 点了哪一首），所以状态就两件事：
 * - `clip === null`：没在放（还没点过、或点了停止）；
 * - `paused`：暂停在第几帧由前端管，编辑器只记「它是暂停着的」。
 *
 * 前端（重）连上时按这份记账补发一次：先 `play_bgm{clip}`，暂停态再补一条 `pause_bgm`
 * （只发暂停的话前端根本没在放，回到同一帧就无从谈起——与视频那边同一个口径）。
 */

export interface BgmPlaybackState {
  /** 现在应在放的那一首（资源逻辑 ID）；`null` = 没在放。 */
  readonly clip: string | null;
  /** 是不是暂停着的（前端记帧；这里只记这件事）。 */
  readonly paused: boolean;
}

/** 缺省：什么都没放（进运行态时就是这样，**不会自动出声**）。 */
export function emptyBgmPlayback(): BgmPlaybackState {
  return { clip: null, paused: false };
}

/** 记下「现在放这一首」（DM 点了弹框里的某一行；同一首再来一次 = 从头重播）。 */
export function withBgmPlaying(_state: BgmPlaybackState, clip: string): BgmPlaybackState {
  return { clip, paused: false };
}

/**
 * 记下暂停 / 继续。
 *
 * 没在放的（`clip === null`）**什么都不做**——编辑器不知道前端此刻手里是什么，
 * 也就谈不上「暂停哪一首」；调用方据此把按钮禁掉或忽略这次点按（与 `withVideoPaused` 同一套）。
 */
export function withBgmPaused(state: BgmPlaybackState, paused: boolean): BgmPlaybackState {
  if (state.clip === null || state.paused === paused) {
    return state;
  }

  return { clip: state.clip, paused };
}

/** 记下「停掉」（DM 明确按了停止）：回到「什么都没放」。 */
export function withBgmStopped(state: BgmPlaybackState): BgmPlaybackState {
  return state.clip === null && !state.paused ? state : emptyBgmPlayback();
}

/** 要下发给前端的动作（都是协议里的 `*_bgm` 命令）。 */
export type BgmAction =
  | { readonly kind: "play"; readonly clip: string }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "stop" };

/** 前端刚连上时要补发的东西（`null` = 现在没什么要补的）。 */
export interface BgmResend {
  readonly clip: string;
  readonly paused: boolean;
}

/**
 * **前端刚连上时要补发哪一首**。
 *
 * 只在「之前没连 → 现在连上了」那一刻补，且只补记账里的那一首；
 * 已经连着的时候不重复发（`sync_state` 快照到得很频繁，不能每来一张就重播一遍）。
 * 没在放（`clip === null`，或 DM 点过停止）就什么都不补——前端是干净的，无需求。
 */
export function bgmResendPlan(input: {
  readonly wasClientConnected: boolean;
  readonly isClientConnected: boolean;
  readonly playback: BgmPlaybackState;
}): BgmResend | null {
  if (input.wasClientConnected || !input.isClientConnected || input.playback.clip === null) {
    return null;
  }

  return { clip: input.playback.clip, paused: input.playback.paused };
}

/** 补发要发的命令（暂停态 = 先放再暂停，前端因此回到同一帧）。 */
export function bgmResendActions(plan: BgmResend): readonly BgmAction[] {
  return plan.paused
    ? [
        { kind: "play", clip: plan.clip },
        { kind: "pause" },
      ]
    : [{ kind: "play", clip: plan.clip }];
}
