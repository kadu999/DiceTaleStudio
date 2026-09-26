/**
 * 本文件从 `editor-store.ts` 拆出（照 `teleport-slice.ts` 的样子）。
 *
 * 放大镜（动作对象，v30）：**图片列表 + 当前展示的那一张**，以及「前端那扇窗」的开 / 关。
 *
 * 两条分工别混：
 * - **列表与展示哪一张**是文档数据（进撤销栈、随场景存盘下发）——窗口下排点一下就是改它；
 * - **前端那扇窗开没开**是运行态记账（不写文档）：开 / 关各一条命令。
 */
import {
  addMagnifierImage as addSceneMagnifierImage,
  removeMagnifierImage as removeSceneMagnifierImage,
  setMagnifierPicked as setSceneMagnifierPicked,
  type ImageRef,
} from "@dts/document";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { makeLog } from "../store-core";
import { type StoreContext } from "../store-context";

export function createMagnifierSlice(
  set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "openMagnifierEditor"
  | "showMagnifier"
  | "addMagnifierImage"
  | "removeMagnifierImage"
  | "selectMagnifierImage"
  | "openMagnifierWindow"
  | "closeMagnifierWindow"
  | "flushMagnifierWindow"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const { pushLog, applyActiveScene, canShowMagnifier, magnifierTargetOf, deliverMagnifierWindow } =
    ctx;

  return {
    // ------------------------------------------------------------ 放大镜（动作对象）

    openMagnifierEditor(objectId) {
      set({ magnifierEditor: objectId !== null, magnifierEditorTarget: objectId });
    },

    /**
     * **触发放大镜这个动作**：开编辑器那扇窗，运行态下再让前端也弹一扇。
     *
     * 画布上双击徽标与面板上的「窗口」按钮都走这里——与传送阵「双击徽标 = 传送」同一套
     * 快路径。编辑态只有编辑器这扇窗（预览），前端那扇等进了运行态再说。
     */
    showMagnifier(objectId) {
      get().openMagnifierEditor(objectId);
      return get().openMagnifierWindow(objectId);
    },

    addMagnifierImage(objectId, image: ImageRef) {
      return applyActiveScene("添加放大镜图片", (scene) => {
        addSceneMagnifierImage(scene, objectId, image);
      });
    },

    removeMagnifierImage(objectId, index) {
      return applyActiveScene("移出放大镜图片", (scene) => {
        removeSceneMagnifierImage(scene, objectId, index);
      });
    },

    selectMagnifierImage(objectId, index) {
      return applyActiveScene("换一张放大镜图片", (scene) => {
        setSceneMagnifierPicked(scene, objectId, index);
      });
    },

    /**
     * 让前端**弹那扇窗**（记账 + 尽力下发 `open_magnifier`）。
     *
     * 编辑态**一条命令都不发**（与 Mask 窗口「编辑态只是预览」同一套）：编辑态连前端都没有，
     * 发出去只会记一条注定补发不出去的账。
     */
    openMagnifierWindow(objectId) {
      if (get().mode !== "run") {
        return undefined;
      }

      const object = magnifierTargetOf(objectId, "打开放大镜窗口");
      if (object === null) {
        return undefined;
      }

      set({ magnifierShown: objectId });
      return deliverMagnifierWindow("open_magnifier", objectId, `显示「${object.name}」的放大镜窗口`);
    },

    /**
     * 让前端**关掉那扇窗**（记账清空 + 尽力下发 `close_magnifier`）。
     *
     * 关**不要求**对象还在 / 还选着图：对象被删掉之后前端的窗还挂着，「关闭画面」得照样关得掉
     * （与 `stopVideoBlend` 同一条规矩）。真正要紧的是记账里那个 id —— 命令靠它**认领**。
     */
    closeMagnifierWindow() {
      const shown = get().magnifierShown;
      if (shown === null) {
        return undefined;
      }

      set({ magnifierShown: null });
      return deliverMagnifierWindow("close_magnifier", shown, "关掉放大镜窗口");
    },

    /**
     * 把记着的「前端那扇窗为谁开着」补发一遍（前端刚连上时调用）。
     *
     * 目标已经没意义了（对象没了 / 组件没了 / 还没选图）就**不补发**，顺手把记账清掉——
     * 否则每次重连都发一条注定失败的命令，运行日志里全是「镜像里没有这个对象」。
     */
    flushMagnifierWindow() {
      const shown = get().magnifierShown;
      if (shown === null) {
        return 0;
      }

      if (!canShowMagnifier(shown)) {
        pushLog(makeLog("warn", `放大镜窗口不补发：目标对象已经不能展示了（${shown}）`));
        set({ magnifierShown: null });
        return 0;
      }

      const requestId = deliverMagnifierWindow("open_magnifier", shown, "补发放大镜窗口", true);
      return requestId === undefined ? 0 : 1;
    },
  };
}
