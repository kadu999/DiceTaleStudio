import { create } from "zustand";
import {
  DEFAULT_SOUND_LAYER,
  DOCUMENT_FORMAT_VERSION,
  DocumentHistory,
  SOUND_LAYER_LABELS,
  addObject,
  clearMapCells,
  createEmptyProject,
  createEmptyScene,
  createId,
  createMapObject,
  createSceneObject,
  createSoundObject,
  isSceneNameTaken,
  nextObjectName,
  paintMapCells,
  parseProjectFile,
  parseSceneFile,
  removeObject as removeSceneObject,
  renameObject as renameSceneObject,
  setMapFogRegions as setSceneMapFogRegions,
  setMapGrid as setSceneMapGrid,
  setObjectActive as setSceneObjectActive,
  setObjectImage as setSceneObjectImage,
  setObjectPosition as setSceneObjectPosition,
  setObjectLocked as setSceneObjectLocked,
  setObjectScale as setSceneObjectScale,
  setObjectSortingOrder as setSceneObjectSortingOrder,
  setSoundClips as setSceneSoundClips,
  setSoundLayer as setSceneSoundLayer,
  setSoundClipName as setSceneSoundClipName,
  setSoundPicked as setSceneSoundPicked,
  validateSceneName,
  type ImageRef,
  type ObjectKind,
  type ProjectDoc,
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
  worldRectOf,
  type GridPoint,
  type GridSize,
  type ImageSize,
  type WorldRect,
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
  createCenteredViewport,
  createViewport,
  fitViewport,
  panBy,
  zoomAt,
  type Viewport,
} from "@dts/renderer";
import type { ClientInfo, SceneInfo, ScenePayload } from "@dts/protocol";
import {
  RuntimeClient,
  type RuntimeLogEntry,
  type RuntimeStateSnapshot,
  type RuntimeStatus,
} from "../services/runtime-client";
import { ScenePushScheduler, scenePayloadText, shouldPushScene } from "../services/runtime-push";
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
import { clearSceneImageCache } from "../services/scene-image";
import {
  emptySoundPlayback,
  soundPlaybackResendPlan,
  withPlaying,
  withStopped,
  type SoundPlaybackEntry,
  type SoundPlaybackState,
} from "../services/sound-playback";

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
export type SceneSaveState = "saved" | "pending" | "saving" | "error";

/**
 * 网格标注（地图编辑）状态。
 *
 * 「怎么画 / 怎么显示」那一半（画笔类型 / 大小 / 每类的显示与颜色 / 网格线、网格标注、战争雾三个总开关）
 * 是**编辑器偏好**，会写进浏览器本地（对齐 Unity 把这几项存在编辑窗口的序列化字段里）。
 * 落笔的地方只有**编辑窗口**（`GridEditDialog`）——画布上不再有「标注模式」。
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
  /** 战争雾那一组设置是否露出来（编辑器偏好；画布上不画雾，要看雾去 Mask 窗口）。 */
  readonly showFog: boolean;
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
  /** 网格标注（画笔）状态：编辑窗口的涂 / 擦与画布的着色都读它。 */
  readonly gridPaint: GridPaintState;
  /**
   * 声音的**期望播放状态**（编辑器记账，见 `services/sound-playback`）。
   *
   * 不写文档、不进撤销栈；点播放 / 停止只改它 + 尽力下发，前端连上时补发。
   */
  readonly soundPlayback: SoundPlaybackState;

  /** 场景编辑（对象增删改）统一走这里：进撤销栈，并触发自动落盘。 */
  applyScenes(
    label: string,
    recipe: (draft: SceneListDraft) => void,
    options?: { coalesceKey?: string },
  ): boolean;
  undo(): void;
  redo(): void;
  resetDoc(doc: ProjectDoc): void;
  setActiveScene(name: string | null): void;
  /** 从资源面板**打开**一个场景：切到它，并把选中态交回场景（属性面板随之显示该场景）。 */
  openScene(name: string): void;
  setSelection(objectIds: readonly string[]): void;
  /** 选中资源文件（传 null 取消）。与对象选中互斥——属性面板一次只显示一样东西。 */
  selectAsset(id: string | null): void;
  setViewport(viewport: Viewport): void;
  zoomAtScreen(anchor: { x: number; y: number }, factor: number): void;
  panByScreen(dx: number, dy: number): void;
  fitToViewport(): void;
  /** 视图复位：缩放回 1:1，并把**世界原点摆回画布正中**（用户平移/缩放后一键回到 0,0）。 */
  resetViewport(): void;
  setViewportSize(size: { width: number; height: number }): void;
  setUi(patch: Partial<EditorUiState>): void;
  setMode(mode: EditorMode): void;
  connectRuntime(): void;
  disconnectRuntime(): void;
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
   * 把记着的期望状态补发一遍（前端刚连上时调用）。
   *
   * 返回补发的层数；编辑器的服务端连接没开、或前端没连时什么都不做（返回 0）。
   */
  flushSoundPlayback(): number;
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
   * 在**运行服务端的那台机器**上用文件管理器打开当前项目目录。
   *
   * 浏览器不能替用户开文件夹，所以这件事由后端调系统命令完成：从平板经局域网访问时，
   * 弹出来的是服务端那台电脑的窗口。失败（系统不支持 / 命令缺失）会写进 `project.error`。
   */
  openProjectFolder(): Promise<boolean>;
  uploadFiles(dirPath: string, files: readonly File[]): Promise<void>;
  deleteResource(id: string, label: string): Promise<boolean>;

  /** 立即把有改动的场景写回文件（手动保存 / 切场景前 flush）。 */
  saveSceneNow(): Promise<boolean>;
  /** 有待保存改动就立刻写回；场景级操作与关闭项目之前调用，避免丢失或写错场景。 */
  flushSceneSave(): Promise<void>;

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
  /** 删除对象（不传 ids 则删当前选中）。 */
  deleteObjects(ids?: readonly string[]): boolean;
  /** 复制对象（不传 ids 则复制当前选中）：副本加「副本」后缀并偏移一点位置。 */
  duplicateObjects(ids?: readonly string[]): boolean;
  /** 移动对象（画布拖动用，参数是世界坐标；连续调用合并成一条撤销记录）。 */
  moveObject(id: string, position: WorldPosition): void;
  /** 一次拖动结束：断开撤销合并，使后续拖动成为独立记录。 */
  endObjectDrag(): void;
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
   * 传进来的位先规范化（只留可绘制位、去重、升序）；一个都不指定 = 删掉这个配置。
   */
  setFogRegions(mapObjectId: string, regions: readonly number[]): boolean;
  /** 战争雾那一组设置是否露出来（编辑器偏好；纯界面，不动文档、也不画到画布上）。 */
  setFogVisible(visible: boolean): void;
}

/**
 * 平板（触控优先或窄屏）下默认收起左右面板，让场景铺满——
 * 三栏硬挤在平板竖屏上会把中间的场景压没。
 */
function initialUi(): EditorUiState {
  const compact =
    typeof window !== "undefined" &&
    (window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 1024);

  return { leftOpen: !compact, rightOpen: !compact, runtimeOpen: false };
}

/**
 * 场景编辑历史（React 之外持有；store 只订阅其变更）。
 *
 * 场景是独立文件、不进工程文件，所以历史挂在**场景列表**上：对象的新建 / 改名 /
 * 删除 / 移动都经 `applyScenes`，因此天然可撤销；撤销发生在哪个场景就改哪个场景。
 */
export const sceneHistory = new DocumentHistory<readonly SceneDoc[]>([], { limit: 200 });

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

/** 场景里的地图在世界里占的矩形（每张地图一块，各自带自己的贴图尺寸）。 */
export function sceneMapRects(scene: SceneDoc | undefined): WorldRect[] {
  // 只算**激活**的地图：它们才是画布上看得见的底图，「适配视图」自然只装看得见的东西
  return (scene?.objects ?? []).flatMap((object) =>
    object.active && object.kind === "Map" && object.map !== undefined && object.position !== null
      ? [worldRectOf(object.position, object.map.image)]
      : [],
  );
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

/**
 * 场景文件的序列化。
 *
 * 场景名**不进文件**（它就是文件名），所以写出去的内容只有内容本身——
 * 这也是「重命名场景 = 只改文件名」能成立的前提。
 */
function serializeSceneFile(scene: SceneDoc): string {
  const file: SceneFileDoc = {
    formatVersion: DOCUMENT_FORMAT_VERSION,
    objects: scene.objects,
  };

  return `${JSON.stringify(file, null, 2)}\n`;
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

  const runtimeClient = new RuntimeClient({
    onStatus: (status, detail) => {
      set((state) => ({
        runtime: {
          ...state.runtime,
          status,
          statusDetail: detail ?? "",
          // 自己没连着服务端时「前端在不在」无从得知：别留一个过期的「已连接」，
          // 也让「前端刚连上 → 补发」这条判断只在真的连上之后成立
          ...(status === "open" ? {} : { client: null, scene: null, runtimeActive: false }),
        },
      }));

      if (status === "open") {
        pushLog(makeLog("info", `已连接服务端${detail === undefined ? "" : ` ${detail}`}`));
      } else if (status === "closed") {
        pushLog(makeLog("warn", "与服务端断开，正在尝试重连"));
      } else if (status === "error") {
        pushLog(makeLog("error", detail ?? "连接出错"));
      }
    },

    onState: (snapshot: RuntimeStateSnapshot) => {
      const wasClientConnected = get().runtime.client !== null;
      set((state) => ({
        runtime: {
          ...state.runtime,
          runtimeActive: snapshot.runtimeActive,
          client: snapshot.client,
          scene: snapshot.scene,
        },
      }));

      // 前端刚连上：把记着的期望播放状态补发一遍（「点的时候前端不在」也不会丢）
      const plan = soundPlaybackResendPlan({
        wasClientConnected,
        isClientConnected: snapshot.client !== null,
        playback: get().soundPlayback,
      });
      if (plan.length > 0) {
        get().flushSoundPlayback();
      }
    },

    onServerLog: (entry) => {
      pushLog(entry);
    },

    onError: (reason, requestId) => {
      set((state) => ({ runtime: { ...state.runtime, lastError: reason } }));
      pushLog(makeLog("error", requestId === undefined ? reason : `[${requestId}] ${reason}`));
    },

    onCommandResult: (message) => {
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

    /**
     * WS 建立（含重连）之后：如果编辑器正处在运行态，就**补发**开闸声明与整份场景。
     *
     * 刷新页面会先断开关闸（前端被踢），重连后这两条让它恢复；前端本来就一直在重试，会自己连回来。
     */
    onOpen: () => {
      if (get().mode !== "run") {
        return;
      }

      runtimeClient.startRuntime();
      pushSceneNow();
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

  /**
   * 把一条「这一层该播什么」**尽力**发给前端。
   *
   * 编辑器没连服务端 / 前端不在时**不发**（状态已经记下），只写明白原因——
   * 等前端连上由 `flushSoundPlayback()` 补发，所以「点的时候前端不在」也不会丢。
   */
  const deliverSoundPlay = (entry: SoundPlaybackEntry): string | undefined => {
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

  const syncHistoryFlags = (): void => {
    set({
      scenes: sceneHistory.current,
      canUndo: sceneHistory.canUndo,
      canRedo: sceneHistory.canRedo,
      undoLabel: sceneHistory.undoLabel ?? "",
      redoLabel: sceneHistory.redoLabel ?? "",
    });
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
  /** 上次成功写盘时的场景内容（场景名 → 序列化文本），用来算「哪些场景有未保存改动」。 */
  const savedScenes = new Map<string, string>();
  let saveTimer: number | null = null;

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

    set({ sceneSaveState: "pending" });
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
    }

    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void get().saveSceneNow();
    }, SCENE_SAVE_DEBOUNCE_MS);
  };

  sceneHistory.subscribe(() => {
    syncHistoryFlags();
    // 运行态下文档一改就（去抖）把整份场景推给服务端 → 前端镜像跟着变
    scheduleRuntimePush();
    if (dirtySceneNames().length === 0) {
      set({ sceneSaveState: "saved" });
      return;
    }

    scheduleSceneSave();
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
      showFog: gridPaint.showFog,
    };
    writeGridPaintPrefs(prefs);
  };

  const storedGridPaint = readGridPaintPrefs();

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
    fogMask: false,
    fogMaskTarget: null,
    gridEditor: false,
    gridEditorTarget: null,
    sceneSaveState: "saved",
    sceneSaveError: "",
    gridPaint: {
      mask: storedGridPaint.mask,
      brushSize: storedGridPaint.brushSize,
      hiddenMask: storedGridPaint.hiddenMask,
      colors: storedGridPaint.colors,
      showGridLines: storedGridPaint.showGridLines,
      showAnnotations: storedGridPaint.showAnnotations,
      showFog: storedGridPaint.showFog,
    },
    soundPlayback: emptySoundPlayback(),
    runtime: {
      status: "idle",
      statusDetail: "",
      runtimeActive: false,
      client: null,
      scene: null,
      logs: [],
      lastError: "",
    },

    applyScenes(label, recipe, options) {
      // 订阅里会同步 scenes 与撤销/重做标记，并安排自动落盘
      return sceneHistory.apply(label, recipe, options ?? {});
    },

    undo() {
      sceneHistory.undo();
    },

    redo() {
      sceneHistory.redo();
    },

    resetDoc(doc) {
      savedScenes.clear();
      // 订阅里会把 scenes 清空、撤销栈清掉，并把保存状态置回 saved
      sceneHistory.reset([]);
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
        // 换了文档：两个格子编辑窗口盯着的地图对象必然失效（偏好留着，下个项目接着用）
        // 两个格子编辑窗口同理：它们指向的地图对象已经不存在了
        fogMask: false,
        fogMaskTarget: null,
        gridEditor: false,
        gridEditorTarget: null,
        // 换了文档：记着的「哪一层该播什么」盯的是上一个项目的对象，清掉
        soundPlayback: emptySoundPlayback(),
      });
    },

    setActiveScene(name) {
      // 切场景前先把手上未保存的改动写回（写入谁由内容差异决定，所以不会写错场景）
      void get().flushSceneSave();
      set({
        activeSceneName: name,
        selectedObjectIds: [],
        fogMask: false,
        fogMaskTarget: null,
        gridEditor: false,
        gridEditorTarget: null,
        // 切场景：记账里的对象属于上一个场景，清掉（前端那边由使用方自己按新场景重播）
        soundPlayback: emptySoundPlayback(),
      });
    },

    openScene(name) {
      if (!get().scenes.some((scene) => scene.name === name)) {
        return;
      }

      void get().flushSceneSave();
      // 打开场景 = 切到它并清掉别的选中：属性面板接着显示这个场景
      set({
        activeSceneName: name,
        selectedObjectIds: [],
        selectedAssetId: null,
        fogMask: false,
        fogMaskTarget: null,
        gridEditor: false,
        gridEditorTarget: null,
        soundPlayback: emptySoundPlayback(),
      });
      pushLog(makeLog("info", `已切换到场景：${name}`));
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
      // 场景整体铺满视口；视口尺寸还没量出来时退回「世界原点居中」
      const scene = scenes.find((item) => item.name === activeSceneName);
      if (viewportSize.width === 0 || viewportSize.height === 0) {
        viewportAdjusted = false;
        set({ viewport: createViewport() });
        return;
      }

      viewportAdjusted = true;
      // 世界无限大：这里装的是**所有地图**的并集外框（一张地图都没有就退回原点居中）
      set({ viewport: fitViewport(sceneMapRects(scene), viewportSize, 24) });
    },

    setViewportSize(size) {
      const previous = get().viewportSize;
      if (previous.width === size.width && previous.height === size.height) {
        return;
      }

      // 尺寸首次确定或用户还没调过视口时，把世界原点摆回正中；
      // 用户一旦自己平移 / 缩放过，就不要再动他的视角。
      if (!viewportAdjusted) {
        set({ viewportSize: size, viewport: createCenteredViewport(size) });
        return;
      }

      set({ viewportSize: size });
    },

    resetViewport() {
      viewportAdjusted = false;
      set({ viewport: createCenteredViewport(get().viewportSize) });
    },

    setUi(patch) {
      set((state) => ({ ui: { ...state.ui, ...patch } }));
    },

    setMode(mode) {
      // 进入运行态时自动展开运行面板：否则「切到运行」后界面毫无反馈，功能不可发现
      set((state) => ({
        mode,
        ui: mode === "run" ? { ...state.ui, runtimeOpen: true } : state.ui,
      }));

      if (mode === "run") {
        // 连上服务端 → 声明运行态（服务端据此**开闸**：前端现在才连得上）→ 推整份场景
        get().connectRuntime();
        if (runtimeClient.connected) {
          runtimeClient.startRuntime();
          get().pushRuntimeScene();
        }

        return;
      }

      // 退出运行态：先声明关闸（服务端会踢掉前端），再断开自己的连接
      pushScheduler.cancel();
      lastPushedSceneText = null;
      if (runtimeClient.connected) {
        runtimeClient.stopRuntime();
      }

      get().disconnectRuntime();
    },

    connectRuntime() {
      runtimeClient.connect();
    },

    disconnectRuntime() {
      runtimeClient.disconnect();
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

      // 先记账（「这一层现在该播什么」），再尽力下发——所以编辑器没连服务端 / 前端不在
      // 也点得动：状态记着，等前端连上补发
      const entry: SoundPlaybackEntry = {
        objectId,
        layer: sound?.layer ?? DEFAULT_SOUND_LAYER,
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

      const label = `层级 ${SOUND_LAYER_LABELS[layer]}`;
      if (!runtimeClient.connected) {
        pushLog(makeLog("info", `已记录停止：${label}（编辑器还没连上服务端，连上后自动补发）`));
        return undefined;
      }

      if (get().runtime.client === null) {
        pushLog(makeLog("info", `已记录停止：${label}（前端未连接，等它连上后自动补发）`));
        return undefined;
      }

      const requestId = runtimeClient.sendCommand({ kind: "stop_sound", layer });
      pushLog(makeLog("info", `下发停止：${label}`));
      return requestId;
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
        pushLog(
          makeLog(
            "info",
            `补发播放：层级 ${SOUND_LAYER_LABELS[entry.layer]}（${entry.clips[0] ?? "(空)"}）`,
          ),
        );
      }

      return entries.length;
    },

    clearRuntimeLogs() {
      set((state) => ({ runtime: { ...state.runtime, logs: [] } }));
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

        // 旧版工程文件：把内联场景落成独立文件，工程文件按新格式回写（只做一次）
        if (load.migratedScenes.length > 0 || load.needsRewrite) {
          for (const scene of load.migratedScenes) {
            await projectApi.writeText(
              projectSceneFileId(name, scene.name),
              serializeSceneFile(scene),
            );
          }

          await projectApi.writeText(
            projectFileId(name),
            `${JSON.stringify(load.doc, null, 2)}\n`,
          );
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

    async openProjectFolder() {
      const project = get().project.current;
      if (project === null) {
        return false;
      }

      try {
        const path = await projectApi.reveal(project);
        // 顺手清掉上一次的错误：成功了还挂着红字会让人以为没成功
        set((state) => ({ project: { ...state.project, error: "" } }));
        pushLog(makeLog("info", `已打开项目目录：${path}`));
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

    async loadScenes() {
      const project = get().project.current;
      if (project === null) {
        set({ scenes: [], activeSceneName: null });
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

        scenes.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));

        // 旧格式的场景文件（带着已废弃的字段）按新格式回写一次——只做一次
        for (const scene of legacy) {
          await projectApi.writeText(
            projectSceneFileId(project, scene.name),
            serializeSceneFile(scene),
          );
        }

        // 记下每个场景「磁盘上的样子」：之后的未保存改动就是拿它比出来的
        savedScenes.clear();
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

    setFogVisible(visible) {
      const gridPaint: GridPaintState = { ...get().gridPaint, showFog: visible };
      set({ gridPaint });
      persistGridPaint(gridPaint);
    },
  };
});
