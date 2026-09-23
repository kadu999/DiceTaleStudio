/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 传送阵：候选目标、选中与触发换台。
 */
import {
  teleportDataOf,
  setTeleportTargets as setSceneTeleportTargets,
  setTeleportPicked as setSceneTeleportPicked,
} from "@dts/document";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { makeLog } from "../store-core";
import { type StoreContext } from "../store-context";

export function createTeleportSlice(
  set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "setTeleportTargets"
  | "setTeleportPicked"
  | "openTeleportEditor"
  | "teleport"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const { pushLog, applyActiveScene, requireTeleportObject, switchScene } = ctx;

  return {
    // ------------------------------------------------------------ 传送阵（动作对象）

    setTeleportTargets(objectId, targets) {
      return applyActiveScene("修改传送目标", (scene) => {
        setSceneTeleportTargets(scene, objectId, targets);
      });
    },

    setTeleportPicked(objectId, target) {
      return applyActiveScene("选择传送目标", (scene) => {
        setSceneTeleportPicked(scene, objectId, target);
      });
    },

    openTeleportEditor(objectId) {
      set({ teleportEditor: objectId !== null, teleportEditorTarget: objectId });
    },

    teleport(objectId) {
      const object = requireTeleportObject(objectId);
      if (object === undefined) {
        return false;
      }

      const teleport = teleportDataOf(object);
      if (teleport === undefined || teleport.targets.length === 0) {
        pushLog(makeLog("error", `${object.name}：还没有加目标场景，先在「传送目标」里勾几个`));
        return false;
      }

      // 选中的那个可能已经被移出候选（手写文件里也可能留下一个对不上的值）：按「还没选」处理
      const target = teleport.picked;
      if (target === undefined || !teleport.targets.includes(target)) {
        pushLog(makeLog("error", `${object.name}：还没选要传送到哪一张场景（面板上点一下小方块）`));
        return false;
      }

      if (target === get().activeSceneName) {
        pushLog(makeLog("warn", `${object.name}：目标就是当前场景，什么都不用做`));
        return false;
      }

      if (!get().scenes.some((scene) => scene.name === target)) {
        pushLog(
          makeLog(
            "error",
            `${object.name}：目标场景「${target}」不存在（可能被改名或删掉了），重新挑一个`,
          ),
        );
        return false;
      }

      // 走切场景那条唯一的路（写回改动 → 记住视口 → 换场景 → 立刻推给前端）。
      // `log: false`：下面这条带来源的日志更说明问题，免得一次传送写两行
      switchScene(target, { clearAssetSelection: true, log: false });
      pushLog(makeLog("info", `传送阵「${object.name}」→ 场景「${target}」`));
      return true;
    },
  };
}
