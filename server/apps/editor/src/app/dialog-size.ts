import { useEffect, useState } from "react";

/**
 * 窗口尺寸与弹窗尺寸计算。
 *
 * 两个格子编辑窗口（网格编辑 / 战争雾 Mask）原来是写死的 `820×560`，在宽屏上显得很小、
 * 白白浪费画布；这里改成**按主窗口比例算**，只钉住「最小能放下界面 / 最大别夸张」两端。
 * 纯函数单独拿出去是为了可单测（jsdom 里量不了布局，但算得出来）。
 */

/** 弹窗尺寸与窗口的比例：宽 80%、高 86%。 */
const WIDTH_RATIO = 0.8;
const HEIGHT_RATIO = 0.86;

/** 再小也要放得下两侧面板与底栏。 */
const MIN_WIDTH = 720;
const MIN_HEIGHT = 520;

/** 再大也别让弹窗变成整屏（留出一点编辑器背景，看得出这是浮层）。 */
const MAX_WIDTH = 1680;
const MAX_HEIGHT = 1200;

/** 无论如何不超出窗口的这个比例（小屏 / 平板上兜底，与 `max-w-[92vw]` 同一档）。 */
const VIEWPORT_LIMIT = 0.92;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 弹窗尺寸：按主窗口比例算，再夹在 `720×520 ~ 1680×1200` 之间，
 * 最后保证不超过窗口的 92%（窄屏上比例值可能比最小值还小）。
 */
export function dialogSizeFor(viewport: {
  readonly width: number;
  readonly height: number;
}): { width: number; height: number } {
  const width = Math.min(
    clamp(viewport.width * WIDTH_RATIO, MIN_WIDTH, MAX_WIDTH),
    Math.max(1, viewport.width * VIEWPORT_LIMIT),
  );
  const height = Math.min(
    clamp(viewport.height * HEIGHT_RATIO, MIN_HEIGHT, MAX_HEIGHT),
    Math.max(1, viewport.height * VIEWPORT_LIMIT),
  );

  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * 把一块内容按给定长宽比**等比装进**可用区域（不放大、不溢出）。
 *
 * 战争的 Mask 窗口用它把「贴图 + 遮罩」那块长宽比盒子算出来：只用 CSS 的长宽比方案
 * （`padding-top` 百分比 / `aspect-ratio`）在「高度先不够」时会把画布挤出可视区——那部分
 * 既看不见也点不到，所以这里直接按可用区域的实测尺寸算。
 */
export function fitBox(
  available: { readonly width: number; readonly height: number },
  aspect: number,
): { width: number; height: number } {
  if (available.width <= 0 || available.height <= 0 || !Number.isFinite(aspect) || aspect <= 0) {
    return { width: 0, height: 0 };
  }

  const width = Math.min(available.width, available.height * aspect);
  return { width: Math.floor(width), height: Math.floor(width / aspect) };
}

/** 当前主窗口（视口）尺寸；随窗口缩放更新。 */
export function useViewportSize(): { width: number; height: number } {
  const [size, setSize] = useState(() =>
    typeof window === "undefined"
      ? { width: 0, height: 0 }
      : { width: window.innerWidth, height: window.innerHeight },
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const onChange = (): void => setSize({ width: window.innerWidth, height: window.innerHeight });
    onChange();
    window.addEventListener("resize", onChange);
    return () => {
      window.removeEventListener("resize", onChange);
    };
  }, []);

  return size;
}

/** 弹窗尺寸（按主窗口比例算，随窗口缩放更新）。 */
export function useDialogSize(): { width: number; height: number } {
  return dialogSizeFor(useViewportSize());
}
