/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 项目级音频**标签表**与三档音量；素材文件的**显示名与标签**（v24 起）落在
 * **那个文件自己的 `.meta`** 那条轨道上，见下面 `setAudioName` / `setAssetTags` 的说明。
 * 标签**任何素材**（图 / 音频 / 视频）都能打：写一律落在顶层 `tags`，
 * 音频旧数据（`audio.tags`）由 `assetTagsOfMeta` 兼容读。
 */
import {
  createAssetMeta,
  setBgmVolume as setProjectBgmVolume,
  setSfxVolume as setProjectSfxVolume,
  setVoiceVolume as setProjectVoiceVolume,
  setAudioTagName as setProjectAudioTagName,
  withMetaAudioName,
  withMetaAssetTags,
  type AssetMetaDoc,
} from "@dts/document";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { type StoreContext } from "../store-context";
import { assetImporterKind } from "../../panels/asset-info";

export function createAudioMetaSlice(
  _set: StoreSet,
  get: StoreGet,
  _ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "setAudioName"
  | "setAssetTags"
  | "setAudioTagName"
  | "openAudioTags"
  | "setBgmVolume"
  | "setSfxVolume"
  | "setVoiceVolume"
> {
  return {
    // ------------------------------------------- 素材级数据：音频文件的显示名 + 标签（素材 meta 那条轨道）

    /**
     * 给一个音频文件起**显示名**（`""` = 退回素材文件名）。
     *
     * v24 起写的是**那个音频文件自己的 `.meta`**（`audio.name`），不再是工程文件的 `audioMeta`——
     * 于是它和图片的切分 / 导入设置同一条轨道（`applyMetas`）：撤销、去抖落盘、按内容差异只写
     * 变过的那一份，全都与切分共用一套（切分那边的理由见 `sprite-slice.ts`）。
     *
     * 名字只是编辑器里给人看的（找不到素材时也靠它认），**不进协议、不参与播放**。
     */
    setAudioName(clipId, name) {
      // 连续敲名字合成一条撤销记录（与音量滑杆同一套写法）
      return get().applyMetas(
        name.trim().length === 0 ? "清除音频文件名字" : "修改音频文件名字",
        (draft) => {
          writeAssetMeta(draft, clipId, (meta) => withMetaAudioName(meta, name));
        },
        { coalesceKey: `audio-name:${clipId}` },
      );
    },

    /**
     * 替换一个素材文件的**整份标签 ID 清单**（界面那边只看得到「现在勾了哪些」）。
     *
     * **任何素材**都能打标签（图 / 音频 / 视频）：写一律落在 meta 顶层的 `tags`，
     * 音频的旧数据（更早版本写在 `audio.tags`）由 `withMetaAssetTags` 在读路径兼容、
     * 写入时一并摘掉——不需要数据迁移。
     *
     * 归一化要按**工程文件里那张标签表**来（越界 / 指向已删的洞 / 重复的 ID 一律丢掉）：
     * 表是项目级的，所以从 `get().doc` 现取——它随时可能是刚改过的（比如「标签」窗口里刚填了名字）。
     */
    setAssetTags(assetId, tagIds) {
      const table = get().doc.audioTags ?? [];
      // 勾一个标签是**离散**动作，所以不合并撤销记录：一次撤销就退回上一个勾选状态
      return get().applyMetas("修改素材标签", (draft) => {
        writeAssetMeta(draft, assetId, (meta) => withMetaAssetTags(meta, tagIds, table));
      });
    },

    // 说明：「标签」窗口只填名字、「选择标签」框只勾选——**两个入口都不新建标签**。
    // 所以「新建并挂上」那条 store 动作也一并去掉了；文档层的 `addAudioTag`
    // （选第一个洞、没有就追加）仍留着：它是标签表的底层能力，别处（迁移 / 将来的工具）还要用。
    openAudioTags(open) {
      _set({ audioTags: open });
    },

    // ---------------------------------------------------------------- 项目级数据：音频标签表

    /**
     * 给**指定的序号**命名（序号不够长就把它补出来）。
     *
     * 「标签」窗口的序号是预先列好的，人往 `#3` 那个格子里敲名字，3 就是它以后的 ID——
     * 所以这里走的是 `setAudioTagName`（允许补槽），而不是只改已存在槽位的 `renameAudioTag`。
     */
    setAudioTagName(tagId, name) {
      return get().applyProject(`命名标签 #${tagId}`, (draft) => {
        setProjectAudioTagName(draft, tagId, name);
      });
    },

    // ---------------------------------------------------------------- 全局设置（工程文件：三档音量）

    setBgmVolume(volume) {
      // 音量滑杆拖动中每一步都改文档：同一个 coalesceKey 让它们合成一条撤销记录
      return get().applyProject(
        "调整背景音乐音量",
        (draft) => {
          setProjectBgmVolume(draft, volume);
        },
        { coalesceKey: "bgm:volume" },
      );
    },

    setSfxVolume(volume) {
      return get().applyProject(
        "调整音效音量",
        (draft) => {
          setProjectSfxVolume(draft, volume);
        },
        { coalesceKey: "sfx:volume" },
      );
    },

    setVoiceVolume(volume) {
      return get().applyProject(
        "调整旁白音量",
        (draft) => {
          setProjectVoiceVolume(draft, volume);
        },
        { coalesceKey: "voice:volume" },
      );
    },
  };
}

/**
 * 在 meta 轨道上写一个素材文件的那一份 meta：**缺就现建一份**（importer 按文件后缀认；
 * 不是素材的文件——目录 / 配置——没有 meta 轨道，直接不建）。
 *
 * 打开项目 / 刷新资源树时每个素材都会补上自己的 `.meta`（见 `project-slice.ts`），
 * 所以这里的兜底只在「界面比装配先一步」时用得上（例如刚上传的素材还没刷新完）；
 * 与 `sprite-slice.ts` 里那套写法一致：纯函数返回原对象 = 什么都没变，**不写回**
 * （否则会在撤销栈里留一条「什么都没改」的记录）。
 */
function writeAssetMeta(
  draft: Record<string, AssetMetaDoc>,
  assetId: string,
  update: (meta: AssetMetaDoc) => AssetMetaDoc,
): void {
  const existing = draft[assetId];
  if (existing === undefined) {
    const importer = assetImporterKind(assetId);
    if (importer === undefined) {
      return;
    }

    const created = createAssetMeta(importer);
    const next = update(created);
    if (next !== created) {
      draft[assetId] = next;
    }

    return;
  }

  const next = update(existing);
  if (next !== existing) {
    draft[assetId] = next;
  }
}
