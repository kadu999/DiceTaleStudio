import { create } from "zustand";
import {
  DOCUMENT_FORMAT_VERSION,
  DocumentHistory,
  createEmptyProject,
  createEmptyScene,
  isSceneNameTaken,
  parseProjectFile,
  parseSceneFile,
  validateSceneName,
  type ProjectDoc,
  type ProjectDraft,
  type SceneDoc,
  type SceneFileDoc,
} from "@dts/document";
import {
  PROJECT_FOLDERS,
  PROJECT_SCENE_FILE_EXTENSION,
  projectAssetId,
  projectFileId,
  projectSceneFileId,
} from "@dts/resources";
import { createViewport, fitViewport, panBy, zoomAt, type Viewport } from "@dts/renderer";
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

  applyDoc(
    label: string,
    recipe: (draft: ProjectDraft) => void,
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

  saveProject(): Promise<boolean>;

  /** 重新扫描 `Assets/scenes/` 并把场景读进内存（打开项目、增删改名后调用）。 */
  loadScenes(): Promise<void>;
  openSceneDialog(mode: SceneDialogMode): void;
  /**
   * 新建场景：在 `Assets/scenes/` 下建一个空场景文件。成功返回 undefined，失败返回原因。
   */
  createScene(name: string): Promise<string | undefined>;
  /** 重命名当前场景：**只改文件名**，场景内容一个字节都不重写。 */
  renameScene(name: string): Promise<string | undefined>;
  /** 删除当前场景（至少要保留一个场景）。 */
  deleteScene(): Promise<string | undefined>;
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

/** 文档历史（React 之外持有；store 只订阅其变更）。 */
export const docHistory = new DocumentHistory<ProjectDoc>(createEmptyProject(), { limit: 200 });

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
      doc: docHistory.current,
      canUndo: docHistory.canUndo,
      canRedo: docHistory.canRedo,
      undoLabel: docHistory.undoLabel ?? "",
      redoLabel: docHistory.redoLabel ?? "",
    });
  };

  /** 打开项目时不要立刻回写文件。 */
  let suppressAutoSave = false;
  let saveTimer: number | null = null;
  /** 启动引导是否正在跑（同步占位，挡住 StrictMode 的第二次 effect）。 */
  let bootstrapping = false;

  /**
   * 文档变更后延迟回写工程文件。
   *
   * 工程就是那一个文件，因此「改了就存」比「记得手动保存」更不容易丢东西；
   * 撤销/重做也会一并落盘，磁盘与内存不会脱节。
   */
  const scheduleAutoSave = (): void => {
    if (suppressAutoSave || get().project.current === null) {
      return;
    }

    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
    }

    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void get().saveProject();
    }, 800);
  };

  docHistory.subscribe(() => {
    syncHistoryFlags();
    scheduleAutoSave();
  });

  return {
    mode: "edit",
    doc: docHistory.current,
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
    runtime: {
      status: "idle",
      statusDetail: "",
      clientConnected: false,
      state: EMPTY_GAME_STATE,
      logs: [],
      lastError: "",
    },

    applyDoc(label, recipe, options) {
      const changed = docHistory.apply(label, recipe, options ?? {});
      if (changed) {
        syncHistoryFlags();
      }

      return changed;
    },

    undo() {
      if (docHistory.undo()) {
        syncHistoryFlags();
      }
    },

    redo() {
      if (docHistory.redo()) {
        syncHistoryFlags();
      }
    },

    resetDoc(doc) {
      docHistory.reset(doc);
      set({
        doc: docHistory.current,
        canUndo: false,
        canRedo: false,
        undoLabel: "",
        redoLabel: "",
        selectedObjectIds: [],
        selectedAssetId: null,
        // 场景是独立文件，由 loadScenes() 装进来；这里只清空当前指向
        scenes: [],
        activeSceneName: null,
      });
    },

    setActiveScene(name) {
      set({ activeSceneName: name, selectedObjectIds: [] });
    },

    openScene(name) {
      if (!get().scenes.some((scene) => scene.name === name)) {
        return;
      }

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
      set({ viewport });
    },

    zoomAtScreen(anchor, factor) {
      set({ viewport: zoomAt(get().viewport, factor, anchor) });
    },

    panByScreen(dx, dy) {
      set({ viewport: panBy(get().viewport, dx, dy) });
    },

    fitToViewport() {
      const { scenes, activeSceneName, viewportSize } = get();
      // 视口按场景里地图对象的贴图尺寸适配；没有地图对象就回到默认视口
      const scene = scenes.find((item) => item.name === activeSceneName);
      const mapObject = scene?.objects.find((object) => object.kind === "Map");
      if (mapObject?.map === undefined || viewportSize.width === 0) {
        set({ viewport: createViewport() });
        return;
      }

      set({
        viewport: fitViewport(
          { width: mapObject.map.image.width, height: mapObject.map.image.height },
          viewportSize,
          24,
        ),
      });
    },

    setViewportSize(size) {
      const previous = get().viewportSize;
      if (previous.width === size.width && previous.height === size.height) {
        return;
      }

      set({ viewportSize: size });
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
      set((state) => ({ project: { ...state.project, busy: true, error: "" } }));
      try {
        const text = await projectApi.readText(projectFileId(name));
        const load = parseProjectFile(JSON.parse(text) as unknown);

        suppressAutoSave = true;
        get().resetDoc(load.doc);
        suppressAutoSave = false;

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

    async saveProject() {
      const project = get().project.current;
      if (project === null) {
        return false;
      }

      try {
        // 工程文件只有项目级数据（场景是 Assets/scenes/ 下的独立文件）
        const text = `${JSON.stringify(get().doc, null, 2)}\n`;
        await projectApi.writeText(projectFileId(project), text);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ project: { ...state.project, error: message } }));
        pushLog(makeLog("error", `保存项目失败：${message}`));
        return false;
      }
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
          const parsed = parseSceneFile(JSON.parse(text) as unknown);
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

        const previous = get().activeSceneName;
        const keep = scenes.some((scene) => scene.name === previous);
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

    async createScene(name) {
      const project = get().project.current;
      if (project === null) {
        return "还没有打开项目";
      }

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
  };
});
