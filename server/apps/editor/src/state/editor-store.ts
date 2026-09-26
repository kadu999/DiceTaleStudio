/**
 * 编辑器状态（**组装点**）。
 *
 * 这个文件只做两件事：把初始状态与 16 个切片拼成一个 store，再把公开 API 原样再导出。
 * 「东西在哪」看这张表：
 *
 * | 想知道什么 | 去哪看 |
 * |---|---|
 * | store 有哪些状态字段、哪些 action | `store-types.ts` 的 `EditorStoreState` |
 * | 初始状态 | `initialState.ts` |
 * | 两条历史、序列化、视图适配、日志工厂等**模块级**工具与状态 | `store-core.ts` |
 * | 闭包状态（定时器 / 调度器 / 运行基线 / 视口记忆…）与局部工具 | `store-context.ts` 的 `StoreContext` |
 * | 某个功能的 action | `slices/<功能>-slice.ts`（一个功能一个文件） |
 *
 * 两条贯穿全仓的约束：
 * - **项目级数据**（`project.json`）与**场景列表**各由一份 `DocumentHistory` 持有（补丁式撤销/重做），
 *   store 里只镜像当前值；编辑一律经 `applyScenes` / `applyProject`。
 * - **运行态**（`runtime` / 四种播放记账 / 运行基线）与文档**物理隔离**：运行态永不写文档，
 *   退出运行时整体还原。
 * - 画布渲染循环直接读 `getState()`，指针移动不触发 React 重渲染。
 */

import { create } from "zustand";
import type { EditorStoreState } from "./store-types";
import { createStoreContext } from "./store-context";
import { createInitialState } from "./initialState";
import { createHistorySlice } from "./slices/history-slice";
import { createSaveSlice } from "./slices/save-slice";
import { createProjectSlice } from "./slices/project-slice";
import { createSceneSlice } from "./slices/scene-slice";
import { createObjectSlice } from "./slices/object-slice";
import { createComponentSlice } from "./slices/component-slice";
import { createTransformSlice } from "./slices/transform-slice";
import { createViewportSlice } from "./slices/viewport-slice";
import { createRuntimeSlice } from "./slices/runtime-slice";
import { createSoundSlice } from "./slices/sound-slice";
import { createVideoSlice } from "./slices/video-slice";
import { createVideoBlendSlice } from "./slices/video-blend-slice";
import { createBgmSlice } from "./slices/bgm-slice";
import { createAudioMetaSlice } from "./slices/audio-meta-slice";
import { createTeleportSlice } from "./slices/teleport-slice";
import { createGridPaintSlice } from "./slices/grid-paint-slice";
import { createFogSlice } from "./slices/fog-slice";
import { createSpriteSlice } from "./slices/sprite-slice";

/**
 * **组装**：初始状态 + 各切片；每个切片就是一份显式列出的
 * `Pick<EditorStoreState, ...>`，漏搬一个 action 或缺一个状态字段都会在这里报错。
 *
 * 切片之间互相调用一律走 `get().xxx()`；闭包状态与局部工具在 `store-context`。
 */
export const useEditorStore = create<EditorStoreState>()((set, get) => {
  const ctx = createStoreContext(set, get);

  return {
    ...createInitialState(ctx.storedGridPaint),
    ...createHistorySlice(set, get, ctx),
    ...createSaveSlice(set, get, ctx),
    ...createProjectSlice(set, get, ctx),
    ...createSceneSlice(set, get, ctx),
    ...createObjectSlice(set, get, ctx),
    ...createComponentSlice(set, get, ctx),
    ...createTransformSlice(set, get, ctx),
    ...createViewportSlice(set, get, ctx),
    ...createRuntimeSlice(set, get, ctx),
    ...createSoundSlice(set, get, ctx),
    ...createVideoSlice(set, get, ctx),
    ...createVideoBlendSlice(set, get, ctx),
    ...createBgmSlice(set, get, ctx),
    ...createAudioMetaSlice(set, get, ctx),
    ...createTeleportSlice(set, get, ctx),
    ...createGridPaintSlice(set, get, ctx),
    ...createFogSlice(set, get, ctx),
    ...createSpriteSlice(set, get, ctx),
  };
});

// ------------------------------------------------------------------ 公开 API
// 只再导出真正从这里取的名字（逐名核对过消费方）；其余直接去 `store-core` / `store-types` 引。

export {
  sceneHistory,
  projectHistory,
  fitSceneViewport,
  serializeSceneFile,
  compareSceneNames,
  findResourceNode,
  withRenamedSceneImage,
} from "./store-core";

export type {
  EditorMode,
  ProjectDialogMode,
  SceneDialogMode,
  SceneSaveState,
} from "./store-types";
