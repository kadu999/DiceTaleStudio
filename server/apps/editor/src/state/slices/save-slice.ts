/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 三份文件（场景 / 工程文件 / 每个素材的 `.meta`）的立即落盘与 flush
 * （工程文件只有立即落盘：没有「关闭前 flush」的调用方，改动全走去抖定时器）。
 */
import { serializeAssetMetaFile } from "@dts/document";
import { assetMetaIdOf, projectFileId, projectSceneFileId } from "@dts/resources";
import { projectApi } from "../../services/project-api";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { projectHistory, makeLog, serializeSceneFile, serializeProjectFile } from "../store-core";
import { type StoreContext } from "../store-context";

export function createSaveSlice(
  set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "saveSceneNow"
  | "flushSceneSave"
  | "saveProjectNow"
  | "saveMetasNow"
  | "flushMetaSave"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const {
    pushLog,
    dirtySceneNames,
    metaDirtyIds,
    clearSceneSaveTimer,
    clearProjectSaveTimer,
    clearMetaSaveTimer,
    savedScenes,
    savedMetas,
  } = ctx;

  return {
    // ---------------------------------------------------------------- 场景

    async saveSceneNow() {
      const project = get().project.current;
      if (project === null) {
        return false;
      }

      // 运行态下不写盘：这些改动退出运行时会被整体还原（对齐 Unity 的播放模式）
      if (get().runtime.runtimeActive) {
        clearSceneSaveTimer();

        set({ sceneSaveState: "runtime" });
        pushLog(makeLog("info", "运行态：改动不会保存（点「编辑」退出运行会还原到进入运行前的样子）"));
        return false;
      }

      clearSceneSaveTimer();

      // 同步取快照：调用方可能紧接着清空内存（例如关闭项目）
      const dirty = get().scenes.filter(
        (scene) => savedScenes.get(scene.name) !== serializeSceneFile(scene, get().assetMetas),
      );
      if (dirty.length === 0) {
        set({ sceneSaveState: "saved", sceneSaveError: "" });
        return true;
      }

      set({ sceneSaveState: "saving", sceneSaveError: "" });
      try {
        for (const scene of dirty) {
          const text = serializeSceneFile(scene, get().assetMetas);
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
      clearSceneSaveTimer();

      if (get().project.current === null || dirtySceneNames().length === 0) {
        return true;
      }

      return get().saveSceneNow();
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
        clearProjectSaveTimer();

        set({ projectSaveState: "runtime" });
        pushLog(
          makeLog("info", "运行态：工程文件（音量 / 音频标注）不会保存（点「编辑」退出运行会还原）"),
        );
        return false;
      }

      clearProjectSaveTimer();

      // 同步取快照：调用方可能紧接着清空内存（例如关闭项目）
      const text = serializeProjectFile(projectHistory.current);
      if (ctx.savedProjectText === text) {
        set({ projectSaveState: "saved", projectSaveError: "" });
        return true;
      }

      set({ projectSaveState: "saving", projectSaveError: "" });
      try {
        await projectApi.writeText(projectFileId(project), text);
        ctx.savedProjectText = text;
        set({ projectSaveState: "saved" });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ projectSaveState: "error", projectSaveError: message });
        pushLog(makeLog("error", `保存工程文件失败：${message}`));
        return false;
      }
    },

    // ---------------------------------------------------------------- 素材 meta（切分 / 导入设置）

    async saveMetasNow() {
      if (get().project.current === null) {
        return false;
      }

      // 运行态下不写盘：与场景 / 工程文件同一条口径（那些改动退出运行时会整体还原）
      if (get().runtime.runtimeActive) {
        clearMetaSaveTimer();

        set({ metaSaveState: "runtime" });
        pushLog(
          makeLog("info", "运行态：素材 meta（切分 / 导入设置）不会保存（点「编辑」退出运行会还原）"),
        );
        return false;
      }

      clearMetaSaveTimer();

      // 同步取快照：只写内容真的变了的那些——一个素材一个文件，切一张图不该碰别的素材的盘
      const dirty = metaDirtyIds();
      if (dirty.length === 0) {
        set({ metaSaveState: "saved", metaSaveError: "" });
        return true;
      }

      set({ metaSaveState: "saving", metaSaveError: "" });
      try {
        for (const id of dirty) {
          const meta = get().assetMetaTable[id];
          if (meta === undefined) {
            continue;
          }

          const text = serializeAssetMetaFile(meta);
          await projectApi.writeText(assetMetaIdOf(id), text);
          savedMetas.set(id, text);
        }

        set({ metaSaveState: "saved" });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ metaSaveState: "error", metaSaveError: message });
        pushLog(makeLog("error", `保存素材 meta 失败：${message}`));
        return false;
      }
    },

    async flushMetaSave() {
      clearMetaSaveTimer();

      if (get().project.current === null || metaDirtyIds().length === 0) {
        return true;
      }

      return get().saveMetasNow();
    },
  };
}
