/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 全局背景音乐（顶栏「音乐」弹框）与「全局设置」窗口。
 */
import { withBgmPaused, withBgmPlaying, withBgmStopped } from "../../services/bgm-playback";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { makeLog } from "../store-core";
import { type StoreContext } from "../store-context";

export function createBgmSlice(
  set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "playBgm"
  | "pauseBgm"
  | "resumeBgm"
  | "stopBgm"
  | "flushBgmPlayback"
  | "openGlobalSettings"
  | "openBgmDialog"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const { pushLog, deliverBgm, flushBgm } = ctx;

  return {
    // ---------------------------------------------------------------- 全局背景音乐（弹框里点一首）

    playBgm(clip) {
      set({ bgmPlayback: withBgmPlaying(get().bgmPlayback, clip) });

      /*
        显式下发：DM 再点同一首的意思就是「从头再放一遍」，那条命令必须真的发出去
        （补发那条路只在「前端刚连上」走一次，不参与这里的判断）。
      */
      return deliverBgm({ kind: "play", clip });
    },

    pauseBgm() {
      const playback = get().bgmPlayback;
      const next = withBgmPaused(playback, true);
      if (next === playback) {
        // 没在放就没有「这一首」可暂停（编辑器不知道前端此刻手里是什么）
        pushLog(makeLog("warn", "还没点过曲子：先在弹框里点一首"));
        return undefined;
      }

      set({ bgmPlayback: next });
      return deliverBgm({ kind: "pause" });
    },

    resumeBgm() {
      const playback = get().bgmPlayback;
      const next = withBgmPaused(playback, false);
      if (next === playback) {
        pushLog(makeLog("warn", "现在没有暂停着的背景音乐"));
        return undefined;
      }

      set({ bgmPlayback: next });
      return deliverBgm({ kind: "resume" });
    },

    stopBgm() {
      set({ bgmPlayback: withBgmStopped(get().bgmPlayback) });
      return deliverBgm({ kind: "stop" });
    },

    flushBgmPlayback() {
      return flushBgm();
    },

    openGlobalSettings(open) {
      set({ globalSettings: open });
    },

    openBgmDialog(open) {
      set({ bgmDialog: open });
    },
  };
}
