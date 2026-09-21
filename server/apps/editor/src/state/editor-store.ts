import { create } from "zustand";
import {
  DEFAULT_SOUND_LAYER,
  DOCUMENT_FORMAT_VERSION,
  DocumentHistory,
  SOUND_LAYER_LABELS,
  addObject,
  clearMapCells,
  collapseScale,
  createEmptyProject,
  createEmptyScene,
  createId,
  createMapObject,
  createSceneObject,
  createSoundObject,
  createTeleportObject,
  effectiveScaleX,
  effectiveScaleY,
  isMapFogEnabled,
  isSceneNameTaken,
  nextObjectName,
  paintMapCells,
  parseProjectFile,
  parseSceneFile,
  removeObject as removeSceneObject,
  renameObject as renameSceneObject,
  setMapFogEnabled as setSceneMapFogEnabled,
  setMapFogRegions as setSceneMapFogRegions,
  setMapGrid as setSceneMapGrid,
  setObjectActive as setSceneObjectActive,
  setObjectImage as setSceneObjectImage,
  setObjectPosition as setSceneObjectPosition,
  setObjectLocked as setSceneObjectLocked,
  setObjectScale as setSceneObjectScale,
  setObjectScaleAxes as setSceneObjectScaleAxes,
  setObjectRotation as setSceneObjectRotation,
  setObjectSortingOrder as setSceneObjectSortingOrder,
  setSoundClips as setSceneSoundClips,
  setSoundLayer as setSceneSoundLayer,
  setSoundClipName as setSceneSoundClipName,
  // 全局设置（项目级）：三档音量（背景音乐的曲目清单不在这里，见 BgmDialog）
  setBgmVolume as setProjectBgmVolume,
  setSfxVolume as setProjectSfxVolume,
  setVoiceVolume as setProjectVoiceVolume,
  // 项目级数据：音频文件标注（显示名 + 标签 ID，纯编辑器数据，见 AudioFilesDialog）
  setAudioMetaName as setProjectAudioName,
  setAudioMetaTags as setProjectAudioTags,
  renameAudioTag as renameProjectAudioTag,
  setAudioTagName as setProjectAudioTagName,
  setTeleportTargets as setSceneTeleportTargets,
  setTeleportPicked as setSceneTeleportPicked,
  setSoundPicked as setSceneSoundPicked,
  setVideoAudio as setSceneVideoAudio,
  setVideoClipName as setSceneVideoClipName,
  setVideoClips as setSceneVideoClips,
  setVideoEnabled as setSceneVideoEnabled,
  setVideoLoop as setSceneVideoLoop,
  setVideoPicked as setSceneVideoPicked,
  isVideoEnabled,
  supportsVideo,
  validateSceneName,
  type ImageRef,
  type ObjectKind,
  type ProjectDoc,
  type ProjectSettingsDoc,
  type SceneDoc,
  type SceneFileDoc,
  type SceneListDraft,
  type SceneObjectDoc,
  type SoundLayer,
  type WorldPosition,
} from "@dts/document";
import {
  CellMask,
  PAINTABLE_MASKS,
  clampBrushSize,
  gridSizeFromImage,
  isHexColor,
  maskToLabel,
  worldRectOf,
  type GridPoint,
  type GridSize,
  type ImageSize,
} from "@dts/grid";
import {
  PROJECT_FOLDERS,
  PROJECT_SCENE_FILE_EXTENSION,
  projectAssetId,
  projectFileId,
  projectSceneFileId,
  projectSceneImageId,
} from "@dts/resources";
import {
  createViewport,
  fitViewport,
  isCornerScaleHandle,
  panBy,
  scaleAnchorFor,
  scaleAxisOf,
  zoomAt,
  type GizmoHandle,
  type TransformTool,
  type Viewport,
} from "@dts/renderer";
import type { ClientInfo, ProjectSettingsInfo, ResourcesInfo, SceneInfo, ScenePayload } from "@dts/protocol";
import {
  RuntimeClient,
  type RuntimeLogEntry,
  type RuntimeStateSnapshot,
  type RuntimeStatus,
} from "../services/runtime-client";
import {
  ScenePushScheduler,
  projectSettingsPayloadText,
  scenePayloadText,
  shouldPushScene,
} from "../services/runtime-push";
import {
  bgmResendActions,
  bgmResendPlan,
  emptyBgmPlayback,
  withBgmPaused,
  withBgmPlaying,
  withBgmStopped,
  type BgmAction,
  type BgmPlaybackState,
} from "../services/bgm-playback";
import {
  projectApi,
  contentTypeFor,
  type ProjectSummary,
  type ResourceTreeNode,
} from "../services/project-api";
import { clearLastProject, readLastProject, writeLastProject } from "../services/session";
import {
  readGridPaintPrefs,
  writeGridPaintPrefs,
  type GridPaintPrefs,
} from "../services/grid-paint-prefs";
import { readEditorPrefs, writeEditorPrefs } from "../services/editor-prefs";
import { resolveTransform, type TransformStart } from "../panels/scene/transform";
import { sceneVisibleRects } from "../panels/scene/display";
import { clearSceneImageCache } from "../services/scene-image";
import {
  emptySoundPlayback,
  soundPlaybackResendPlan,
  withPlaying,
  withSoundPaused,
  withStopped,
  type SoundPlaybackEntry,
  type SoundPlaybackState,
} from "../services/sound-playback";
import {
  emptyVideoPlayback,
  videoPlaybackResendPlan,
  withVideoPaused,
  withVideoPlaying,
  withVideoStopped,
  type VideoPlaybackEntry,
  type VideoPlaybackState,
} from "../services/video-playback";
import {
  emptyFogReveal,
  fogRevealResendPlan,
  pruneFogReveal,
  withEraseBatch,
  withRegion,
  type FogRevealEntry,
  type FogRevealPoint,
  type FogRevealState,
} from "../services/fog-reveal";
import { MASK_BRUSH_RATIO, MASK_BRUSH_SOFTNESS } from "../services/mask-math";

/**
 * 编辑器状态。
 *
 * 关键约束：
 * - **项目文件**（`project.json`）由 `DocumentHistory` 持有（补丁式撤销/重做），store 里只镜像当前值；
 * - **场景是文件**（`Assets/scenes/<场景名>.json`），单独放在 `scenes` 切片里：
 *   编辑器只做建 / 删 / 改名，**永不写场景内容**（内容由外部提交）；
 * - **运行态**数据放在独立的 `runtime` 切片，与 `doc` 物理隔离——运行态永不写文档；
 * - 画布渲染循环直接读 `getState()`，指针移动不触发 React 重渲染。
 */

export type EditorMode = "edit" | "run";

export interface EditorUiState {
  readonly leftOpen: boolean;
  readonly rightOpen: boolean;
  readonly runtimeOpen: boolean;
  /**
   * 当前变换工具（画布上的手柄跟着它换）：移动 / 旋转 / 缩放，对齐 Unity 的 W / E / R。
   *
   * 它是**编辑器偏好**而不是文档内容：换个工具是「我现在想怎么摆对象」，
   * 不该让场景文件因为点了一下按钮就变脏。默认 `move`——正是手柄出现之前那个行为。
   */
  readonly tool: TransformTool;
  /**
   * 「背景音乐」弹框里**在行右边显示路径**吗（默认不显示）。
   *
   * 同样是**编辑器偏好**而不是文档内容：清单想看得多细是「我怎么看」，
   * 记在浏览器本地（`services/editor-prefs`），换个项目也还在。
   */
  readonly bgmPaths: boolean;
}

export interface RuntimeUiState {
  readonly status: RuntimeStatus;
  readonly statusDetail: string;
  /** 服务端有没有开闸（= 编辑器声明了运行态）。没开闸时前端连不上。 */
  readonly runtimeActive: boolean;
  /** 前端是谁（连上后由 `client_hello` 补上名字与版本）；null = 没连。 */
  readonly client: ClientInfo | null;
  /** 已经推给服务端的那份场景的摘要；null = 还没推过。 */
  readonly scene: SceneInfo | null;
  /** 前端本地资源包状态（它把当前项目的 Assets/ 下到本地）；null = 还没收到回执。 */
  readonly resources: ResourcesInfo | null;
  /** 已经推给服务端的**全局设置**摘要（推送时间；设置里只有三档音量）；null = 还没推过。 */
  readonly settings: ProjectSettingsInfo | null;
  readonly logs: RuntimeLogEntry[];
  readonly lastError: string;
}

/** 项目（一个项目 = 一个文件夹 + 一个 `project.json`）相关状态。 */
export interface ProjectUiState {
  /** 服务端上的全部合法项目；**没有 `project.json` 的目录不算项目**，不会出现在这里 */
  readonly list: readonly ProjectSummary[];
  /** 当前已打开的项目；null 表示尚未打开 */
  readonly current: string | null;
  readonly tree: readonly ResourceTreeNode[];
  readonly busy: boolean;
  readonly error: string;
}

/** 项目对话框模式：新建 / 打开 / 未展开。 */
export type ProjectDialogMode = "create" | "open" | null;

/** 场景对话框模式：新建 / 重命名 / 未展开。 */
export type SceneDialogMode = "create" | "rename" | null;

/** 场景文件的保存状态：已保存 / 有未保存改动 / 正在写 / 写失败。 */
export type SceneSaveState = "saved" | "pending" | "saving" | "error" | "runtime";

/**
 * 网格标注（地图编辑）状态。
 *
 * 「怎么画 / 怎么显示」那一半（画笔类型 / 大小 / 每类的显示与颜色 / 网格线、网格标注两个总开关）
 * 是**编辑器偏好**，会写进浏览器本地（对齐 Unity 把这几项存在编辑窗口的序列化字段里）。
 * 落笔的地方只有**编辑窗口**（`GridEditDialog`）——画布上不再有「标注模式」。
 *
 * 战争雾**不在这里**：开关与雾区都是文档数据（`map.fog`），因为它决定前端生不生成那一层雾
 * （见 `setFogEnabled`）。
 *
 * 画笔类型直接用格子掩码位表示，`CellMask.Empty`(=0) 就是橡皮擦——与 Unity 的
 * 「橡皮擦 (0)」是同一件事，不必再造一个布尔字段。
 */
export interface GridPaintState {
  /** 画笔：格子掩码位；0 = 橡皮擦。 */
  readonly mask: number;
  readonly brushSize: number;
  /** 隐藏的类型位（显示开关）：只影响绘制，不动数据，也不影响画笔。 */
  readonly hiddenMask: number;
  /** 类型位 → `#rrggbb`；透明度跟类型绑定（见 `@dts/grid` 的 `defaultCellMaskStyle`）。 */
  readonly colors: Readonly<Record<number, string>>;
  /** 画布上是否画网格线（所有地图；纯显示）。 */
  readonly showGridLines: boolean;
  /** 画布上是否给格子着色（所有地图；纯显示）。 */
  readonly showAnnotations: boolean;
}

export interface EditorStoreState {
  readonly mode: EditorMode;
  /** 项目文件（`project.json`）的内容：只有项目级数据 */
  readonly doc: ProjectDoc;
  /** 当前项目里的场景（来自 `Assets/scenes/*.json`，名字就是文件名） */
  readonly scenes: readonly SceneDoc[];
  /** 当前场景名（= 文件名）；null 表示项目里还没有场景 */
  readonly activeSceneName: string | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string;
  readonly redoLabel: string;
  readonly selectedObjectIds: readonly string[];
  /** 在资源面板里选中的资源文件（贴图 / 视频…）；与对象选中互斥，属性面板据此显示 */
  readonly selectedAssetId: string | null;
  readonly viewport: Viewport;
  readonly viewportSize: { width: number; height: number };
  readonly ui: EditorUiState;
  readonly runtime: RuntimeUiState;
  readonly project: ProjectUiState;
  /** 启动引导是否已跑完（外部观察者用它判断「该弹的对话框已经弹出来了」）。 */
  readonly bootstrapped: boolean;
  /** 项目对话框模式：由启动引导与菜单共同驱动，因此放在 store 里而不是组件局部状态 */
  readonly projectDialog: ProjectDialogMode;
  /** 场景对话框模式（同样由菜单驱动） */
  readonly sceneDialog: SceneDialogMode;
  /** 「新建对象」弹框是否打开（按钮与快捷键都能唤出，所以放 store） */
  readonly objectDialog: boolean;
  /** 「选择贴图」弹框是否打开（属性面板上的按钮唤出） */
  readonly imagePicker: boolean;
  /** 正在换贴图的地图对象 id；null 表示弹框没打开 */
  readonly imagePickerTarget: string | null;
  /** 「编辑声音」窗口是否打开（属性面板「声音」组上的按钮唤出） */
  readonly soundEditor: boolean;
  /** 正在编辑哪个声音对象的声音；null 表示窗口没打开 */
  readonly soundEditorTarget: string | null;
  /** 「传送目标」窗口是否打开（属性面板「传送」组里的 `＋` 唤出） */
  readonly teleportEditor: boolean;
  /** 正在编辑哪个传送阵的候选目标；null 表示窗口没打开 */
  readonly teleportEditorTarget: string | null;
  /** 「编辑视频」窗口是否打开（地图 / 精灵属性面板「视频」组上的按钮唤出） */
  readonly videoEditor: boolean;
  /** 正在编辑哪个对象的视频列表；null 表示窗口没打开 */
  readonly videoEditorTarget: string | null;
  /** 「全局设置」窗口是否打开（「工程」菜单唤出；里面只有三档音量） */
  readonly globalSettings: boolean;
  /** 「背景音乐」弹框是否打开（顶栏「音乐」按钮唤出） */
  readonly bgmDialog: boolean;
  /** 「标签」窗口是否打开（工程菜单 / 属性面板唤出；标签表：新建 / 改名 / 删除） */
  readonly audioTags: boolean;
  /** 「战争雾 Mask 窗口」是否打开（属性面板的按钮唤出） */
  readonly fogMask: boolean;
  /** Mask 窗口正在编辑哪张地图；null 表示窗口没打开 */
  readonly fogMaskTarget: string | null;
  /** 「网格编辑窗口」是否打开（属性面板的按钮唤出；与 Mask 窗口**互斥**） */
  readonly gridEditor: boolean;
  /** 网格编辑窗口正在编辑哪张地图；null 表示窗口没打开 */
  readonly gridEditorTarget: string | null;
  /** 场景文件的保存状态（自动存与手动保存共用） */
  readonly sceneSaveState: SceneSaveState;
  readonly sceneSaveError: string;
  /**
   * **工程文件**（`project.json`）的保存状态（自动存与手动保存共用）。
   *
   * 与 `sceneSaveState` 分开：两份文件各自有未保存改动，底栏要把两件事都说清楚
   * （「场景未保存」与「工程未保存」是两回事，合成一个只会让人以为都存了）。
   */
  readonly projectSaveState: SceneSaveState;
  readonly projectSaveError: string;
  /** 网格标注（画笔）状态：编辑窗口的涂 / 擦与画布的着色都读它。 */
  readonly gridPaint: GridPaintState;
  /**
   * 声音的**期望播放状态**（编辑器记账，见 `services/sound-playback`）。
   *
   * 不写文档、不进撤销栈；点播放 / 停止只改它 + 尽力下发，前端连上时补发。
   */
  readonly soundPlayback: SoundPlaybackState;
  /**
   * 视频的**期望播放状态**（编辑器记账，见 `services/video-playback`）。
   *
   * 与 `soundPlayback` 一样是运行态：不写文档、不进撤销栈；点播放 / 暂停 / 停止只改它 + 尽力下发，
   * 前端连上时补发。**按对象记**（不是按层级）：每个对象各自一条、互不影响；
   * **切场景清**（记账里的对象属于上一个场景），与 `soundPlayback` 同一处。
   */
  readonly videoPlayback: VideoPlaybackState;
  /**
   * **全局背景音乐**的期望播放状态（编辑器记账，见 `services/bgm-playback`）。
   *
   * 与 `soundPlayback` / `videoPlayback` 一样是运行态：不写文档、不进撤销栈。
   * 差别在归属——它是**全局一条**（没有宿主对象，也不在项目设置里）：
   * 曲目清单就是项目 `Assets/audio/` 下的音频（弹框里点一首）；
   * - 缺省 = 什么都没放（**进运行态不会自动出声**，播放权全交给 DM）；
   * - 前端（重）连上时补发记账里的那一首（暂停态先放再暂停）；
   * - **切场景不碰它**（换台不该把 BGM 掐了），换项目 / 退出运行态才清。
   */
  readonly bgmPlayback: BgmPlaybackState;
  /**
   * 战争雾的**揭示记账**（编辑器记账，见 `services/fog-reveal`）。
   *
   * 与 `soundPlayback` 一样是运行态：不写文档、不进撤销栈；擦一笔 / 拨整区开关只改它 + 尽力下发，
   * 前端（重）连上时补发。**切场景不清**——雾是按地图对象记的，前端各场景的雾层都留着
   * （`soundPlayback` 按场景清，因为「这一层该响什么」是当前场景的事）。
   */
  readonly fogReveal: FogRevealState;
  /**
   * 正在进行的手柄拖拽的快照；null = 没在拖。
   *
   * 放在 store 里（而不是组件闭包里）有一个具体理由：拖拽期间画布要**按快照**画手柄
   * （对象转过角度时手柄要跟着转、缩放时锚点要跟着走），闭包里的副本没法参与渲染。
   */
  readonly transformStart: TransformStart | null;

  /** 场景编辑（对象增删改）统一走这里：进撤销栈，并触发自动落盘。 */
  applyScenes(
    label: string,
    recipe: (draft: SceneListDraft) => void,
    options?: { coalesceKey?: string },
  ): boolean;
  /**
   * **工程文件**（项目级数据：全局设置）的编辑走这里：进撤销栈，并触发工程文件的自动落盘。
   *
   * 与 `applyScenes` 并列（两份文件、两套历史），但**撤销入口只有一个**——见 `undo`。
   */
  applyProject(
    label: string,
    recipe: (draft: ProjectDoc) => void,
    options?: { coalesceKey?: string },
  ): boolean;
  undo(): void;
  redo(): void;
  resetDoc(doc: ProjectDoc): void;
  setActiveScene(name: string | null): void;
  /** 从资源面板**打开**一个场景：切到它，并把选中态交回场景（属性面板随之显示该场景）。 */
  openScene(name: string): void;
  /**
   * 按**当前顺序**切到第 `index` 个场景（0 基；切换条上的 `1`-`9` 与快捷键都走它）。
   *
   * 顺序的唯一来源是 `scenes` 数组（装载时按 `compareSceneNames` 排好），
   * 所以这里与切换条上看到的序号必然一致。越界返回 `false`（什么都不做）。
   */
  openSceneByIndex(index: number): boolean;
  /** 上一场 / 下一场（`delta` = ±1）：到首 / 尾返回 `false`，**不循环**。 */
  openAdjacentScene(delta: -1 | 1): boolean;
  setSelection(objectIds: readonly string[]): void;
  /** 选中资源文件（传 null 取消）。与对象选中互斥——属性面板一次只显示一样东西。 */
  selectAsset(id: string | null): void;
  setViewport(viewport: Viewport): void;
  zoomAtScreen(anchor: { x: number; y: number }, factor: number): void;
  panByScreen(dx: number, dy: number): void;
  /**
   * **适配视图**：把当前场景里**画布上看得见的东西**（地图 / 精灵 / 徽标…）一起装进视口，
   * 外框居中、按需缩放。一个都没落位时退回「世界原点居中 1:1」。
   *
   * 「复位」按钮与「视图 → 适配视口」都走它：对 DM 而言这两件事是同一个意思——
   * 「让我重新看见全场」。曾经「复位」是「缩放回 1:1 + 世界原点居中」，在 1920×1080 的图上
   * 只看得到中间一块，正是要解决的问题。
   */
  fitToViewport(): void;
  setViewportSize(size: { width: number; height: number }): void;
  setUi(patch: Partial<EditorUiState>): void;
  setMode(mode: EditorMode): void;
  /** 连上服务端（页面加载时就连：编辑态也要知道服务端在不在运行）。 */
  connectRuntime(): void;
  /**
   * 把**当前场景整份**推给服务端（运行态才推，内容没变不推）。
   *
   * 进运行态、WS 重连后调用它是「补齐全量」；平时由文档变更自动去抖触发，
   * 所以正常情况下不用手点（面板上那句「已同步 N 个对象」就是它的结果）。
   */
  pushRuntimeScene(): void;
  /**
   * 让**前端**播放这个声音对象选中的那一条（编辑器自己不出声，只**记账** + 尽力下发）。
   *
   * 命令里只有 `objectId + layer`：**播哪一条由前端从镜像里的那个对象读**（数据在场景里）。
   * 编辑器还没连上服务端 / 前端没连时**照样能点**：状态记在 `soundPlayback` 里，等前端连上补发。
   */
  playSound(objectId: string): string | undefined;
  /** 让前端**停掉**某个声音对象所在的层级（同层只响一条，所以按层停）。 */
  stopSound(objectId: string): string | undefined;
  /**
   * 让前端**暂停**某个声音对象所在的层级（v6 起，与视频那组对称）。
   *
   * 按**层级**管：同层只响一条，所以「暂停这一层」= 暂停当前那条。这一层不是这个对象在响时
   * 写一条说明原因的运行日志（去选中那个正在响的对象，或直接按「停止」）。
   */
  pauseSound(objectId: string): string | undefined;
  /** 从暂停的那一帧继续放这个对象所在的层级。 */
  resumeSound(objectId: string): string | undefined;
  /**
   * 把记着的期望状态补发一遍（前端刚连上时调用）。
   *
   * 返回补发的层数；编辑器的服务端连接没开、或前端没连时什么都不做（返回 0）。
   */
  flushSoundPlayback(): number;
  /**
   * 让**前端**在某个地图 / 精灵上放它选中的那一条视频（编辑器自己不放，只**记账** + 尽力下发）。
   *
   * 命令里只有 `objectId`：**放哪一条、循环、声音都由前端从镜像里的那个对象读**
   * （数据在场景里，命令只是触发器）。编辑器还没连上服务端 / 前端没连时**照样能点**：
   * 状态记在 `videoPlayback` 里，等前端连上补发。
   */
  playVideo(objectId: string): string | undefined;
  /** 让前端把某个对象上的视频**暂停在当前帧**（没在放就写一条说明原因的日志）。 */
  pauseVideo(objectId: string): string | undefined;
  /** 从暂停的那一帧继续放（对没在播的对象语义由前端决定：从头放）。 */
  resumeVideo(objectId: string): string | undefined;
  /** 让前端**停掉**某个对象上的视频并拆掉那一层（露出对象自己原来的贴图）。 */
  stopVideo(objectId: string): string | undefined;
  /**
   * 把记着的期望播放状态补发一遍（前端刚连上时调用）。
   *
   * 返回补发的对象数；编辑器的服务端连接没开、或前端没连时什么都不做（返回 0）。
   * 暂停态的对象会补「先放再暂停」，前端因此回到同一帧。
   */
  flushVideoPlayback(): number;
  /** 打开 / 关闭「编辑视频」窗口（`null` = 关闭）。 */
  openVideoEditor(objectId: string | null): void;
  /**
   * 视频：**启用 / 关掉**这个对象的视频（文档数据）。
   *
   * 关掉 = 前端不建视频层（播放类命令会被拒），但**已经加的视频留着**（再打开就回来）；
   * 一个视频都没加时关掉会把 `video` 字段整个摘掉（与「从没开过」同义）。
   */
  setVideoEnabled(objectId: string, enabled: boolean): boolean;
  /** 视频：往里加一条（已经在列表里就不重复加；原来没选过就把它选上）。 */
  addVideoClip(objectId: string, clipId: string): boolean;
  /** 视频：移出一条（名字与「选中的那条」由文档命令一起收拾）。 */
  removeVideoClip(objectId: string, clipId: string): boolean;
  /** 视频：选中 / 取消选中「放哪一条」（`null` = 取消选中）。 */
  selectVideoClip(objectId: string, clip: string | null): boolean;
  /** 视频：给某个文件起显示名（空 = 退回素材文件名）。 */
  setVideoClipName(objectId: string, clipId: string, name: string): boolean;
  /** 视频：循环播放开关（文档数据）。 */
  setVideoLoop(objectId: string, loop: boolean): boolean;
  /** 视频：是否放视频自带的声音（文档数据）。 */
  setVideoAudio(objectId: string, audio: boolean): boolean;
  /**
   * 全局背景音乐（v16 起）：让前端放 / **切换**到某一首。
   *
   * 与声音对象的「播放」同一套规矩（记账 + 尽力下发，前端不在就等它连上补发），
   * 但命令里**带 `clip`**：曲目清单不在任何对象上、也不在项目设置里——它就是弹框里
   * 列出来的项目音频，所以命令说「现在放哪一首」。
   * 再点同一首 = 让前端从头重播一遍（与视频那边同一个手感）。
   */
  playBgm(clip: string): string | undefined;
  /** 全局背景音乐：暂停（只有点过的那一首谈得上暂停）。 */
  pauseBgm(): string | undefined;
  /** 全局背景音乐：从暂停处继续。 */
  resumeBgm(): string | undefined;
  /** 全局背景音乐：停掉（停完再点一首 = 从头放）。 */
  stopBgm(): string | undefined;
  /**
   * 把记账里的背景音乐补发一遍（前端刚连上时调用）。
   *
   * 返回真正下发的命令条数：没连上、或本来就没在放（`clip === null`，含点过停止）时返回 0。
   * 不按内容签名去重——补发的时机只有「前端刚连上」一处，不必再叠一层状态。
   */
  flushBgmPlayback(): number;
  /** 打开 / 关闭「全局设置」窗口（只有三档音量）。 */
  openGlobalSettings(open: boolean): void;
  /** 打开 / 关闭「背景音乐」弹框（顶栏「音乐」按钮唤出）。 */
  openBgmDialog(open: boolean): void;
  /**
   * 音频文件：起显示名（`""` = 退回素材文件名）。进工程文件、可撤销、随自动落盘。
   *
   * 界面入口只有一个：**选中那个音频文件时属性面板上的「显示名」输入框**
   * （曾经另有一个「音频文件」列表窗口，v18 删掉了——「选中谁就改谁」本来就是这个面板的用法）。
   */
  setAudioName(clipId: string, name: string): boolean;
  /**
   * 音频文件：替换**整份**标签 ID 清单（去重升序、丢掉越界已删的，由文档命令做）。
   */
  setAudioTags(clipId: string, tagIds: readonly number[]): boolean;
  /**
   * 标签表：给某个 tag ID 改名字（**只改表**，文件里的 ID 不动）。
   *
   * 只改**已经存在**的槽位；给「序号预先列好、只填名字」的界面用的是 `setAudioTagName`。
   */
  renameAudioTag(tagId: number, name: string): boolean;
  /**
   * 标签表：给**指定的序号**命名（序号不存在就把它补出来，中间的缺口补成空名字）。
   *
   * 「标签」窗口用它：序号是预先列好的，人往第 N 个格子里敲名字，N 就是它以后的 ID
   * （对齐 Unity 的 TagManager）。指向洞（`null`）的序号不写。
   */
  setAudioTagName(tagId: number, name: string): boolean;
  /** 打开 / 关闭「标签」窗口（标签表：只填名字）。 */
  openAudioTags(open: boolean): void;
  /** 全局设置 · 背景音乐音量（`0..1`，越界夹回；前端收到即生效）。 */
  setBgmVolume(volume: number): boolean;
  /** 全局设置 · 音效通道音量（`0..1`）。 */
  setSfxVolume(volume: number): boolean;
  /** 全局设置 · 旁白通道音量（`0..1`）。 */
  setVoiceVolume(volume: number): boolean;
  clearRuntimeLogs(): void;

  /**
   * 启动引导，页面加载后调用一次：
   * 1. 有「上次打开的项目」且它还在 → 直接打开它；
   * 2. 一个项目都没有 → 弹「新建项目」；
   * 3. 有项目但没有（或已失效的）上次记录 → 弹「打开项目」列表让用户挑。
   */
  bootstrapEditor(): Promise<void>;
  openProjectDialog(mode: ProjectDialogMode): void;
  refreshProjects(): Promise<void>;
  createProject(name: string): Promise<boolean>;
  openProject(name: string): Promise<boolean>;
  closeProject(): void;
  deleteProject(name: string): Promise<boolean>;
  refreshTree(): Promise<void>;
  createFolder(path: string): Promise<boolean>;
  /**
   * 在**运行服务端的那台机器**上用文件管理器打开项目里的某一层。
   *
   * 浏览器不能替用户开文件夹，所以这件事由后端调系统命令完成：从平板经局域网访问时，
   * 弹出来的是服务端那台电脑的窗口。`target` 是**项目内相对路径**（空串 = 项目根）：
   * 给目录就打开那个目录；给文件路径并且 `selectFile` 为真，就打开它所在目录并**选中它**。
   * 失败（系统不支持 / 命令缺失 / 路径越界）会写进 `project.error`。
   */
  openProjectFolder(target?: string, selectFile?: boolean): Promise<boolean>;
  uploadFiles(dirPath: string, files: readonly File[]): Promise<void>;
  deleteResource(id: string, label: string): Promise<boolean>;

  /** 立即把有改动的场景写回文件（手动保存 / 切场景前 flush）。 */
  saveSceneNow(): Promise<boolean>;
  /** 有待保存改动就立刻写回；场景级操作与关闭项目之前调用，避免丢失或写错场景。 */
  flushSceneSave(): Promise<void>;

  /**
   * 立即把**工程文件**（`project.json`，全局设置在这里）写回磁盘。
   *
   * 与 `saveSceneNow` 同一套：运行态下不写盘（改动退出运行会整体还原），失败写进 `projectSaveError`。
   */
  saveProjectNow(): Promise<boolean>;
  /** 工程文件有待保存改动就立刻写回；关项目 / 进运行态前调用。 */
  flushProjectSave(): Promise<void>;

  /** 重新扫描 `Assets/scenes/` 并把场景读进内存（打开项目、增删改名后调用）。 */
  loadScenes(): Promise<void>;
  openSceneDialog(mode: SceneDialogMode): void;
  openObjectDialog(open: boolean): void;
  /**
   * 打开「选择贴图」弹框（传要换贴图的地图对象 id）；传 null 关闭。
   *
   * 打开与关闭走同一条路：**记住当前目标是 store 的事**，弹框组件只读它。
   */
  openImagePicker(mapObjectId: string | null): void;
  /**
   * 新建场景：在 `Assets/scenes/` 下建一个空场景文件。成功返回 undefined，失败返回原因。
   */
  createScene(name: string): Promise<string | undefined>;
  /** 重命名当前场景：**只改文件名**，场景内容一个字节都不重写。 */
  renameScene(name: string): Promise<string | undefined>;
  /** 删除当前场景（至少要保留一个场景）。 */
  deleteScene(): Promise<string | undefined>;

  /**
   * 在当前场景新建对象；不传 position 就放在世界原点（= 场景正中）。
   * 成功返回 undefined，失败返回原因。
   */
  createObject(
    kind: ObjectKind,
    name: string,
    position?: WorldPosition,
  ): Promise<string | undefined>;
  /** 改对象名（trim 后为空则拒绝）。 */
  renameObject(id: string, name: string): boolean;
  /**
   * 激活 / 停用对象（对齐 Unity 的勾选框）：不激活就不画、也不能在画布上点选，
   * 但对象仍在场景里，属性面板照样能改。
   */
  setObjectActive(id: string, active: boolean): boolean;
  /** 翻转激活状态（列表里那只眼睛）。**目标值由 store 现算**，不交给界面上的旧值。 */
  toggleObjectActive(id: string): boolean;
  /**
   * 锁定 / 解锁对象（对齐列表里那把锁）：锁上就**不能移动**——画布上拖不动，
   * 世界坐标也改不了（`moveObject` 会直接拒掉）。别的照常可改，也不影响选中 / 删除。
   */
  setObjectLocked(id: string, locked: boolean): boolean;
  /** 翻转锁定状态（列表里那把锁）。**目标值由 store 现算**。 */
  toggleObjectLocked(id: string): boolean;
  /** 改对象的显示顺序（大的画在前面）；连续输入合并成一条撤销记录。 */
  setObjectSortingOrder(id: string, sortingOrder: number): boolean;
  /** 改对象的**缩放**（1 = 原始尺寸；夹在 0.01 ~ 100）；连续输入合并成一条撤销记录。 */
  setObjectScale(id: string, scale: number): boolean;
  /**
   * 改对象的**角度**（绕竖轴，单位**弧度**；与 Unity 的 Y 轴旋转同一套符号）。
   * 面板按度编辑，这里收弧度；归一化到 `(-180°, 180°]`；连续输入合并成一条撤销记录。
   */
  setObjectRotation(id: string, rotationRadians: number): boolean;
  /** 删除对象（不传 ids 则删当前选中）。 */
  deleteObjects(ids?: readonly string[]): boolean;
  /** 复制对象（不传 ids 则复制当前选中）：副本加「副本」后缀并偏移一点位置。 */
  duplicateObjects(ids?: readonly string[]): boolean;
  /** 移动对象（画布拖动用，参数是世界坐标；连续调用合并成一条撤销记录）。 */
  moveObject(id: string, position: WorldPosition): void;
  /** 一次拖动结束：断开撤销合并，使后续拖动成为独立记录。 */
  endObjectDrag(): void;
  /** 换变换工具（移动 / 旋转 / 缩放）；写进浏览器本地偏好，不进文档。 */
  setTool(tool: TransformTool): void;
  /** 「背景音乐」弹框显不显示路径；同样写进浏览器本地偏好，不进文档。 */
  setBgmPaths(show: boolean): void;
  /**
   * 开始一次变换拖拽：把当前状态拍成快照（世界中心、角度、两轴有效缩放、
   * 按下时的指针位置、缩放锚点）。
   *
   * `handle` 传 `null` = **拖的是对象本体**（「移动」工具下的自由移动，没有手柄也就没有轴约束
   * 与缩放锚点）；传手柄名则按手柄决定轴约束（移动柄）或锚点 / 角与边（缩放柄）。
   *
   * 返回 `undefined` = 这次不进入变换：对象不存在 / 没落位 / **锁定**（锁的语义是
   * 「不能被移动」，旋转缩放当然也算移动它）/ 正在拖别的。
   */
  beginObjectTransform(
    id: string,
    handle: GizmoHandle | null,
    pointer: WorldPosition,
    halfWidth: number,
    halfHeight: number,
  ): TransformStart | undefined;
  /**
   * 拖拽中：按快照算出新值并写进文档（连续调用合并成一条撤销记录）。
   *
   * `axis`（移动柄）与 `snapAngle`（Shift 吸附 15°）由调用方从事件里读；
   * 一切以 `beginObjectTransform` 的快照为基准，不做逐帧累加。
   */
  applyObjectTransform(
    pointer: WorldPosition,
    options?: { readonly axis?: "x" | "y"; readonly snapAngle?: boolean; readonly uniform?: boolean },
  ): void;
  /** 一次手柄拖拽结束：断开撤销合并（与 `endObjectDrag` 同一件事，名字说清用途）。 */
  endObjectTransform(): void;
  /** 取消这次拖拽：用快照把位置 / 角度 / 两轴缩放写回按下前的样子，再收尾。 */
  cancelObjectTransform(): void;
  /** 改对象的**两轴缩放**（单轴手柄与属性面板用）；两轴相等时自动折叠回等比。 */
  setObjectScaleAxes(id: string, x: number, y: number): boolean;
  /** 换对象显示的图片（地图写进 map.image，精灵写进 image；宽高由调用方从素材本身读出）。 */
  setObjectImage(objectId: string, image: ImageRef): boolean;
  /**
   * 替换声音对象的音频列表（资源逻辑 ID；去空去重，值没变不算变更）。
   *
   * 低层入口：面板上点小方块走 `selectSoundClip`，窗口里加 / 删走 `addSoundClip` /
   * `removeSoundClip`（它们各自只做一件事，好读）。
   */
  setSoundClips(objectId: string, clips: readonly string[]): boolean;
  /**
   * 把一条音频**加进来**（已在列表里就什么都不做，只把它选上）。
   *
   * 只有已经加进来的音频才能被播（`selectSoundClip` 会拒掉别的），所以这是「添素材」的入口；
   * 原来选中的那条如果还在，**不抢**——正听着 A 的时候加一条 B，选择不该被顶掉。
   */
  addSoundClip(objectId: string, clipId: string): boolean;
  /**
   * 把一条音频**移出去**：它的名字一起删掉，移走的正好是选中的那条就顺到下一条
   * （都没了 = 这条声音暂时没得播）。
   */
  removeSoundClip(objectId: string, clipId: string): boolean;
  /**
   * 选这一条声音（**单选**：只能选已经加进来的，传 null 取消选中）。
   *
   * 名字按文件记（`names`），所以换选不会动名字。
   */
  selectSoundClip(objectId: string, clip: string | null): boolean;
  /** 给某个音频文件起显示名（留空 = 退回素材文件名）；名字只是标签，不进协议。 */
  setSoundClipName(objectId: string, clipId: string, name: string): boolean;
  /** 打开 / 关闭「编辑声音」窗口（传声音对象 id；传 null 关闭）。 */
  openSoundEditor(objectId: string | null): void;
  /** 改声音层级（同层同时只响一条的那一层）；非声音对象 / 值没变返回 false。 */
  setSoundLayer(objectId: string, layer: SoundLayer): boolean;
  /**
   * 改**传送阵的候选目标场景**（「传送目标」窗口里勾 / 取消勾就是这件事）。
   *
   * 传的是**整份新清单**（去空去重由文档命令做）：窗口那边只看得到「勾了哪些」，
   * 拼出来最直接。清单一变，**选中的那一个跟着走**（移出去的正好是选中的 → 顺到下一条；
   * 一条不剩 → `picked` 删掉）。
   */
  setTeleportTargets(objectId: string, targets: readonly string[]): boolean;
  /**
   * 选「传送」送到哪一个（必须在候选里；`null` = 取消选中）。
   *
   * 与播放声音「点小方块选播哪条」同一个位置、同一套规矩：这是**场景数据**（进撤销栈、
   * 重开项目还在），运行态下改的也一样是「临时改动」（退出运行会还原）。
   */
  setTeleportPicked(objectId: string, target: string | null): boolean;
  /** 打开 / 关闭「传送目标」窗口（传传送阵 id；传 null 关闭）。 */
  openTeleportEditor(objectId: string | null): void;
  /**
   * **触发传送阵**：把整个场景切到它**选中的那个**候选场景（= DM 的「换台」）。
   *
   * 走的就是切场景那条路（`switchScene`）：写回改动 → 记住视口 → 换场景 → 适配 / 恢复视口 →
   * **立刻 `scene_push`**。UI 上它**不改文档、不进撤销栈**——「按一下换台」不是编辑。
   *
   * 返回 `false` 且**写明理由**（写进运行日志）的四种情况：不是传送阵 / 候选是空的 /
   * 还没选（或选的那个已经不在候选里）/ 目标场景不存在（改名或删掉了）或就是当前场景。
   */
  teleport(objectId: string): boolean;
  /** 改地图网格的列数 / 行数（格子按新尺寸重建，重叠部分保留）。 */
  setMapGrid(mapObjectId: string, grid: GridSize): boolean;

  /** 换画笔：可绘制的类型位，或 `CellMask.Empty`（0）= 橡皮擦；其他值忽略。 */
  setGridBrush(mask: number): void;
  /** 改画笔大小（夹到 1..5，与 Unity 一致）。 */
  setGridBrushSize(brushSize: number): void;
  /** 切换某个类型在画布上的显示（只影响绘制）。 */
  toggleGridTypeVisible(bit: number): void;
  /** 改某个类型的颜色（只收 `#rrggbb`）。 */
  setGridTypeColor(bit: number, hex: string): void;
  /** 画布上是否画**网格线**（所有地图；纯显示，不影响数据）。 */
  setGridLinesVisible(visible: boolean): void;
  /** 画布上是否给**格子着色**（所有地图；纯显示，不影响数据）。 */
  setGridAnnotationsVisible(visible: boolean): void;
  /**
   * 标注一笔：`from → to` 之间（含两端）经过的格子按当前画笔刷一遍。
   * `from` 为 null 表示这一笔的起点就是 `to`；连续调用合并成一条撤销记录。
   * 返回是否真的产生了变更（落笔在网格外、重复涂抹都会返回 false）。
   */
  paintGridStroke(mapObjectId: string, from: GridPoint | null, to: GridPoint): boolean;
  /** 一次涂抹结束：断开撤销合并，使下一笔成为独立记录（对齐对象拖动的 `endObjectDrag`）。 */
  endGridStroke(): void;
  /** 清空整张网格（可撤销）。 */
  clearGrid(mapObjectId: string): boolean;

  /**
   * 打开 / 关闭「战争雾 Mask 窗口」（`null` = 关闭）。
   *
   * 与「选择贴图」一样由属性面板的按钮唤出：窗口是模态层，所以**不动**画布上的
   * 选中（关掉窗口就回到原样）。两个格子编辑窗口**互斥**——同时开两层
   * 模态遮罩谁也点不到，所以开一个就把另一个关掉。
   */
  openFogMask(objectId: string | null): void;
  /** 打开 / 关闭「网格编辑窗口」（`null` = 关闭）；与 Mask 窗口互斥。 */
  openGridEditor(objectId: string | null): void;
  /**
   * 指定哪些区域算战争雾（只改绑定，不动格子数据）。
   *
   * 传进来的位先规范化（只留可绘制位、去重、升序）；一个都不指定时：开关**开着**就留一份空的
   * 绑定（面板那一组与开关状态都还在），**关着**才把这份配置整个删掉。
   */
  setFogRegions(mapObjectId: string, regions: readonly number[]): boolean;
  /**
   * 打开 / 关掉这张地图的**战争雾总开关**（文档数据，可撤销、跟着场景存盘下发）。
   *
   * 只有开着，前端才生成那一层雾——关掉是**真的不建**，不是画了再藏起来。
   * 关掉**不清雾区绑定**（再打开就回来）；一个雾区都没指定时会把 `map.fog` 整个摘掉。
   * 正开着的 Mask 窗口跟着关掉（它编辑的那张地图现在没有雾了）。
   */
  setFogEnabled(mapObjectId: string, enabled: boolean): boolean;
  /**
   * 战争雾：在 Mask 窗口里**擦一笔**（运行态才下发给前端）。
   *
   * 拖动中是分批调用的：每一批的点都记进 `fogReveal`（相邻批次并成一条完整轨迹），
   * 有前端连着就顺手发一条 `erase_mask`。`done` 是这一笔的最后一批（抬手 / 取消），
   * 只有它写一条运行日志——不然拖动中会把日志刷屏。
   *
   * 编辑态（没点「运行」）什么都不做：Mask 窗口那时候只是预览，与今天完全一样。
   */
  eraseFogMask(objectId: string, points: readonly FogRevealPoint[], done: boolean): string | undefined;
  /** 战争雾：把某个雾区**整片揭示 / 整片盖回**（与 Mask 窗口右侧那个开关同一件事）。 */
  setFogRegionRevealed(objectId: string, region: number, revealed: boolean): string | undefined;
  /**
   * 把记着的揭示记录补发一遍（前端刚连上时调用）。
   *
   * 返回补发的步数（擦一笔 / 一次整区开合都算一步）；没连服务端或前端不在时返回 0。
   */
  flushFogReveal(): number;
}

/**
 * 平板（触控优先或窄屏）下默认收起左右面板，让场景铺满——
 * 三栏硬挤在平板竖屏上会把中间的场景压没。
 */
function initialUi(): EditorUiState {
  const compact =
    typeof window !== "undefined" &&
    (window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 1024);
  const prefs = readEditorPrefs();

  return {
    leftOpen: !compact,
    rightOpen: !compact,
    runtimeOpen: false,
    tool: prefs.tool,
    bgmPaths: prefs.bgmPaths,
  };
}

/**
 * 场景编辑历史（React 之外持有；store 只订阅其变更）。
 *
 * 场景是独立文件、不进工程文件，所以历史挂在**场景列表**上：对象的新建 / 改名 /
 * 删除 / 移动都经 `applyScenes`，因此天然可撤销；撤销发生在哪个场景就改哪个场景。
 */
export const sceneHistory = new DocumentHistory<readonly SceneDoc[]>([], { limit: 200 });

/**
 * **工程文件**（`project.json`，v15 起才真的有可编辑内容：全局设置的三档音量）的编辑历史。
 *
 * 与 `sceneHistory` 并列而不是合并，是因为两者是**两份文件**：场景各自成文件、工程文件是项目级的。
 * 但用户只该看到一个「撤销」——所以加了 `lastEditTrack`：撤销 / 重做作用在**最近改过的那条轨道**上，
 * 那条轨道撤完了就轮到另一条（见 `undo` / `redo`）。在两套历史之间切换时还要清掉对方的重做栈
 * （`clearRedo`）：否则「撤销 A、改 B、重做」会跳回一个已经不存在的未来。
 */
export const projectHistory = new DocumentHistory<ProjectDoc>(createEmptyProject(), { limit: 200 });

/** 最近一次编辑发生在哪条轨道上（两套历史共用一个撤销入口）。 */
type EditTrack = "scenes" | "project";
let lastEditTrack: EditTrack = "scenes";

/** 撤销入口要能不理泛型地操作两条轨道，所以只依赖这点共同接口。 */
interface EditHistory {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | undefined;
  readonly redoLabel: string | undefined;
  undo(): boolean;
  redo(): boolean;
}

/** 按「先试哪条轨道」的顺序排：最近改过的那条优先，撤完了轮到另一条。 */
function trackOrder(preferred: EditTrack): readonly [EditTrack, EditTrack] {
  return preferred === "project" ? ["project", "scenes"] : ["scenes", "project"];
}

function historyOf(track: EditTrack): EditHistory {
  return track === "scenes" ? sceneHistory : projectHistory;
}

/**
 * 下一次撤销 / 重做会作用在哪条轨道上。
 *
 * 菜单文案与实际执行**共用这一个判定**（`undo` / `redo` / `syncHistoryFlags` 都调它），
 * 所以「撤销 移动对象」点下去必然撤销的就是那件事。两条都没得撤时返回最近改过的那条
 * （此时标签本来就是空的）。
 */
function activeTrack(action: "undo" | "redo"): EditTrack {
  for (const track of trackOrder(lastEditTrack)) {
    if ((action === "undo" ? historyOf(track).canUndo : historyOf(track).canRedo)) {
      return track;
    }
  }

  return lastEditTrack;
}

/** 自动落盘的防抖窗口：连续拖动 / 连续输入只写一次盘。 */
const SCENE_SAVE_DEBOUNCE_MS = 800;

/** 场景里对象位置的默认落点：世界原点。 */
const SCENE_CENTER: WorldPosition = { x: 0, y: 0 };

/**
 * 新建地图对象时的默认贴图尺寸。
 *
 * 贴图按同名约定放在 `Assets/images/<场景名>.png`，网格尺寸由图片算出来，不手写 64×36。
 */
const DEFAULT_MAP_IMAGE = { width: 1920, height: 1080 } as const;

/**
 * 「适配视图」/「复位」/ 首次量到画布尺寸时的默认视野：**同一个算法，只有这一份**。
 *
 * 装的是当前场景里**画布上看得见的东西**（地图 / 精灵 / 徽标…，见 `sceneVisibleRects`），
 * 外框居中、按需缩放，四周留 24px 边距。
 *
 * **只缩不放（上限 1:1）**：装得下就按 1:1 摆中间——「尽量看到所有对象」要的是
 * **别把东西漏在屏幕外**，而不是把小场景放大到糊脸（一张 120×120 的精灵铺满 1400px 的画布
 * 既没有信息量，还会让人以为比例坏了）。装不下才缩，缩到刚好装下。
 *
 * 单独提出来是因为它有三个入口——用户点「复位」/「视图 → 适配视口」，以及**视口尺寸第一次
 * 量出来时**的默认视野（打开场景、转屏、拉开面板）。三处必须同一套算法，否则「默认看到的」
 * 与「按一下复位看到的」会不一样。
 */
export function fitSceneViewport(
  scenes: readonly SceneDoc[],
  activeSceneName: string | null,
  size: { readonly width: number; readonly height: number },
): Viewport {
  const scene = scenes.find((item) => item.name === activeSceneName);
  return fitViewport(sceneVisibleRects(scene), size, 24, { max: 1 });
}

/**
 * 从**原始场景文件 JSON** 里挖出场景尺寸（地图对象的贴图尺寸）。
 *
 * 旧格式的位置是归一化坐标，读文件时就要用它换算成世界坐标——那时还没解析出对象，
 * 所以这里直接看原始 JSON；挖不到就返回 undefined（由 `parseSceneFile` 用兜底尺寸）。
 */
function sceneSizeHint(raw: unknown): ImageSize | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }

  const objects = (raw as { objects?: unknown }).objects;
  if (!Array.isArray(objects)) {
    return undefined;
  }

  for (const object of objects) {
    if (typeof object !== "object" || object === null) {
      continue;
    }

    const map = (object as { map?: unknown }).map;
    if (typeof map !== "object" || map === null) {
      continue;
    }

    const image = (map as { image?: unknown }).image;
    if (typeof image !== "object" || image === null) {
      continue;
    }

    const { width, height } = image as { width?: unknown; height?: unknown };
    if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
      return { width, height };
    }
  }

  return undefined;
}

/** 逻辑 ID 里的文件名（`project:项目/Assets/images/Map001.png` → `Map001.png`）。 */
function fileNameOfResourceId(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash < 0 ? id : id.slice(slash + 1);
}

/**
 * 场景改名时同步**场景名隐式引用**的贴图 ID。
 *
 * 贴图是按「与场景同名」的约定自动指到 `Assets/images/<场景名>.png` 的
 * （见 `projectSceneImageId`）。所以只要某个**地图**的贴图当前指向旧场景名，
 * 就把它改指到新场景名——否则场景一改名，贴图立刻就找不到了。
 *
 * **只动地图的 `map.image`，不动精灵的 `image`**：地图的引用是**约定**（跟着场景名走），
 * 精灵的图片是用户**明确挑的**（哪怕它恰好和场景同名，那也还是他挑的那张文件，
 * 改指到别的文件反而是篡改）。手工指定的其它贴图同理不受影响。
 */
function withRenamedSceneImage(
  project: string,
  file: SceneFileDoc,
  oldName: string,
  newName: string,
): { file: SceneFileDoc; changed: number } {
  const oldFile = `${oldName}.png`;
  let changed = 0;

  const objects = file.objects.map((object) => {
    const map = object.map;
    if (map === undefined || fileNameOfResourceId(map.image.id) !== oldFile) {
      return object;
    }

    changed += 1;
    return {
      ...object,
      map: { ...map, image: { ...map.image, id: projectSceneImageId(project, newName) } },
    };
  });

  return { file: { ...file, objects }, changed };
}

/** 副本相对原对象的偏移量（世界像素，按第几个副本递增，避免整批叠在一起）。 */
const COPY_OFFSET = 24;

/** 复制出来的副本落点：偏移一点（世界无限大，不用夹）。 */
function offsetPosition(position: WorldPosition | null, step: number): WorldPosition {
  const base = position ?? SCENE_CENTER;
  return { x: base.x + COPY_OFFSET * step, y: base.y + COPY_OFFSET * step };
}

/** 在场景列表里按名字找场景（对象编辑都作用于当前场景）。 */
function findSceneByName(
  scenes: readonly SceneDoc[],
  name: string | null,
): SceneDoc | undefined {
  return name === null ? undefined : scenes.find((scene) => scene.name === name);
}

/** 撤销记录上显示的变换动作名（与工具一一对应，用户看到的和点的一致）。 */
const TRANSFORM_LABELS: Record<TransformTool, string> = {
  none: "移动对象",
  move: "移动对象",
  rotate: "旋转对象",
  scale: "缩放对象",
};

/**
 * 场景文件的序列化。
 *
 * 场景名**不进文件**（它就是文件名），所以写出去的内容只有内容本身——
 * 这也是「重命名场景 = 只改文件名」能成立的前提。
 *
 * 写出去之前每个对象都过一遍 `collapseScale`：两轴相等的缩放**只写等比 `scale`**。
 * 少了这一步，用角手柄拖出来的（或单轴拖回等比的）对象会带着 `scaleX` / `scaleY` 落盘，
 * 而那两个字段 Unity 客户端还不认——等比场景本来不需要它们。
 *
 * **按场景对象引用缓存结果**（`WeakMap`）：拖手柄时每一帧都要拿它比对「有没有未保存的改动」，
 * 而一个项目里通常只有一个场景在变——没变的那些场景不该被反复 `JSON.stringify`。
 * 缓存成立的前提是**文档不可变**（immer 每次修改都产出新对象，只有真改过的场景才换引用），
 * 所以拿引用当键不会读到脏文本。
 */
const serializedScenes = new WeakMap<SceneDoc, string>();

export function serializeSceneFile(scene: SceneDoc): string {
  const cached = serializedScenes.get(scene);
  if (cached !== undefined) {
    return cached;
  }

  const file: SceneFileDoc = {
    formatVersion: DOCUMENT_FORMAT_VERSION,
    objects: scene.objects.map(collapseScale),
  };

  const text = `${JSON.stringify(file, null, 2)}\n`;
  serializedScenes.set(scene, text);
  return text;
}

/**
 * 工程文件（`project.json`）的序列化。
 *
 * 与场景文件那套同一个写法（两空格缩进 + 末尾换行），差别只有内容：工程文件里**有项目名**
 * （场景文件里没有，场景名就是文件名），并且带着项目级的那几样东西——道具库与 v15 起的全局设置。
 *
 * `formatVersion` 每次都写当前版本：工程文件里的字段是**会被补齐的**（缺 `settings` 就补一份），
 * 写回时版本号一起前进，磁盘上的文件从此自描述。
 */
export function serializeProjectFile(doc: ProjectDoc): string {
  return `${JSON.stringify({ ...doc, formatVersion: DOCUMENT_FORMAT_VERSION }, null, 2)}\n`;
}

/**
 * 场景的**展示顺序**：中文拼音序 + **数字按数值比**。
 *
 * `numeric: true` 是这条的关键：没有它，`第10幕` 会排在 `第2幕` 前面（逐字符比），
 * 而编号恰恰是 DM 给「跑团顺序」最常用的办法（`01-门厅`、`第2幕-地牢`）。
 * 顺序就是 `scenes` 数组的顺序，切换条、`1`-`9` 直选、上一场 / 下一场都按它走。
 */
export function compareSceneNames(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hans-CN", { numeric: true });
}

/** 在资源树里按条件找节点（找场景目录、按 id 找选中的资源文件）。 */
export function findResourceNode(
  nodes: readonly ResourceTreeNode[],
  match: (node: ResourceTreeNode) => boolean,
): ResourceTreeNode | undefined {
  for (const node of nodes) {
    if (match(node)) {
      return node;
    }

    const found = findResourceNode(node.children ?? [], match);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

const MAX_LOGS = 200;
let logSeq = 0;

function makeLog(level: RuntimeLogEntry["level"], message: string): RuntimeLogEntry {
  logSeq += 1;
  return {
    id: `log_${logSeq}`,
    level,
    message,
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
  };
}

export const useEditorStore = create<EditorStoreState>()((set, get) => {
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
          statusDetail: detail ?? "",
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
        // 揭示记账也是运行态：关闸就清掉（前端已经被踢下线，下次运行重新开始）
        set({ fogReveal: emptyFogReveal(), videoPlayback: emptyVideoPlayback() });
        // 背景音乐同理：回到「什么都没放」（下次进运行态**不会自动出声**，由 DM 点一首）
        set({ bgmPlayback: emptyBgmPlayback() });
      }

      // 前端刚连上：把记着的期望播放状态补发一遍（「点的时候前端不在」也不会丢）
      const plan = soundPlaybackResendPlan({
        wasClientConnected,
        isClientConnected: snapshot.client !== null,
        playback: get().soundPlayback,
      });
      if (plan.length > 0) {
        get().flushSoundPlayback();
      }

      // 视频同理：按对象补发（暂停态的先放再暂停）
      const videoPlan = videoPlaybackResendPlan({
        wasClientConnected,
        isClientConnected: snapshot.client !== null,
        playback: get().videoPlayback,
      });
      if (videoPlan.length > 0) {
        get().flushVideoPlayback();
      }

      // 战争雾同理：前端（重）连上时，把它还没看到的那些揭示轨迹补发一遍
      const fogPlan = fogRevealResendPlan({
        wasClientConnected,
        isClientConnected: snapshot.client !== null,
        reveal: get().fogReveal,
      });
      if (fogPlan.length > 0) {
        get().flushFogReveal();
      }

      // 背景音乐同理：前端刚连上时把它还没听到的那一首补过去（暂停态先放再暂停）。
      // 期望「什么都没放」时 `bgmResendPlan` 返回 null，一条都不发
      const bgmPlan = bgmResendPlan({
        wasClientConnected,
        isClientConnected: snapshot.client !== null,
        playback: get().bgmPlayback,
      });
      if (bgmPlan !== null) {
        get().flushBgmPlayback();
      }
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

  /** 去抖推送：连续拖动 / 连续输入只推最后一次。 */
  const pushScheduler = new ScenePushScheduler({
    // 去抖到点后**重新读一次当前文档**（比排队时那份更新），再决定推不推
    push: (_text) => {
      const scene = currentSceneDoc();
      const nextText = scenePayloadText(scene);
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

      // 文档模型与协议模型结构一致，只差 `RleRun` 的 readonly 标注（服务端还会用 zod 校验一遍）
      runtimeClient.pushScene(scene as ScenePayload | null);
      lastPushedSceneText = nextText;
    },
  });

  /** 立刻推一份全量（进运行态、重连补发用）。 */
  const pushSceneNow = (): void => {
    pushScheduler.flush(scenePayloadText(currentSceneDoc()));
  };

  /** 文档变了就安排一次推送（运行态 + 连着服务端才有意义，由 shouldPushScene 判定）。 */
  const scheduleRuntimePush = (): void => {
    if (get().mode !== "run" || !runtimeClient.connected) {
      return;
    }

    pushScheduler.schedule(scenePayloadText(currentSceneDoc()));
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
   * 把一条「这一层该播什么」**尽力**发给前端。
   *
   * 编辑器没连服务端 / 前端不在时**不发**（状态已经记下），只写明白原因——
   * 等前端连上由 `flushSoundPlayback()` 补发，所以「点的时候前端不在」也不会丢。
   */
  const deliverSoundPlay = (entry: Omit<SoundPlaybackEntry, "paused">): string | undefined => {
    const label = `层级 ${SOUND_LAYER_LABELS[entry.layer]}`;
    const what = entry.clips[0] ?? "(空)";

    if (!runtimeClient.connected) {
      pushLog(makeLog("info", `已记录播放：${label}（${what}；编辑器还没连上服务端，连上后自动补发）`));
      return undefined;
    }

    if (get().runtime.client === null) {
      pushLog(makeLog("info", `已记录播放：${label}（${what}；前端未连接，等它连上后自动补发）`));
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

    if (!runtimeClient.connected) {
      pushLog(makeLog("info", `已记录${what}：${label}（编辑器还没连上服务端，连上后自动补发）`));
      return undefined;
    }

    if (get().runtime.client === null) {
      pushLog(makeLog("info", `已记录${what}：${label}（前端未连接，等它连上后自动补发）`));
      return undefined;
    }

    const requestId = runtimeClient.sendCommand({ kind, layer });
    pushLog(makeLog("info", `下发${what}：${label}`));
    return requestId;
  };

  /**
   * 找出「能揭示战争雾」的对象：当前场景里那张**开了战争雾、也指定了雾区**的地图。
   *
   * 找不到就写一条**说明原因**的运行日志并返回 null（不静默失败）：
   * 这类失败恰恰说明瞄准的目标不对（对象被删了 / 拿精灵去擦雾 / 开关关着 / 还没指定雾区）。
   */
  const fogTargetOf = (objectId: string, what: string): SceneObjectDoc | null => {
    const object = findSceneByName(get().scenes, get().activeSceneName)?.objects.find(
      (item) => item.id === objectId,
    );

    if (object === undefined) {
      pushLog(makeLog("warn", `${what}失败：找不到这个对象（${objectId}）`));
      return null;
    }

    if (object.kind !== "Map") {
      pushLog(makeLog("warn", `${what}失败：「${object.name}」不是地图，没有雾层`));
      return null;
    }

    if (object.map === undefined || !isMapFogEnabled(object.map)) {
      pushLog(makeLog("warn", `${what}失败：「${object.name}」的战争雾开关关着（属性面板 → 战争雾）`));
      return null;
    }

    if ((object.map.fog?.regions ?? []).length === 0) {
      pushLog(makeLog("warn", `${what}失败：「${object.name}」还没指定雾区（属性面板 → 战争雾）`));
      return null;
    }

    return object;
  };

  /** 这个对象**现在**还能揭示雾吗？补发前筛掉没意义的记录用——与 `fogTargetOf` 同口径，但不写日志。 */
  const canRevealFog = (objectId: string): boolean => {
    const object = findSceneByName(get().scenes, get().activeSceneName)?.objects.find(
      (item) => item.id === objectId,
    );

    return (
      object !== undefined &&
      object.kind === "Map" &&
      object.map !== undefined &&
      isMapFogEnabled(object.map) &&
      (object.map.fog?.regions ?? []).length > 0
    );
  };

  /**
   * 找出「能放视频」的对象：当前场景里的**地图或精灵**，且**加了视频也选了那一条**。
   *
   * 与 `fogTargetOf` 同一个口径：找不到就写一条**说明原因**的运行日志并返回 null（不静默失败）。
   * 「能放视频」的判据只有 `supportsVideo` 一处（文档命令与校验走的是同一个函数）。
   */
  const videoTargetOf = (objectId: string, what: string): SceneObjectDoc | null => {
    const object = findSceneByName(get().scenes, get().activeSceneName)?.objects.find(
      (item) => item.id === objectId,
    );

    if (object === undefined) {
      pushLog(makeLog("warn", `${what}失败：找不到这个对象（${objectId}）`));
      return null;
    }

    if (!supportsVideo(object.kind)) {
      pushLog(makeLog("warn", `${what}失败：「${object.name}」不是地图或精灵，放不了视频`));
      return null;
    }

    // 与战争雾那条一模一样的第三种拒绝：开关关着（不是没加视频，也不是没选）
    if (!isVideoEnabled(object)) {
      pushLog(makeLog("warn", `${what}失败：「${object.name}」的视频开关关着（属性面板 → 视频 → 启用）`));
      return null;
    }

    const clips = object.video?.clips ?? [];
    if (clips.length === 0) {
      pushLog(makeLog("warn", `${what}失败：「${object.name}」还没加视频（属性面板 → 视频）`));
      return null;
    }

    const picked = object.video?.picked;
    if (picked === undefined || !clips.includes(picked)) {
      pushLog(makeLog("warn", `${what}失败：「${object.name}」还没选要放哪一条视频`));
      return null;
    }

    return object;
  };

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
    if (!runtimeClient.connected) {
      if (!quiet) {
        pushLog(makeLog("info", `${label}：已记录（编辑器还没连上服务端，连上后自动补发）`));
      }

      return undefined;
    }

    if (get().runtime.client === null) {
      if (!quiet) {
        pushLog(makeLog("info", `${label}：已记录（前端未连接，等它连上后自动补发）`));
      }

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
   * 命令里只有 `objectId + stroke`：雾层在前端**自己镜像里的那张地图**上（`map.fog.regions`
   * + `map.cells`），这里发的只是鼠标拖过的轨迹——参考实现也是这么做的（不发整张遮罩）。
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
    if (!runtimeClient.connected) {
      pushLog(makeLog("info", `${bgmActionLabel(action)}：已记录（编辑器还没连上服务端，连上后自动补发）`));
      return undefined;
    }

    if (get().runtime.client === null) {
      pushLog(makeLog("info", `${bgmActionLabel(action)}：已记录（前端未连接，等它连上后自动补发）`));
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
      canUndo: historyOf("scenes").canUndo || historyOf("project").canUndo,
      canRedo: historyOf("scenes").canRedo || historyOf("project").canRedo,
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
   */
  let runBaseline: {
    readonly scenes: readonly SceneDoc[];
    readonly activeSceneName: string | null;
    readonly doc: ProjectDoc;
  } | null = null;

  /** 拍下当前文档作为运行基线（不动状态、不记日志）。 */
  const snapshotRunBaseline = (): void => {
    runBaseline = {
      scenes: get().scenes,
      activeSceneName: get().activeSceneName,
      doc: projectHistory.current,
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
  let saveTimer: number | null = null;

  /**
   * 上次成功写盘的**工程文件**文本；`null` = 还没装载过（或刚换过文档）。
   *
   * 与 `savedScenes` 同一个用途，只是工程文件只有一份，所以存文本而不是 Map。
   */
  let savedProjectText: string | null = null;
  let projectSaveTimer: number | null = null;

  /** 内存里的工程文件与磁盘不一致（有未保存的全局设置改动）。 */
  const projectDirty = (): boolean =>
    get().project.current !== null && savedProjectText !== serializeProjectFile(projectHistory.current);

  /** 内存里与磁盘不一致的场景名（顺序与 scenes 一致）。 */
  const dirtySceneNames = (): string[] =>
    get()
      .scenes.filter((scene) => savedScenes.get(scene.name) !== serializeSceneFile(scene))
      .map((scene) => scene.name);

  /**
   * 有改动就延迟回写场景文件。
   *
   * 「改了就存」比「记得手动保存」更不容易丢东西，手动保存只是把它提前。
   * 待保存的场景**按内容差异算**，所以撤销 / 重做、跨场景编辑都不会写错文件。
   */
  const scheduleSceneSave = (): void => {
    if (get().project.current === null) {
      return;
    }

    // 运行态下的改动**不落盘**（对齐 Unity 的播放模式）：退出运行时会整体还原，
    // 写盘只会把「临时试出来的样子」留在文件里
    if (get().runtime.runtimeActive) {
      set({ sceneSaveState: "runtime" });
      return;
    }

    set({ sceneSaveState: "pending" });
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
    }

    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void get().saveSceneNow();
    }, SCENE_SAVE_DEBOUNCE_MS);
  };

  /**
   * 有改动就延迟回写**工程文件**（全局设置）。
   *
   * 与场景那套同一份防抖窗口：拖音量滑杆时每一格都会改文档，但只该写一次盘。
   * 运行态下不写（见 `saveProjectNow`）。
   */
  const scheduleProjectSave = (): void => {
    if (get().project.current === null) {
      return;
    }

    if (get().runtime.runtimeActive) {
      set({ projectSaveState: "runtime" });
      return;
    }

    set({ projectSaveState: "pending" });
    if (projectSaveTimer !== null) {
      window.clearTimeout(projectSaveTimer);
    }

    projectSaveTimer = window.setTimeout(() => {
      projectSaveTimer = null;
      void get().saveProjectNow();
    }, SCENE_SAVE_DEBOUNCE_MS);
  };

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

    scheduleSceneSave();
  });

  /**
   * 工程文件（全局设置）的变更：与场景那套对称——同步 doc 与撤销标记、运行态下推给服务端、
   * 编辑态下（去抖）落盘。
   */
  projectHistory.subscribe(() => {
    syncHistoryFlags();
    scheduleSettingsPush();

    if (get().runtime.runtimeActive) {
      set({ projectSaveState: "runtime" });
      return;
    }

    if (!projectDirty()) {
      set({ projectSaveState: "saved" });
      return;
    }

    scheduleProjectSave();
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

  /** 当前场景里按 id 找一个对象（画布与变换用；找不到返回 undefined）。 */
  const currentObjectOf = (id: string): SceneObjectDoc | undefined =>
    findSceneByName(get().scenes, get().activeSceneName)?.objects.find((object) => object.id === id);

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
    }

    // 清选中 / 关窗口 / 清记账这一套**照旧无条件执行**（切到同一个场景时也一样）：
    // 记账记的是「这个场景现在该响什么 / 放什么」，重新打开它就该从「没在播」开始
    set({
      activeSceneName: name,
      selectedObjectIds: [],
      ...(options.clearAssetSelection === true ? { selectedAssetId: null } : {}),
      fogMask: false,
      fogMaskTarget: null,
      gridEditor: false,
      gridEditorTarget: null,
      // 切场景：记账里的对象属于上一个场景，清掉（前端那边由使用方自己按新场景重播）
      soundPlayback: emptySoundPlayback(),
      videoPlayback: emptyVideoPlayback(),
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
    mode: "edit",
    doc: createEmptyProject(),
    scenes: [],
    activeSceneName: null,
    canUndo: false,
    canRedo: false,
    undoLabel: "",
    redoLabel: "",
    selectedObjectIds: [],
    selectedAssetId: null,
    viewport: createViewport(),
    viewportSize: { width: 0, height: 0 },
    ui: initialUi(),
    project: { list: [], current: null, tree: [], busy: false, error: "" },
    bootstrapped: false,
    projectDialog: null,
    sceneDialog: null,
    objectDialog: false,
    imagePicker: false,
    imagePickerTarget: null,
    soundEditor: false,
    soundEditorTarget: null,
    teleportEditor: false,
    teleportEditorTarget: null,
    videoEditor: false,
    videoEditorTarget: null,
    globalSettings: false,
    bgmDialog: false,
    audioTags: false,
    fogMask: false,
    fogMaskTarget: null,
    gridEditor: false,
    gridEditorTarget: null,
    sceneSaveState: "saved",
    sceneSaveError: "",
    projectSaveState: "saved",
    projectSaveError: "",
    gridPaint: {
      mask: storedGridPaint.mask,
      brushSize: storedGridPaint.brushSize,
      hiddenMask: storedGridPaint.hiddenMask,
      colors: storedGridPaint.colors,
      showGridLines: storedGridPaint.showGridLines,
      showAnnotations: storedGridPaint.showAnnotations,
    },
    soundPlayback: emptySoundPlayback(),
    videoPlayback: emptyVideoPlayback(),
    bgmPlayback: emptyBgmPlayback(),
    fogReveal: emptyFogReveal(),
    transformStart: null,
    runtime: {
      status: "idle",
      statusDetail: "",
      runtimeActive: false,
      client: null,
      scene: null,
      resources: null,
      settings: null,
      logs: [],
      lastError: "",
    },

    applyScenes(label, recipe, options) {
      // 订阅里会同步 scenes 与撤销/重做标记，并安排自动落盘
      return sceneHistory.apply(label, recipe, options ?? {});
    },

    applyProject(label, recipe, options) {
      // 与 applyScenes 对称：订阅里会同步 doc、撤销/重做标记与工程文件的落盘
      return projectHistory.apply(label, recipe, options ?? {});
    },

    undo() {
      // 两套历史共用一个撤销入口：作用在**最近改过的那条轨道**上，撤完了轮到另一条
      // （顺序判定只有 `activeTrack` 一处，菜单文案也用它）
      const track = activeTrack("undo");
      const history = historyOf(track);
      if (!history.canUndo) {
        return;
      }

      history.undo();
      lastEditTrack = track;
    },

    redo() {
      const track = activeTrack("redo");
      const history = historyOf(track);
      if (!history.canRedo) {
        return;
      }

      history.redo();
      lastEditTrack = track;
    },

    resetDoc(doc) {
      savedScenes.clear();
      // 换文档了：记着的视口属于上一个项目的同名场景，不能拿来用
      sceneViewports.clear();
      // 订阅里会把 scenes 清空、撤销栈清掉，并把保存状态置回 saved
      sceneHistory.reset([]);
      // 工程文件同理：换项目时这份 doc 就是新的磁盘内容（`openProject` 里已经读过它了）
      projectHistory.reset(doc);
      savedProjectText = serializeProjectFile(doc);
      set({
        doc,
        canUndo: false,
        canRedo: false,
        undoLabel: "",
        redoLabel: "",
        selectedObjectIds: [],
        selectedAssetId: null,
        // 场景是独立文件，由 loadScenes() 装进来；这里只清空当前指向
        scenes: [],
        activeSceneName: null,
        sceneSaveState: "saved",
        sceneSaveError: "",
        projectSaveState: "saved",
        projectSaveError: "",
        // 换了文档：两个格子编辑窗口盯着的地图对象必然失效（偏好留着，下个项目接着用）
        // 两个格子编辑窗口同理：它们指向的地图对象已经不存在了
        fogMask: false,
        fogMaskTarget: null,
        gridEditor: false,
        gridEditorTarget: null,
        // 换了文档：记着的「哪一层该播什么」盯的是上一个项目的对象，清掉
        soundPlayback: emptySoundPlayback(),
        // 视频的记账同理（它是按对象记的），窗口也跟着关
        videoPlayback: emptyVideoPlayback(),
        videoEditor: false,
        videoEditorTarget: null,
        // 背景音乐也是一段记账（清单本身来自项目资源，不随项目变）：回到「什么都没放」，
        // 两个窗口都关掉
        bgmPlayback: emptyBgmPlayback(),
        globalSettings: false,
        bgmDialog: false,
        // 标签表窗口也跟前一个项目的标签表说再见
        audioTags: false,
        // 战争雾的揭示记账同理：瞄准的对象已经不存在了
        fogReveal: emptyFogReveal(),
      });

      // 文档整份换掉了（关项目 / 换文档）：运行中的话基线要跟着换，否则退出运行会把
      // 上一个项目的场景还原回来
      refreshRunBaseline();
    },

    setActiveScene(name) {
      switchScene(name);
    },

    openScene(name) {
      if (!get().scenes.some((scene) => scene.name === name)) {
        return;
      }

      // 打开场景 = 切到它并清掉别的选中：属性面板接着显示这个场景（并记一条运行日志）
      switchScene(name, { clearAssetSelection: true, log: true });
    },

    openSceneByIndex(index) {
      const names = get().scenes.map((scene) => scene.name);
      const name = names[index];
      if (name === undefined) {
        return false;
      }

      switchScene(name, { clearAssetSelection: true, log: true });
      return true;
    },

    openAdjacentScene(delta) {
      const names = get().scenes.map((scene) => scene.name);
      const current = names.indexOf(get().activeSceneName ?? "");
      const next = current + delta;
      // 到端点就什么都不做（**不循环**：开场按「上一场」跳到最后一幕比没反应更让人困惑）
      if (current < 0 || next < 0 || next >= names.length) {
        return false;
      }

      switchScene(names[next] as string, { clearAssetSelection: true, log: true });
      return true;
    },

    setSelection(objectIds) {
      const next = [...objectIds];
      // 选中对象就取消资源选中：属性面板一次只显示一样东西
      set({ selectedObjectIds: next, selectedAssetId: null });
    },

    selectAsset(id) {
      set({ selectedAssetId: id, selectedObjectIds: [] });
    },

    setViewport(viewport) {
      viewportAdjusted = true;
      set({ viewport });
    },

    zoomAtScreen(anchor, factor) {
      viewportAdjusted = true;
      set({ viewport: zoomAt(get().viewport, factor, anchor) });
    },

    panByScreen(dx, dy) {
      viewportAdjusted = true;
      set({ viewport: panBy(get().viewport, dx, dy) });
    },

    fitToViewport() {
      const { scenes, activeSceneName, viewportSize } = get();
      // 视口尺寸还没量出来时退回「世界原点居中 1:1」（此刻算不出该缩到多少）
      if (viewportSize.width === 0 || viewportSize.height === 0) {
        viewportAdjusted = false;
        set({ viewport: createViewport() });
        return;
      }

      viewportAdjusted = true;
      set({ viewport: fitSceneViewport(scenes, activeSceneName, viewportSize) });
    },

    setViewportSize(size) {
      const previous = get().viewportSize;
      if (previous.width === size.width && previous.height === size.height) {
        return;
      }

      // 尺寸首次确定或用户还没调过视口时**直接适配**：打开场景 / 转屏 / 拉开面板之后
      // 第一眼就该看到整个场景（而不是世界原点周围那一块，让对象散在屏幕外）
      if (!viewportAdjusted) {
        set({
          viewportSize: size,
          viewport: fitSceneViewport(get().scenes, get().activeSceneName, size),
        });
        return;
      }

      set({ viewportSize: size });
    },

    setUi(patch) {
      set((state) => ({ ui: { ...state.ui, ...patch } }));
    },

    setMode(mode) {
      /*
        编辑 / 运行是**服务端的状态**（`runtimeActive`），这里只负责「请服务端改一下」，
        界面等 `editor_state` 回来再跟着变——所以刷新页面不会退出运行态，也不会把前端踢掉。
        连接是页面加载就连上的（bootstrapEditor），编辑态也连着，这样随时知道服务端在不在运行。
      */
      if (mode === "run") {
        // 用户主动点「运行」：顺手展开运行面板，否则切过去界面毫无反馈、功能不可发现
        set((state) => ({ ui: { ...state.ui, runtimeOpen: true } }));

        if (!runtimeClient.connected) {
          // 还没连上服务端：先记下「用户要运行」，把连接踢一脚，连上后 `onOpen` 补发
          pendingRunRequest = true;
          get().connectRuntime();
          pushLog(makeLog("info", "正在连接服务端…连上后自动进入运行态"));
          return;
        }

        runtimeClient.startRuntime();
        // 立刻推一份全量：不等 editor_state 回来，前端能更早拿到场景
        get().pushRuntimeScene();
        return;
      }

      // 退出运行态：服务端关闸并踢掉前端。连接保留（编辑态也要知道服务端状态）
      pendingRunRequest = false;
      pushScheduler.cancel();
      lastPushedSceneText = null;
      if (runtimeClient.connected) {
        runtimeClient.stopRuntime();
        return;
      }

      pushLog(makeLog("warn", "与服务端断开，连上后自动同步运行态"));
    },

    connectRuntime() {
      runtimeClient.connect();
    },

    pushRuntimeScene() {
      pushSceneNow();
    },

    // ---------------------------------------------------------------- 声音对象

    playSound(objectId) {
      const object = findSceneByName(get().scenes, get().activeSceneName)?.objects.find(
        (item) => item.id === objectId,
      );
      if (object === undefined || object.kind !== "PlaySound") {
        pushLog(makeLog("error", "找不到这个声音对象"));
        return undefined;
      }

      const sound = object.sound;
      const clips = sound?.clips ?? [];
      if (clips.length === 0) {
        pushLog(makeLog("error", `${object.name}：还没有加音频，先在「编辑声音」窗口里加一条`));
        return undefined;
      }

      // 播的就是**选中的那一条**（面板上点小方块切）。手写文件里 `picked` 可能不在列表里，
      // 那种按「还没选」处理，别拿一条对不上的音频去播。
      const picked = sound?.picked;
      if (picked === undefined || !clips.includes(picked)) {
        pushLog(makeLog("error", `${object.name}：还没选声音，先选一条`));
        return undefined;
      }

      /*
        背景音乐不再属于对象（它走顶栏「音乐」弹框 + `play_bgm` 那一组命令）。
        老文件里写着 `layer: "bgm"` 的对象**照样读得回来**，但播放会被前端明确拒掉——
        与其让它走一趟注定失败的下发，不如在这里就说清楚该去哪儿（前端那边也有一份同样的说法）。
      */
      const objectLayer = sound?.layer ?? DEFAULT_SOUND_LAYER;
      if (objectLayer === "bgm") {
        pushLog(
          makeLog(
            "warn",
            `「${object.name}」用的是背景音乐层：背景音乐已改成顶栏「音乐」弹框（点项目音频），` +
              "请把这条改成音效或旁白",
          ),
        );
        return undefined;
      }

      // 先记账（「这一层现在该播什么」），再尽力下发——所以编辑器没连服务端 / 前端不在
      // 也点得动：状态记着，等前端连上补发
      const entry: Omit<SoundPlaybackEntry, "paused"> = {
        objectId,
        layer: objectLayer,
        clips: [picked],
      };
      set({ soundPlayback: withPlaying(get().soundPlayback, entry) });

      return deliverSoundPlay(entry);
    },

    stopSound(objectId) {
      const object = findSceneByName(get().scenes, get().activeSceneName)?.objects.find(
        (item) => item.id === objectId,
      );
      if (object === undefined || object.kind !== "PlaySound") {
        pushLog(makeLog("error", "找不到这个声音对象"));
        return undefined;
      }

      const layer = object.sound?.layer ?? DEFAULT_SOUND_LAYER;
      set({ soundPlayback: withStopped(get().soundPlayback, layer) });

      return deliverSoundControl("stop_sound", layer, "停止");
    },

    pauseSound(objectId) {
      const object = findSceneByName(get().scenes, get().activeSceneName)?.objects.find(
        (item) => item.id === objectId,
      );
      if (object === undefined || object.kind !== "PlaySound") {
        pushLog(makeLog("error", "找不到这个声音对象"));
        return undefined;
      }

      const layer = object.sound?.layer ?? DEFAULT_SOUND_LAYER;
      const label = `层级 ${SOUND_LAYER_LABELS[layer]}`;

      // 同层只响一条：这一层不是它在响时，暂停无从谈起——写明是谁在响，别发一条注定没意义的命令
      const holder = get().soundPlayback.layers[layer];
      if (holder === undefined || holder.objectId !== objectId) {
        pushLog(
          makeLog(
            "warn",
            `暂停失败：「${object.name}」所在的${label}没在播它（${
              holder === undefined ? "这一层没在播" : "这一层是别的对象在响"
            }）`,
          ),
        );
        return undefined;
      }

      set({ soundPlayback: withSoundPaused(get().soundPlayback, layer, true) });
      return deliverSoundControl("pause_sound", layer, "暂停");
    },

    resumeSound(objectId) {
      const object = findSceneByName(get().scenes, get().activeSceneName)?.objects.find(
        (item) => item.id === objectId,
      );
      if (object === undefined || object.kind !== "PlaySound") {
        pushLog(makeLog("error", "找不到这个声音对象"));
        return undefined;
      }

      const layer = object.sound?.layer ?? DEFAULT_SOUND_LAYER;
      const entry = get().soundPlayback.layers[layer];
      if (entry === undefined || entry.objectId !== objectId) {
        pushLog(
          makeLog("warn", `继续播放失败：「${object.name}」所在的层级 ${SOUND_LAYER_LABELS[layer]} 没在播它`),
        );
        return undefined;
      }

      set({ soundPlayback: withSoundPaused(get().soundPlayback, layer, false) });
      return deliverSoundControl("resume_sound", layer, "继续播放");
    },

    flushSoundPlayback() {
      const { runtime, soundPlayback } = get();
      if (!runtimeClient.connected || runtime.client === null) {
        return 0;
      }

      const entries = Object.values(soundPlayback.layers);
      for (const entry of entries) {
        runtimeClient.sendCommand({
          kind: "play_sound",
          objectId: entry.objectId,
          layer: entry.layer,
        });

        // 暂停态：先播再暂停，前端才停在原处（只发 pause 的话它根本没在响）——与视频同一套
        if (entry.paused) {
          runtimeClient.sendCommand({ kind: "pause_sound", layer: entry.layer });
        }

        pushLog(
          makeLog(
            "info",
            `补发播放：层级 ${SOUND_LAYER_LABELS[entry.layer]}（${entry.clips[0] ?? "(空)"}${
              entry.paused ? "，暂停态" : ""
            }）`,
          ),
        );
      }

      return entries.length;
    },

    // ---------------------------------------------------------------- 视频（地图 / 精灵）

    playVideo(objectId) {
      const object = videoTargetOf(objectId, "播放视频");
      if (object === null) {
        return undefined;
      }

      const video = object.video;
      const clip = video?.picked;
      if (clip === undefined) {
        // `videoTargetOf` 已经拦过这种情况，这里只是把类型收窄（同时兜住手写文件的坏数据）
        pushLog(makeLog("warn", `播放视频失败：「${object.name}」还没选要放哪一条视频`));
        return undefined;
      }

      // 先记账（「这个对象现在该放什么」），再尽力下发——所以编辑器没连服务端 / 前端不在
      // 也点得动：状态记着，等前端连上补发
      const entry: Omit<VideoPlaybackEntry, "paused"> = {
        objectId,
        clip,
        loop: video?.loop ?? false,
        audio: video?.audio ?? false,
      };
      set({ videoPlayback: withVideoPlaying(get().videoPlayback, entry) });

      return deliverVideo("play_video", objectId, `播放视频（${clip}）`);
    },

    pauseVideo(objectId) {
      const object = videoTargetOf(objectId, "暂停视频");
      if (object === null) {
        return undefined;
      }

      // 没在记账里 = 这个对象没在放：写明白，别发一条注定被前端拒的命令
      if (get().videoPlayback.objects[objectId] === undefined) {
        pushLog(makeLog("warn", `暂停视频失败：「${object.name}」没在放视频`));
        return undefined;
      }

      set({ videoPlayback: withVideoPaused(get().videoPlayback, objectId, true) });
      return deliverVideo("pause_video", objectId, "暂停视频");
    },

    resumeVideo(objectId) {
      const object = videoTargetOf(objectId, "继续播放视频");
      if (object === null) {
        return undefined;
      }

      if (get().videoPlayback.objects[objectId] === undefined) {
        pushLog(makeLog("warn", `继续播放失败：「${object.name}」没在放视频（先点「播放」）`));
        return undefined;
      }

      set({ videoPlayback: withVideoPaused(get().videoPlayback, objectId, false) });
      return deliverVideo("resume_video", objectId, "继续播放视频");
    },

    stopVideo(objectId) {
      // 停**不要求**还选着一条视频 / 还是地图或精灵：对象被改成别的类型之后，
      // 前端那一层还挂着，「停止」得照样能拆掉它
      const object = findSceneByName(get().scenes, get().activeSceneName)?.objects.find(
        (item) => item.id === objectId,
      );

      const tracked = get().videoPlayback.objects[objectId] !== undefined;
      if (object === undefined && !tracked) {
        pushLog(makeLog("warn", `停止视频失败：找不到这个对象（${objectId}）`));
        return undefined;
      }

      set({ videoPlayback: withVideoStopped(get().videoPlayback, objectId) });
      return deliverVideo("stop_video", objectId, "停止视频");
    },

    flushVideoPlayback() {
      const { runtime, videoPlayback } = get();
      if (!runtimeClient.connected || runtime.client === null) {
        return 0;
      }

      const entries = Object.values(videoPlayback.objects);
      for (const entry of entries) {
        // 补发不发日志（逐条写会把运行日志刷屏），末尾汇总一条
        deliverVideo("play_video", entry.objectId, "补发视频", true);

        // 暂停态：先放再暂停，前端才回到同一帧（只发 pause 的话它根本没在放）
        if (entry.paused) {
          deliverVideo("pause_video", entry.objectId, "补发视频（暂停）", true);
        }
      }

      if (entries.length > 0) {
        const paused = entries.filter((entry) => entry.paused).length;
        pushLog(
          makeLog(
            "info",
            `补发视频：${entries.length} 个对象${paused === 0 ? "" : `（其中 ${paused} 个是暂停态）`}` +
              "（前端刚连上，把它还没看到的那些放送补过去）",
          ),
        );
      }

      return entries.length;
    },

    clearRuntimeLogs() {
      set((state) => ({ runtime: { ...state.runtime, logs: [] } }));
    },

    // ---------------------------------------------------------------- 全局背景音乐（弹框里点一首）

    playBgm(clip) {
      set({ bgmPlayback: withBgmPlaying(get().bgmPlayback, clip) });

      /*
        显式下发：DM 再点同一首的意思就是「从头再放一遍」，那条命令必须真的发出去
        （补发那条路只在「前端刚连上」走一次，不参与这里的判断）。
      */
      return deliverBgm({ kind: "play", clip });
    },

    pauseBgm() {
      const playback = get().bgmPlayback;
      const next = withBgmPaused(playback, true);
      if (next === playback) {
        // 没在放就没有「这一首」可暂停（编辑器不知道前端此刻手里是什么）
        pushLog(makeLog("warn", "还没点过曲子：先在弹框里点一首"));
        return undefined;
      }

      set({ bgmPlayback: next });
      return deliverBgm({ kind: "pause" });
    },

    resumeBgm() {
      const playback = get().bgmPlayback;
      const next = withBgmPaused(playback, false);
      if (next === playback) {
        pushLog(makeLog("warn", "现在没有暂停着的背景音乐"));
        return undefined;
      }

      set({ bgmPlayback: next });
      return deliverBgm({ kind: "resume" });
    },

    stopBgm() {
      set({ bgmPlayback: withBgmStopped(get().bgmPlayback) });
      return deliverBgm({ kind: "stop" });
    },

    flushBgmPlayback() {
      return flushBgm();
    },

    openGlobalSettings(open) {
      set({ globalSettings: open });
    },

    openBgmDialog(open) {
      set({ bgmDialog: open });
    },

    // ---------------------------------------------------------------- 项目级数据：音频文件标注（显示名 + 标签）

    setAudioName(clipId, name) {
      // 连续敲名字合成一条撤销记录（与音量滑杆同一套写法）
      return get().applyProject(
        name.trim().length === 0 ? "清除音频文件名字" : "修改音频文件名字",
        (draft) => {
          setProjectAudioName(draft, clipId, name);
        },
        { coalesceKey: `audio-name:${clipId}` },
      );
    },

    setAudioTags(clipId, tagIds) {
      // 勾一个标签是**离散**动作，所以不合并撤销记录：一次撤销就退回上一个勾选状态
      return get().applyProject("修改音频文件标签", (draft) => {
        setProjectAudioTags(draft, clipId, tagIds);
      });
    },

    renameAudioTag(tagId, name) {
      return get().applyProject("修改标签名字", (draft) => {
        renameProjectAudioTag(draft, tagId, name);
      });
    },

    /**
     * 给**指定的序号**命名（序号不够长就把它补出来）。
     *
     * 「标签」窗口的序号是预先列好的，人往 `#3` 那个格子里敲名字，3 就是它以后的 ID——
     * 所以这里走的是 `setAudioTagName`（允许补槽），而不是只改已存在槽位的 `renameAudioTag`。
     */
    setAudioTagName(tagId, name) {
      return get().applyProject(`命名标签 #${tagId}`, (draft) => {
        setProjectAudioTagName(draft, tagId, name);
      });
    },

    // 说明：「标签」窗口只填名字、「选择标签」框只勾选——**两个入口都不新建标签**。
    // 所以「新建并挂上」那条 store 动作也一并去掉了；文档层的 `addAudioTag`
    // （选第一个洞、没有就追加）仍留着：它是标签表的底层能力，别处（迁移 / 将来的工具）还要用。
    openAudioTags(open) {
      set({ audioTags: open });
    },

    // ---------------------------------------------------------------- 全局设置（工程文件：三档音量）

    setBgmVolume(volume) {
      // 音量滑杆拖动中每一步都改文档：同一个 coalesceKey 让它们合成一条撤销记录
      return get().applyProject(
        "调整背景音乐音量",
        (draft) => {
          setProjectBgmVolume(draft, volume);
        },
        { coalesceKey: "bgm:volume" },
      );
    },

    setSfxVolume(volume) {
      return get().applyProject(
        "调整音效音量",
        (draft) => {
          setProjectSfxVolume(draft, volume);
        },
        { coalesceKey: "sfx:volume" },
      );
    },

    setVoiceVolume(volume) {
      return get().applyProject(
        "调整旁白音量",
        (draft) => {
          setProjectVoiceVolume(draft, volume);
        },
        { coalesceKey: "voice:volume" },
      );
    },

    // ---------------------------------------------------------------- 项目

    openProjectDialog(mode) {
      set({ projectDialog: mode });
    },

    async bootstrapEditor() {
      if (bootstrapping || get().bootstrapped) {
        return;
      }

      // 同步占位：StrictMode 下 effect 会跑两次，不能弹两次对话框
      bootstrapping = true;

      // 页面加载就连服务端：**运行态存在服务端**，连上才知道「现在是在运行还是编辑」
      // （刷新页面后如果服务端还在运行，editor_state 会把界面切回运行态，前端不会被踢）
      get().connectRuntime();

      try {
        await get().refreshProjects();

        if (get().project.error.length > 0) {
          // 列不出来（多半是连不上服务端）：别误导性地引导「新建」，把错误摆在对话框里
          set({ projectDialog: "open" });
          return;
        }

        const list = get().project.list;

        // 1) 上次打开的项目还在 → 直接回到它
        const remembered = readLastProject();
        if (remembered !== null) {
          if (
            list.some((item) => item.name === remembered) &&
            (await get().openProject(remembered))
          ) {
            return;
          }

          // 记录已失效（项目被删 / 改名 / 项目文件坏了）：忘掉它，免得每次启动都白试一遍
          clearLastProject();
        }

        // 2) 一个项目都没有 → 引导新建；3) 有项目但没记录 → 让用户挑
        set({ projectDialog: list.length === 0 ? "create" : "open" });
      } finally {
        // 标记「引导已完成」：外部据此判断该弹的对话框已经弹出来了
        set({ bootstrapped: true });
      }
    },

    async refreshProjects() {
      set((state) => ({ project: { ...state.project, busy: true, error: "" } }));
      try {
        const list = await projectApi.list();
        set((state) => ({ project: { ...state.project, list, busy: false } }));
      } catch (error) {
        set((state) => ({
          project: {
            ...state.project,
            busy: false,
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    },

    async createProject(name) {
      set((state) => ({ project: { ...state.project, busy: true, error: "" } }));
      try {
        await projectApi.create(name);
        await get().refreshProjects();
        return await get().openProject(name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ project: { ...state.project, busy: false, error: message } }));
        pushLog(makeLog("error", `新建项目失败：${message}`));
        return false;
      }
    },

    async openProject(name) {
      // 切项目前先把上一个项目里未保存的改动写回
      await get().flushSceneSave();

      set((state) => ({ project: { ...state.project, busy: true, error: "" } }));
      try {
        const text = await projectApi.readText(projectFileId(name));
        const load = parseProjectFile(JSON.parse(text) as unknown);

        // 上一个项目的贴图不该继续占内存（缓存按逻辑 ID，跨项目也不会互相命中）
        clearSceneImageCache();
        get().resetDoc(load.doc);

        // 旧版工程文件：把内联场景落成独立文件，工程文件按新格式回写（只做一次）。
        // v15 起「缺 `settings`」也算需要回写（全局设置会被补一份默认的落进文件）。
        if (load.migratedScenes.length > 0 || load.needsRewrite) {
          for (const scene of load.migratedScenes) {
            await projectApi.writeText(
              projectSceneFileId(name, scene.name),
              serializeSceneFile(scene),
            );
          }

          await projectApi.writeText(projectFileId(name), serializeProjectFile(load.doc));
          pushLog(
            makeLog("info", `工程文件已升级到 v${DOCUMENT_FORMAT_VERSION}（场景拆成 ${load.migratedScenes.length} 个文件）`),
          );
        }

        const tree = await projectApi.tree(name);
        set((state) => ({ project: { ...state.project, current: name, tree, busy: false } }));
        await get().loadScenes();
        // 记住了下次启动才能自动回到它
        writeLastProject(name);
        pushLog(makeLog("info", `已打开项目：${name}`));
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ project: { ...state.project, busy: false, error: message } }));
        pushLog(makeLog("error", `打开项目失败：${message}`));
        return false;
      }
    },

    closeProject() {
      // 待保存的改动先写回：flush 内部会**同步**取好场景快照，所以随后的清空不会把它丢掉
      void get().flushSceneSave();
      clearSceneImageCache();
      set((state) => ({ project: { ...state.project, current: null, tree: [], error: "" } }));
      // 主动关闭 = 不想再看到它，下次启动不该又把它拉回来
      clearLastProject();
      get().resetDoc(createEmptyProject());
    },

    async deleteProject(name) {
      try {
        await projectApi.remove(name);
        if (readLastProject() === name) {
          clearLastProject();
        }

        if (get().project.current === name) {
          get().closeProject();
        }

        await get().refreshProjects();
        pushLog(makeLog("info", `已删除项目：${name}`));
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ project: { ...state.project, error: message } }));
        pushLog(makeLog("error", `删除项目失败：${message}`));
        return false;
      }
    },

    async refreshTree() {
      const project = get().project.current;
      if (project === null) {
        return;
      }

      try {
        const tree = await projectApi.tree(project);
        set((state) => ({ project: { ...state.project, tree, error: "" } }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ project: { ...state.project, error: message } }));
      }
    },

    async createFolder(path) {
      const project = get().project.current;
      if (project === null) {
        return false;
      }

      try {
        await projectApi.createFolder(project, path);
        await get().refreshTree();
        pushLog(makeLog("info", `已创建目录：${path}`));
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ project: { ...state.project, error: message } }));
        pushLog(makeLog("error", `创建目录失败：${message}`));
        return false;
      }
    },

    async openProjectFolder(target = "", selectFile = false) {
      const project = get().project.current;
      if (project === null) {
        return false;
      }

      try {
        const opened = await projectApi.reveal(project, target, selectFile);
        // 顺手清掉上一次的错误：成功了还挂着红字会让人以为没成功
        set((state) => ({ project: { ...state.project, error: "" } }));
        // 日志里带上**项目内**的相对路径：后端回的是绝对路径，人看的是「打开的是哪一个」
        const what = selectFile ? "文件" : "目录";
        const where = target.length === 0 ? "" : `（${target}）`;
        pushLog(makeLog("info", `已打开${what}${where}：${opened}`));
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ project: { ...state.project, error: message } }));
        pushLog(makeLog("error", `打开项目目录失败：${message}`));
        return false;
      }
    },

    async uploadFiles(dirPath, files) {
      const project = get().project.current;
      if (project === null || files.length === 0) {
        return;
      }

      try {
        for (const file of files) {
          const relative = dirPath.length > 0 ? `${dirPath}/${file.name}` : file.name;
          await projectApi.uploadBinary(
            projectAssetId(project, relative),
            await file.arrayBuffer(),
            contentTypeFor(file.name),
          );
        }

        await get().refreshTree();
        pushLog(makeLog("info", `已导入 ${files.length} 个资源`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ project: { ...state.project, error: message } }));
        pushLog(makeLog("error", `导入资源失败：${message}`));
      }
    },

    async deleteResource(id, label) {
      try {
        await projectApi.deleteResource(id);
        await get().refreshTree();
        pushLog(makeLog("info", `已删除：${label}`));
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ project: { ...state.project, error: message } }));
        pushLog(makeLog("error", `删除失败：${message}`));
        return false;
      }
    },

    // ---------------------------------------------------------------- 场景

    async saveSceneNow() {
      const project = get().project.current;
      if (project === null) {
        return false;
      }

      // 运行态下不写盘：这些改动退出运行时会被整体还原（对齐 Unity 的播放模式）
      if (get().runtime.runtimeActive) {
        if (saveTimer !== null) {
          window.clearTimeout(saveTimer);
          saveTimer = null;
        }

        set({ sceneSaveState: "runtime" });
        pushLog(makeLog("info", "运行态：改动不会保存（点「编辑」退出运行会还原到进入运行前的样子）"));
        return false;
      }

      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }

      // 同步取快照：调用方可能紧接着清空内存（例如关闭项目）
      const dirty = get().scenes.filter(
        (scene) => savedScenes.get(scene.name) !== serializeSceneFile(scene),
      );
      if (dirty.length === 0) {
        set({ sceneSaveState: "saved", sceneSaveError: "" });
        return true;
      }

      set({ sceneSaveState: "saving", sceneSaveError: "" });
      try {
        for (const scene of dirty) {
          const text = serializeSceneFile(scene);
          await projectApi.writeText(projectSceneFileId(project, scene.name), text);
          savedScenes.set(scene.name, text);
        }

        set({ sceneSaveState: "saved" });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ sceneSaveState: "error", sceneSaveError: message });
        pushLog(makeLog("error", `保存场景失败：${message}`));
        return false;
      }
    },

    async flushSceneSave() {
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }

      if (get().project.current === null || dirtySceneNames().length === 0) {
        return;
      }

      await get().saveSceneNow();
    },

    // ---------------------------------------------------------------- 工程文件（音量 / 音频标注）

    async saveProjectNow() {
      const project = get().project.current;
      if (project === null) {
        return false;
      }

      // 运行态下不写盘：工程文件（三档音量 / 音频标注）同样是文档数据
      // （改音量立刻生效、退出运行会还原）
      if (get().runtime.runtimeActive) {
        if (projectSaveTimer !== null) {
          window.clearTimeout(projectSaveTimer);
          projectSaveTimer = null;
        }

        set({ projectSaveState: "runtime" });
        pushLog(
          makeLog("info", "运行态：工程文件（音量 / 音频标注）不会保存（点「编辑」退出运行会还原）"),
        );
        return false;
      }

      if (projectSaveTimer !== null) {
        window.clearTimeout(projectSaveTimer);
        projectSaveTimer = null;
      }

      // 同步取快照：调用方可能紧接着清空内存（例如关闭项目）
      const text = serializeProjectFile(projectHistory.current);
      if (savedProjectText === text) {
        set({ projectSaveState: "saved", projectSaveError: "" });
        return true;
      }

      set({ projectSaveState: "saving", projectSaveError: "" });
      try {
        await projectApi.writeText(projectFileId(project), text);
        savedProjectText = text;
        set({ projectSaveState: "saved" });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ projectSaveState: "error", projectSaveError: message });
        pushLog(makeLog("error", `保存工程文件失败：${message}`));
        return false;
      }
    },

    async flushProjectSave() {
      if (projectSaveTimer !== null) {
        window.clearTimeout(projectSaveTimer);
        projectSaveTimer = null;
      }

      if (!projectDirty()) {
        return;
      }

      await get().saveProjectNow();
    },

    async loadScenes() {
      const project = get().project.current;
      if (project === null) {
        set({ scenes: [], activeSceneName: null });
        // 文档整份被换掉（这里是被清空）：运行中的话，基线要跟着换
        refreshRunBaseline();
        return;
      }

      try {
        const folder = findResourceNode(
          get().project.tree,
          (node) => node.path === PROJECT_FOLDERS.scenes,
        );
        const files = (folder?.children ?? []).filter(
          (node) => node.type === "file" && node.name.endsWith(PROJECT_SCENE_FILE_EXTENSION),
        );

        const scenes: SceneDoc[] = [];
        const legacy: SceneDoc[] = [];
        for (const file of files) {
          const text = await projectApi.readText(file.id);
          const raw: unknown = JSON.parse(text);
          // 旧格式（v4 及更早）的位置是归一化坐标，换算成世界坐标需要场景尺寸：
          // 先看文件里地图对象的贴图尺寸，没有再退回默认尺寸。
          const parsed = parseSceneFile(raw, sceneSizeHint(raw));
          const scene: SceneDoc = {
            // 场景名就是文件名，文件内容里不存名字
            name: file.name.slice(0, -PROJECT_SCENE_FILE_EXTENSION.length),
            objects: parsed.file.objects,
          };

          scenes.push(scene);
          if (parsed.needsRewrite) {
            legacy.push(scene);
          }
        }

        scenes.sort((a, b) => compareSceneNames(a.name, b.name));

        // 旧格式的场景文件（带着已废弃的字段）按新格式回写一次——只做一次
        for (const scene of legacy) {
          await projectApi.writeText(
            projectSceneFileId(project, scene.name),
            serializeSceneFile(scene),
          );
        }

        // 记下每个场景「磁盘上的样子」：之后的未保存改动就是拿它比出来的
        savedScenes.clear();
        // 场景是**重新读盘**的（打开 / 切换项目、增删改名后重读）：记着的视口按名字对不上了
        sceneViewports.clear();
        for (const scene of scenes) {
          savedScenes.set(scene.name, serializeSceneFile(scene));
        }
        set({ sceneSaveState: "saved", sceneSaveError: "" });

        const previous = get().activeSceneName;
        const keep = scenes.some((scene) => scene.name === previous);
        // 把装载进来的场景交给历史容器：**对象编辑的 recipe 都在它上面改**，
        // 忘了这一步的话 `applyScenes` 会在空数组里找场景、永远「没产生变更」。
        // 场景级操作（增删改名 / 重新打开项目）不入撤销栈，所以这里直接 reset。
        sceneHistory.reset(scenes);
        set({
          scenes,
          activeSceneName: keep ? previous : (scenes[0]?.name ?? null),
          selectedObjectIds: [],
          // 场景重新装载过：对象 id 可能全换了，两个格子编辑窗口盯着的对象 id 也未必还存在
          fogMask: false,
          fogMaskTarget: null,
          gridEditor: false,
          gridEditorTarget: null,
        });

        // 文档整份换掉了（打开 / 重新装载项目、增删改名场景后重读）：运行中的话基线要跟着换
        refreshRunBaseline();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ project: { ...state.project, error: message } }));
        pushLog(makeLog("error", `读取场景失败：${message}`));
      }
    },

    openSceneDialog(mode) {
      set({ sceneDialog: mode });
    },

    openObjectDialog(open) {
      set({ objectDialog: open });
    },

    async createScene(name) {
      const project = get().project.current;
      if (project === null) {
        return "还没有打开项目";
      }

      // 场景的增 / 删 / 改名是**文件操作**（立刻落盘），运行态下不允许：
      // 那种改动退出运行时还原不回来（文件已经建/删了），所以干脆挡在这里
      if (get().runtime.runtimeActive) {
        return "运行态下不能新建场景，先点「编辑」退出运行";
      }

      // 先把手上的改动写回，免得紧接着的 loadScenes 把它们冲掉
      await get().flushSceneSave();

      const trimmed = name.trim();
      const reason = validateSceneName(trimmed);
      if (reason !== undefined) {
        return reason;
      }

      if (isSceneNameTaken(get().scenes, trimmed)) {
        return `场景「${trimmed}」已存在`;
      }

      try {
        // 新场景是**空场景**；内容之后由外部工具填，编辑器不再写它
        await projectApi.writeText(
          projectSceneFileId(project, trimmed),
          serializeSceneFile(createEmptyScene(trimmed)),
        );
        await get().refreshTree();
        await get().loadScenes();
        get().setActiveScene(trimmed);
        pushLog(makeLog("info", `已新建场景：${trimmed}`));
        return undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushLog(makeLog("error", `新建场景失败：${message}`));
        return message;
      }
    },

    async renameScene(name) {
      const project = get().project.current;
      const current = get().activeSceneName;
      if (project === null || current === null) {
        return "还没有可以重命名的场景";
      }

      if (get().runtime.runtimeActive) {
        return "运行态下不能重命名场景，先点「编辑」退出运行";
      }

      // 先写回：改名只搬文件，待保存的改动必须落进被搬的那个文件里
      await get().flushSceneSave();

      const trimmed = name.trim();
      const reason = validateSceneName(trimmed);
      if (reason !== undefined) {
        return reason;
      }

      if (trimmed === current) {
        return undefined;
      }

      if (isSceneNameTaken(get().scenes, trimmed)) {
        return `场景「${trimmed}」已存在`;
      }

      try {
        // 场景改名会牵动**与场景同名的贴图引用**：先把文件里的引用改指到新名字，
        // 否则场景一改名，贴图（`Assets/images/<场景名>.png`）立刻就找不到了。
        const sceneFileId = projectSceneFileId(project, current);
        const raw: unknown = JSON.parse(await projectApi.readText(sceneFileId));
        const renamed = withRenamedSceneImage(project, parseSceneFile(raw).file, current, trimmed);
        if (renamed.changed > 0) {
          await projectApi.writeText(
            sceneFileId,
            `${JSON.stringify({ ...renamed.file, formatVersion: DOCUMENT_FORMAT_VERSION }, null, 2)}\n`,
          );
          pushLog(
            makeLog("info", `场景贴图引用已同步为：${trimmed}.png（${renamed.changed} 个地图对象）`),
          );
        }

        // 改文件名：场景名就是文件名，场景内容由上面的引用同步负责
        await projectApi.renameResource(sceneFileId, projectSceneFileId(project, trimmed));
        await get().refreshTree();
        await get().loadScenes();
        get().setActiveScene(trimmed);
        pushLog(makeLog("info", `场景已重命名为：${trimmed}`));
        return undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushLog(makeLog("error", `重命名场景失败：${message}`));
        return message;
      }
    },

    async deleteScene() {
      const project = get().project.current;
      const current = get().activeSceneName;
      if (project === null || current === null) {
        return "还没有可以删除的场景";
      }

      // 运行态的判断放在「还剩几个场景」前面：运行中一律先请用户退出运行，
      // 不然同一个动作在「最后一个场景」上给出的理由会看不出跟运行态有关
      if (get().runtime.runtimeActive) {
        return "运行态下不能删除场景，先点「编辑」退出运行";
      }

      if (get().scenes.length <= 1) {
        return "至少要保留一个场景";
      }

      // 先把手上的改动写回（别的场景可能还有未保存的编辑）
      await get().flushSceneSave();

      try {
        await projectApi.deleteResource(projectSceneFileId(project, current));
        await get().refreshTree();
        await get().loadScenes();
        pushLog(makeLog("info", `已删除场景：${current}`));
        return undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushLog(makeLog("error", `删除场景失败：${message}`));
        return message;
      }
    },

    // ---------------------------------------------------------------- 场景对象

    async createObject(kind, name, position) {
      const project = get().project.current;
      const sceneName = get().activeSceneName;
      const scene = findSceneByName(get().scenes, sceneName);
      if (project === null || sceneName === null || scene === undefined) {
        return "还没有场景";
      }

      const trimmed = name.trim();
      if (trimmed.length === 0) {
        return "请输入对象名";
      }

      // 世界无限大：落点就是给的那个坐标，不夹取
      const at = position === undefined ? { ...SCENE_CENTER } : { x: position.x, y: position.y };
      const object: SceneObjectDoc =
        kind === "Map"
          ? // 地图对象的贴图按同名约定取 Assets/images/<场景名>.png，网格由贴图尺寸算出来；
            // 它和别的对象一样有世界坐标（贴图中心），画布上能拖、属性面板能改
            createMapObject({
              name: trimmed,
              image: {
                id: projectSceneImageId(project, sceneName),
                width: DEFAULT_MAP_IMAGE.width,
                height: DEFAULT_MAP_IMAGE.height,
              },
              grid: gridSizeFromImage(DEFAULT_MAP_IMAGE),
              position: at,
            })
          : kind === "PlaySound"
            ? // 声音对象（动作对象）：和实体一样摆在世界里（画布上是一枚音频徽标，可以拖），
              // 新建时音频列表是空的（还没挑素材）
              createSoundObject({ name: trimmed, position: at })
            : kind === "Teleport"
              ? // 传送阵（动作对象）：同样摆在世界里（画布上是一枚传送徽标），
                // 新建时**还没指定目标场景**——属性面板挑一个目标，传送按钮才点得动
                createTeleportObject({ name: trimmed, position: at })
              : // 其它实体（例如精灵，kind = "SceneObject"）走普通对象：只有名字、类型与位置
                createSceneObject({ name: trimmed, kind, position: at });

      const changed = get().applyScenes(`新建对象 ${trimmed}`, (draft) => {
        const target = draft.find((item) => item.name === sceneName);
        if (target !== undefined) {
          addObject(target, object);
        }
      });

      if (!changed) {
        return "新建对象失败";
      }

      set({ selectedObjectIds: [object.id], selectedAssetId: null });
      pushLog(makeLog("info", `已新建对象：${trimmed}（${kind}）`));
      return undefined;
    },

    renameObject(id, name) {
      const sceneName = get().activeSceneName;
      const trimmed = name.trim();
      if (sceneName === null || trimmed.length === 0) {
        return false;
      }

      return get().applyScenes(`重命名对象 ${trimmed}`, (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          renameSceneObject(scene, id, trimmed);
        }
      });
    },

    setObjectActive(id, active) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const scene = findSceneByName(get().scenes, sceneName);
      const object = scene?.objects.find((item) => item.id === id);
      if (object === undefined || object.active === active) {
        return false;
      }

      const changed = get().applyScenes(active ? `激活 ${object.name}` : `停用 ${object.name}`, (draft) => {
        const target = draft.find((item) => item.name === sceneName);
        if (target !== undefined) {
          setSceneObjectActive(target, id, active);
        }
      });

      if (changed) {
        pushLog(makeLog("info", `${active ? "已显示" : "已隐藏"}对象：${object.name}`));
      }

      return changed;
    },

    toggleObjectActive(id) {
      const object = findSceneByName(get().scenes, get().activeSceneName)?.objects.find(
        (item) => item.id === id,
      );
      if (object === undefined) {
        return false;
      }

      return get().setObjectActive(id, !object.active);
    },

    setObjectLocked(id, locked) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const object = findSceneByName(get().scenes, sceneName)?.objects.find((item) => item.id === id);
      if (object === undefined || object.locked === locked) {
        return false;
      }

      const changed = get().applyScenes(
        locked ? `锁定 ${object.name}` : `解锁 ${object.name}`,
        (draft) => {
          const target = draft.find((item) => item.name === sceneName);
          if (target !== undefined) {
            setSceneObjectLocked(target, id, locked);
          }
        },
      );

      if (changed) {
        pushLog(makeLog("info", `${locked ? "已锁定" : "已解锁"}对象：${object.name}`));
      }

      return changed;
    },

    toggleObjectLocked(id) {
      const object = findSceneByName(get().scenes, get().activeSceneName)?.objects.find(
        (item) => item.id === id,
      );
      if (object === undefined) {
        return false;
      }

      return get().setObjectLocked(id, !object.locked);
    },

    setObjectSortingOrder(id, sortingOrder) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes(
        "修改显示顺序",
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene !== undefined) {
            setSceneObjectSortingOrder(scene, id, sortingOrder);
          }
        },
        // 连续敲数字 / 按住微调按钮合并成一条撤销记录
        { coalesceKey: `sorting:${id}` },
      );
    },

    setObjectScale(id, scale) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes(
        "修改缩放",
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene !== undefined) {
            setSceneObjectScale(scene, id, scale);
          }
        },
        // 连续输入合并成一条撤销记录（与显示顺序同一套做法）
        { coalesceKey: `scale:${id}` },
      );
    },

    setObjectRotation(id, rotationRadians) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes(
        "修改角度",
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene !== undefined) {
            setSceneObjectRotation(scene, id, rotationRadians);
          }
        },
        // 连续输入合并成一条撤销记录
        { coalesceKey: `rotation:${id}` },
      );
    },

    deleteObjects(ids) {
      const sceneName = get().activeSceneName;
      const targetIds = ids ?? get().selectedObjectIds;
      if (sceneName === null || targetIds.length === 0) {
        return false;
      }

      const changed = get().applyScenes(
        targetIds.length === 1 ? "删除对象" : `删除 ${targetIds.length} 个对象`,
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene === undefined) {
            return;
          }

          for (const id of targetIds) {
            removeSceneObject(scene, id);
          }
        },
      );

      if (changed) {
        set({ selectedObjectIds: [] });
        // 两个格子编辑窗口同理：它们盯着的那张地图没了就把窗口关掉（否则窗口里是一张画不出来的图）
        const fogTarget = get().fogMaskTarget;
        if (fogTarget !== null && targetIds.includes(fogTarget)) {
          set({ fogMask: false, fogMaskTarget: null });
        }

        const editTarget = get().gridEditorTarget;
        if (editTarget !== null && targetIds.includes(editTarget)) {
          set({ gridEditor: false, gridEditorTarget: null });
        }
      }

      return changed;
    },

    duplicateObjects(ids) {
      const sceneName = get().activeSceneName;
      const targetIds = ids ?? get().selectedObjectIds;
      if (sceneName === null || targetIds.length === 0) {
        return false;
      }

      const copies: string[] = [];
      const changed = get().applyScenes(
        targetIds.length === 1 ? "复制对象" : `复制 ${targetIds.length} 个对象`,
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene === undefined) {
            return;
          }

          let step = 1;
          for (const id of targetIds) {
            const source = scene.objects.find((object) => object.id === id);
            if (source === undefined) {
              continue;
            }

            const copy: SceneObjectDoc = {
              ...source,
              id: createId("obj"),
              // 名字与位置都错开，复制出来的东西不会与原对象完全重叠 / 同名
              name: nextObjectName(scene.objects, `${source.name} 副本`),
              position: offsetPosition(source.position, step),
            };
            step += 1;
            addObject(scene, copy);
            copies.push(copy.id);
          }
        },
        // 连按复制合并成一条撤销记录
        { coalesceKey: "duplicate" },
      );

      if (!changed) {
        return false;
      }

      set({ selectedObjectIds: copies, selectedAssetId: null });
      pushLog(makeLog("info", `已复制 ${copies.length} 个对象`));
      return true;
    },

    moveObject(id, position) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return;
      }

      // **锁定 = 不能移动**：这里是全项目唯一的移动入口（画布拖动、属性面板改坐标都走它），
      // 所以护栏放在这一处就够——画布那边还会先判一次（免得白进一次拖动状态）
      const object = findSceneByName(get().scenes, sceneName)?.objects.find((item) => item.id === id);
      if (object === undefined || object.locked) {
        return;
      }

      get().applyScenes(
        "移动对象",
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene !== undefined) {
            setSceneObjectPosition(scene, id, position);
          }
        },
        { coalesceKey: `move:${id}` },
      );
    },

    endObjectDrag() {
      sceneHistory.endCoalescing();
    },

    setTool(tool) {
      set((state) => ({ ui: { ...state.ui, tool } }));
      // 写偏好要**整份**写（存储里是一整个对象）：漏掉别的字段 = 把它悄悄还原成默认值
      writeEditorPrefs({ tool, bgmPaths: get().ui.bgmPaths });
    },

    setBgmPaths(show) {
      set((state) => ({ ui: { ...state.ui, bgmPaths: show } }));
      writeEditorPrefs({ tool: get().ui.tool, bgmPaths: show });
    },

    beginObjectTransform(id, handle, pointer, halfWidth, halfHeight) {
      // 「拖动」模式既没有手柄、也不吃对象本体的拖动：护栏放在这里，任何调用方都进不来
      const tool = get().ui.tool;
      if (tool === "none") {
        return undefined;
      }

      const object = currentObjectOf(id);
      // 锁定的对象**不进入变换**：锁的语义就是「不能被移动」，而旋转与缩放同样是在动它。
      // 画布那边还会先判一次（免得白进一次拖拽状态），这里的护栏是给其它调用方兜底的。
      if (object === undefined || object.position === null || object.locked) {
        return undefined;
      }

      const center = { x: object.position.x, y: object.position.y };
      // **锚点矩形要用整宽整高**：`halfWidth` / `halfHeight` 是半尺寸，而 `worldRectOf`
      // 收的是整尺寸。传半尺寸会把固定点放到「中心与对角的中点」上——按下缩放的一瞬间
      // 对象就跳到 1.5 倍。命中测试那边同一件事写的就是 `half.width * 2`。
      const rect = worldRectOf(center, { width: halfWidth * 2, height: halfHeight * 2 });
      // 拖对象本体（`handle === null`）没有手柄：既没有轴约束，也没有缩放锚点 / 角边之分
      const scaleHandle = tool === "scale" && handle !== null ? handle : null;
      // 边手柄管哪一轴：拖它是「只改这一轴」，`resolveTransform` 靠它把另一轴按住不动
      const scaleAxis = scaleHandle === null ? undefined : scaleAxisOf(scaleHandle);

      const start: TransformStart = {
        id,
        mode: tool,
        base: center,
        rotation: object.rotation,
        scaleX: effectiveScaleX(object),
        scaleY: effectiveScaleY(object),
        // 移动按「指针位移」、旋转按「指针方位角增量」、缩放按「指针相对锚点的偏移比例」——
        // 三者都要**按下这一刻的真实指针位置**当基准（见 transform.ts 顶部说明）
        pointer,
        center,
        // 移动与旋转用不到锚点；缩放拖拽的固定点是对角 / 对边中点（与 Unity 一致）
        anchor:
          scaleHandle === null
            ? center
            : (scaleAnchorFor(scaleHandle, rect, object.rotation) ?? center),
        corner: scaleHandle !== null && isCornerScaleHandle(scaleHandle),
        ...(scaleAxis === undefined ? {} : { axis: scaleAxis }),
      };

      set({ transformStart: start });
      return start;
    },

    applyObjectTransform(pointer, options) {
      const start = get().transformStart;
      if (start === null) {
        return;
      }

      // 拖拽途中对象可能已经被删掉（撤销 / 别人删了）：直接收手，别写一个不存在的 id
      if (currentObjectOf(start.id) === undefined) {
        return;
      }

      const result = resolveTransform({
        start,
        pointer,
        ...(options?.axis === undefined ? {} : { axis: options.axis }),
        ...(options?.snapAngle === undefined ? {} : { snapAngle: options.snapAngle }),
        ...(options?.uniform === undefined ? {} : { uniform: options.uniform }),
      });

      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return;
      }

      // 位置 / 角度 / 缩放**一次写完**：三次独立调用会产生三条撤销记录，
      // 而用户眼里这明明是一次拖拽（对比 `moveObject` 只改一个属性，所以它单独一条）
      get().applyScenes(
        TRANSFORM_LABELS[start.mode],
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene === undefined) {
            return;
          }

          setSceneObjectPosition(scene, start.id, result.position);
          setSceneObjectRotation(scene, start.id, result.rotation);
          setSceneObjectScaleAxes(scene, start.id, { x: result.scaleX, y: result.scaleY });
        },
        { coalesceKey: `transform:${start.id}` },
      );
    },

    endObjectTransform() {
      set({ transformStart: null });
      sceneHistory.endCoalescing();
    },

    cancelObjectTransform() {
      const start = get().transformStart;
      const sceneName = get().activeSceneName;
      set({ transformStart: null });

      if (start === null || sceneName === null) {
        sceneHistory.endCoalescing();
        return;
      }

      // 用快照写回按下前的样子。快照里的 scaleX / scaleY 是**有效值**，
      // 而"按下前是不是等比的写法"已经无从考证——所以统一按当前工具的形状写回：
      // 等比就折叠回 `scale`（`collapseScale` 会做），非等比就写两轴。
      get().applyScenes(
        "取消变换",
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene === undefined) {
            return;
          }

          setSceneObjectPosition(scene, start.id, start.base);
          setSceneObjectRotation(scene, start.id, start.rotation);
          setSceneObjectScaleAxes(scene, start.id, { x: start.scaleX, y: start.scaleY });
        },
        { coalesceKey: `transform:${start.id}` },
      );

      sceneHistory.endCoalescing();
    },

    setObjectScaleAxes(id, x, y) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes(
        "修改缩放",
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene !== undefined) {
            setSceneObjectScaleAxes(scene, id, { x, y });
          }
        },
        // 连续输入合并成一条撤销记录（与等比缩放同一套做法）
        { coalesceKey: `scale:${id}` },
      );
    },

    setMapGrid(mapObjectId, grid) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes("修改网格尺寸", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneMapGrid(scene, mapObjectId, grid);
        }
      });
    },

    setObjectImage(objectId, image) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const changed = get().applyScenes("更换贴图", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneObjectImage(scene, objectId, image);
        }
      });

      if (changed) {
        pushLog(makeLog("info", `已更换贴图：${image.id}（${image.width}×${image.height}）`));
      }

      return changed;
    },

    openImagePicker(objectId) {
      set({ imagePicker: objectId !== null, imagePickerTarget: objectId });
      if (objectId !== null) {
        // 打开「选择贴图」时刷新一次目录：素材由外部提交，不刷新的话刚放进去的图选不到。
        void get().refreshTree();
      }
    },

    // ------------------------------------------------------------ 声音对象（动作对象）

    setSoundClips(objectId, clips) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes("修改音频列表", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneSoundClips(scene, objectId, clips);
        }
      });
    },

    selectSoundClip(objectId, clip) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const object = findSceneByName(get().scenes, sceneName)?.objects.find(
        (item) => item.id === objectId,
      );
      if (object === undefined || object.kind !== "PlaySound") {
        return false;
      }

      // 单选：只能选**加进来的**那几条（`setSoundPicked` 会把不在列表里的拒掉）。
      // 名字按文件记，换选不动它。
      return get().applyScenes("选择声音", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneSoundPicked(scene, objectId, clip);
        }
      });
    },

    addSoundClip(objectId, clipId) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const object = findSceneByName(get().scenes, sceneName)?.objects.find(
        (item) => item.id === objectId,
      );
      if (object === undefined || object.kind !== "PlaySound") {
        return false;
      }

      const sound = object.sound;
      const already = (sound?.clips ?? []).includes(clipId);
      // 原来选中的那条要是还在，就不抢（正听着 A 加一条 B，选择不该被顶掉）
      const hadPicked = sound?.picked;

      return get().applyScenes("添加声音", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene === undefined) {
          return;
        }

        if (!already) {
          setSceneSoundClips(scene, objectId, [...(sound?.clips ?? []), clipId]);
        }

        if (hadPicked === undefined) {
          // 之前一条都没选（或列表本来是空的）：加进来的这条就是现在要播的
          setSceneSoundPicked(scene, objectId, clipId);
        }
      });
    },

    removeSoundClip(objectId, clipId) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const object = findSceneByName(get().scenes, sceneName)?.objects.find(
        (item) => item.id === objectId,
      );
      if (object === undefined || object.kind !== "PlaySound") {
        return false;
      }

      const clips = object.sound?.clips ?? [];
      if (!clips.includes(clipId)) {
        return false;
      }

      // 名字与「选中的那条」由 `setSoundClips` 一起收拾（见 `syncSoundSideData`）
      return get().applyScenes("移除声音", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneSoundClips(
            scene,
            objectId,
            clips.filter((id) => id !== clipId),
          );
        }
      });
    },

    setSoundClipName(objectId, clipId, name) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes("修改声音名字", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneSoundClipName(scene, objectId, clipId, name);
        }
      });
    },

    openSoundEditor(objectId) {
      set({ soundEditor: objectId !== null, soundEditorTarget: objectId });
      if (objectId !== null) {
        // 与「选择贴图」同一条规矩：素材由外部提交进 Assets/audio/，打开时刷一次目录
        void get().refreshTree();
      }
    },

    setSoundLayer(objectId, layer) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes("修改声音层级", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneSoundLayer(scene, objectId, layer);
        }
      });
    },

    // ------------------------------------------------------------ 视频（地图 / 精灵）

    openVideoEditor(objectId) {
      set({ videoEditor: objectId !== null, videoEditorTarget: objectId });
      if (objectId !== null) {
        // 与「选择音频」同一条规矩：素材由外部提交进 Assets/video/，打开时刷一次目录
        void get().refreshTree();
      }
    },

    setVideoEnabled(objectId, enabled) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const changed = get().applyScenes(enabled ? "启用视频" : "关闭视频", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneVideoEnabled(scene, objectId, enabled);
        }
      });

      // 关掉了：正开着的「编辑视频」窗口跟着关（那一组已经收起来了）
      if (!enabled && get().videoEditorTarget === objectId) {
        set({ videoEditor: false, videoEditorTarget: null });
      }

      return changed;
    },

    addVideoClip(objectId, clipId) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const object = findSceneByName(get().scenes, sceneName)?.objects.find(
        (item) => item.id === objectId,
      );
      if (object === undefined || !supportsVideo(object.kind)) {
        return false;
      }

      const video = object.video;
      const already = (video?.clips ?? []).includes(clipId);
      // 原来选中的那条要是还在，就不抢（正放着 A 加一条 B，选择不该被顶掉）
      const hadPicked = video?.picked;

      return get().applyScenes("添加视频", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene === undefined) {
          return;
        }

        if (!already) {
          setSceneVideoClips(scene, objectId, [...(video?.clips ?? []), clipId]);
        }

        if (hadPicked === undefined) {
          // 之前一条都没选（或列表本来是空的）：加进来的这条就是现在要放的
          setSceneVideoPicked(scene, objectId, clipId);
        }
      });
    },

    removeVideoClip(objectId, clipId) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const object = findSceneByName(get().scenes, sceneName)?.objects.find(
        (item) => item.id === objectId,
      );
      if (object === undefined) {
        return false;
      }

      const clips = object.video?.clips ?? [];
      if (!clips.includes(clipId)) {
        return false;
      }

      // 名字与「选中的那条」由 `setVideoClips` 一起收拾（见 `syncVideoSideData`）
      return get().applyScenes("移除视频", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneVideoClips(
            scene,
            objectId,
            clips.filter((id) => id !== clipId),
          );
        }
      });
    },

    selectVideoClip(objectId, clip) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const object = findSceneByName(get().scenes, sceneName)?.objects.find(
        (item) => item.id === objectId,
      );
      if (object === undefined || !supportsVideo(object.kind)) {
        return false;
      }

      // 单选：只能选**加进来的**那几条（`setVideoPicked` 会把不在列表里的拒掉）。
      // 名字按文件记，换选不动它。
      return get().applyScenes("选择视频", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneVideoPicked(scene, objectId, clip);
        }
      });
    },

    setVideoClipName(objectId, clipId, name) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes("修改视频名字", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneVideoClipName(scene, objectId, clipId, name);
        }
      });
    },

    setVideoLoop(objectId, loop) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes("修改视频循环", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneVideoLoop(scene, objectId, loop);
        }
      });
    },

    setVideoAudio(objectId, audio) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes("修改视频声音", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneVideoAudio(scene, objectId, audio);
        }
      });
    },

    // ------------------------------------------------------------ 传送阵（动作对象）

    setTeleportTargets(objectId, targets) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes("修改传送目标", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneTeleportTargets(scene, objectId, targets);
        }
      });
    },

    setTeleportPicked(objectId, target) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes("选择传送目标", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneTeleportPicked(scene, objectId, target);
        }
      });
    },

    openTeleportEditor(objectId) {
      set({ teleportEditor: objectId !== null, teleportEditorTarget: objectId });
    },

    teleport(objectId) {
      const object = currentObjectOf(objectId);
      if (object === undefined || object.kind !== "Teleport") {
        pushLog(makeLog("error", "找不到这个传送阵"));
        return false;
      }

      const teleport = object.teleport;
      if (teleport === undefined || teleport.targets.length === 0) {
        pushLog(makeLog("error", `${object.name}：还没有加目标场景，先在「传送目标」里勾几个`));
        return false;
      }

      // 选中的那个可能已经被移出候选（手写文件里也可能留下一个对不上的值）：按「还没选」处理
      const target = teleport.picked;
      if (target === undefined || !teleport.targets.includes(target)) {
        pushLog(makeLog("error", `${object.name}：还没选要传送到哪一张场景（面板上点一下小方块）`));
        return false;
      }

      if (target === get().activeSceneName) {
        pushLog(makeLog("warn", `${object.name}：目标就是当前场景，什么都不用做`));
        return false;
      }

      if (!get().scenes.some((scene) => scene.name === target)) {
        pushLog(
          makeLog(
            "error",
            `${object.name}：目标场景「${target}」不存在（可能被改名或删掉了），重新挑一个`,
          ),
        );
        return false;
      }

      // 走切场景那条唯一的路（写回改动 → 记住视口 → 换场景 → 立刻推给前端）。
      // `log: false`：下面这条带来源的日志更说明问题，免得一次传送写两行
      switchScene(target, { clearAssetSelection: true, log: false });
      pushLog(makeLog("info", `传送阵「${object.name}」→ 场景「${target}」`));
      return true;
    },

    // ------------------------------------------------------------ 网格标注

    setGridBrush(mask) {
      const paintable = mask === CellMask.Empty || PAINTABLE_MASKS.some((bit) => bit === mask);
      if (!paintable) {
        return;
      }

      const gridPaint: GridPaintState = { ...get().gridPaint, mask };
      set({ gridPaint });
      persistGridPaint(gridPaint);
    },

    setGridBrushSize(brushSize) {
      if (!Number.isFinite(brushSize)) {
        return;
      }

      const gridPaint: GridPaintState = {
        ...get().gridPaint,
        // 夹到 1..5：与 Unity 的 IntSlider 同一个范围，也决定了画笔半径
        brushSize: clampBrushSize(brushSize),
      };
      set({ gridPaint });
      persistGridPaint(gridPaint);
    },

    toggleGridTypeVisible(bit) {
      if (!PAINTABLE_MASKS.some((value) => value === bit)) {
        return;
      }

      const gridPaint: GridPaintState = {
        ...get().gridPaint,
        hiddenMask: get().gridPaint.hiddenMask ^ bit,
      };
      set({ gridPaint });
      persistGridPaint(gridPaint);
    },

    setGridTypeColor(bit, hex) {
      if (!PAINTABLE_MASKS.some((value) => value === bit) || !isHexColor(hex)) {
        return;
      }

      const gridPaint: GridPaintState = {
        ...get().gridPaint,
        colors: { ...get().gridPaint.colors, [bit]: hex },
      };
      set({ gridPaint });
      persistGridPaint(gridPaint);
    },

    setGridLinesVisible(visible) {
      const gridPaint: GridPaintState = { ...get().gridPaint, showGridLines: visible };
      set({ gridPaint });
      persistGridPaint(gridPaint);
    },

    setGridAnnotationsVisible(visible) {
      const gridPaint: GridPaintState = { ...get().gridPaint, showAnnotations: visible };
      set({ gridPaint });
      persistGridPaint(gridPaint);
    },

    paintGridStroke(mapObjectId, from, to) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      // 画笔与大小取调用瞬间的值：慢速拖动时用户可能刚换过画笔，落下一笔就该用新的
      const { mask, brushSize } = get().gridPaint;
      const start = from ?? to;

      return get().applyScenes(
        mask === CellMask.Empty ? "擦除网格" : "标注网格",
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene !== undefined) {
            // 落笔在网格外 / 目标不是地图 / 数据坏了都会返回 false（不产生补丁）
            paintMapCells(scene, mapObjectId, start, to, { mask, brushSize });
          }
        },
        // 一整笔（按下 → 抬手的若干次 pointermove）合并成一条撤销记录
        { coalesceKey: `paint:${mapObjectId}` },
      );
    },

    endGridStroke() {
      sceneHistory.endCoalescing();
    },

    clearGrid(mapObjectId) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const changed = get().applyScenes("清空网格", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          clearMapCells(scene, mapObjectId);
        }
      });

      if (changed) {
        pushLog(makeLog("info", "已清空网格标注"));
      }

      return changed;
    },

    // ------------------------------------------------------------ 战争雾（Mask 窗口）

    openFogMask(objectId) {
      set({
        fogMask: objectId !== null,
        fogMaskTarget: objectId,
        // 两个格子编辑窗口互斥：同时开两层模态遮罩，谁也别想点
        ...(objectId === null ? {} : { gridEditor: false, gridEditorTarget: null }),
      });
    },

    openGridEditor(objectId) {
      set({
        gridEditor: objectId !== null,
        gridEditorTarget: objectId,
        ...(objectId === null ? {} : { fogMask: false, fogMaskTarget: null }),
      });
    },

    setFogRegions(mapObjectId, regions) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes("指定雾区", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          // 规范化与「没变更」的判断都在命令里，这里只负责找到场景
          setSceneMapFogRegions(scene, mapObjectId, regions);
        }
      });
    },

    setFogEnabled(mapObjectId, enabled) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const changed = get().applyScenes(enabled ? "打开战争雾" : "关闭战争雾", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          // 开关写的是**文档数据**：只有它跟着场景下发，前端才知道该不该生成那一层雾
          setSceneMapFogEnabled(scene, mapObjectId, enabled);
        }
      });

      // 关掉了：正开着的 Mask 窗口跟着关（它编辑的那张地图已经没有雾了，留着只会擦空气）
      if (!enabled && get().fogMaskTarget === mapObjectId) {
        set({ fogMask: false, fogMaskTarget: null });
      }

      return changed;
    },

    eraseFogMask(objectId, points, done) {
      // 编辑态：Mask 窗口只是预览（擦了不写文档、也不下发），与「运行」之前完全一样
      if (get().mode !== "run" || points.length === 0) {
        return undefined;
      }

      const map = fogTargetOf(objectId, "擦除战争雾");
      if (map === null) {
        return undefined;
      }

      // 逐批记账：拖动中的相邻批次在记账里并成**一条完整轨迹**（补发时要的是整笔）
      set({ fogReveal: withEraseBatch(get().fogReveal, objectId, points) });

      const requestId = deliverFogErase(objectId, points);
      if (!done) {
        return requestId;
      }

      const entry = get().fogReveal.objects[objectId];
      const strokes = (entry?.ops ?? []).filter((op) => op.kind === "stroke").length;
      const total = (entry?.ops ?? []).reduce(
        (count, op) => count + (op.kind === "stroke" ? op.stroke.points.length : 0),
        0,
      );
      const what = `「${map.name}」第 ${strokes} 笔（${total} 个落点）`;

      pushLog(
        frontendReady()
          ? makeLog("info", `下发擦除：${what}（请前端沿轨迹擦掉雾）`)
          : makeLog(
              "info",
              `已记录擦除：${what}（${
                runtimeClient.connected ? "前端未连接，等它连上后自动补发" : "编辑器还没连上服务端，连上后自动补发"
              }）`,
            ),
      );

      return requestId;
    },

    setFogRegionRevealed(objectId, region, revealed) {
      if (get().mode !== "run") {
        return undefined;
      }

      const map = fogTargetOf(objectId, revealed ? "揭示雾区" : "盖回雾区");
      if (map === null) {
        return undefined;
      }

      if (!(map.map?.fog?.regions ?? []).includes(region)) {
        pushLog(makeLog("warn", `雾区操作失败：「${map.name}」没把 ${maskToLabel(region)} 指定为雾区`));
        return undefined;
      }

      set({ fogReveal: withRegion(get().fogReveal, objectId, region, revealed) });

      const what = `${maskToLabel(region)}${revealed ? "整片揭示" : "整片盖回"}`;
      if (!frontendReady()) {
        pushLog(
          makeLog(
            "info",
            `已记录${revealed ? "揭示" : "盖回"}：${what}（${
              runtimeClient.connected ? "前端未连接，等它连上后自动补发" : "编辑器还没连上服务端，连上后自动补发"
            }）`,
          ),
        );
        return undefined;
      }

      const requestId = runtimeClient.sendCommand({
        kind: "reveal_fog_region",
        objectId,
        region,
        revealed,
      });
      pushLog(makeLog("info", `下发${revealed ? "揭示" : "盖回"}：${what}（「${map.name}」）`));
      return requestId;
    },

    flushFogReveal() {
      const { fogReveal } = get();
      if (!frontendReady()) {
        return 0;
      }

      // 先按当前文档筛掉没意义的记录（对象被删了 / 不是地图 / 开关关着 / 解绑了雾区），免得补发一堆注定失败的命令
      const pruned = pruneFogReveal(fogReveal, canRevealFog);
      const entries: Array<{ objectId: string; entry: FogRevealEntry }> = Object.entries(
        pruned.objects,
      ).map(([objectId, entry]) => ({ objectId, entry }));

      let steps = 0;
      for (const { objectId, entry } of entries) {
        for (const op of entry.ops) {
          if (op.kind === "stroke") {
            deliverFogErase(objectId, op.stroke.points);
          } else {
            runtimeClient.sendCommand({
              kind: "reveal_fog_region",
              objectId,
              region: op.region,
              revealed: op.revealed,
            });
          }

          steps += 1;
        }
      }

      if (pruned !== fogReveal) {
        set({ fogReveal: pruned });
      }

      if (steps === 0) {
        return 0;
      }

      pushLog(
        makeLog(
          "info",
          `补发战争雾：${entries.length} 张地图 / ${steps} 步（前端刚连上，把它还没看到的揭示补过去）`,
        ),
      );
      return steps;
    },
  };
});
