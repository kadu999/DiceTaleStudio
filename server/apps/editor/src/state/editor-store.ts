import { create } from "zustand";
import {
  DocumentHistory,
  addObject,
  addScene,
  createEmptyProject,
  createMapObject,
  createSceneDoc,
  createSceneObject,
  findScene,
  isSceneNameTaken,
  parseProjectDoc,
  removeScene,
  renameScene,
  validateSceneName,
  type ObjectKind,
  type ProjectDoc,
  type ProjectDraft,
} from "@dts/document";
import { campaignFileId, campaignMapImageId, campaignProjectId } from "@dts/resources";
import { createViewport, fitViewport, panBy, zoomAt, type Viewport } from "@dts/renderer";
import type { GameStateSnapshot } from "@dts/protocol";
import {
  RuntimeClient,
  type RuntimeLogEntry,
  type RuntimeStatus,
} from "../services/runtime-client";
import {
  campaignApi,
  contentTypeFor,
  type CampaignSummary,
  type ResourceTreeNode,
} from "../services/campaign-api";

/**
 * 编辑器状态。
 *
 * 关键约束：
 * - **文档**由 `DocumentHistory` 持有（补丁式撤销/重做），store 里只镜像当前值；
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

/** 跑团工程（一个跑团 = 一个文件夹 + 一个工程文件）相关状态。 */
export interface CampaignUiState {
  readonly list: readonly CampaignSummary[];
  /** 当前已打开的跑团；null 表示尚未打开工程 */
  readonly current: string | null;
  readonly tree: readonly ResourceTreeNode[];
  readonly busy: boolean;
  readonly error: string;
}

export interface EditorStoreState {
  readonly mode: EditorMode;
  readonly doc: ProjectDoc;
  readonly activeMapId: string | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string;
  readonly redoLabel: string;
  readonly selectedObjectIds: readonly string[];
  readonly viewport: Viewport;
  readonly viewportSize: { width: number; height: number };
  readonly ui: EditorUiState;
  readonly runtime: RuntimeUiState;
  readonly campaign: CampaignUiState;

  applyDoc(
    label: string,
    recipe: (draft: ProjectDraft) => void,
    options?: { coalesceKey?: string },
  ): boolean;
  undo(): void;
  redo(): void;
  resetDoc(doc: ProjectDoc): void;
  setActiveMap(mapId: string | null): void;
  setSelection(objectIds: readonly string[]): void;
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

  refreshCampaigns(): Promise<void>;
  createProject(name: string): Promise<boolean>;
  openProject(name: string): Promise<boolean>;
  closeProject(): void;
  refreshTree(): Promise<void>;
  createFolder(path: string): Promise<boolean>;
  uploadFiles(dirPath: string, files: readonly File[]): Promise<void>;
  deleteResource(id: string, label: string): Promise<boolean>;

  saveProject(): Promise<boolean>;
  createScene(name: string): boolean;
  deleteScene(sceneId: string): boolean;
  renameScene(sceneId: string, name: string): boolean;
  switchScene(sceneId: string): void;
  /** 在当前场景里新建对象（**不需要地图**）。 */
  createObject(kind: ObjectKind, name: string): boolean;
  /** 在当前场景里添加一个地图对象（贴图 + 网格；地图只是场景里的一个对象）。 */
  addMapObject(name?: string): boolean;
}

const EMPTY_GAME_STATE: GameStateSnapshot = {
  currentMap: "",
  players: {},
  spawnPoints: {},
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

/** 新场景的默认尺寸（与 DiceTale 现有地图一致：1920x1080 贴图 / 64x36 格，每格 30px）。 */
const DEFAULT_SCENE_IMAGE = { width: 1920, height: 1080 } as const;
const DEFAULT_SCENE_GRID = { width: 64, height: 36 } as const;

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

  /** 打开工程时不要立刻回写文件。 */
  let suppressAutoSave = false;
  let saveTimer: number | null = null;

  /**
   * 文档变更后延迟回写工程文件。
   *
   * 工程就是那一个文件，因此「改了就存」比「记得手动保存」更不容易丢东西；
   * 撤销/重做也会一并落盘，磁盘与内存不会脱节。
   */
  const scheduleAutoSave = (): void => {
    if (suppressAutoSave || get().campaign.current === null) {
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
    activeMapId: null,
    canUndo: false,
    canRedo: false,
    undoLabel: "",
    redoLabel: "",
    selectedObjectIds: [],
    viewport: createViewport(),
    viewportSize: { width: 0, height: 0 },
    ui: initialUi(),
    campaign: { list: [], current: null, tree: [], busy: false, error: "" },
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
        activeMapId: doc.scenes[0]?.id ?? null,
      });
    },

    setActiveMap(mapId) {
      set({ activeMapId: mapId, selectedObjectIds: [] });
    },

    setSelection(objectIds) {
      set({ selectedObjectIds: [...objectIds] });
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
      const { doc, activeMapId, viewportSize } = get();
      // 视口按场景里地图对象的贴图尺寸适配；没有地图对象就回到默认视口
      const scene = doc.scenes.find((item) => item.id === activeMapId);
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

    // ---------------------------------------------------------------- 跑团工程

    async refreshCampaigns() {
      set((state) => ({ campaign: { ...state.campaign, busy: true, error: "" } }));
      try {
        const list = await campaignApi.list();
        set((state) => ({ campaign: { ...state.campaign, list, busy: false } }));
      } catch (error) {
        set((state) => ({
          campaign: {
            ...state.campaign,
            busy: false,
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    },

    async createProject(name) {
      set((state) => ({ campaign: { ...state.campaign, busy: true, error: "" } }));
      try {
        await campaignApi.create(name);
        await get().refreshCampaigns();
        return await get().openProject(name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ campaign: { ...state.campaign, busy: false, error: message } }));
        pushLog(makeLog("error", `新建跑团失败：${message}`));
        return false;
      }
    },

    async openProject(name) {
      set((state) => ({ campaign: { ...state.campaign, busy: true, error: "" } }));
      try {
        const text = await campaignApi.readText(campaignProjectId(name));
        const doc = parseProjectDoc(JSON.parse(text) as unknown);
        suppressAutoSave = true;
        get().resetDoc(doc);
        suppressAutoSave = false;

        const tree = await campaignApi.tree(name);
        set((state) => ({ campaign: { ...state.campaign, current: name, tree, busy: false } }));
        pushLog(makeLog("info", `已打开跑团：${name}`));
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ campaign: { ...state.campaign, busy: false, error: message } }));
        pushLog(makeLog("error", `打开跑团失败：${message}`));
        return false;
      }
    },

    closeProject() {
      set((state) => ({ campaign: { ...state.campaign, current: null, tree: [], error: "" } }));
      get().resetDoc(createEmptyProject());
    },

    async refreshTree() {
      const campaign = get().campaign.current;
      if (campaign === null) {
        return;
      }

      try {
        const tree = await campaignApi.tree(campaign);
        set((state) => ({ campaign: { ...state.campaign, tree, error: "" } }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ campaign: { ...state.campaign, error: message } }));
      }
    },

    async createFolder(path) {
      const campaign = get().campaign.current;
      if (campaign === null) {
        return false;
      }

      try {
        await campaignApi.createFolder(campaign, path);
        await get().refreshTree();
        pushLog(makeLog("info", `已创建目录：${path}`));
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ campaign: { ...state.campaign, error: message } }));
        pushLog(makeLog("error", `创建目录失败：${message}`));
        return false;
      }
    },

    async uploadFiles(dirPath, files) {
      const campaign = get().campaign.current;
      if (campaign === null || files.length === 0) {
        return;
      }

      try {
        for (const file of files) {
          const relative = dirPath.length > 0 ? `${dirPath}/${file.name}` : file.name;
          await campaignApi.uploadBinary(
            campaignFileId(campaign, relative),
            await file.arrayBuffer(),
            contentTypeFor(file.name),
          );
        }

        await get().refreshTree();
        pushLog(makeLog("info", `已导入 ${files.length} 个资源`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ campaign: { ...state.campaign, error: message } }));
        pushLog(makeLog("error", `导入资源失败：${message}`));
      }
    },

    async deleteResource(id, label) {
      try {
        await campaignApi.deleteResource(id);
        await get().refreshTree();
        pushLog(makeLog("info", `已删除：${label}`));
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ campaign: { ...state.campaign, error: message } }));
        pushLog(makeLog("error", `删除失败：${message}`));
        return false;
      }
    },

    // ---------------------------------------------------------------- 场景

    async saveProject() {
      const campaign = get().campaign.current;
      if (campaign === null) {
        return false;
      }

      try {
        const text = `${JSON.stringify(get().doc, null, 2)}\n`;
        await campaignApi.writeText(campaignProjectId(campaign), text);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ campaign: { ...state.campaign, error: message } }));
        pushLog(makeLog("error", `保存工程失败：${message}`));
        return false;
      }
    },

    createScene(name) {
      const trimmed = name.trim();
      const reason = validateSceneName(trimmed);
      if (reason !== undefined) {
        pushLog(makeLog("error", reason));
        return false;
      }

      const doc = get().doc;
      if (isSceneNameTaken(doc, trimmed)) {
        pushLog(makeLog("error", `场景「${trimmed}」已存在`));
        return false;
      }

      const sceneId = `scene_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      // 新场景是**空场景**：所有对象（含地图）随后按需添加
      const scene = createSceneDoc({ id: sceneId, name: trimmed });

      get().applyDoc(`新建场景 ${trimmed}`, (draft) => {
        addScene(draft, scene);
      });
      set({ activeMapId: sceneId, selectedObjectIds: [] });
      pushLog(makeLog("info", `已创建场景：${trimmed}（空场景，可添加对象）`));
      return true;
    },

    createObject(kind, name) {
      const sceneId = get().activeMapId;
      if (sceneId === null) {
        pushLog(makeLog("error", "还没有场景，先建一个场景再添加对象"));
        return false;
      }

      const object = createSceneObject({ name, kind });
      const changed = get().applyDoc(`新建对象 ${name}`, (draft) => {
        const scene = findScene(draft, sceneId);
        if (scene !== undefined) {
          addObject(scene, object);
        }
      });

      if (changed) {
        set({ selectedObjectIds: [object.id] });
        pushLog(makeLog("info", `已新建对象：${name}（${kind}）`));
      }

      return changed;
    },

    addMapObject(name) {
      const sceneId = get().activeMapId;
      const doc = get().doc;
      const scene = sceneId === null ? undefined : doc.scenes.find((item) => item.id === sceneId);
      if (sceneId === null || scene === undefined) {
        pushLog(makeLog("error", "还没有场景，先建一个场景再添加地图"));
        return false;
      }

      const campaign = get().campaign.current;
      const mapName = name ?? `${scene.name} 地图`;
      const mapObject = createMapObject({
        name: mapName,
        // 贴图按同名约定放在跑团的 images/maps/ 下
        image: {
          id: campaign === null ? "" : campaignMapImageId(campaign, scene.name),
          width: DEFAULT_SCENE_IMAGE.width,
          height: DEFAULT_SCENE_IMAGE.height,
        },
        grid: { width: DEFAULT_SCENE_GRID.width, height: DEFAULT_SCENE_GRID.height, cellSize: 1 },
      });

      const changed = get().applyDoc(`添加地图对象 ${mapName}`, (draft) => {
        const target = findScene(draft, sceneId);
        if (target !== undefined) {
          addObject(target, mapObject);
        }
      });

      if (changed) {
        set({ selectedObjectIds: [mapObject.id] });
        pushLog(
          makeLog(
            "info",
            `已添加地图对象：${mapName}（${DEFAULT_SCENE_GRID.width}×${DEFAULT_SCENE_GRID.height}）`,
          ),
        );
      }

      return changed;
    },

    deleteScene(sceneId) {
      const doc = get().doc;
      const scene = doc.scenes.find((item) => item.id === sceneId);
      if (scene === undefined) {
        return false;
      }

      if (doc.scenes.length <= 1) {
        pushLog(makeLog("warn", "至少要保留一个场景"));
        return false;
      }

      const changed = get().applyDoc(`删除场景 ${scene.name}`, (draft) => {
        removeScene(draft, sceneId);
      });
      if (!changed) {
        return false;
      }

      if (get().activeMapId === sceneId) {
        set({ activeMapId: get().doc.scenes[0]?.id ?? null, selectedObjectIds: [] });
      }

      pushLog(makeLog("info", `已删除场景：${scene.name}`));
      return true;
    },

    renameScene(sceneId, name) {
      const trimmed = name.trim();
      const reason = validateSceneName(trimmed);
      if (reason !== undefined) {
        pushLog(makeLog("error", reason));
        return false;
      }

      if (isSceneNameTaken(get().doc, trimmed, sceneId)) {
        pushLog(makeLog("error", `场景「${trimmed}」已存在`));
        return false;
      }

      const changed = get().applyDoc(`重命名场景为 ${trimmed}`, (draft) => {
        renameScene(draft, sceneId, trimmed);
      });
      if (changed) {
        pushLog(makeLog("info", `场景已重命名为：${trimmed}`));
      }

      return changed;
    },

    switchScene(sceneId) {
      get().setActiveMap(sceneId);
      const scene = get().doc.scenes.find((item) => item.id === sceneId);
      if (scene !== undefined) {
        pushLog(makeLog("info", `已切换到场景：${scene.name}`));
      }
    },
  };
});
