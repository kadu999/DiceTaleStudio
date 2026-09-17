import { create } from "zustand";
import {
  DocumentHistory,
  createEmptyProject,
  type ProjectDoc,
  type ProjectDraft,
} from "@dts/document";
import { createViewport, fitViewport, panBy, zoomAt, type Viewport } from "@dts/renderer";
import type { GameStateSnapshot } from "@dts/protocol";
import {
  RuntimeClient,
  type RuntimeLogEntry,
  type RuntimeStatus,
} from "../services/runtime-client";

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

  docHistory.subscribe(syncHistoryFlags);

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
        activeMapId: doc.maps[0]?.id ?? null,
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
      const map = doc.maps.find((item) => item.id === activeMapId);
      if (map === undefined || viewportSize.width === 0) {
        set({ viewport: createViewport() });
        return;
      }

      set({
        viewport: fitViewport(
          { width: map.image.width, height: map.image.height },
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
  };
});
