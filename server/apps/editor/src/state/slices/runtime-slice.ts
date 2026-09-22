/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 运行态：编辑 / 运行切换、服务端连接、场景推送与运行日志。
 */
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { makeLog } from "../store-core";
import { type StoreContext } from "../store-context";

export function createRuntimeSlice(
  set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<EditorStoreState, "setMode" | "connectRuntime" | "pushRuntimeScene" | "clearRuntimeLogs"> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const { pushLog, runtimeClient, pushScheduler, pushSceneNow } = ctx;

  return {
    setMode(mode) {
      /*
        编辑 / 运行是**服务端的状态**（`runtimeActive`），这里只负责「请服务端改一下」，
        界面等 `editor_state` 回来再跟着变——所以刷新页面不会退出运行态，也不会把前端踢掉。
        连接是页面加载就连上的（bootstrapEditor），编辑态也连着，这样随时知道服务端在不在运行。
      */
      if (mode === "run") {
        // 用户主动点「运行」：顺手展开运行面板，否则切过去界面毫无反馈、功能不可发现
        set((state) => ({ ui: { ...state.ui, runtimeOpen: true } }));

        if (!runtimeClient.connected) {
          // 还没连上服务端：先记下「用户要运行」，把连接踢一脚，连上后 `onOpen` 补发
          ctx.pendingRunRequest = true;
          get().connectRuntime();
          pushLog(makeLog("info", "正在连接服务端…连上后自动进入运行态"));
          return;
        }

        runtimeClient.startRuntime();
        // 立刻推一份全量：不等 editor_state 回来，前端能更早拿到场景
        get().pushRuntimeScene();
        return;
      }

      // 退出运行态：服务端关闸并踢掉前端。连接保留（编辑态也要知道服务端状态）
      ctx.pendingRunRequest = false;
      pushScheduler.cancel();
      ctx.lastPushedSceneText = null;
      if (runtimeClient.connected) {
        runtimeClient.stopRuntime();
        return;
      }

      pushLog(makeLog("warn", "与服务端断开，连上后自动同步运行态"));
    },

    connectRuntime() {
      runtimeClient.connect();
    },

    pushRuntimeScene() {
      pushSceneNow();
    },

    clearRuntimeLogs() {
      set((state) => ({ runtime: { ...state.runtime, logs: [] } }));
    },
  };
}
