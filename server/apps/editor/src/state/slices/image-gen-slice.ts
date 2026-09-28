/**
 * 「AI 生图」工具（菜单栏「工具 → AI 生图」）。
 *
 * 一个**聊天框**：写一句要画什么 → 后端调生图接口画一张、**直接存成项目素材** →
 * 这里把「你说了什么 / 画出来什么样 / 存到哪儿了」一条条记下来，并允许
 * 「用作选中对象的贴图」（与「从项目里挑一张图」走同一条命令，不另开一条）。
 *
 * 三条边界：
 * 1. 密钥与供应商的地址**都在服务端**（见 `services/image-gen-api.ts` 的说明）；
 * 2. 生成出来的东西是**普通项目素材**：与手动导入的图没有任何区别，素材面板里一样能改
 *    切分 / 显示名，删掉也一样；
 * 3. 聊天记录**只活在这一次会话里**（不写盘、不进撤销栈）——它是操作日志，不是文档数据。
 */
import { imageGenApi } from "../../services/image-gen-api";
import { configApi } from "../../services/config-api";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { makeLog } from "../store-core";
import { type StoreContext } from "../store-context";

/** 聊天框里一条的本地 ID（只是给 React 做 key / 定位，不进任何文件）。 */
let entrySeq = 0;

function nextEntryId(): string {
  entrySeq += 1;
  return `gen-${entrySeq.toString()}`;
}

export function createImageGenSlice(
  set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "openImageGenDialog"
  | "generateImage"
  | "clearImageGenHistory"
  | "useGeneratedImage"
  | "setImageGenRemoveBackground"
  | "setImageGenReferenceImage"
  | "refreshImageGenConfig"
> {
  const { pushLog } = ctx;

  return {
    openImageGenDialog(open) {
      set({ imageGenDialog: open });
      // 打开时顺手取一次配置：平台名 / 配没配好 / 尺寸档都可能被服务端改过
      if (open) {
        void get().refreshImageGenConfig();
      }
    },

    async generateImage(prompt, size, removeBackground) {
      const project = get().project.current;
      const text = prompt.trim();
      // 三个「不该发生」：没打开项目 / 空提示词 / 上一张还在画——都不报错，静默不动更省事
      if (project === null || text.length === 0 || get().imageGenBusy) {
        return false;
      }

      const remove = removeBackground ?? get().imageGenRemoveBackground;
      const reference = get().imageGenReferenceImage;
      const inputs = reference.length === 0 ? [] : [reference];
      const entryId = nextEntryId();
      const entry = {
        id: entryId,
        prompt: text,
        size: size ?? "",
        status: "pending" as const,
        ...(reference.length === 0 ? {} : { inputImage: reference }),
      };
      set((state) => ({
        imageGenBusy: true,
        imageGenEntries: [...state.imageGenEntries, entry],
      }));

      try {
        const image = await imageGenApi.generate({
          project,
          prompt: text,
          ...(size === undefined || size.length === 0 ? {} : { size }),
          removeBackground: remove,
          ...(inputs.length === 0 ? {} : { inputImages: inputs }),
        });
        set((state) => ({
          imageGenBusy: false,
          imageGenEntries: state.imageGenEntries.map((item) =>
            item.id === entryId ? { ...item, status: "done" as const, image } : item,
          ),
        }));

        // 新素材刚进项目：刷新资源树，素材面板立刻就能看到它
        await get().refreshTree();
        pushLog(makeLog("info", `生图完成：${image.path}`));
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({
          imageGenBusy: false,
          imageGenEntries: state.imageGenEntries.map((item) =>
            item.id === entryId ? { ...item, status: "error" as const, error: message } : item,
          ),
        }));
        pushLog(makeLog("error", `生图失败：${message}`));
        return false;
      }
    },

    clearImageGenHistory() {
      set({ imageGenEntries: [] });
    },

    setImageGenRemoveBackground(remove) {
      set({ imageGenRemoveBackground: remove });
    },

    setImageGenReferenceImage(imageId) {
      set({ imageGenReferenceImage: imageId ?? "" });
    },

    async refreshImageGenConfig() {
      try {
        const config = await configApi.get();
        const imageGen = config.imageGen ?? null;
        set({
          imageGenConfig: imageGen,
          // 初值只在第一次（还没有配置）时采用，免得把用户手动勾的覆盖掉
          ...(imageGen === null || get().imageGenConfig !== null
            ? {}
            : { imageGenRemoveBackground: imageGen.removeBackground }),
        });
      } catch (error) {
        // 取不到配置不影响用生图（尺寸走平台默认、抠背景默认关）：记一条日志即可
        pushLog(makeLog("warn", `读取生图配置失败：${error instanceof Error ? error.message : String(error)}`));
      }
    },

    useGeneratedImage(entryId) {
      const state = get();
      const image = state.imageGenEntries.find((item) => item.id === entryId)?.image;
      if (image === undefined) {
        return "这一条还没有图";
      }

      if (state.selectedObjectIds.length !== 1) {
        return "先在画布上选中**一个**要贴这张图的对象";
      }

      const objectId = state.selectedObjectIds[0]!;
      // 身份（GUID）在**第一次引用**时就要带上：与「挑一张图」同一套（见 `ensureAssetMeta`）
      const meta = state.ensureAssetMeta(image.id);
      const applied = state.setObjectImageSprite(
        objectId,
        { id: image.id, width: image.width, height: image.height, guid: meta.guid },
        null,
      );
      if (!applied) {
        return "这个对象放不了贴图（它是一个不成像的对象）";
      }

      pushLog(makeLog("info", `已把生成的图贴到 ${objectId}：${image.path}`));
      return "";
    },
  };
}
