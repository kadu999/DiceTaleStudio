/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 项目级音频标注（显示名 / 标签表）与三档音量。
 */
import {
  setBgmVolume as setProjectBgmVolume,
  setSfxVolume as setProjectSfxVolume,
  setVoiceVolume as setProjectVoiceVolume,
  setAudioMetaName as setProjectAudioName,
  setAudioMetaTags as setProjectAudioTags,
  renameAudioTag as renameProjectAudioTag,
  setAudioTagName as setProjectAudioTagName,
} from "@dts/document";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { type StoreContext } from "../store-context";

export function createAudioMetaSlice(
  set: StoreSet,
  get: StoreGet,
  _ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "setAudioName"
  | "setAudioTags"
  | "renameAudioTag"
  | "setAudioTagName"
  | "openAudioTags"
  | "setBgmVolume"
  | "setSfxVolume"
  | "setVoiceVolume"
> {
  return {
    // ---------------------------------------------------------------- 项目级数据：音频文件标注（显示名 + 标签）

    setAudioName(clipId, name) {
      // 连续敲名字合成一条撤销记录（与音量滑杆同一套写法）
      return get().applyProject(
        name.trim().length === 0 ? "清除音频文件名字" : "修改音频文件名字",
        (draft) => {
          setProjectAudioName(draft, clipId, name);
        },
        { coalesceKey: `audio-name:${clipId}` },
      );
    },

    setAudioTags(clipId, tagIds) {
      // 勾一个标签是**离散**动作，所以不合并撤销记录：一次撤销就退回上一个勾选状态
      return get().applyProject("修改音频文件标签", (draft) => {
        setProjectAudioTags(draft, clipId, tagIds);
      });
    },

    renameAudioTag(tagId, name) {
      return get().applyProject("修改标签名字", (draft) => {
        renameProjectAudioTag(draft, tagId, name);
      });
    },

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

    // 说明：「标签」窗口只填名字、「选择标签」框只勾选——**两个入口都不新建标签**。
    // 所以「新建并挂上」那条 store 动作也一并去掉了；文档层的 `addAudioTag`
    // （选第一个洞、没有就追加）仍留着：它是标签表的底层能力，别处（迁移 / 将来的工具）还要用。
    openAudioTags(open) {
      set({ audioTags: open });
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
