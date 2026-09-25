/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 视口：平移 / 缩放 / 适配 / 尺寸，以及界面偏好 patch。
 */
import { createViewport, panBy, zoomAt } from "@dts/renderer";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { fitSceneViewport } from "../store-core";
import { type StoreContext } from "../store-context";

export function createViewportSlice(
  set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "zoomAtScreen"
  | "panByScreen"
  | "fitToViewport"
  | "setViewportSize"
  | "setUi"
> {
  return {
    zoomAtScreen(anchor, factor) {
      ctx.viewportAdjusted = true;
      set({ viewport: zoomAt(get().viewport, factor, anchor) });
    },

    panByScreen(dx, dy) {
      ctx.viewportAdjusted = true;
      set({ viewport: panBy(get().viewport, dx, dy) });
    },

    fitToViewport() {
      const { scenes, activeSceneName, viewportSize } = get();
      // 视口尺寸还没量出来时退回「世界原点居中 1:1」（此刻算不出该缩到多少）
      if (viewportSize.width === 0 || viewportSize.height === 0) {
        ctx.viewportAdjusted = false;
        set({ viewport: createViewport() });
        return;
      }

      ctx.viewportAdjusted = true;
      set({ viewport: fitSceneViewport(scenes, activeSceneName, viewportSize) });
    },

    setViewportSize(size) {
      const previous = get().viewportSize;
      if (previous.width === size.width && previous.height === size.height) {
        return;
      }

      // 尺寸首次确定或用户还没调过视口时**直接适配**：打开场景 / 转屏 / 拉开面板之后
      // 第一眼就该看到整个场景（而不是世界原点周围那一块，让对象散在屏幕外）
      if (!ctx.viewportAdjusted) {
        set({
          viewportSize: size,
          viewport: fitSceneViewport(get().scenes, get().activeSceneName, size),
        });
        return;
      }

      set({ viewportSize: size });
    },

    setUi(patch) {
      set((state) => ({ ui: { ...state.ui, ...patch } }));
    },
  };
}
