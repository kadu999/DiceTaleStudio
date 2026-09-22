/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 场景：装载、切换、新建 / 重命名 / 删除。
 */
import {
  DOCUMENT_FORMAT_VERSION,
  createEmptyScene,
  isSceneNameTaken,
  parseSceneFile,
  validateScene,
  validateSceneName,
  type SceneDoc,
} from "@dts/document";
import { PROJECT_FOLDERS, PROJECT_SCENE_FILE_EXTENSION, projectSceneFileId } from "@dts/resources";
import { projectApi } from "../../services/project-api";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import {
  sceneHistory,
  makeLog,
  sceneSizeHint,
  withRenamedSceneImage,
  serializeSceneFile,
  compareSceneNames,
  findResourceNode,
} from "../store-core";
import { type StoreContext } from "../store-context";

export function createSceneSlice(
  set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "setActiveScene"
  | "openScene"
  | "openSceneByIndex"
  | "openAdjacentScene"
  | "loadScenes"
  | "openSceneDialog"
  | "createScene"
  | "renameScene"
  | "deleteScene"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const { pushLog, refreshRunBaseline, switchScene, savedScenes, sceneViewports } = ctx;

  return {
    setActiveScene(name) {
      switchScene(name);
    },

    openScene(name) {
      if (!get().scenes.some((scene) => scene.name === name)) {
        return;
      }

      // 打开场景 = 切到它并清掉别的选中：属性面板接着显示这个场景（并记一条运行日志）
      switchScene(name, { clearAssetSelection: true, log: true });
    },

    openSceneByIndex(index) {
      const names = get().scenes.map((scene) => scene.name);
      const name = names[index];
      if (name === undefined) {
        return false;
      }

      switchScene(name, { clearAssetSelection: true, log: true });
      return true;
    },

    openAdjacentScene(delta) {
      const names = get().scenes.map((scene) => scene.name);
      const current = names.indexOf(get().activeSceneName ?? "");
      const next = current + delta;
      // 到端点就什么都不做（**不循环**：开场按「上一场」跳到最后一幕比没反应更让人困惑）
      if (current < 0 || next < 0 || next >= names.length) {
        return false;
      }

      switchScene(names[next] as string, { clearAssetSelection: true, log: true });
      return true;
    },

    async loadScenes() {
      const project = get().project.current;
      if (project === null) {
        set({ scenes: [], activeSceneName: null });
        // 文档整份被换掉（这里是被清空）：运行中的话，基线要跟着换
        refreshRunBaseline();
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

          // 语义校验（zod 只管形状，不管业务）：把项目当前的 spriteSheets 传进去，
          // 格子越界这类子图 warning 才认得出来；warning 落进日志，不拦加载
          for (const issue of validateScene(scene, { spriteSheets: get().doc.spriteSheets })) {
            if (issue.level === "warning") {
              pushLog(makeLog("warn", `场景「${scene.name}」：${issue.message}`));
            }
          }

          scenes.push(scene);
          if (parsed.needsRewrite) {
            legacy.push(scene);
          }
        }

        scenes.sort((a, b) => compareSceneNames(a.name, b.name));

        // 旧格式的场景文件（带着已废弃的字段）按新格式回写一次——只做一次
        for (const scene of legacy) {
          await projectApi.writeText(
            projectSceneFileId(project, scene.name),
            serializeSceneFile(scene),
          );
        }

        // 记下每个场景「磁盘上的样子」：之后的未保存改动就是拿它比出来的
        savedScenes.clear();
        // 场景是**重新读盘**的（打开 / 切换项目、增删改名后重读）：记着的视口按名字对不上了
        sceneViewports.clear();
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

        // 文档整份换掉了（打开 / 重新装载项目、增删改名场景后重读）：运行中的话基线要跟着换
        refreshRunBaseline();
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

      // 场景的增 / 删 / 改名是**文件操作**（立刻落盘），运行态下不允许：
      // 那种改动退出运行时还原不回来（文件已经建/删了），所以干脆挡在这里
      if (get().runtime.runtimeActive) {
        return "运行态下不能新建场景，先点「编辑」退出运行";
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

      if (get().runtime.runtimeActive) {
        return "运行态下不能重命名场景，先点「编辑」退出运行";
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

      // 运行态的判断放在「还剩几个场景」前面：运行中一律先请用户退出运行，
      // 不然同一个动作在「最后一个场景」上给出的理由会看不出跟运行态有关
      if (get().runtime.runtimeActive) {
        return "运行态下不能删除场景，先点「编辑」退出运行";
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
  };
}
