import { create } from "zustand";
import {
  DOCUMENT_FORMAT_VERSION,
  DocumentHistory,
  addObject,
  createEmptyProject,
  createEmptyScene,
  createId,
  createMapObject,
  createSceneObject,
  isSceneNameTaken,
  nextObjectName,
  parseProjectFile,
  parseSceneFile,
  removeObject as removeSceneObject,
  renameObject as renameSceneObject,
  setObjectPosition as setSceneObjectPosition,
  validateSceneName,
  type ObjectKind,
  type ProjectDoc,
  type SceneDoc,
  type SceneFileDoc,
  type SceneListDraft,
  type SceneObjectDoc,
  type WorldPosition,
} from "@dts/document";
import { gridSizeFromImage, worldExtentOf, type ImageSize } from "@dts/grid";
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
import type { GameStateSnapshot } from "@dts/protocol";
import {
  RuntimeClient,
  type RuntimeLogEntry,
  type RuntimeStatus,
} from "../services/runtime-client";
import {
  projectApi,
  contentTypeFor,
  type ProjectSummary,
  type ResourceTreeNode,
} from "../services/project-api";
import { clearLastProject, readLastProject, writeLastProject } from "../services/session";
import { clearSceneImageCache } from "../services/scene-image";

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
  readonly clientConnected: boolean;
  readonly state: GameStateSnapshot;
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
  /** 场景文件的保存状态（自动存与手动保存共用） */
  readonly sceneSaveState: SceneSaveState;
  readonly sceneSaveError: string;

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
  invokeAction(objectId: string, actionId: string): string | undefined;
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
  /** 删除对象（不传 ids 则删当前选中）。 */
  deleteObjects(ids?: readonly string[]): boolean;
  /** 复制对象（不传 ids 则复制当前选中）：副本加「副本」后缀并偏移一点位置。 */
  duplicateObjects(ids?: readonly string[]): boolean;
  /** 移动对象（画布拖动用，参数是世界坐标；连续调用合并成一条撤销记录）。 */
  moveObject(id: string, position: WorldPosition): void;
  /** 一次拖动结束：断开撤销合并，使后续拖动成为独立记录。 */
  endObjectDrag(): void;
}

const EMPTY_GAME_STATE: GameStateSnapshot = {
  currentMap: "",
  players: {},
  objects: {},
};

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

/** 场景里对象位置的默认落点：世界原点（= 场景正中）。 */
const SCENE_CENTER: WorldPosition = { x: 0, y: 0 };

/**
 * 新建地图对象时的默认贴图尺寸。
 *
 * 与画布占位尺寸取同一个值（1920×1080 → 64×36 格）：贴图按同名约定放在
 * `Assets/images/<场景名>.png`，网格尺寸由图片算出来，不手写 64×36。
 */
const DEFAULT_MAP_IMAGE = { width: 1920, height: 1080 } as const;

/** 系统尚未创建地图对象时的占位场景尺寸（与 `DEFAULT_MAP_IMAGE` 同值）。 */
export const PLACEHOLDER_SCENE_SIZE: ImageSize = DEFAULT_MAP_IMAGE;

/**
 * 场景尺寸（世界坐标的半宽半高就由它决定）：有地图对象就用它的贴图尺寸，否则用占位尺寸。
 *
 * **绘制、命中测试、拖动落点必须用同一个尺寸**，否则会出现「点哪儿不在哪儿」。
 */
export function sceneImageSize(scene: SceneDoc | undefined): ImageSize {
  const mapObject = scene?.objects.find((object) => object.kind === "Map");
  return mapObject?.map?.image ?? PLACEHOLDER_SCENE_SIZE;
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

/** 把世界坐标夹进场景范围内（画布拖动可能拖到场景外）。 */
export function clampToScene(position: WorldPosition, scene: SceneDoc | undefined): WorldPosition {
  const extent = worldExtentOf(sceneImageSize(scene));
  return {
    x: Math.min(extent.halfWidth, Math.max(-extent.halfWidth, position.x)),
    y: Math.min(extent.halfHeight, Math.max(-extent.halfHeight, position.y)),
  };
}

/** 副本相对原对象的偏移量（世界像素，按第几个副本递增，避免整批叠在一起）。 */
const COPY_OFFSET = 24;

/** 复制出来的副本落点：偏移一点并夹回场景内。 */
function offsetPosition(
  position: WorldPosition | null,
  step: number,
  scene: SceneDoc | undefined,
): WorldPosition {
  const base = position ?? SCENE_CENTER;
  return clampToScene(
    { x: base.x + COPY_OFFSET * step, y: base.y + COPY_OFFSET * step },
    scene,
  );
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

  const runtimeClient = new RuntimeClient({
    onStatus: (status, detail) => {
      set((state) => ({
        runtime: { ...state.runtime, status, statusDetail: detail ?? "" },
      }));

      if (status === "open") {
        pushLog(makeLog("info", `已连接服务端${detail === undefined ? "" : ` ${detail}`}`));
      } else if (status === "closed") {
        pushLog(makeLog("warn", "与服务端断开，正在尝试重连"));
      } else if (status === "error") {
        pushLog(makeLog("error", detail ?? "连接出错"));
      }
    },

    onSnapshot: (gameState, clientConnected) => {
      set((state) => ({
        runtime: { ...state.runtime, state: gameState, clientConnected },
      }));
    },

    onActionResult: (message) => {
      pushLog(
        makeLog(
          message.ok ? "info" : "warn",
          `动作 ${message.objectId}/${message.actionId} ${message.ok ? "执行成功" : `执行失败：${message.reason ?? "未知原因"}`}${
            message.effects !== undefined && message.effects.length > 0
              ? `（${message.effects.join("，")}）`
              : ""
          }`,
        ),
      );
    },

    onError: (reason, requestId) => {
      set((state) => ({ runtime: { ...state.runtime, lastError: reason } }));
      pushLog(makeLog("error", requestId === undefined ? reason : `[${requestId}] ${reason}`));
    },
  });

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
    if (dirtySceneNames().length === 0) {
      set({ sceneSaveState: "saved" });
      return;
    }

    scheduleSceneSave();
  });

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
    sceneSaveState: "saved",
    sceneSaveError: "",
    runtime: {
      status: "idle",
      statusDetail: "",
      clientConnected: false,
      state: EMPTY_GAME_STATE,
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
      });
    },

    setActiveScene(name) {
      // 切场景前先把手上未保存的改动写回（写入谁由内容差异决定，所以不会写错场景）
      void get().flushSceneSave();
      set({ activeSceneName: name, selectedObjectIds: [] });
    },

    openScene(name) {
      if (!get().scenes.some((scene) => scene.name === name)) {
        return;
      }

      void get().flushSceneSave();
      // 打开场景 = 切到它并清掉别的选中：属性面板接着显示这个场景
      set({ activeSceneName: name, selectedObjectIds: [], selectedAssetId: null });
      pushLog(makeLog("info", `已切换到场景：${name}`));
    },

    setSelection(objectIds) {
      // 选中对象就取消资源选中：属性面板一次只显示一样东西
      set({ selectedObjectIds: [...objectIds], selectedAssetId: null });
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
      set({ viewport: fitViewport(sceneImageSize(scene), viewportSize, 24) });
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
        get().connectRuntime();
      } else {
        get().disconnectRuntime();
      }
    },

    connectRuntime() {
      runtimeClient.connect();
    },

    disconnectRuntime() {
      runtimeClient.disconnect();
    },

    invokeAction(objectId, actionId) {
      if (!runtimeClient.connected) {
        pushLog(makeLog("error", "未连接服务端，无法触发动作"));
        return undefined;
      }

      const requestId = runtimeClient.invokeAction(objectId, actionId);
      pushLog(makeLog("info", `触发动作 ${objectId}/${actionId}（${requestId}）`));
      return requestId;
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
        // 只改文件名：场景名就是文件名，所以内容一个字节都不用重写
        await projectApi.renameResource(
          projectSceneFileId(project, current),
          projectSceneFileId(project, trimmed),
        );
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

      // 落点夹到场景内：画布拖动可能给出越界坐标，夹一次就够（写入端唯一）
      const at =
        position === undefined
          ? { ...SCENE_CENTER }
          : clampToScene({ x: position.x, y: position.y }, scene);
      const object: SceneObjectDoc =
        kind === "Map"
          ? {
              // 地图对象的贴图按同名约定取 Assets/images/<场景名>.png，网格由贴图尺寸算出来
              ...createMapObject({
                name: trimmed,
                image: {
                  id: projectSceneImageId(project, sceneName),
                  width: DEFAULT_MAP_IMAGE.width,
                  height: DEFAULT_MAP_IMAGE.height,
                },
                grid: { ...gridSizeFromImage(DEFAULT_MAP_IMAGE), cellSize: 1 },
              }),
              // 地图铺满整个场景，没有「摆在哪个点」这回事：不给位置，画布上就不画标记点
              position: null,
            }
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
              position: offsetPosition(source.position, step, scene),
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

      get().applyScenes(
        "移动对象",
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene !== undefined) {
            setSceneObjectPosition(scene, id, clampToScene(position, scene));
          }
        },
        { coalesceKey: `move:${id}` },
      );
    },

    endObjectDrag() {
      sceneHistory.endCoalescing();
    },
  };
});
