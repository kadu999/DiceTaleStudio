/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * **闭包状态与局部工具**：所有切片共享的那一份（`createStoreContext(set, get)`）。
 */
import {
  DEFAULT_SLOT_COMPONENT,
  supportsObjectComponent,
  createAssetMetas,
  mapDataOf,
  serializeAssetMetaFile,
  videoBlendDataOf,
  videoDataOf,
  SOUND_LAYER_LABELS,
  fogOf,
  isFogEnabled,
  isVideoEnabled,
  type AssetMetas,
  type ComponentType,
  type ProjectDoc,
  type ProjectSettingsDoc,
  type SceneDoc,
  type SceneListDraft,
  type GameObjectDoc,
  type SoundLayer,
} from "@dts/document";
import { type Viewport } from "@dts/renderer";
import type { ScenePayload } from "@dts/protocol";
import {
  RuntimeClient,
  type RuntimeLogEntry,
  type RuntimeStateSnapshot,
} from "../services/runtime-client";
import {
  ScenePushScheduler,
  projectSettingsPayloadText,
  scenePayloadOf,
  scenePayloadText,
  shouldPushScene,
} from "../services/runtime-push";
import {
  bgmResendActions,
  bgmResendPlan,
  emptyBgmPlayback,
  type BgmAction,
} from "../services/bgm-playback";
import {
  readGridPaintPrefs,
  writeGridPaintPrefs,
  type GridPaintPrefs,
} from "../services/grid-paint-prefs";
import {
  emptySoundPlayback,
  soundPlaybackResendPlan,
  type SoundPlaybackEntry,
} from "../services/sound-playback";
import { emptyVideoPlayback, videoPlaybackResendPlan } from "../services/video-playback";
import {
  emptyVideoBlendPlayback,
  videoBlendPlaybackResendPlan,
} from "../services/video-blend-playback";
import { emptyFogReveal, fogRevealResendPlan, type FogRevealPoint } from "../services/fog-reveal";
import {
  emptyVideoBlendReveal,
  videoBlendRevealResendPlan,
} from "../services/video-blend-reveal";
import { MASK_BRUSH_RATIO, MASK_BRUSH_SOFTNESS, VIDEO_BLEND_MASK_SOFTNESS } from "../services/mask-math";
import { type StoreSet, type StoreGet, type AssetMetaTable, type GridPaintState, type EditorStoreState } from "./store-types";
import {
  sceneHistory,
  projectHistory,
  metaHistory,
  activeTrack,
  historyOf,
  EDIT_TRACKS,
  makeLog,
  MAX_LOGS,
  SCENE_SAVE_DEBOUNCE_MS,
  findSceneByName,
  serializeSceneFile,
  serializeProjectFile,
} from "./store-core";

/**
 * `create()` 里的**闭包状态与局部工具**：切片拿不到它们，所以统一从这里取。
 *
 * 这里**只放非 action 的东西**——store action 一律不进 ctx，切片之间互相调用走
 * `get().xxx()`。
 */
export interface StoreContext {
  /** 把运行态日志追加进 store（保留最近 MAX_LOGS 条）。 */
  pushLog(entry: RuntimeLogEntry): void;
  /** 当前打开的场景（`activeSceneName` 对应的那份）；没打开就是 null。 */
  currentSceneDoc(): SceneDoc | null;
  /** 与服务端的连接（配置在创建时一次给全）。 */
  readonly runtimeClient: RuntimeClient;
  /** 场景推送的去抖通道。 */
  readonly pushScheduler: ScenePushScheduler;
  /** 立刻推一份全量场景（进运行态、重连补发用）。 */
  pushSceneNow(): void;
  /** 文档变了就安排一次推送。 */
  scheduleRuntimePush(): void;
  /** 当前项目的全局设置（没打开项目 = null）。 */
  currentSettingsOf(): ProjectSettingsDoc | null;
  /** 全局设置的推送通道。 */
  readonly settingsScheduler: ScenePushScheduler;
  /** 立刻推一份设置（进运行态、重连补发用）。 */
  pushSettingsNow(): void;
  /** 设置变了就安排一次推送。 */
  scheduleSettingsPush(): void;
  /** 把一条「这一层该播什么」尽力发给前端。 */
  deliverSoundPlay(entry: Omit<SoundPlaybackEntry, "paused">): string | undefined;
  /** 把一条**按层级**的声音命令（停止 / 暂停 / 继续）尽力发给前端。 */
  deliverSoundControl(
    kind: "stop_sound" | "pause_sound" | "resume_sound",
    layer: SoundLayer,
    what: string,
  ): string | undefined;
  /** 找出「能揭示战争雾」的对象（找不到就写日志并返回 null）。 */
  fogTargetOf(objectId: string, what: string): GameObjectDoc | null;
  /** 这个对象**现在**还能揭示雾吗（与 `fogTargetOf` 同口径，但不写日志）。 */
  canRevealFog(objectId: string): boolean;
  /** 这张贴图**现在**还能擦混合遮罩吗（与 `videoBlendTargetOf` 同口径，但不写日志）。 */
  canRevealVideoBlend(objectId: string): boolean;
  /** 找出「能放视频」的对象（找不到就写日志并返回 null）。 */
  videoTargetOf(objectId: string, what: string): GameObjectDoc | null;
  /** 找出「能混合放视频」的对象（找不到就写日志并返回 null）。 */
  videoBlendTargetOf(objectId: string, what: string): GameObjectDoc | null;
  /** 按 id 找当前场景里的对象。 */
  findObjectById(objectId: string): GameObjectDoc | undefined;
  /**
   * 对**当前场景**做一次可撤销编辑（`applyScenes` 的「当前场景」版）。
   *
   * 没有当前场景（`activeSceneName` 为 null，或场景列表里暂时没有它）时返回 false、
   * 不进撤销栈；有就把 `recipe` 用在那个场景的 draft 上。包装只覆盖这段公共尾部——
   * 各调用的前后检查（对象在不在 / 改完关不关窗口）仍留在切片里。
   */
  applyActiveScene(
    label: string,
    recipe: (scene: SceneListDraft[number]) => boolean | void,
    options?: { coalesceKey?: string },
  ): boolean;
  /** 找一个**带某个特性**的对象（不写日志）。 */
  objectWithFeature(objectId: string, component: string): GameObjectDoc | undefined;
  /** 找一个**声音对象**；找不到就写一条日志。 */
  requireSoundObject(objectId: string): GameObjectDoc | undefined;
  /** 找一个**传送阵**；找不到就写一条日志。 */
  requireTeleportObject(objectId: string): GameObjectDoc | undefined;
  /** 把一条视频命令**尽力**发给前端。 */
  deliverVideo(
    kind: "play_video" | "pause_video" | "resume_video" | "stop_video",
    objectId: string,
    label: string,
    quiet?: boolean,
  ): string | undefined;
  /** 把一批轨迹**尽力**发给前端。 */
  deliverFogErase(objectId: string, points: readonly FogRevealPoint[]): string | undefined;
  /** 把一批混合遮罩的擦除轨迹**尽力**发给前端。 */
  deliverVideoMaskErase(objectId: string, points: readonly FogRevealPoint[]): string | undefined;
  /** 前端在不在（编辑器连着服务端 **且** 前端连着）。 */
  frontendReady(): boolean;
  /** 背景音乐动作在运行日志里的说法。 */
  bgmActionLabel(action: BgmAction): string;
  /** 真发一条背景音乐命令（调用方负责确认前端连着）。 */
  sendBgmAction(action: BgmAction): string | undefined;
  /** 把一条背景音乐动作**尽力**发给前端。 */
  deliverBgm(action: BgmAction): string | undefined;
  /** 把记账里的背景音乐补发一遍。 */
  flushBgm(): number;
  /** 同步 `scenes` / `doc` 与撤销、重做标记。 */
  syncHistoryFlags(): void;
  /** 拍下当前文档作为运行基线（不动状态、不记日志）。 */
  snapshotRunBaseline(): void;
  /** 进入运行态：记下快照，并让底栏显示「运行中（不保存）」。 */
  rememberRunBaseline(): void;
  /** 文档被**整份换掉**时把运行基线跟着换。 */
  refreshRunBaseline(): void;
  /** 退出运行态：整体还原到进入运行前的样子。 */
  restoreRunBaseline(): void;
  /** 内存里的工程文件与磁盘不一致（有未保存的全局设置改动）。 */
  projectDirty(): boolean;
  /** 内存里与磁盘不一致的场景名（顺序与 scenes 一致）。 */
  dirtySceneNames(): string[];
  /** 内存里与磁盘不一致的素材 meta 的**路径 ID**（只写这几份）。 */
  metaDirtyIds(): string[];
  /** 有改动就延迟回写场景文件。 */
  scheduleSceneSave(): void;
  /** 有改动就延迟回写**工程文件**。 */
  scheduleProjectSave(): void;
  /** 有改动就延迟回写**素材 meta**（每份一个文件，只写内容变了的那些）。 */
  scheduleMetaSave(): void;
  /** 取消待写的场景落盘定时器（切片里手动保存 / flush 时用）。 */
  clearSceneSaveTimer(): void;
  /** 取消待写的工程文件落盘定时器。 */
  clearProjectSaveTimer(): void;
  /** 取消待写的素材 meta 落盘定时器。 */
  clearMetaSaveTimer(): void;
  /** 标注偏好的落盘（画笔类型 / 大小 / 每类的显示与颜色）。 */
  persistGridPaint(gridPaint: GridPaintState): void;
  /** **切场景的唯一路径**。 */
  switchScene(
    name: string | null,
    options?: { readonly clearAssetSelection?: boolean; readonly log?: boolean },
  ): void;

  /** 上次**真的推出去**的场景文本（去重与「补发全量」都靠它）。 */
  lastPushedSceneText: string | null;
  /** 用户点过「运行」、但那一刻还没连上服务端；`onOpen` 消费一次。 */
  pendingRunRequest: boolean;
  /** 用户有没有自己调过视口（平移 / 缩放 / 适配）。 */
  viewportAdjusted: boolean;
  /** 启动引导是否正在跑（同步占位，挡住 StrictMode 的第二次 effect）。 */
  bootstrapping: boolean;
  /** 上次成功写盘的**工程文件**文本；null = 还没装载过（或刚换过文档）。 */
  savedProjectText: string | null;

  /** 上次成功写盘时的场景内容（场景名 → 序列化文本）。 */
  readonly savedScenes: Map<string, string>;
  /**
   * 上次成功写盘时的**素材 meta**（素材路径 ID → 序列化文本）。
   *
   * 与 `savedScenes` 同一个用途：按内容差异算出「哪几份 meta 真的变了」——
   * meta 是一素材一个文件，比整表更省事（切一张图只写那一份，别的素材一个字节都不动）。
   */
  readonly savedMetas: Map<string, string>;
  /** 每个场景上次的视口（**只在本次会话里记住**，不落盘）。 */
  readonly sceneViewports: Map<string, Viewport>;
  /** 读回来的网格标注偏好（初始状态用）。 */
  readonly storedGridPaint: GridPaintPrefs;
  /** 「成功的回执不用写日志」的命令 id：战争雾拖动中的那些批次。 */
  readonly quietCommandIds: Set<string>;
}

export function createStoreContext(set: StoreSet, get: StoreGet): StoreContext {
  /** 把运行态日志追加进 store（保留最近 MAX_LOGS 条）。 */
  const pushLog = (entry: RuntimeLogEntry): void => {
    set((state) => ({
      runtime: { ...state.runtime, logs: [...state.runtime.logs, entry].slice(-MAX_LOGS) },
    }));
  };

  /** 当前打开的场景（`activeSceneName` 对应的那份）；没打开就是 null。 */
  const currentSceneDoc = (): SceneDoc | null =>
    findSceneByName(get().scenes, get().activeSceneName) ?? null;

  /** 上次**真的推出去**的场景文本（去重与「补发全量」都靠它）。 */
  let lastPushedSceneText: string | null = null;

  /**
   * 用户点过「运行」、但那一刻还没连上服务端（服务端在重启 / 网线刚插上）。
   *
   * `runtime_start` 要等连接可用才能发，所以先把这份**意图**记下来、`onOpen` 消费一次——
   * 不记的话日志里答应过的「连上后自动进入运行态」永远等不到。
   */
  let pendingRunRequest = false;

  /**
   * 「成功的回执不用写日志」的命令 id：战争雾拖动中的那些批次。
   *
   * 拖动中一条命令一批（攒够 4 个点或 150ms 一批），成功回执要是每条都写一行，运行日志会被刷屏。
   * **失败照写**（不静默失败）；回执或错误回来时就把它从集合里去掉，不会越攒越多。
   */
  const quietCommandIds = new Set<string>();

  const runtimeClient = new RuntimeClient({
    onStatus: (status, detail) => {
      set((state) => ({
        runtime: {
          ...state.runtime,
          status,
          // 自己没连着服务端时「前端在不在」无从得知：别留一个过期的「已连接」，
          // 也让「前端刚连上 → 补发」这条判断只在真的连上之后成立。
          // **运行态不动**：它是服务端的门控状态，断线不等于关闸——清零会让「运行中的改动不保存」
          // 当场失效（运行期间的改动会被当成编辑态的改动写进文件），退出运行的还原也丢了。
          ...(status === "open" ? {} : { client: null, scene: null }),
        },
      }));

      if (status === "open") {
        pushLog(makeLog("info", `已连接服务端${detail === undefined ? "" : ` ${detail}`}`));
      } else if (status === "closed") {
        // **一定带上原因**：服务端在 close reason 里写明了为什么踢人（协议版本不一致最常见），
        // 只写「断开，正在尝试重连」会让人对着重连风暴无从下手（见 `describeSocketClose`）
        pushLog(makeLog("warn", `与服务端断开：${detail ?? "原因不明"}，正在尝试重连`));
      } else if (status === "error") {
        pushLog(makeLog("error", detail ?? "连接出错"));
      }

      // 断开服务端 = 手上这份「上次推出去的是什么」不再可信（服务端可能重启过、场景缓存已空）。
      // 清掉它，重连后即便场景内容一个字没变也会真的重推一次，而不是被去重跳过、
      // 让前端停在 `scene_sync: null`（空场景）。
      if (status !== "open") {
        lastPushedSceneText = null;
      }
    },

    onState: (snapshot: RuntimeStateSnapshot) => {
      const wasClientConnected = get().runtime.client !== null;
      const wasRuntimeActive = get().runtime.runtimeActive;

      // **运行态由服务端说了算**：界面上的编辑/运行跟着它走（刷新页面后服务端还记着在运行，
      // 这里就会自动切回运行态，而不是把前端踢掉）。
      // 注意**不**在这里展开运行面板：面板展开会改变布局，而这是「跟着服务端状态走」的被动同步；
      // 主动点「运行」时才展开（见 setMode）。
      set((state) => ({
        mode: snapshot.runtimeActive ? "run" : "edit",
        runtime: {
          ...state.runtime,
          runtimeActive: snapshot.runtimeActive,
          client: snapshot.client,
          scene: snapshot.scene,
          resources: snapshot.resources,
          settings: snapshot.settings,
        },
      }));

      // 服务端开着运行态，手上却没有基线（连上时它就已经开着）→ 现在这份文档就是「运行前的样子」
      if (snapshot.runtimeActive && runBaseline === null) {
        rememberRunBaseline();
      }

      // 刚开闸（真的从「编辑」切过来）→ 把当前场景与全局设置整份补过去。
      // 只在「false → true」这一跳推，避免 scene_push 引发的状态广播把自己推进死循环
      // （内容没变的第二次推送会被 shouldPushScene / 签名去重掉）。
      if (snapshot.runtimeActive && !wasRuntimeActive) {
        pushSettingsNow();
        get().pushRuntimeScene();
      }

      // 关闸 → 还原到进入运行前的样子（对齐 Unity：退出播放模式丢掉运行期间的改动）
      if (!snapshot.runtimeActive && wasRuntimeActive) {
        restoreRunBaseline();
        // 服务端侧的「上次推出去的场景」也跟着没了（它重启过 / 清过缓存）：清掉基线文本，
        // 用户再点「运行」时一定会重推一份，不会被 `shouldPushScene` 的去重跳过。
        lastPushedSceneText = null;
        // 揭示记账也是运行态：关闸就清掉（前端已经被踢下线，下次运行重新开始）
        set({
          fogReveal: emptyFogReveal(),
          videoBlendReveal: emptyVideoBlendReveal(),
          videoPlayback: emptyVideoPlayback(),
          videoBlendPlayback: emptyVideoBlendPlayback(),
        });
        // 背景音乐同理：回到「什么都没放」（下次进运行态**不会自动出声**，由 DM 点一首）
        set({ bgmPlayback: emptyBgmPlayback() });
      }

      // 前端刚连上：把「点的时候它不在」记下的期望状态补发一遍（声音 / 视频 / 雾 / 音乐
      // 同一段骨架：有计划就 flush）。判据的差异保留——前三个看「计划非空」，音乐的
      // 「没放」是 null（期望「什么都没放」时一条都不发）。
      const clientConnected = snapshot.client !== null;
      const resendOnReconnect = (needsResend: boolean, flush: () => number): void => {
        if (needsResend) {
          flush();
        }
      };

      // 声音：这一层该响什么（补发时逐条写日志，所以这里不重复记）
      resendOnReconnect(
        soundPlaybackResendPlan({
          wasClientConnected,
          isClientConnected: clientConnected,
          playback: get().soundPlayback,
        }).length > 0,
        () => get().flushSoundPlayback(),
      );

      // 视频：按对象补发（暂停态的先放再暂停）
      resendOnReconnect(
        videoPlaybackResendPlan({
          wasClientConnected,
          isClientConnected: clientConnected,
          playback: get().videoPlayback,
        }).length > 0,
        () => get().flushVideoPlayback(),
      );

      // 视频混合：同一套（按对象补发；前端见 `VideoBlend` 就同时起停两条通道）
      resendOnReconnect(
        videoBlendPlaybackResendPlan({
          wasClientConnected,
          isClientConnected: clientConnected,
          playback: get().videoBlendPlayback,
        }).length > 0,
        () => get().flushVideoBlendPlayback(),
      );

      // 战争雾：它还没看到的那些揭示轨迹
      resendOnReconnect(
        fogRevealResendPlan({
          wasClientConnected,
          isClientConnected: clientConnected,
          reveal: get().fogReveal,
        }).length > 0,
        () => get().flushFogReveal(),
      );

      // 视频混合：同一套（把它还没看到的擦除轨迹补过去）
      resendOnReconnect(
        videoBlendRevealResendPlan({
          wasClientConnected,
          isClientConnected: clientConnected,
          reveal: get().videoBlendReveal,
        }).length > 0,
        () => get().flushVideoBlendReveal(),
      );

      // 音乐：把它还没听到的那一首补过去（暂停态先放再暂停）
      resendOnReconnect(
        bgmResendPlan({
          wasClientConnected,
          isClientConnected: clientConnected,
          playback: get().bgmPlayback,
        }) !== null,
        () => get().flushBgmPlayback(),
      );
    },

    onServerLog: (entry) => {
      pushLog(entry);
    },

    onError: (reason, requestId) => {
      if (requestId !== undefined) {
        quietCommandIds.delete(requestId);
      }

      set((state) => ({ runtime: { ...state.runtime, lastError: reason } }));
      pushLog(makeLog("error", requestId === undefined ? reason : `[${requestId}] ${reason}`));
    },

    onCommandResult: (message) => {
      // 拖动中的战争雾批次：成功不写日志（否则运行日志会被刷屏），失败照写
      const quiet = quietCommandIds.delete(message.requestId);
      if (quiet && message.ok) {
        return;
      }

      pushLog(
        makeLog(
          message.ok ? "info" : "warn",
          `命令 ${message.ok ? "执行成功" : `执行失败：${message.reason ?? "未知原因"}`}${
            message.effects !== undefined && message.effects.length > 0
              ? `（${message.effects.join("，")}）`
              : ""
          }`,
        ),
      );
    },

    onOpen: () => {
      // 补发一次声明：用户点过「运行」但当时没连上（`pendingRunRequest`），
      // 或者本地记着「用户点过运行」而服务端还没开闸
      // （服务端已经开着的话，`editor_state` 会让界面自动回到运行态，不用重复发）
      if (pendingRunRequest || (get().mode === "run" && !get().runtime.runtimeActive)) {
        pendingRunRequest = false;
        runtimeClient.startRuntime();
      }
    },
  });

  /**
   * 当前的**素材 meta 索引**（v23 起替换了原来那份「工程文件里的切分表」）。
   *
   * 场景载荷要用它把「第几格」解析成「几行几列 + 第几格」（见 `resolveSceneSprites`），
   * 所以推送路径上每一处都得带上；没打开项目时是空索引（不解析子图）。
   * 读的是 store 里那份派生索引（由 `metaHistory` 的订阅重建），于是**推送与面板看到的是同一份**。
   */
  const currentAssetMetas = (): AssetMetas => get().assetMetas;

  /** 去抖推送：连续拖动 / 连续输入只推最后一次。 */
  const pushScheduler = new ScenePushScheduler({
    // 去抖到点后**重新读一次当前文档**（比排队时那份更新），再决定推不推
    push: (_text) => {
      const scene = currentSceneDoc();
      const metas = currentAssetMetas();
      const nextText = scenePayloadText(scene, metas);
      if (
        !shouldPushScene({
          mode: get().mode,
          connected: runtimeClient.connected,
          lastPushed: lastPushedSceneText,
          next: nextText,
        })
      ) {
        return;
      }

      // 文档模型与协议模型结构一致，只差子图解析出来的 `spriteGrid` 与 `RleRun` 的 readonly 标注
      // （服务端还会用 zod 校验一遍）
      runtimeClient.pushScene(scenePayloadOf(scene, metas) as ScenePayload | null);
      lastPushedSceneText = nextText;
    },
  });

  /** 立刻推一份全量（进运行态、重连补发用）。 */
  const pushSceneNow = (): void => {
    pushScheduler.flush(scenePayloadText(currentSceneDoc(), currentAssetMetas()));
  };

  /** 文档变了就安排一次推送（运行态 + 连着服务端才有意义，由 shouldPushScene 判定）。 */
  const scheduleRuntimePush = (): void => {
    if (get().mode !== "run" || !runtimeClient.connected) {
      return;
    }

    pushScheduler.schedule(scenePayloadText(currentSceneDoc(), currentAssetMetas()));
  };

  /** 当前项目的全局设置（没打开项目 = null：推上去等于让前端清掉手上的设置）。 */
  const currentSettingsOf = (): ProjectSettingsDoc | null =>
    get().project.current === null ? null : projectHistory.current.settings;

  /** 上次真的推出去的设置文本（与场景那份同一个用途：内容没变不重推）。 */
  let lastPushedSettingsText: string | null = null;

  /**
   * 全局设置的推送通道（与场景那套并列）。
   *
   * 音量是滑杆拖出来的，一次拖动会改很多次文档 — 所以同样去抖；内容没变（拖回来、撤销回原样）
   * 一个字节都不发。
   */
  const settingsScheduler = new ScenePushScheduler({
    push: () => {
      const settings = currentSettingsOf();
      const nextText = projectSettingsPayloadText(settings);
      if (get().mode !== "run" || !runtimeClient.connected || lastPushedSettingsText === nextText) {
        return;
      }

      runtimeClient.pushSettings(settings);
      lastPushedSettingsText = nextText;
    },
  });

  /** 立刻推一份设置（进运行态、重连补发用）。 */
  const pushSettingsNow = (): void => {
    settingsScheduler.flush(projectSettingsPayloadText(currentSettingsOf()));
  };

  /** 设置变了就安排一次推送（只有运行态 + 连着服务端才有意义）。 */
  const scheduleSettingsPush = (): void => {
    if (get().mode !== "run" || !runtimeClient.connected) {
      return;
    }

    settingsScheduler.schedule(projectSettingsPayloadText(currentSettingsOf()));
  };

  /**
   * deliver* 的公共守卫：编辑器没连上服务端 / 前端不在时**不发**（状态已经记下），
   * 写一条「已记录…」日志说明原因并返回 false；前端就绪时返回 true，调用方继续发命令。
   *
   * 各调用方的日志**文案模板本来就不一致**（声音带层级与内容、视频 / 背景音乐格式不同），
   * 所以这里只合并守卫结构；`recorded` 负责合成完整文案，`reason` 是两种离线原因里命中
   * 的那一条（逐字固定，测试钉着）。
   *
   * `quiet` 给补发用：补发被挡住时不写日志（成功与否由调用方汇总一条）。
   */
  const guardDeliver = (recorded: (reason: string) => string, quiet = false): boolean => {
    if (!runtimeClient.connected) {
      if (!quiet) {
        pushLog(makeLog("info", recorded("编辑器还没连上服务端，连上后自动补发")));
      }

      return false;
    }

    if (get().runtime.client === null) {
      if (!quiet) {
        pushLog(makeLog("info", recorded("前端未连接，等它连上后自动补发")));
      }

      return false;
    }

    return true;
  };

  /**
   * 把一条「这一层该播什么」**尽力**发给前端。
   *
   * 编辑器没连服务端 / 前端不在时**不发**（状态已经记下），只写明白原因——
   * 等前端连上由 `flushSoundPlayback()` 补发，所以「点的时候前端不在」也不会丢。
   */
  const deliverSoundPlay = (entry: Omit<SoundPlaybackEntry, "paused">): string | undefined => {
    const label = `层级 ${SOUND_LAYER_LABELS[entry.layer]}`;
    const what = entry.clips[0] ?? "(空)";

    if (!guardDeliver((reason) => `已记录播放：${label}（${what}；${reason}）`)) {
      return undefined;
    }

    // 命令里只带 objectId + layer：播哪一条由**前端从镜像里的那个对象读**（数据在场景里）
    const requestId = runtimeClient.sendCommand({
      kind: "play_sound",
      objectId: entry.objectId,
      layer: entry.layer,
    });
    pushLog(makeLog("info", `下发播放：${label}（${what}，请前端按它自己镜像里的选中项播）`));
    return requestId;
  };

  /**
   * 把一条**按层级**的声音命令尽力发给前端（停止 / 暂停 / 继续走它；播放那条还带「播哪一条」的说明，
   * 留在 `deliverSoundPlay` 里）。
   *
   * 与 `deliverSoundPlay` 同一套规矩：编辑器没连服务端 / 前端不在时**不发**（状态已经记下），
   * 只写明白原因，等前端连上由 `flushSoundPlayback()` 补发。
   */
  const deliverSoundControl = (
    kind: "stop_sound" | "pause_sound" | "resume_sound",
    layer: SoundLayer,
    what: string,
  ): string | undefined => {
    const label = `层级 ${SOUND_LAYER_LABELS[layer]}`;

    if (!guardDeliver((reason) => `已记录${what}：${label}（${reason}）`)) {
      return undefined;
    }

    const requestId = runtimeClient.sendCommand({ kind, layer });
    pushLog(makeLog("info", `下发${what}：${label}`));
    return requestId;
  };

  /** 按 id 找当前场景里的对象。 */
  const findObjectById = (objectId: string): GameObjectDoc | undefined =>
    findSceneByName(get().scenes, get().activeSceneName)?.objects.find((item) => item.id === objectId);

  /**
   * 对**当前场景**做一次可撤销编辑（`applyScenes` 的「当前场景」版）。
   *
   * 没有当前场景（`activeSceneName` 为 null，或场景列表里暂时没有它）时返回 false、
   * 不进撤销栈；有就把 `recipe` 用在那个场景的 draft 上。包装只覆盖这段公共尾部——
   * 各调用的前后检查（对象在不在 / 改完关不关窗口）仍留在切片里。
   */
  const applyActiveScene = (
    label: string,
    recipe: (scene: SceneListDraft[number]) => boolean | void,
    options?: { coalesceKey?: string },
  ): boolean => {
    const sceneName = get().activeSceneName;
    if (sceneName === null) {
      return false;
    }

    return get().applyScenes(
      label,
      (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          return recipe(scene);
        }
        return undefined;
      },
      options,
    );
  };

  /**
   * 找出「能揭示战争雾」的对象：当前场景里真实存在的 `Fog` 对象，且引用了有效地图、
   * 开着开关、指定了雾区。
   *
   * 找不到就写一条**说明原因**的运行日志并返回 null（不静默失败）：
   * 这类失败恰恰说明瞄准的目标不对（对象被删了 / 不是雾对象 / 没引用地图 / 开关关着 /
   * 还没指定雾区）。
   */
  const fogTargetOf = (objectId: string, what: string): GameObjectDoc | null => {
    const object = findObjectById(objectId);

    if (object === undefined) {
      pushLog(makeLog("warn", `${what}失败：找不到这个对象（${objectId}）`));
      return null;
    }

    const fog = fogOf(object);
    if (fog === undefined) {
      pushLog(makeLog("warn", `${what}失败：「${object.name}」不是战争雾对象，没有雾层`));
      return null;
    }

    const mapId = fog.mapId ?? "";
    const map = mapId.length === 0 ? undefined : findObjectById(mapId);
    if (map === undefined || mapDataOf(map) === undefined) {
      pushLog(
        makeLog(
          "warn",
          `${what}失败：「${object.name}」${mapId.length === 0 ? "还没选引用的地图" : "引用的地图不存在或不是地图"}（属性面板 → 战争雾）`,
        ),
      );
      return null;
    }

    if (!isFogEnabled(object)) {
      pushLog(makeLog("warn", `${what}失败：「${object.name}」的战争雾开关关着（属性面板 → 战争雾）`));
      return null;
    }

    if ((fog.regions ?? []).length === 0) {
      pushLog(makeLog("warn", `${what}失败：「${object.name}」还没指定雾区（属性面板 → 战争雾）`));
      return null;
    }

    return object;
  };

  /** 这个雾对象**现在**还能揭示雾吗？补发前筛掉没意义的记录用——与 `fogTargetOf` 同口径，但不写日志。 */
  const canRevealFog = (objectId: string): boolean => {
    const object = findObjectById(objectId);
    const fog = object === undefined ? undefined : fogOf(object);
    if (object === undefined || fog === undefined) {
      return false;
    }

    const mapId = fog.mapId ?? "";
    const map = mapId.length === 0 ? undefined : findObjectById(mapId);
    if (map === undefined || mapDataOf(map) === undefined) {
      return false;
    }

    return isFogEnabled(object) && (fog.regions ?? []).length > 0;
  };

  /**
   * 这张贴图**现在**还能擦混合遮罩吗？补发前筛掉没意义的记录用——
   * 与 `videoBlendTargetOf` 同口径，但不写日志（对象没了 / 组件没了 = 擦不了）。
   */
  const canRevealVideoBlend = (objectId: string): boolean => {
    const object = findObjectById(objectId);
    if (object === undefined || videoBlendDataOf(object) === undefined) {
      return false;
    }

    return supportsObjectComponent(object, DEFAULT_SLOT_COMPONENT.videoBlend);
  };

  /**
   * 找出「能放视频」的对象：当前场景里实际挂有视频组件且选中了一条视频的对象。
   *
   * 与 `fogTargetOf` 同一个口径：找不到就写一条**说明原因**的运行日志并返回 null（不静默失败）。
   * 「能放视频」的判据只有 `supportsVideo` 一处（文档命令与校验走的是同一个函数）。
   */
  const videoTargetOf = (objectId: string, what: string): GameObjectDoc | null => {
    const object = findObjectById(objectId);

    if (object === undefined) {
      pushLog(makeLog("warn", `${what}失败：找不到这个对象（${objectId}）`));
      return null;
    }

    if (!supportsObjectComponent(object, DEFAULT_SLOT_COMPONENT.video)) {
      pushLog(makeLog("warn", `${what}失败：「${object.name}」没有视频组件`));
      return null;
    }

    // 与战争雾那条一模一样的第三种拒绝：没启用（不是没加视频，也不是没选）
    if (!isVideoEnabled(object)) {
      pushLog(makeLog("warn", `${what}失败：「${object.name}」的视频没启用（属性面板 → 添加组件 → 视频）`));
      return null;
    }

    const video = videoDataOf(object);
    const clips = video?.clips ?? [];
    if (clips.length === 0) {
      pushLog(makeLog("warn", `${what}失败：「${object.name}」还没加视频（属性面板 → 视频）`));
      return null;
    }

    const picked = video?.picked;
    if (picked === undefined || !clips.includes(picked)) {
      pushLog(makeLog("warn", `${what}失败：「${object.name}」还没选要放哪一条视频`));
      return null;
    }

    return object;
  };

  /**
   * 找出「能混合放视频」的对象：当前场景里实际挂有 `VideoBlend` 组件、且**两条通道至少选了一条**的对象。
   *
   * 与 `videoTargetOf` 同一个口径：找不到就写一条**说明原因**的运行日志并返回 null（不静默失败）。
   * 「能混合放」的判据只有 `supportsVideoBlend` 一处（文档命令与校验走的是同一个函数）。
   */
  const videoBlendTargetOf = (objectId: string, what: string): GameObjectDoc | null => {
    const object = findObjectById(objectId);

    if (object === undefined) {
      pushLog(makeLog("warn", `${what}失败：找不到这个对象（${objectId}）`));
      return null;
    }

    if (!supportsObjectComponent(object, DEFAULT_SLOT_COMPONENT.videoBlend)) {
      pushLog(makeLog("warn", `${what}失败：「${object.name}」没有视频混合组件`));
      return null;
    }

    const blend = videoBlendDataOf(object);
    const picks = [blend?.a.id, blend?.b.id].filter((id): id is string => id !== undefined);
    if (picks.length === 0) {
      pushLog(
        makeLog("warn", `${what}失败：「${object.name}」两路都还没选素材（属性面板 → 视频混合）`),
      );
      return null;
    }

    return object;
  };

  /**
   * 找一个**实际挂有或按旧 kind 预设可补建某个特性组件**的对象；不写日志。
   *
   * 已有组件实例优先；缺失必需组件兼容与可选组件准入由组件定义分别声明。
   */
  const objectWithFeature = (objectId: string, component: ComponentType): GameObjectDoc | undefined => {
    const object = findObjectById(objectId);
    const attached = object?.components.some((item) => item.type === component) === true;
    return object !== undefined && (attached || supportsObjectComponent(object, component)) ? object : undefined;
  };

  /**
   * 找一个**带某个特性**的对象；找不到就写一条日志（给「点下去该有反馈」的动作面板用）。
   *
   * `noun` 是日志里对这个东西的称呼（「声音对象」/「传送阵」……）。
   */
  const requireObject = (
    objectId: string,
    component: ComponentType,
    noun: string,
  ): GameObjectDoc | undefined => {
    const object = objectWithFeature(objectId, component);
    if (object === undefined) {
      pushLog(makeLog("error", `找不到这个${noun}`));
    }

    return object;
  };

  /** 找一个**声音对象**；找不到就写一条日志（给「点下去该有反馈」的动作面板用）。 */
  const requireSoundObject = (objectId: string): GameObjectDoc | undefined =>
    requireObject(objectId, DEFAULT_SLOT_COMPONENT.sound, "声音对象");

  /** 找一个**传送阵**；找不到就写一条日志（与 `requireSoundObject` 同一个口径）。 */
  const requireTeleportObject = (objectId: string): GameObjectDoc | undefined =>
    requireObject(objectId, DEFAULT_SLOT_COMPONENT.teleport, "传送阵");

  /**
   * 把一条视频命令**尽力**发给前端（`play_video` / `pause_video` / `resume_video` / `stop_video`）。
   *
   * 与 `deliverSoundPlay` 同一套：编辑器没连服务端 / 前端不在时**不发**（状态已经记下），
   * 只写明白原因——等前端连上由 `flushVideoPlayback()` 补发。
   * 命令里只有 `objectId`：放哪一条 / 循环 / 声音由前端从镜像里那个对象读。
   *
   * `quiet` 给**补发**用：补发时逐条写日志会把运行日志刷屏，成功与否由调用方汇总一条。
   */
  const deliverVideo = (
    kind: "play_video" | "pause_video" | "resume_video" | "stop_video",
    objectId: string,
    label: string,
    quiet = false,
  ): string | undefined => {
    if (!guardDeliver((reason) => `${label}：已记录（${reason}）`, quiet)) {
      return undefined;
    }

    const requestId = runtimeClient.sendCommand({ kind, objectId });
    if (!quiet) {
      pushLog(makeLog("info", `下发${label}：${objectId}`));
    }

    return requestId;
  };

  /**
   * 把一批轨迹**尽力**发给前端（前端不在就什么都不做，由调用方在收笔时写一条日志说明）。
   *
   * 命令里只有 `objectId + stroke`：`objectId` 是**雾对象 id**，雾层在前端它自己的
   * `FogOfWar` 组件里（regions 来自雾对象、格子取自它引用的地图）。这里发的只是鼠标
   * 拖过的轨迹——参考实现也是这么做的（不发整张遮罩）。
   */
  const deliverFogErase = (objectId: string, points: readonly FogRevealPoint[]): string | undefined => {
    if (!runtimeClient.connected || get().runtime.client === null) {
      return undefined;
    }

    const requestId = runtimeClient.sendCommand({
      kind: "erase_mask",
      objectId,
      stroke: { points: [...points], radius: MASK_BRUSH_RATIO, softness: MASK_BRUSH_SOFTNESS },
    });

    // 拖动中一条命令一批：成功的回执不写日志（失败照写），免得把运行日志刷屏
    quietCommandIds.add(requestId);
    return requestId;
  };

  /**
   * 把一批混合遮罩的擦除轨迹**尽力**发给前端（`erase_video_mask`）。
   *
   * 与 `deliverFogErase` 同一套：命令里只有 `objectId + stroke`（`objectId` = **贴图对象 id**，
   * 遮罩在推下去的那个对象的 `VideoBlend` 里）。拖动中成功回执不写日志。
   */
  const deliverVideoMaskErase = (
    objectId: string,
    points: readonly FogRevealPoint[],
  ): string | undefined => {
    if (!runtimeClient.connected || get().runtime.client === null) {
      return undefined;
    }

    const requestId = runtimeClient.sendCommand({
      kind: "erase_video_mask",
      objectId,
      // 软边 0.5（不是雾的 1）：混合遮罩要**实心核**，擦到的地方才会真的变成 0（完全 B）
      stroke: { points: [...points], radius: MASK_BRUSH_RATIO, softness: VIDEO_BLEND_MASK_SOFTNESS },
    });

    quietCommandIds.add(requestId);
    return requestId;
  };

  /** 前端在不在（编辑器连着服务端 **且** 前端连着）。 */
  const frontendReady = (): boolean => runtimeClient.connected && get().runtime.client !== null;

  /** 背景音乐动作在运行日志里的说法。 */
  const bgmActionLabel = (action: BgmAction): string =>
    action.kind === "play"
      ? `背景音乐：${action.clip}`
      : action.kind === "pause"
        ? "背景音乐：暂停"
        : action.kind === "resume"
          ? "背景音乐：继续"
          : "背景音乐：停止";

  /** 真发一条背景音乐命令（调用方负责确认前端连着）。 */
  const sendBgmAction = (action: BgmAction): string | undefined => {
    const requestId = runtimeClient.sendCommand(
      action.kind === "play"
        ? { kind: "play_bgm", clip: action.clip }
        : action.kind === "pause"
          ? { kind: "pause_bgm" }
          : action.kind === "resume"
            ? { kind: "resume_bgm" }
            : { kind: "stop_bgm" },
    );

    pushLog(makeLog("info", `下发${bgmActionLabel(action)}`));
    return requestId;
  };

  /**
   * 把一条背景音乐动作**尽力**发给前端（DM 的手动操作走它）。
   *
   * 与 `deliverSound` / `deliverVideo` 同一套：编辑器没连服务端 / 前端不在时**不发**
   * （记账已经改过），只写明白原因——等前端连上由 `flushBgmPlayback()` 补发。
   */
  const deliverBgm = (action: BgmAction): string | undefined => {
    if (!guardDeliver((reason) => `${bgmActionLabel(action)}：已记录（${reason}）`)) {
      return undefined;
    }

    return sendBgmAction(action);
  };

  /**
   * 把记账里的背景音乐补发一遍（前端刚连上时走它，与 `flushSoundPlayback` 同一条路）。
   *
   * 没在放（`clip === null`，含点过停止）就什么都不发——前端是干净的，无需求。
   * 补发的触发点只有「前端刚连上」一处（见 `onRuntimeState` / `bgmResendPlan`），
   * 所以这里不需要「按内容签名去重」那层状态。
   */
  const flushBgm = (): number => {
    const playback = get().bgmPlayback;
    if (!frontendReady() || playback.clip === null) {
      return 0;
    }

    const actions = bgmResendActions({ clip: playback.clip, paused: playback.paused });
    for (const action of actions) {
      sendBgmAction(action);
    }

    return actions.length;
  };

  const syncHistoryFlags = (): void => {
    const undoHistory = historyOf(activeTrack("undo"));
    const redoHistory = historyOf(activeTrack("redo"));
    set({
      scenes: sceneHistory.current,
      doc: projectHistory.current,
      // 三条轨道共用一个撤销入口：只要还有一条能撤 / 能重做，菜单项就是亮的
      // （`EDIT_TRACKS` 是三条轨道的唯一清单，加轨道不用回来补这里）
      canUndo: EDIT_TRACKS.some((track) => historyOf(track).canUndo),
      canRedo: EDIT_TRACKS.some((track) => historyOf(track).canRedo),
      undoLabel: undoHistory.canUndo ? (undoHistory.undoLabel ?? "") : "",
      redoLabel: redoHistory.canRedo ? (redoHistory.redoLabel ?? "") : "",
    });
  };

  /**
   * 进入运行前的文档快照（对齐 Unity 的播放模式：**运行中的改动不保存、退出即还原**）。
   *
   * 运行态里允许随便改（改激活、拖位置、涂格子、调音量…）——那些改动会推给前端看效果，
   * 但既不写盘也不留历史；退出运行时把整个文档换回这份快照。immer 的文档是不可变的，
   * 所以这里存引用就够（每次 apply 都是新对象）。
   *
   * v15 起快照里**也带着工程文件**：全局设置（三档音量）同样是文档数据，
   * 「运行态改音量立刻生效、退出运行还原」这条规矩靠它落地。
   * v23 起**再带上素材 meta**（切分 / 导入设置）：同一条规矩——运行态里切过的图集
   * 退出运行也该回到切之前的样子（何况运行态本来就不落盘）。
   */
  let runBaseline: {
    readonly scenes: readonly SceneDoc[];
    readonly activeSceneName: string | null;
    readonly doc: ProjectDoc;
    readonly metas: AssetMetaTable;
  } | null = null;

  /** 拍下当前文档作为运行基线（不动状态、不记日志）。 */
  const snapshotRunBaseline = (): void => {
    runBaseline = {
      scenes: get().scenes,
      activeSceneName: get().activeSceneName,
      doc: projectHistory.current,
      metas: metaHistory.current,
    };
  };

  /** 进入运行态：记下快照，并让底栏显示「运行中（不保存）」。 */
  const rememberRunBaseline = (): void => {
    snapshotRunBaseline();
    set({ sceneSaveState: "runtime" });
    pushLog(makeLog("info", "进入运行态：**运行中的改动不会保存**，点「编辑」会还原到现在的样子"));
  };

  /**
   * 文档被**整份换掉**（打开 / 关闭项目、重新装载场景）时把运行基线跟着换。
   *
   * 编辑器完全可能在服务端**已经开着运行态**的时候才拿到文档：刷新页面后接回去、开第二个窗口、
   * 运行中打开另一个项目——这些情况下手上的文档跟原基线已经对不上了。不跟着换，退出运行就会把
   * 文档还原成**别的项目**（或者一片空白）。
   */
  const refreshRunBaseline = (): void => {
    if (get().runtime.runtimeActive) {
      snapshotRunBaseline();
      // 文档刚装载完，落盘状态是「已保存」——运行态下底栏要说「运行中（不保存）」，
      // 否则会被读成「刚才那些运行中的改动已经存好了」
      set({ sceneSaveState: "runtime" });
    }
  };

  /** 退出运行态：整体还原到进入运行前的样子（撤销栈一并清空——运行期间的编辑不入历史）。 */
  const restoreRunBaseline = (): void => {
    const baseline = runBaseline;
    runBaseline = null;
    if (baseline === null) {
      return;
    }

    sceneHistory.reset(baseline.scenes);
    // 工程文件（全局设置）一起还原：运行态里拖过的音量不留痕（要留下就先退出运行再调）
    projectHistory.reset(baseline.doc);
    // 素材 meta（切分 / 导入设置）同理：运行态里切过的图集回到切之前的样子
    metaHistory.reset(baseline.metas);

    const restoredNames = new Set(baseline.scenes.map((scene) => scene.name));
    set((state) => ({
      activeSceneName:
        baseline.activeSceneName !== null && restoredNames.has(baseline.activeSceneName)
          ? baseline.activeSceneName
          : (baseline.scenes[0]?.name ?? null),
      // 选中的对象可能已经被还原掉了：清掉不在场景里的 id，免得属性面板指着不存在的东西
      selectedObjectIds: state.selectedObjectIds.filter((id) =>
        baseline.scenes.some((scene) => scene.objects.some((object) => object.id === id)),
      ),
    }));

    pushLog(makeLog("info", "已退出运行态：文档已还原到进入运行前的样子（运行期间的改动与撤销栈都已丢弃）"));
  };

  /** 启动引导是否正在跑（同步占位，挡住 StrictMode 的第二次 effect）。 */
  let bootstrapping = false;
  /**
   * 用户有没有自己调过视口（平移 / 缩放 / 适配）。
   *
   * 没调过时，画布尺寸一变就把**世界原点摆回正中**——首帧量到的容器尺寸常常是布局
   * 中间态（窄列 / 0 宽），不跟着校正的话「场景中心 = 0,0」会偏到一边去。
   */
  let viewportAdjusted = false;
  /**
   * 每个场景上次的视口（**只在本次会话里记住**，不落盘）。
   *
   * 为什么记：跑团时在几张图之间来回切（酒馆 ↔ 地窖 ↔ 遭遇图），切回去应该还是刚才看的那一角，
   * 而不是「又从 1:1 原点开始」；切到**没去过的**场景则自动适配（整张地图铺满），
   * 否则从一张放大 8 倍的地图切过来，看见的只是一块空白。
   *
   * 为什么不落盘：隔一天打开项目时被一个说不清来路的缩放吓到，比省下这一次适配更烦人。
   */
  const sceneViewports = new Map<string, Viewport>();
  /** 上次成功写盘时的场景内容（场景名 → 序列化文本），用来算「哪些场景有未保存改动」。 */
  const savedScenes = new Map<string, string>();

  /**
   * 上次成功写盘的**工程文件**文本；`null` = 还没装载过（或刚换过文档）。
   *
   * 与 `savedScenes` 同一个用途，只是工程文件只有一份，所以存文本而不是 Map。
   */
  let savedProjectText: string | null = null;

  /** 内存里的工程文件与磁盘不一致（有未保存的全局设置改动）。 */
  const projectDirty = (): boolean =>
    get().project.current !== null && savedProjectText !== serializeProjectFile(projectHistory.current);

  /** 内存里与磁盘不一致的场景名（顺序与 scenes 一致）。 */
  const dirtySceneNames = (): string[] =>
    get()
      .scenes.filter((scene) => savedScenes.get(scene.name) !== serializeSceneFile(scene, get().assetMetas))
      .map((scene) => scene.name);

  /**
   * 做一只「有改动就延迟回写」的去抖器：场景 / 工程文件 / 素材 meta 三条轨道同一份骨架，
   * 差异只有保存状态字段与落盘动作（参数化进来）。
   *
   * 「改了就存」比「记得手动保存」更不容易丢东西，手动保存只是把它提前。
   * 防抖窗口共用 `SCENE_SAVE_DEBOUNCE_MS`：拖音量滑杆、连点导入设置的每一格都改文档，
   * 但只该写一次盘。
   * 运行态下的改动**不落盘**（对齐 Unity 的播放模式）：退出运行时会整体还原，
   * 写盘只会把「临时试出来的样子」留在文件里。
   *
   * 返回的 `[schedule, clearTimer]` 共用同一只定时器：手动保存 / flush 先 clearTimer
   * 再立刻落盘，与「自动存」不会写出两条。
   */
  const makeSaveScheduler = <K extends "sceneSaveState" | "projectSaveState" | "metaSaveState">(
    saveStateKey: K,
    saveNow: () => Promise<boolean>,
  ): { readonly schedule: () => void; readonly clearTimer: () => void } => {
    let timer: number | null = null;

    const schedule = (): void => {
      if (get().project.current === null) {
        return;
      }

      if (get().runtime.runtimeActive) {
        set({ [saveStateKey]: "runtime" } as Pick<EditorStoreState, K>);
        return;
      }

      set({ [saveStateKey]: "pending" } as Pick<EditorStoreState, K>);
      if (timer !== null) {
        window.clearTimeout(timer);
      }

      timer = window.setTimeout(() => {
        timer = null;
        void saveNow();
      }, SCENE_SAVE_DEBOUNCE_MS);
    };

    const clearTimer = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    return { schedule, clearTimer };
  };

  // 场景：待保存的场景**按内容差异算**，所以撤销 / 重做、跨场景编辑都不会写错文件。
  const sceneSave = makeSaveScheduler("sceneSaveState", () => get().saveSceneNow());
  // 工程文件（全局设置）。
  const projectSave = makeSaveScheduler("projectSaveState", () => get().saveProjectNow());
  // 素材 meta：每份一个 `<素材>.meta`，写的时候**只写内容变了的那几份**（比对 `savedMetas`）。
  const metaSave = makeSaveScheduler("metaSaveState", () => get().saveMetasNow());

  /**
   * 上次成功写盘的**素材 meta**（素材路径 ID → 序列化文本），用来算「哪几份 meta 有未保存改动」。
   *
   * 与 `savedScenes` 同一个用途，只是键是素材的路径 ID、值是那一份 `.meta` 的原文。
   */
  const savedMetas = new Map<string, string>();

  /** 内存里与磁盘不一致的素材 meta（返回它们的路径 ID）。 */
  const metaDirtyIds = (): string[] =>
    Object.entries(metaHistory.current)
      .filter(([id, meta]) => savedMetas.get(id) !== serializeAssetMetaFile(meta))
      .map(([id]) => id);

  sceneHistory.subscribe(() => {
    syncHistoryFlags();
    // 运行态下文档一改就（去抖）把整份场景推给服务端 → 前端镜像跟着变
    scheduleRuntimePush();

    if (get().runtime.runtimeActive) {
      set({ sceneSaveState: "runtime" });
      return;
    }

    if (dirtySceneNames().length === 0) {
      set({ sceneSaveState: "saved" });
      return;
    }

    sceneSave.schedule();
  });

  /**
   * 工程文件（全局设置）的变更：与场景那套对称——同步 doc 与撤销标记、运行态下推给服务端、
   * 编辑态下（去抖）落盘。
   *
   * **除了设置，还要重推一次场景**：全局设置随载荷走（前端收到即生效），所以设置一改，
   * 前端那边也该跟着变。文本比对保证「改的是别的项目级数据」时一个字节都不发。
   */
  projectHistory.subscribe(() => {
    syncHistoryFlags();
    scheduleSettingsPush();
    scheduleRuntimePush();

    if (get().runtime.runtimeActive) {
      set({ projectSaveState: "runtime" });
      return;
    }

    if (!projectDirty()) {
      set({ projectSaveState: "saved" });
      return;
    }

    projectSave.schedule();
  });

  /**
   * **素材 meta**的变更（第三条轨道）：重建派生索引 → 同步真源表与撤销标记 →
   * 重推场景（切分参与场景载荷的解析）→ 编辑态下（去抖）只回写变了的那几份。
   *
   * 为什么改了切分要重推场景：子图引用上只写着「第几格」，「几行几列」得随载荷走
   * （前端没有 `.meta`，见 `resolveSceneSprites`），所以切分一改，引用它的对象在前端那边
   * 也该跟着变——这正是「改切分，所有引用它的对象一起变」的落地。文本比对保证
   * 「改的是别的素材」时一个字节都不发。
   *
   * 索引在这里**重建**而不是让每个 action 自己维护：任何一处写 meta（切分 / 导入设置 /
   * 新建 / 撤销 / 重做 / 读盘）都经这条订阅，两个方向（guid、路径 ID）因此永远一致。
   */
  metaHistory.subscribe(() => {
    const table = metaHistory.current;
    set({
      assetMetaTable: table,
      assetMetas: createAssetMetas(
        Object.entries(table).map(([id, meta]) => ({ id, meta })),
      ),
    });

    syncHistoryFlags();
    scheduleRuntimePush();

    if (get().runtime.runtimeActive) {
      set({ metaSaveState: "runtime" });
      return;
    }

    if (metaDirtyIds().length === 0) {
      set({ metaSaveState: "saved" });
      return;
    }

    metaSave.schedule();
  });

  /**
   * 标注偏好的落盘（画笔类型 / 大小 / 每类的显示与颜色）。
   *
   * 只写这几项、**同步写**：内容不到 200 字节，而且与文档无关（不参与自动存那套防抖）。
   */
  const persistGridPaint = (gridPaint: GridPaintState): void => {
    const prefs: GridPaintPrefs = {
      mask: gridPaint.mask,
      brushSize: gridPaint.brushSize,
      hiddenMask: gridPaint.hiddenMask,
      colors: gridPaint.colors,
      showGridLines: gridPaint.showGridLines,
      showAnnotations: gridPaint.showAnnotations,
    };
    writeGridPaintPrefs(prefs);
  };

  const storedGridPaint = readGridPaintPrefs();

  /**
   * **切场景的唯一路径**：切之前写回改动与视口，切之后恢复视口、立刻推给前端。
   *
   * 不把这套动作抄成两三份的理由：落了一步（尤其是**推送**）就会出现「画布换了、投影没换」
   * 这种在跑团现场最恼人的偏差，而调用方有三处（切换条 / 快捷键 / 资源面板）。
   */
  const switchScene = (
    name: string | null,
    options: { readonly clearAssetSelection?: boolean; readonly log?: boolean } = {},
  ): void => {
    const previous = get().activeSceneName;
    const changed = previous !== name;

    if (changed) {
      // 切之前先把手上未保存的改动写回（写入谁由内容差异决定，所以不会写错场景）
      void get().flushSceneSave();
      if (previous !== null) {
        sceneViewports.set(previous, get().viewport);
      }

      /*
        真的换场景时**先把上一个场景的视频停掉**（尽力而为，逐条按对象发 `stop_video`）。
        为什么不像声音那样只清记账就走：客户端把别的场景整棵子树 `SetActive(false)` 藏起来，
        画面是看不见了，但**开了声音的视频会继续响**——现场表现就是「换了台还有声音」。
        调用方不写日志（补发汇总一条），免得切场景刷一串。
      */
      for (const entry of Object.values(get().videoPlayback.objects)) {
        deliverVideo("stop_video", entry.objectId, "停止视频", true);
      }

      // 视频混合同理：换了台还「混着」的画面比看不见更糟
      for (const entry of Object.values(get().videoBlendPlayback.objects)) {
        deliverVideo("stop_video", entry.objectId, "停止混合视频", true);
      }
    }

    // 清选中 / 关窗口 / 清记账这一套**照旧无条件执行**（切到同一个场景时也一样）：
    // 记账记的是「这个场景现在该响什么 / 放什么」，重新打开它就该从「没在播」开始
    set({
      activeSceneName: name,
      selectedObjectIds: [],
      ...(options.clearAssetSelection === true ? { selectedAssetId: null } : {}),
      fogMask: false,
      fogMaskTarget: null,
      videoBlendMask: false,
      videoBlendMaskTarget: null,
      gridEditor: false,
      gridEditorTarget: null,
      // 切场景：记账里的对象属于上一个场景，清掉（前端那边由使用方自己按新场景重播）
      soundPlayback: emptySoundPlayback(),
      videoPlayback: emptyVideoPlayback(),
      videoBlendPlayback: emptyVideoBlendPlayback(),
    });

    // **视口跟着场景走**：回到这个场景上次的样子；没来过就适配（整张地图铺满）。
    // 画布尺寸还没量出来（抽屉挡着 / 0 宽）时**不动视口**——那时候「适配」会把世界原点甩到角上。
    // 只在**真的换了场景**时做：点当前那一格不该把视角重置
    if (changed && name !== null) {
      const remembered = sceneViewports.get(name);
      if (remembered !== undefined) {
        viewportAdjusted = true;
        set({ viewport: remembered });
      } else if (get().viewportSize.width > 0 && get().viewportSize.height > 0) {
        get().fitToViewport();
      }
    }

    // **运行态下切场景要立刻推**（不等 200ms 去抖）：对 DM 而言这就是「换台」，
    // 投影晚一秒都比不换更让人困惑。推不推仍由 shouldPushScene 决定（编辑态 / 断线不推；
    // 内容没变也不推，所以「切到同一个场景」不会产生流量）
    pushSceneNow();

    if (options.log === true) {
      pushLog(makeLog("info", `已切换到场景：${name}`));
    }
  };

  return {
    pushLog,
    currentSceneDoc,
    runtimeClient,
    pushScheduler,
    pushSceneNow,
    scheduleRuntimePush,
    currentSettingsOf,
    settingsScheduler,
    pushSettingsNow,
    scheduleSettingsPush,
    deliverSoundPlay,
    deliverSoundControl,
    fogTargetOf,
    canRevealFog,
    canRevealVideoBlend,
    videoTargetOf,
    videoBlendTargetOf,
    findObjectById,
    applyActiveScene,
    objectWithFeature,
    requireSoundObject,
    requireTeleportObject,
    deliverVideo,
    deliverFogErase,
    deliverVideoMaskErase,
    frontendReady,
    bgmActionLabel,
    sendBgmAction,
    deliverBgm,
    flushBgm,
    syncHistoryFlags,
    snapshotRunBaseline,
    rememberRunBaseline,
    refreshRunBaseline,
    restoreRunBaseline,
    projectDirty,
    dirtySceneNames,
    metaDirtyIds,
    scheduleSceneSave: sceneSave.schedule,
    scheduleProjectSave: projectSave.schedule,
    scheduleMetaSave: metaSave.schedule,
    clearSceneSaveTimer: sceneSave.clearTimer,
    clearProjectSaveTimer: projectSave.clearTimer,
    clearMetaSaveTimer: metaSave.clearTimer,
    persistGridPaint,
    switchScene,
    savedScenes,
    savedMetas,
    sceneViewports,
    storedGridPaint,
    quietCommandIds,
    get lastPushedSceneText() {
      return lastPushedSceneText;
    },
    set lastPushedSceneText(value: string | null) {
      lastPushedSceneText = value;
    },
    get pendingRunRequest() {
      return pendingRunRequest;
    },
    set pendingRunRequest(value: boolean) {
      pendingRunRequest = value;
    },
    get viewportAdjusted() {
      return viewportAdjusted;
    },
    set viewportAdjusted(value: boolean) {
      viewportAdjusted = value;
    },
    get bootstrapping() {
      return bootstrapping;
    },
    set bootstrapping(value: boolean) {
      bootstrapping = value;
    },
    get savedProjectText() {
      return savedProjectText;
    },
    set savedProjectText(value: string | null) {
      savedProjectText = value;
    },
  };
}
