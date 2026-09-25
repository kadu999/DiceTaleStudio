/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 战争雾：Mask 窗口、雾区绑定与揭示记账。
 */
import {
  fogOf,
  setFogEnabled as setSceneFogEnabled,
  setFogMap as setSceneFogMap,
  setFogRegions as setSceneFogRegions,
} from "@dts/document";
import { maskToLabel } from "@dts/grid";
import {
  pruneFogReveal,
  withEraseBatch,
  withRegion,
  type FogRevealEntry,
} from "../../services/fog-reveal";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { makeLog } from "../store-core";
import { type StoreContext } from "../store-context";

export function createFogSlice(
  set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "openFogMask"
  | "openGridEditor"
  | "setFogMap"
  | "setFogRegions"
  | "setFogEnabled"
  | "eraseFogMask"
  | "setFogRegionRevealed"
  | "flushFogReveal"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const { pushLog, applyActiveScene, runtimeClient, fogTargetOf, canRevealFog, deliverFogErase, frontendReady } = ctx;

  return {
    // ------------------------------------------------------------ 战争雾（Mask 窗口）

    openFogMask(objectId) {
      set({
        fogMask: objectId !== null,
        fogMaskTarget: objectId,
        // 两个格子编辑窗口互斥：同时开两层模态遮罩，谁也别想点
        ...(objectId === null ? {} : { gridEditor: false, gridEditorTarget: null }),
      });
    },

    openGridEditor(objectId) {
      set({
        gridEditor: objectId !== null,
        gridEditorTarget: objectId,
        ...(objectId === null ? {} : { fogMask: false, fogMaskTarget: null }),
      });
    },

    setFogMap(fogObjectId, mapObjectId) {
      const changed = applyActiveScene("选择引用的地图", (scene) => {
        setSceneFogMap(scene, fogObjectId, mapObjectId);
      });

      // 换地图后 Mask 窗口里那张图变了：顺手关掉，免得窗口还对着旧地图
      if (changed && get().fogMaskTarget === fogObjectId) {
        set({ fogMask: false, fogMaskTarget: null });
      }

      return changed;
    },

    setFogRegions(fogObjectId, regions) {
      return applyActiveScene("指定雾区", (scene) => {
        // 规范化与「没变更」的判断都在命令里，这里只负责找到场景
        setSceneFogRegions(scene, fogObjectId, regions);
      });
    },

    setFogEnabled(fogObjectId, enabled) {
      const changed = applyActiveScene(enabled ? "打开战争雾" : "关闭战争雾", (scene) => {
        // 开关写的是**文档数据**：只有它跟着场景下发，前端才知道该不该生成那一层雾
        setSceneFogEnabled(scene, fogObjectId, enabled);
      });

      // 关掉了：正开着的 Mask 窗口跟着关（它编辑的那个雾对象现在不生成雾了）
      if (!enabled && get().fogMaskTarget === fogObjectId) {
        set({ fogMask: false, fogMaskTarget: null });
      }

      return changed;
    },

    eraseFogMask(objectId, points, done) {
      // 编辑态：Mask 窗口只是预览（擦了不写文档、也不下发），与「运行」之前完全一样
      if (get().mode !== "run" || points.length === 0) {
        return undefined;
      }

      const map = fogTargetOf(objectId, "擦除战争雾");
      if (map === null) {
        return undefined;
      }

      // 逐批记账：拖动中的相邻批次在记账里并成**一条完整轨迹**（补发时要的是整笔）
      set({ fogReveal: withEraseBatch(get().fogReveal, objectId, points) });

      const requestId = deliverFogErase(objectId, points);
      if (!done) {
        return requestId;
      }

      const entry = get().fogReveal.objects[objectId];
      const strokes = (entry?.ops ?? []).filter((op) => op.kind === "stroke").length;
      const total = (entry?.ops ?? []).reduce(
        (count, op) => count + (op.kind === "stroke" ? op.stroke.points.length : 0),
        0,
      );
      const what = `「${map.name}」第 ${strokes} 笔（${total} 个落点）`;

      pushLog(
        frontendReady()
          ? makeLog("info", `下发擦除：${what}（请前端沿轨迹擦掉雾）`)
          : makeLog(
              "info",
              `已记录擦除：${what}（${
                runtimeClient.connected ? "前端未连接，等它连上后自动补发" : "编辑器还没连上服务端，连上后自动补发"
              }）`,
            ),
      );

      return requestId;
    },

    setFogRegionRevealed(objectId, region, revealed) {
      if (get().mode !== "run") {
        return undefined;
      }

      const object = fogTargetOf(objectId, revealed ? "揭示雾区" : "盖回雾区");
      if (object === null) {
        return undefined;
      }

      if (!(fogOf(object)?.regions ?? []).includes(region)) {
        pushLog(makeLog("warn", `雾区操作失败：「${object.name}」没把 ${maskToLabel(region)} 指定为雾区`));
        return undefined;
      }

      set({ fogReveal: withRegion(get().fogReveal, objectId, region, revealed) });

      const what = `${maskToLabel(region)}${revealed ? "整片揭示" : "整片盖回"}`;
      if (!frontendReady()) {
        pushLog(
          makeLog(
            "info",
            `已记录${revealed ? "揭示" : "盖回"}：${what}（${
              runtimeClient.connected ? "前端未连接，等它连上后自动补发" : "编辑器还没连上服务端，连上后自动补发"
            }）`,
          ),
        );
        return undefined;
      }

      const requestId = runtimeClient.sendCommand({
        kind: "reveal_fog_region",
        objectId,
        region,
        revealed,
      });
      pushLog(makeLog("info", `下发${revealed ? "揭示" : "盖回"}：${what}（「${object.name}」）`));
      return requestId;
    },

    flushFogReveal() {
      const { fogReveal } = get();
      if (!frontendReady()) {
        return 0;
      }

      // 先按当前文档筛掉没意义的记录（对象被删了 / 不是地图 / 开关关着 / 解绑了雾区），免得补发一堆注定失败的命令
      const pruned = pruneFogReveal(fogReveal, canRevealFog);
      const entries: Array<{ objectId: string; entry: FogRevealEntry }> = Object.entries(
        pruned.objects,
      ).map(([objectId, entry]) => ({ objectId, entry }));

      let steps = 0;
      for (const { objectId, entry } of entries) {
        for (const op of entry.ops) {
          if (op.kind === "stroke") {
            deliverFogErase(objectId, op.stroke.points);
          } else {
            runtimeClient.sendCommand({
              kind: "reveal_fog_region",
              objectId,
              region: op.region,
              revealed: op.revealed,
            });
          }

          steps += 1;
        }
      }

      if (pruned !== fogReveal) {
        set({ fogReveal: pruned });
      }

      if (steps === 0) {
        return 0;
      }

      pushLog(
        makeLog(
          "info",
          `补发战争雾：${entries.length} 张地图 / ${steps} 步（前端刚连上，把它还没看到的揭示补过去）`,
        ),
      );
      return steps;
    },
  };
}
