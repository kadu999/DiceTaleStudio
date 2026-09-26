/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 项目：建 / 开 / 关 / 删、资源树与文件操作，以及**素材 meta 的装配与迁移**。
 */
import {
  assetIdOfGuid,
  DOCUMENT_FORMAT_VERSION,
  createAssetMeta,
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
import { assetImporterKind } from "../../panels/asset-info";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { makeLog, serializeSceneFile, serializeProjectFile, findResourceNode, metaHistory } from "../store-core";
import { type StoreContext } from "../store-context";

/**
 * 资源树里全部**文件**节点（目录不参与：`.meta` 只配给文件）。
 *
 * 树里本来就没有 `.meta` / `.gitkeep` / `project.json`（后端的 `list()` 与
 * `PROJECT_SPECIAL_FILES` 各自滤掉了），所以这里不需要再挡一遍。
 */
function fileNodesOf(nodes: readonly ResourceTreeNodeLike[]): ResourceTreeNodeLike[] {
  const files: ResourceTreeNodeLike[] = [];
  for (const node of nodes) {
    if (node.type === "file") {
      files.push(node);
      continue;
    }

    files.push(...fileNodesOf(node.children ?? []));
  }

  return files;
}

/** 只用得到节点的这几个字段（避免把 store 的类型拖进这个纯工具里）。 */
interface ResourceTreeNodeLike {
  readonly name: string;
  readonly path: string;
  readonly id: string;
  readonly type: "folder" | "file";
  readonly children?: readonly ResourceTreeNodeLike[];
}

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
  | "renameResource"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const { pushLog, savedMetas } = ctx;

  /**
   * 读回一个项目的**全部素材 meta**，装配第三条轨道（真源表 + 派生索引都由订阅重建）。
   *
   * 四件事，顺序是有意的：
   * 1. 逐条解析（`parseAssetMetaFile`）：**读不懂的那一份跳过并说明是哪一份**——一份坏 meta
   *    不该让整个项目打不开（与后端「坏 JSON 跳过」同一条口径），那份素材按没有 meta 处理；
   * 2. `needsRewrite` 的（缺 guid 的、手写的）**收集起来回写一次**——与场景 / 工程文件
   *    「补过就回写」同一条规矩，磁盘上的文件从此自描述；
   * 3. **给每个还没有 meta 的素材补一份**（v24 的口径：每个素材旁边一个 `<素材>.meta`）。
   *    种类按**项目内相对路径**定（`assetImporterKind`：图片 / 音频 / 视频 / 场景；`.json`
   *    只有落在 `Assets/scenes/` 里才算场景），项目里的其它文件（配置、文本）不是素材，
   *    不配 meta。三条细节：
   *    - 写盘**失败只报 warn**（磁盘只读 / 没权限）：补 meta 是「整理」，不该让项目打不开；
   *      写不成的那一份**不记进 `savedMetas`**，于是它算「有未保存改动」，由去抖落盘再试一次；
   *    - 建成之后**记进 `savedMetas`**（下面那一步），所以它不会被当成「有未保存改动」重写一遍；
   *    - 只补**缺的**：已经有 meta 的素材一个字节都不动（改名后的 `.meta` 也跟着素材改了名，
   *      这里按新的路径 ID 找到它，guid 照旧）。
   * 4. 先把「磁盘上的样子」记进 `savedMetas`，再 `reset` 进轨道：订阅按内容差异安排落盘，
   *    少了这一步，刚读回来的表会被当成「全都有未保存改动」而整体重写一遍。
   *
   * 打开项目与刷新资源树都走它：索引的唯一来源是**盘上的 meta**，不靠内存拼。
   * `tree` 由调用方传进来（打开项目时它比这一步先拿到，见 `openProject`）。
   */
  async function loadAssetMetas(
    project: string,
    tree: readonly ResourceTreeNodeLike[],
  ): Promise<void> {
    const raw = await projectApi.readMetas(project);
    const table: Record<string, AssetMetaDoc> = {};
    const rewrites: Array<{ readonly id: string; readonly meta: AssetMetaDoc }> = [];
    /*
      盘上有 meta、但读不出来的素材（后端 JSON 就坏了，或这份 meta 根本不是这一版写的）：
      **不给它们补新的**——补一份就是新 GUID，那会把盘上那份盖掉，引用旧 GUID 的地方一起断。
      「读不懂」这件事有两个来源，都要挡住：后端解析不了 JSON（`raw.unreadable`），
      以及 JSON 是好的、但过不了 meta 的 schema（下面 catch 里补进去）。
    */
    const unreadable = new Set<string>(raw.unreadable);

    for (const [id, value] of Object.entries(raw.metas)) {
      try {
        const loaded = parseAssetMetaFile(value);
        table[id] = loaded.doc;
        if (loaded.needsRewrite) {
          rewrites.push({ id, meta: loaded.doc });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        unreadable.add(id);
        pushLog(
          makeLog("warn", `素材 meta 读取失败（${id}）：${message}；这一份保持原样不动，请手工修`),
        );
      }
    }

    // 每个素材一份 `.meta`：缺的那几份现建（新 GUID + 按素材种类定的导入器）并立刻落盘
    let created = 0;
    const failed: Array<{ readonly id: string; readonly message: string }> = [];
    for (const node of fileNodesOf(tree)) {
      if (table[node.id] !== undefined || unreadable.has(node.id)) {
        continue;
      }

      const importer = assetImporterKind(node.path);
      if (importer === undefined) {
        continue;
      }

      const meta = createAssetMeta(importer);
      table[node.id] = meta;
      try {
        await projectApi.writeText(assetMetaIdOf(node.id), serializeAssetMetaFile(meta));
        created += 1;
      } catch (error) {
        failed.push({ id: node.id, message: `${node.path}（${error instanceof Error ? error.message : String(error)}）` });
      }
    }

    // 盘上「内容旧了、需要回写」的那几份也回写一次。**同样容错**：一份写不进去只报出来，
    // 绝不让它把后面的 `metaHistory.reset` 跳过——那会让本次会话所有素材的 meta 全丢。
    for (const { id, meta } of rewrites) {
      try {
        await projectApi.writeText(assetMetaIdOf(id), serializeAssetMetaFile(meta));
      } catch (error) {
        failed.push({ id, message: `${id}（${error instanceof Error ? error.message : String(error)}）` });
      }
    }

    // 写失败的那几份**不记进 `savedMetas`**：于是它们在订阅里算「有未保存改动」，
    // 由那条去抖落盘再试一次（磁盘只读时它只试一次，不会反复刷）
    const failedIds = new Set(failed.map((item) => item.id));
    savedMetas.clear();
    for (const [id, meta] of Object.entries(table)) {
      if (!failedIds.has(id)) {
        savedMetas.set(id, serializeAssetMetaFile(meta));
      }
    }

    metaHistory.reset(table);

    if (created > 0) {
      pushLog(makeLog("info", `已为 ${created} 个素材生成 .meta`));
    }

    // 写不进去（磁盘只读 / 没权限）**只报出来**：补 meta 是整理，不该让项目打不开
    for (const item of failed) {
      pushLog(makeLog("warn", `素材 meta 写不进去：${item.message}`));
    }
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

        // 迁移搬出来的素材 meta（v23 的图片切分 / 导入设置、v24 的音频标注）**各自落盘**。
        // 落盘放在 `loadAssetMetas` 之前是有意的：下面读回来的就是刚写下的，
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
        let currentTree = tree;
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

          /*
            迁移**刚写下**的场景文件不在上面那份资源树里（它是写文件之前取的）：
            场景列表是照着树里的 `Assets/scenes/` 读的，不重取就会显示「场景 0」；
            而且这些新文件也该各配一份自己的 `.meta`（每个素材一份，不分是谁写下的）。
            只在真的写了新文件时重取一次，平常打开不付这份钱。
          */
          if (load.migratedScenes.length > 0) {
            currentTree = await projectApi.tree(name);
          }
        }

        if (load.migratedMetas.length > orphans.length) {
          pushLog(
            makeLog(
              "info",
              `素材级数据已搬进各自的 .meta（${load.migratedMetas.length - orphans.length} 个素材：切分 / 导入设置 / 音频标注）`,
            ),
          );
        }

        // 孤儿键：**说清是哪一个**，人才知道盘上哪个旧名字留下的、要不要手工捡回来
        for (const id of orphans) {
          pushLog(
            makeLog(
              "warn",
              `改名留下的孤儿：工程文件里的素材数据「${id}」找不到对应素材，已丢弃（「.meta」要跟着素材一起改名）`,
            ),
          );
        }

        set((state) => ({
          project: { ...state.project, current: name, tree: currentTree, busy: false },
        }));
        /*
          索引要在 `loadScenes` 之前建好：场景里的子图引用（越界提示）靠它解析；
          顺便把「还没有 meta」的素材补上各自那一份（v24：每个素材旁边一个 `.meta`）。

          **这一段失败不许把项目弄成打不开**：素材 meta 是**辅助数据**（图片的切分、音频的
          显示名 / 标签），场景才是内容。所以单独兜一层——读 / 写 meta 出错时记一条日志，
          照旧往下读场景。外面那个 catch 只管真正的失败（工程文件读不出来、校验过不去），
          那种才该返回 false；少了这一层，一次 meta 抖动就会变成「项目打开了、场景 0 个」。
        */
        try {
          await loadAssetMetas(name, currentTree);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          pushLog(
            makeLog("warn", `素材 meta 装配失败：${message}；场景照常加载，切分与音频标注这次先用不上`),
          );
        }

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

    async refreshTree(resolveReferences = false) {
      const project = get().project.current;
      if (project === null) {
        return false;
      }

      // 先落盘文档与 meta，再刷新索引并重载场景，让被改名的 GUID 引用解析到新路径。
      if (!(await get().flushSceneSave()) || !(await get().flushMetaSave())) {
        return false;
      }

      try {
        const previousMetaTable = metaHistory.current;
        const previousMetas = get().assetMetas;
        const tree = await projectApi.tree(project);
        set((state) => ({ project: { ...state.project, tree, error: "" } }));
        // 素材可能在编辑器外面被加进来 / 改名 / 删掉了：索引跟着资源树重建
        // （`.meta` 与素材成对改名时，键跟着换、guid 不变，引用照样指得对），
        // 新加进来的素材也在这里补上自己那一份 `.meta`
        await loadAssetMetas(project, tree);

        const currentMetas = get().assetMetas;
        const currentMetaTable = get().assetMetaTable;
        const movedMetaTable: Record<string, AssetMetaDoc> = {};
        for (const meta of Object.values(previousMetaTable)) {
          const newId = assetIdOfGuid(currentMetas, meta.guid);
          if (newId !== undefined) movedMetaTable[newId] = meta;
        }
        for (const [id, meta] of Object.entries(currentMetaTable)) {
          movedMetaTable[id] ??= meta;
        }
        const metaPathsChanged =
          Object.keys(previousMetaTable).length !== Object.keys(movedMetaTable).length ||
          Object.keys(previousMetaTable).some((id) => movedMetaTable[id] === undefined) ||
          Object.keys(previousMetaTable).some((id) => assetIdOfGuid(currentMetas, previousMetaTable[id]!.guid) !== id);
        if (metaPathsChanged) {
          savedMetas.clear();
          for (const [id, meta] of Object.entries(movedMetaTable)) {
            savedMetas.set(id, serializeAssetMetaFile(meta));
          }
          metaHistory.reset(movedMetaTable);
        }

        const currentId = (id: string): string => {
          const meta = previousMetas.byId[id];
          return meta === undefined ? id : assetIdOfGuid(currentMetas, meta.guid) ?? id;
        };
        const selectedAssetId = get().selectedAssetId;
        const spriteSelection = selectedAssetId?.match(/^(.*)::sprite:(\d+)$/);
        const soundPlayback = get().soundPlayback;
        const videoPlayback = get().videoPlayback;
        const bgmPlayback = get().bgmPlayback;
        set({
          selectedAssetId:
            selectedAssetId === null
              ? null
              : spriteSelection == null
                ? currentId(selectedAssetId)
                : `${currentId(spriteSelection[1] as string)}::sprite:${spriteSelection[2]}`,
          soundPlayback: {
            layers: Object.fromEntries(
              Object.entries(soundPlayback.layers).map(([layer, entry]) => [
                layer,
                { ...entry, clips: entry.clips.map(currentId) },
              ]),
            ),
          },
          videoPlayback: {
            objects: Object.fromEntries(
              Object.entries(videoPlayback.objects).map(([objectId, entry]) => [
                objectId,
                { ...entry, clip: currentId(entry.clip) },
              ]),
            ),
          },
          bgmPlayback:
            bgmPlayback.clip === null
              ? bgmPlayback
              : { ...bgmPlayback, clip: currentId(bgmPlayback.clip) },
        });
        if (resolveReferences && !(await get().loadScenes())) {
          return false;
        }
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ project: { ...state.project, error: message } }));
        return false;
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

    async renameResource(fromId, toId, label) {
      if (get().project.current === null) {
        return "还没有打开项目";
      }

      if (get().runtime.runtimeActive) {
        return "运行态下不能重命名资源，先点「编辑」退出运行";
      }

      try {
        if (!(await get().flushSceneSave())) {
          return get().sceneSaveError || "场景保存失败，资源未重命名";
        }

        if (!(await get().flushMetaSave())) {
          return get().metaSaveError || "素材信息保存失败，资源未重命名";
        }

        await projectApi.renameResource(fromId, toId);
        if (!(await get().refreshTree(true))) {
          return get().project.error || "资源树刷新失败，资源已改名；请刷新资源树";
        }

        pushLog(makeLog("info", `已重命名：${label}`));
        return undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ project: { ...state.project, error: message } }));
        pushLog(makeLog("error", `重命名失败：${message}`));
        return message;
      }
    },
  };
}
