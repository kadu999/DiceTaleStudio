/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 项目：建 / 开 / 关 / 删、资源树与文件操作，以及**素材 meta 的装配与迁移**。
 */
import {
  DOCUMENT_FORMAT_VERSION,
  createEmptyProject,
  parseAssetMetaFile,
  parseProjectFile,
  serializeAssetMetaFile,
  type AssetMetaDoc,
} from "@dts/document";
import {
  assetMetaIdOf,
  projectAssetId,
  projectFileId,
  projectSceneFileId,
} from "@dts/resources";
import { projectApi, contentTypeFor } from "../../services/project-api";
import { clearLastProject, readLastProject, writeLastProject } from "../../services/session";
import { clearSceneImageCache } from "../../services/scene-image";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { makeLog, serializeSceneFile, serializeProjectFile, findResourceNode, metaHistory } from "../store-core";
import { type StoreContext } from "../store-context";

export function createProjectSlice(
  set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "openProjectDialog"
  | "bootstrapEditor"
  | "refreshProjects"
  | "createProject"
  | "openProject"
  | "closeProject"
  | "deleteProject"
  | "refreshTree"
  | "createFolder"
  | "openProjectFolder"
  | "uploadFiles"
  | "deleteResource"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const { pushLog, savedMetas } = ctx;

  /**
   * 读回一个项目的**全部素材 meta**，装配第三条轨道（真源表 + 派生索引都由订阅重建）。
   *
   * 三件事，顺序是有意的：
   * 1. 逐条解析（`parseAssetMetaFile`）：**读不懂的那一份跳过并说明是哪一份**——一份坏 meta
   *    不该让整个项目打不开（与后端「坏 JSON 跳过」同一条口径），那份素材按普通图片处理；
   * 2. `needsRewrite` 的（缺 guid 的、手写的）**收集起来回写一次**——与场景 / 工程文件
   *    「补过就回写」同一条规矩，磁盘上的文件从此自描述；
   * 3. 先把「磁盘上的样子」记进 `savedMetas`，再 `reset` 进轨道：订阅按内容差异安排落盘，
   *    少了这一步，刚读回来的表会被当成「全都有未保存改动」而整体重写一遍。
   *
   * 打开项目与刷新资源树都走它：索引的唯一来源是**盘上的 meta**，不靠内存拼。
   */
  async function loadAssetMetas(project: string): Promise<void> {
    const raw = await projectApi.readMetas(project);
    const table: Record<string, AssetMetaDoc> = {};
    const rewrites: Array<{ readonly id: string; readonly meta: AssetMetaDoc }> = [];

    for (const [id, value] of Object.entries(raw)) {
      try {
        const loaded = parseAssetMetaFile(value);
        table[id] = loaded.doc;
        if (loaded.needsRewrite) {
          rewrites.push({ id, meta: loaded.doc });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushLog(makeLog("warn", `素材 meta 读取失败（${id}）：${message}；这份素材按普通图片处理`));
      }
    }

    savedMetas.clear();
    for (const [id, meta] of Object.entries(table)) {
      savedMetas.set(id, serializeAssetMetaFile(meta));
    }

    for (const { id, meta } of rewrites) {
      await projectApi.writeText(assetMetaIdOf(id), serializeAssetMetaFile(meta));
    }

    metaHistory.reset(table);
  }

  return {
    // ---------------------------------------------------------------- 项目

    openProjectDialog(mode) {
      set({ projectDialog: mode });
    },

    async bootstrapEditor() {
      if (ctx.bootstrapping || get().bootstrapped) {
        return;
      }

      // 同步占位：StrictMode 下 effect 会跑两次，不能弹两次对话框
      ctx.bootstrapping = true;

      // 页面加载就连服务端：**运行态存在服务端**，连上才知道「现在是在运行还是编辑」
      // （刷新页面后如果服务端还在运行，editor_state 会把界面切回运行态，前端不会被踢）
      get().connectRuntime();

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
      // 切项目前先把上一个项目里未保存的改动写回（场景与素材 meta 各有一份）
      await get().flushSceneSave();
      await get().flushMetaSave();

      set((state) => ({ project: { ...state.project, busy: true, error: "" } }));
      try {
        const text = await projectApi.readText(projectFileId(name));
        const load = parseProjectFile(JSON.parse(text) as unknown);

        // 资源树先拿到手：v22 → v23 的迁移要按它判断「这个键还有没有对应的素材」
        // （没有的就是改名留下的孤儿键，丢弃并报 warning——不猜它属于谁）
        const tree = await projectApi.tree(name);

        // 上一个项目的贴图不该继续占内存（缓存按逻辑 ID，跨项目也不会互相命中）
        clearSceneImageCache();
        get().resetDoc(load.doc);

        // v22 → v23：把工程文件里那份 `spriteSheets` / `spriteSettings` 搬出来的 meta
        // **各自落盘**。落盘放在 `loadAssetMetas` 之前是有意的：下面读回来的就是刚写下的，
        // 于是「盘上的 .meta」始终是唯一来源，不需要在内存里再拼一次
        const orphans: string[] = [];
        for (const { id, meta } of load.migratedMetas) {
          if (findResourceNode(tree, (node) => node.id === id) === undefined) {
            orphans.push(id);
            continue;
          }

          await projectApi.writeText(assetMetaIdOf(id), serializeAssetMetaFile(meta));
        }

        // 旧版工程文件：把内联场景落成独立文件，工程文件按新格式回写（只做一次）。
        // v15 起「缺 `settings`」也算需要回写（全局设置会被补一份默认的落进文件）。
        if (load.migratedScenes.length > 0 || load.needsRewrite) {
          for (const scene of load.migratedScenes) {
            await projectApi.writeText(
              projectSceneFileId(name, scene.name),
              serializeSceneFile(scene),
            );
          }

          await projectApi.writeText(projectFileId(name), serializeProjectFile(load.doc));
          pushLog(
            makeLog("info", `工程文件已升级到 v${DOCUMENT_FORMAT_VERSION}（场景拆成 ${load.migratedScenes.length} 个文件）`),
          );
        }

        if (load.migratedMetas.length > orphans.length) {
          pushLog(
            makeLog(
              "info",
              `图片的导入设置与切分已搬进各自的 .meta（${load.migratedMetas.length - orphans.length} 个素材）`,
            ),
          );
        }

        // 孤儿键：**说清是哪一个**，人才知道盘上哪个旧名字留下的、要不要手工捡回来
        for (const id of orphans) {
          pushLog(
            makeLog(
              "warn",
              `改名留下的孤儿：工程文件里的切分 / 导入设置「${id}」找不到对应素材，已丢弃（「.meta」要跟着素材一起改名）`,
            ),
          );
        }

        set((state) => ({ project: { ...state.project, current: name, tree, busy: false } }));
        // 索引要在 `loadScenes` 之前建好：场景里的子图引用（越界提示）靠它解析
        await loadAssetMetas(name);
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
      // 待保存的改动先写回：flush 内部会**同步**取好快照，所以随后的清空不会把它丢掉
      void get().flushSceneSave();
      void get().flushMetaSave();
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

      // 重新读盘之前先把手上未保存的 meta 写回：不然刚切的图集会被盘上的旧内容冲掉
      // （与场景操作前那一串 `flushSceneSave` 同一条规矩）
      await get().flushMetaSave();

      try {
        const tree = await projectApi.tree(project);
        set((state) => ({ project: { ...state.project, tree, error: "" } }));
        // 素材可能在编辑器外面被加进来 / 改名 / 删掉了：索引跟着资源树重建
        // （`.meta` 与素材成对改名时，键跟着换、guid 不变，引用照样指得对）
        await loadAssetMetas(project);
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

    async openProjectFolder(target = "", selectFile = false) {
      const project = get().project.current;
      if (project === null) {
        return false;
      }

      try {
        const opened = await projectApi.reveal(project, target, selectFile);
        // 顺手清掉上一次的错误：成功了还挂着红字会让人以为没成功
        set((state) => ({ project: { ...state.project, error: "" } }));
        // 日志里带上**项目内**的相对路径：后端回的是绝对路径，人看的是「打开的是哪一个」
        const what = selectFile ? "文件" : "目录";
        const where = target.length === 0 ? "" : `（${target}）`;
        pushLog(makeLog("info", `已打开${what}${where}：${opened}`));
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
  };
}
