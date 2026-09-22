/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 网格标注：画笔偏好与落笔 / 清空。
 */
import { clearMapCells, paintMapCells } from "@dts/document";
import { CellMask, PAINTABLE_MASKS, clampBrushSize, isHexColor } from "@dts/grid";
import {
  type StoreSet,
  type StoreGet,
  type EditorStoreState,
  type GridPaintState,
} from "../store-types";
import { sceneHistory, makeLog } from "../store-core";
import { type StoreContext } from "../store-context";

export function createGridPaintSlice(
  set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "setGridBrush"
  | "setGridBrushSize"
  | "toggleGridTypeVisible"
  | "setGridTypeColor"
  | "setGridLinesVisible"
  | "setGridAnnotationsVisible"
  | "paintGridStroke"
  | "endGridStroke"
  | "clearGrid"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const { pushLog, persistGridPaint } = ctx;

  return {
    // ------------------------------------------------------------ 网格标注

    setGridBrush(mask) {
      const paintable = mask === CellMask.Empty || PAINTABLE_MASKS.some((bit) => bit === mask);
      if (!paintable) {
        return;
      }

      const gridPaint: GridPaintState = { ...get().gridPaint, mask };
      set({ gridPaint });
      persistGridPaint(gridPaint);
    },

    setGridBrushSize(brushSize) {
      if (!Number.isFinite(brushSize)) {
        return;
      }

      const gridPaint: GridPaintState = {
        ...get().gridPaint,
        // 夹到 1..5：与 Unity 的 IntSlider 同一个范围，也决定了画笔半径
        brushSize: clampBrushSize(brushSize),
      };
      set({ gridPaint });
      persistGridPaint(gridPaint);
    },

    toggleGridTypeVisible(bit) {
      if (!PAINTABLE_MASKS.some((value) => value === bit)) {
        return;
      }

      const gridPaint: GridPaintState = {
        ...get().gridPaint,
        hiddenMask: get().gridPaint.hiddenMask ^ bit,
      };
      set({ gridPaint });
      persistGridPaint(gridPaint);
    },

    setGridTypeColor(bit, hex) {
      if (!PAINTABLE_MASKS.some((value) => value === bit) || !isHexColor(hex)) {
        return;
      }

      const gridPaint: GridPaintState = {
        ...get().gridPaint,
        colors: { ...get().gridPaint.colors, [bit]: hex },
      };
      set({ gridPaint });
      persistGridPaint(gridPaint);
    },

    setGridLinesVisible(visible) {
      const gridPaint: GridPaintState = { ...get().gridPaint, showGridLines: visible };
      set({ gridPaint });
      persistGridPaint(gridPaint);
    },

    setGridAnnotationsVisible(visible) {
      const gridPaint: GridPaintState = { ...get().gridPaint, showAnnotations: visible };
      set({ gridPaint });
      persistGridPaint(gridPaint);
    },

    paintGridStroke(mapObjectId, from, to) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      // 画笔与大小取调用瞬间的值：慢速拖动时用户可能刚换过画笔，落下一笔就该用新的
      const { mask, brushSize } = get().gridPaint;
      const start = from ?? to;

      return get().applyScenes(
        mask === CellMask.Empty ? "擦除网格" : "标注网格",
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene !== undefined) {
            // 落笔在网格外 / 目标不是地图 / 数据坏了都会返回 false（不产生补丁）
            paintMapCells(scene, mapObjectId, start, to, { mask, brushSize });
          }
        },
        // 一整笔（按下 → 抬手的若干次 pointermove）合并成一条撤销记录
        { coalesceKey: `paint:${mapObjectId}` },
      );
    },

    endGridStroke() {
      sceneHistory.endCoalescing();
    },

    clearGrid(mapObjectId) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const changed = get().applyScenes("清空网格", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          clearMapCells(scene, mapObjectId);
        }
      });

      if (changed) {
        pushLog(makeLog("info", "已清空网格标注"));
      }

      return changed;
    },
  };
}
