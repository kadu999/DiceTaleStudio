/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 初始状态（`EditorStoreState` 里**不是 action** 的那一半）。
 */
import { createEmptyProject } from "@dts/document";
import { createViewport } from "@dts/renderer";
import { emptyBgmPlayback } from "../services/bgm-playback";
import { type GridPaintPrefs } from "../services/grid-paint-prefs";
import { emptySoundPlayback } from "../services/sound-playback";
import { emptyVideoPlayback } from "../services/video-playback";
import { emptyFogReveal } from "../services/fog-reveal";
import { type EditorStoreData } from "./store-types";
import { initialUi } from "./store-core";

export function createInitialState(storedGridPaint: GridPaintPrefs): EditorStoreData {
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
  };
}
