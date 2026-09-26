/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 场景列表 / 工程文件 / 素材 meta **三条历史**的编辑入口（撤销入口只有一个，见 `undo`）。
 */
import { emptyBgmPlayback } from "../../services/bgm-playback";
import { emptySoundPlayback } from "../../services/sound-playback";
import { emptyVideoPlayback } from "../../services/video-playback";
import { emptyFogReveal } from "../../services/fog-reveal";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import {
  sceneHistory,
  projectHistory,
  metaHistory,
  setLastEditTrack,
  activeTrack,
  historyOf,
  serializeProjectFile,
} from "../store-core";
import { type StoreContext } from "../store-context";

export function createHistorySlice(
  set: StoreSet,
  _get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  "applyScenes" | "applyProject" | "applyMetas" | "undo" | "redo" | "resetDoc"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const { refreshRunBaseline, savedScenes, savedMetas, sceneViewports } = ctx;

  return {
    applyScenes(label, recipe, options) {
      // 订阅里会同步 scenes 与撤销/重做标记，并安排自动落盘
      const changed = sceneHistory.apply(label, recipe, options ?? {});
      // **真的产生改动才算「最近改过这条轨道」**（无改动时历史根本没入栈）
      if (changed) {
        setLastEditTrack("scenes");
      }

      return changed;
    },

    applyProject(label, recipe, options) {
      // 与 applyScenes 对称：订阅里会同步 doc、撤销/重做标记与工程文件的落盘
      const changed = projectHistory.apply(label, recipe, options ?? {});
      if (changed) {
        setLastEditTrack("project");
      }

      return changed;
    },

    applyMetas(label, recipe, options) {
      // 第三条轨道（素材 meta）：订阅里会重建索引、并在去抖后把**变过的那几份**写回盘
      const changed = metaHistory.apply(label, recipe, options ?? {});
      if (changed) {
        setLastEditTrack("metas");
      }

      return changed;
    },

    undo() {
      // 三套历史共用一个撤销入口：作用在**最近改过的那条轨道**上，撤完了轮到另一条
      // （顺序判定只有 `activeTrack` 一处，菜单文案也用它）
      const track = activeTrack("undo");
      const history = historyOf(track);
      if (!history.canUndo) {
        return;
      }

      history.undo();
      setLastEditTrack(track);
    },

    redo() {
      const track = activeTrack("redo");
      const history = historyOf(track);
      if (!history.canRedo) {
        return;
      }

      history.redo();
      setLastEditTrack(track);
    },

    resetDoc(doc) {
      savedScenes.clear();
      // 换文档了：记着的视口属于上一个项目的同名场景，不能拿来用
      sceneViewports.clear();
      // 订阅里会把 scenes 清空、撤销栈清掉，并把保存状态置回 saved
      sceneHistory.reset([]);
      // 工程文件同理：换项目时这份 doc 就是新的磁盘内容（`openProject` 里已经读过它了）
      projectHistory.reset(doc);
      ctx.savedProjectText = serializeProjectFile(doc);
      // 素材 meta 也是**换文档 = 换磁盘内容**：先把「磁盘上的样子」清掉，
      // 免得空表与旧快照一比变成「有未保存改动」；接着清空表（订阅里重建索引与保存状态）。
      // 真正的内容由 `openProject` / `refreshTree` 读完 meta 后 reset 进来
      savedMetas.clear();
      metaHistory.reset({});
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
        metaSaveState: "saved",
        metaSaveError: "",
        // 换了文档：两个格子编辑窗口盯着的地图对象必然失效（偏好留着，下个项目接着用）
        // 两个格子编辑窗口同理：它们指向的地图对象已经不存在了
        fogMask: false,
        fogMaskTarget: null,
        gridEditor: false,
        gridEditorTarget: null,
        // 换了文档：记着的「哪一层该播什么」盯的是上一个项目的对象，清掉
        soundPlayback: emptySoundPlayback(),
        // 视频的记账同理（它是按对象记的）
        videoPlayback: emptyVideoPlayback(),
        // 背景音乐也是一段记账（清单本身来自项目资源，不随项目变）：回到「什么都没放」，
        // 两个窗口都关掉
        bgmPlayback: emptyBgmPlayback(),
        globalSettings: false,
        bgmDialog: false,
        // 标签表窗口也跟前一个项目的标签表说再见
        audioTags: false,
        // 战争雾的揭示记账同理：瞄准的对象已经不存在了
        fogReveal: emptyFogReveal(),
        // 放大镜：编辑器那扇窗盯的对象与前端那扇窗都跟着上一个文档没了
        magnifierEditor: false,
        magnifierEditorTarget: null,
        magnifierShown: null,
      });

      // 文档整份换掉了（关项目 / 换文档）：运行中的话基线要跟着换，否则退出运行会把
      // 上一个项目的场景还原回来
      refreshRunBaseline();
    },
  };
}
