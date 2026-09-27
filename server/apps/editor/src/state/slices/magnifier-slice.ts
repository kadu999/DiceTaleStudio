/**
 * 本文件从 `editor-store.ts` 拆出（照 `teleport-slice.ts` 的样子）。
 *
 * 放大镜（动作对象，v30；v31 起数据是**状态列表**）：**状态列表 + 当前展示的那一个**
 * （每条 = 标题 + 图 + 文字），以及「前端那扇窗」的开 / 关。
 *
 * 两条分工别混：
 * - **列表与展示哪一个 / 每个状态里的内容**是文档数据（进撤销栈、随场景存盘下发）
 *   ——窗口下排点一下、上面那块区域里挑图 / 打字，改的都是它；
 * - **前端那扇窗开没开**是运行态记账（不写文档）：开 / 关各一条命令，**跟着编辑器那扇窗的
 *   开 / 关走**（`openMagnifierEditor`）——界面上不再单独摆开 / 关按钮。
 */
import {
  addMagnifierState as addSceneMagnifierState,
  removeMagnifierState as removeSceneMagnifierState,
  setMagnifierPicked as setSceneMagnifierPicked,
  setMagnifierStateImage as setSceneMagnifierStateImage,
  setMagnifierStateText as setSceneMagnifierStateText,
  setMagnifierStateTitle as setSceneMagnifierStateTitle,
  setMagnifierStateTween as setSceneMagnifierStateTween,
  setMagnifierStateShow as setSceneMagnifierStateShow,
  setMagnifierStateVideo as setSceneMagnifierStateVideo,
  setMagnifierStateVideoSwitch as setSceneMagnifierStateVideoSwitch,
  type ImageRef,
  type MagnifierPart,
  type MagnifierTween,
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
  | "addMagnifierState"
  | "removeMagnifierState"
  | "selectMagnifierState"
  | "setMagnifierStateImage"
  | "setMagnifierStateVideo"
  | "setMagnifierStateVideoSwitch"
  | "setMagnifierStateTween"
  | "setMagnifierStateShow"
  | "setMagnifierStateTitle"
  | "setMagnifierStateText"
  | "openMagnifierWindow"
  | "closeMagnifierWindow"
  | "flushMagnifierWindow"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const { pushLog, applyActiveScene, canShowMagnifier, magnifierTargetOf, deliverMagnifierWindow } =
    ctx;

  return {
    // ------------------------------------------------------------ 放大镜（动作对象）

    /**
     * 打开 / 关闭**编辑器这扇放大镜窗**；**前端那扇窗的开 / 关跟着它走**（同一次切换）。
     *
     * 打开（`objectId` 非 null）→ 顺手投到前端；关闭（`null`）→ 顺手收掉前端那扇。
     * 前端那扇窗自己没有按钮（「只能后端来关闭」），编辑器这扇窗就是那个**唯一的开关**——
     * 面板与底栏都不再各摆一个按钮（用户原话：「关闭和打开都是界面打开和关闭的同步，
     * 根本就不需要另外加按钮」）。编辑态投不出去（`openMagnifierWindow` 自己会挡）。
     *
     * 返回下发请求 id（前端没连 / 编辑态时是 `undefined`）。
     */
    openMagnifierEditor(objectId) {
      set({ magnifierEditor: objectId !== null, magnifierEditorTarget: objectId });

      return objectId === null
        ? get().closeMagnifierWindow()
        : get().openMagnifierWindow(objectId);
    },

    /**
     * **触发放大镜这个动作**（画布上双击徽标 / 面板上的「窗口」按钮）：开编辑器那扇窗，
     * 前端那扇由 `openMagnifierEditor` 顺手同步（运行态下才投得出去）。
     */
    showMagnifier(objectId) {
      return get().openMagnifierEditor(objectId);
    },

    addMagnifierState(objectId) {
      return applyActiveScene("添加放大镜状态", (scene) => {
        addSceneMagnifierState(scene, objectId);
      });
    },

    removeMagnifierState(objectId, index) {
      return applyActiveScene("移出放大镜状态", (scene) => {
        removeSceneMagnifierState(scene, objectId, index);
      });
    },

    selectMagnifierState(objectId, index) {
      return applyActiveScene("换一个放大镜状态", (scene) => {
        setSceneMagnifierPicked(scene, objectId, index);
      });
    },

    setMagnifierStateImage(objectId, index, image: ImageRef | null) {
      return applyActiveScene("换放大镜状态里的图", (scene) => {
        setSceneMagnifierStateImage(scene, objectId, index, image);
      });
    },

    setMagnifierStateVideo(objectId, index, clipId) {
      return applyActiveScene("换放大镜状态里的视频", (scene) => {
        setSceneMagnifierStateVideo(scene, objectId, index, clipId);
      });
    },

    setMagnifierStateVideoSwitch(objectId, index, patch) {
      return applyActiveScene("改放大镜视频开关", (scene) => {
        setSceneMagnifierStateVideoSwitch(scene, objectId, index, patch);
      });
    },

    setMagnifierStateTween(objectId, index, tween: MagnifierTween) {
      return applyActiveScene("改放大镜媒体动画", (scene) => {
        setSceneMagnifierStateTween(scene, objectId, index, tween);
      });
    },

    setMagnifierStateShow(objectId, index, part: MagnifierPart, shown: boolean) {
      return applyActiveScene("改放大镜显示开关", (scene) => {
        setSceneMagnifierStateShow(scene, objectId, index, part, shown);
      });
    },

    setMagnifierStateTitle(objectId, index, title) {
      return applyActiveScene("改放大镜状态标题", (scene) => {
        setSceneMagnifierStateTitle(scene, objectId, index, title);
      });
    },

    setMagnifierStateText(objectId, index, text) {
      return applyActiveScene("改放大镜状态文字", (scene) => {
        setSceneMagnifierStateText(scene, objectId, index, text);
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
     * 目标已经没意义了（对象没了 / 组件没了 / 选中的状态还没有图）就**不补发**，顺手把记账清掉——
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
