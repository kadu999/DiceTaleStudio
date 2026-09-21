/**
 * 视频的**期望播放状态**：编辑器记账「哪个对象现在应该放什么视频」。
 *
 * 与声音的记账（`sound-playback.ts`）同一套思路，但**按对象记**而不是按层级：
 * 视频挂在对象自己身上，每个对象各自一条、互不影响（地图放着背景视频时，精灵也能同时放）。
 *
 * 它是「后台希望前端现在放什么」，**不写文档、不进撤销栈**（与 `runtime` 镜像一样属于运行态）。
 * 点「播放 / 暂停 / 停止」只改这里 + **尽力**下发命令：
 * - 编辑器还没连上服务端（编辑态）或前端没连 → 只记账，写明白原因；
 * - 等**前端连上**的那一刻补发一次，所以「点的时候前端不在」也不会丢。
 * - 暂停是**记账里的一档状态**：补发时先 `play_video` 再 `pause_video`，前端回到同一帧。
 */

/** 一个对象「期望播放」的内容。 */
export interface VideoPlaybackEntry {
  readonly objectId: string;
  /**
   * 下发时的**视频快照**（对象后来换视频 / 被删也看得出当时放的是什么）；
   * 前端真正放的仍是镜像里 `video.picked` 那一条——命令只是触发器。
   */
  readonly clip: string;
  /** 下发时的循环 / 声音开关快照（面板上那份是文档数据，这里留一份便于日志与诊断）。 */
  readonly loop: boolean;
  readonly audio: boolean;
  /** 暂停态：补发时要「先放再暂停」，否则前端会从头开始放。 */
  readonly paused: boolean;
}

export interface VideoPlaybackState {
  /** key = 对象 id；**没有这个 key** = 这个对象应该是停着的。 */
  readonly objects: Readonly<Record<string, VideoPlaybackEntry>>;
}

export function emptyVideoPlayback(): VideoPlaybackState {
  return { objects: {} };
}

/** 记下「这个对象要放这个」（同一个对象再点别的就顶掉：一个对象一次只放一条）。 */
export function withVideoPlaying(
  state: VideoPlaybackState,
  entry: Omit<VideoPlaybackEntry, "paused">,
): VideoPlaybackState {
  return { objects: { ...state.objects, [entry.objectId]: { ...entry, paused: false } } };
}

/**
 * 记下暂停 / 继续。
 *
 * 没在记账里的对象**什么都不做**（没播过就谈不上暂停）——返回原状态，
 * 于是调用方可以据此判断「这次点按有没有意义」。
 */
export function withVideoPaused(
  state: VideoPlaybackState,
  objectId: string,
  paused: boolean,
): VideoPlaybackState {
  const entry = state.objects[objectId];
  if (entry === undefined || entry.paused === paused) {
    return state;
  }

  return { objects: { ...state.objects, [objectId]: { ...entry, paused } } };
}

/** 记下「这个对象要停」：把它从记账里删掉。 */
export function withVideoStopped(state: VideoPlaybackState, objectId: string): VideoPlaybackState {
  if (state.objects[objectId] === undefined) {
    return state;
  }

  const objects = { ...state.objects };
  delete objects[objectId];
  return { objects };
}

/**
 * **前端刚连上时要补发哪些对象**。
 *
 * 只在「之前没连 → 现在连上了」那一刻补，且每个对象只补一条（一个对象一次只放一条）；
 * 已经连着的时候不重复发（`editor_state` 快照到得很频繁，不能每来一张就重放一遍）。
 */
export function videoPlaybackResendPlan(input: {
  readonly wasClientConnected: boolean;
  readonly isClientConnected: boolean;
  readonly playback: VideoPlaybackState;
}): readonly VideoPlaybackEntry[] {
  if (input.wasClientConnected || !input.isClientConnected) {
    return [];
  }

  return Object.values(input.playback.objects);
}
