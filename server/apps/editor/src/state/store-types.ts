/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 编辑器状态的**类型**：界面态 / 运行态 / 项目态，以及总状态 `EditorStoreState`。
 */
import {
  type AssetMetaDoc,
  type AssetMetas,
  type ImageRef,
  type ImageSpriteRef,
  type ObjectKind,
  type ProjectDoc,
  type SceneDoc,
  type SceneListDraft,
  type SoundLayer,
  type SpriteImportSettingsDoc,
  type SpriteSheetDoc,
  type WorldPosition,
} from "@dts/document";
import { type GridPoint, type GridSize } from "@dts/grid";
import { type GizmoHandle, type TransformTool, type Viewport } from "@dts/renderer";
import type { ClientInfo, ProjectSettingsInfo, ResourcesInfo, SceneInfo } from "@dts/protocol";
import { type RuntimeLogEntry, type RuntimeStatus } from "../services/runtime-client";
import { type BgmPlaybackState } from "../services/bgm-playback";
import { type ProjectSummary, type ResourceTreeNode } from "../services/project-api";
import { type TransformStart } from "../panels/scene/transform";
import { type SoundPlaybackState } from "../services/sound-playback";
import { type VideoPlaybackState } from "../services/video-playback";
import { type FogRevealPoint, type FogRevealState } from "../services/fog-reveal";
import type { StoreApi } from "zustand";

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
 * 素材 meta 的**真源表**：键 = 素材的路径 ID（v23 起，第三条撤销轨道上的那份）。
 *
 * 为什么按路径 ID 当键：撤销补丁要落在**具体某一项**上，而 `AssetMetas` 索引里同一份 meta
 * 有 guid 与路径两个键（两个方向指向同一份对象）；挑一个当写入口径才不会「补丁打在 guid 上、
 * 按路径读不到」。路径 ID 同时是后端那份 `metas` 字典的键、也是挑图时手上那个键，所以选它。
 */
export type AssetMetaTable = Readonly<Record<string, AssetMetaDoc>>;

/**
 * 素材 meta 表的**可写草稿**（`applyMetas` 的配方拿到的就是它）。
 *
 * 与 `AssetMetaTable` 只差「能不能写」：真源表对外是只读的（写只能经撤销轨道），
 * 而配方拿到的那一份正是要就地改的 draft——与 `SceneListDraft` 同一个道理。
 */
export type AssetMetaDraft = Record<string, AssetMetaDoc>;

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
  /**
   * **素材 meta 的索引**（`guid → meta` 与 `路径 ID → meta` 两个方向，v23 起）。
   *
   * 它是**派生出来给读的地方用的那一份**：画布、属性面板、资源面板、校验、推送一律经它解析
   * （`metaOfImage` / `spriteSheetOfMeta`…），于是「按 guid 查到的」与「按路径查到的」
   * 永远是同一份。真源是下一条 `assetMetaTable`（进撤销栈的那份），
   * 这里跟着它重建（见 `store-context.ts` 对 `metaHistory` 的订阅）。
   */
  readonly assetMetas: AssetMetas;
  /**
   * 素材 meta 的**真源表**（键 = 素材的路径 ID，v23 起）：进撤销栈、被落盘比对的那一份。
   *
   * 与 `assetMetas` 分成两份是有意的：撤销补丁要打在**具体某一项**上，而索引里同一份 meta
   * 有 guid 与路径两个键——挑路径 ID 当写入口径（它同时是后端那份 `metas` 字典的键、
   * 也是挑图时手上那个键），索引只负责读。
   */
  readonly assetMetaTable: AssetMetaTable;
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
  /**
   * 「编辑媒体清单」窗口（`MediaEditDialog`：声音 / 视频同一个窗口按 kind 调整）：
   * 非 null = 打开，`kind` 是哪一种、`objectId` 是正在编辑哪个对象。
   */
  readonly mediaEditor: { readonly kind: "audio" | "video"; readonly objectId: string } | null;
  /** 「传送目标」窗口是否打开（属性面板「传送」组里的 `＋` 唤出） */
  readonly teleportEditor: boolean;
  /** 正在编辑哪个传送阵的候选目标；null 表示窗口没打开 */
  readonly teleportEditorTarget: string | null;
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
  /**
   * **素材 meta**（`<素材>.meta`）的保存状态（去抖自动存与手动保存共用）。
   *
   * 与上两份并列：meta 是**每个素材一个文件**，所以它有自己的一份「有没有未保存改动」
   * （比对 `savedMetas` 里的文本快照，只写内容真的变了的那几份）与自己的错误。
   */
  readonly metaSaveState: SceneSaveState;
  readonly metaSaveError: string;
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
   * **工程文件**（项目级数据：全局设置、音频标签表）的编辑走这里：进撤销栈，并触发工程文件的自动落盘。
   *
   * 与 `applyScenes` 并列（两份文件、两套历史），但**撤销入口只有一个**——见 `undo`。
   */
  applyProject(
    label: string,
    recipe: (draft: ProjectDoc) => void,
    options?: { coalesceKey?: string },
  ): boolean;
  /**
   * **素材 meta**（`<素材>.meta`）的编辑走这里：第三条轨道，落盘是「每份一个文件」。
   *
   * 图片的切分 / 导入设置与音频的显示名 / 标签都经它（写入口径是 `@dts/document` 的
   * `withMetaSprite*` / `withMetaAudio*` 纯函数）。之所以要有一个统一入口，而不是各处直接调
   * `metaHistory.apply`：三条轨道**共用一个撤销入口**，撤销要作用在「最近改过的那条」上
   * （见 `undo`）——每一次真的产生改动的编辑都得把这条轨道记下来，否则撤销会跑错轨道
   * （例如「改完标签表再摘一个文件的标签」按撤销会去撤标签表那一下）。
   */
  applyMetas(
    label: string,
    recipe: (draft: AssetMetaDraft) => void,
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
  zoomAtScreen(anchor: { x: number; y: number }, factor: number): void;
  panByScreen(dx: number, dy: number): void;
  /**
   * **适配视图**：把当前场景里**画布上看得见的东西**（地图 / 贴图 / 徽标…）一起装进视口，
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
   * 让**前端**在某个地图 / 贴图上放它选中的那一条视频（编辑器自己不放，只**记账** + 尽力下发）。
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
  /**
   * 打开 / 关闭「编辑媒体清单」窗口（`MediaEditDialog`：`audio` = 声音、`video` = 视频；
   * 传 `null` 关闭）。两扇窗口合并后只有一个开关。
   */
  openMediaEditor(kind: "audio" | "video", objectId: string | null): void;
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
   * 素材文件（**任何素材**：图 / 音频 / 视频）：替换**整份**标签 ID 清单
   * （去重升序、丢掉越界已删的，由文档命令做）。
   */
  setAssetTags(assetId: string, tagIds: readonly number[]): boolean;
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
  refreshTree(resolveReferences?: boolean): Promise<boolean>;
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
  renameResource(fromId: string, toId: string, label: string): Promise<string | undefined>;

  /** 立即把有改动的场景写回文件（手动保存 / 切场景前 flush）。 */
  saveSceneNow(): Promise<boolean>;
  /** 有待保存改动就立刻写回；场景级操作与关闭项目之前调用，避免丢失或写错场景。 */
  flushSceneSave(): Promise<boolean>;

  /**
   * 立即把**工程文件**（`project.json`，全局设置在这里）写回磁盘。
   *
   * 与 `saveSceneNow` 同一套：运行态下不写盘（改动退出运行会整体还原），失败写进 `projectSaveError`。
   */
  saveProjectNow(): Promise<boolean>;

  /**
   * 立即把**有改动的素材 meta**（`<素材>.meta`）写回磁盘。
   *
   * 与 `saveProjectNow` 同一套：只写内容真的变了的那几份（比对 `savedMetas` 的文本快照）、
   * 运行态下不写盘（改动退出运行会整体还原）、失败写进 `metaSaveError` 并记一条 error 日志。
   */
  saveMetasNow(): Promise<boolean>;
  /** 素材 meta 有待保存改动就立刻写回；关项目 / 换项目 / 重新读盘之前调用，避免丢掉刚切的图集。 */
  flushMetaSave(): Promise<boolean>;

  /** 重新扫描 `Assets/scenes/` 并把场景读进内存（打开项目、增删改名后调用）。 */
  loadScenes(): Promise<boolean>;
  openSceneDialog(mode: SceneDialogMode): void;
  openObjectDialog(open: boolean): void;
  /**
   * 打开「选择贴图」弹框（传要换贴图的对象 id，精灵与贴图都走这里）；传 null 关闭。
   *
   * 打开与关闭走同一条路：**记住当前目标是 store 的事**，弹框组件只读它。
   */
  openImagePicker(objectId: string | null): void;
  /**
   * 新建场景：在 `Assets/scenes/` 下建一个空场景文件。成功返回 undefined，失败返回原因。
   */
  createScene(name: string): Promise<string | undefined>;
  /** 重命名当前场景：**只改文件名**，场景内容一个字节都不重写。 */
  renameScene(name: string, sceneName?: string): Promise<string | undefined>;
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
  /** 一次手柄拖拽结束：断开撤销合并，使下一次拖拽成为独立记录。 */
  endObjectTransform(): void;
  /** 取消这次拖拽：用快照把位置 / 角度 / 两轴缩放写回按下前的样子，再收尾。 */
  cancelObjectTransform(): void;
  /** 改对象的**两轴缩放**（单轴手柄与属性面板用）；两轴相等时自动折叠回等比。 */
  setObjectScaleAxes(id: string, x: number, y: number): boolean;
  /**
   * 「选择贴图 / 精灵」窗口确定时的那一条命令：**图 + 格子一次写进去**（一条撤销记录）。
   *
   * `sprite` 为 `null` = 用整张图（会把对象上原来的子图引用清掉）。
   */
  setObjectImageSprite(objectId: string, image: ImageRef, sprite: ImageSpriteRef | null): boolean;
  /**
   * 改一张图的**切分**（列 × 行；`null` = 恢复整图）：落在**素材 meta** 那条轨道上。
   *
   * 切分只有这一份（那个素材的 `.meta`，见 `withMetaSpriteSheet`），所以
   * 「改它 = 所有引用它的对象一起变」；`imageId` 是素材的路径 ID，也是 `AssetMetaTable` 的键。
   */
  setSpriteSheet(imageId: string, sheet: SpriteSheetDoc | null): boolean;
  /** 改一张图的**导入设置**（`null` / `Default` = 普通图片）；同样落在素材 meta 那条轨道上。 */
  setSpriteImportSettings(imageId: string, settings: SpriteImportSettingsDoc | null): boolean;
  /**
   * 拿到这个素材的 meta，**没有就现建一份**（含新 GUID）并落盘。
   *
   * 挑图 / 引用一条图片时要往 `ImageRef` 里写 `guid`——身份必须在**第一次引用**时就定下来，
   * 否则「引用了却没身份」的窗口期里素材一改名，引用就又断在路径上了。
   * 已经有 meta（哪怕只是按路径命中的）时原样返回，一个字节都不改。
   */
  ensureAssetMeta(imageId: string): AssetMetaDoc;
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
  /**
   * **泛型组件字段写入**：按组件规格改一个简单字段（布尔 / 数字 / 枚举 / 字符串）。
   *
   * 加一个这类字段不再需要新写一条 action——键名、类型收窄、夹取范围都来自
   * `@dts/document` 的组件规格（`component-specs/`）。返回 `false` 表示没有变更
   * （未知组件 / 字段不归规格管 / 值非法 / 值没变）。
   *
   * `type` 是**组件类型 ID 字符串**（不是 `ComponentType` 联合）：规格注册表按字符串查，
   * 于是加一个组件不必先改这个联合；代价是拼错只能在运行期表现为 `false`，
   * 而所有调用点都从规格里取键，实际由 `FieldDef.key` 的编译期约束兜住。
   */
  setComponentField(objectId: string, type: string, key: string, value: unknown): boolean;
  /** Explicitly restore the default data for a missing required component. */
  repairObjectComponent(objectId: string, type: "PlaySound" | "Teleport"): boolean;
  /**
   * **泛型对象字段写入**：按对象字段规格（`@dts/document` 的 `OBJECT_SPEC`）改 `object` 自己的
   * 一个简单字段——与 `setComponentField` 的分工只有「写在哪」。返回 `false` 表示没有变更。
   *
   * 目前规格里只有 `sortingOrder`（它另有一个说得出名字的入口 `setObjectSortingOrder`）；
   * 其余基础字段各有一件专属语义（改名联动 / 运行日志 / 等比折叠 / 单位换算…），
   * 继续走各自的专用 action，理由写在 `object-spec.ts` 的表里。
   */
  setObjectField(objectId: string, key: string, value: unknown): boolean;

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
  /** 一次涂抹结束：断开撤销合并，使下一笔成为独立记录（对齐对象变换的 `endObjectTransform`）。 */
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
 * zustand 的 `set` / `get`：切片工厂拿到的就是这两个（单独写出来，好让每个切片
 * 显式声明自己的签名）。
 */
export type StoreSet = StoreApi<EditorStoreState>["setState"];
export type StoreGet = StoreApi<EditorStoreState>["getState"];

/** `EditorStoreState` 里全部 **action 名**（函数成员）。 */
type EditorStoreActionName = {
  [K in keyof EditorStoreState]: EditorStoreState[K] extends (...args: never[]) => unknown ? K : never;
}[keyof EditorStoreState];

/** `EditorStoreState` 里**状态字段**那一半（`createInitialState` 的返回类型）。 */
export type EditorStoreData = Omit<EditorStoreState, EditorStoreActionName>;
