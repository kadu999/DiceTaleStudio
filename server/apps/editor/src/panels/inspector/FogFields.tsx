import { PAINTABLE_MASKS, maskToLabel, regionsToMask, hasMask } from "@dts/grid";
import type { SceneObjectDoc } from "@dts/document";
import { useEditorStore } from "../../state/editor-store";
import { decodeCellsCached } from "../scene/grid-paint";
import { FieldRow } from "./fields";

/**
 * 战争雾的**编辑区**：放进属性面板的「战争雾」分组里（分组标题由外面给，这里只出行）。
 *
 * 这一组解决的是「**哪些区域算雾**」：
 * 格子上的 8 个类型位是中性的「区域」（面板上叫区域1–区域8），不与玩法绑定，所以雾区要在
 * 这里**手动指定**。指定之后：
 *
 * - 「已覆盖」数出这些区域的格子（也就是画布上会盖雾罩的那些）；
 * - 「打开 Mask 窗口…」在贴图上按雾区涂/擦（真正的编辑在那里做，这里只负责指定与统计）；
 * - 「显示 → 战争雾」按运行时的样子在画布上预览（纯显示，不动数据）。
 *
 * 未指定任何雾区时，Mask 窗口与预览都没有意义，所以按钮禁用并写明原因——
 * 比让用户点开一个画不了东西的窗口强。
 */
export function FogFields({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  const setFogRegions = useEditorStore((state) => state.setFogRegions);
  const openFogMask = useEditorStore((state) => state.openFogMask);
  const showFog = useEditorStore((state) => state.gridPaint.showFog);
  const setFogPreviewVisible = useEditorStore((state) => state.setFogPreviewVisible);

  const map = object.map;
  if (map === undefined) {
    return <></>;
  }

  // 绑定可能来自手写文件（含未知位）：这里只做展示与判断，规范化交给文档命令
  const regions = map.fog?.regions ?? [];
  const fogMask = regionsToMask(regions);
  const covered = fogCellCount(object, fogMask);

  const toggle = (bit: number): void => {
    setFogRegions(
      object.id,
      regions.includes(bit) ? regions.filter((value) => value !== bit) : [...regions, bit],
    );
  };

  return (
    <>
      <FieldRow label="指定雾区">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {PAINTABLE_MASKS.map((bit) => {
            const bound = regions.includes(bit);
            return (
              <button
                key={bit}
                type="button"
                data-testid={`fog-region-${bit}`}
                data-bound={bound}
                aria-pressed={bound}
                title={`${maskToLabel(bit)}：点一下${bound ? "取消" : "指定"}为雾区`}
                className={`flex-none rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                  bound
                    ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                    : "border-[var(--color-editor-border)] text-[var(--color-editor-text-dim)] hover:bg-[var(--color-editor-panel-alt)]"
                }`}
                onClick={() => toggle(bit)}
              >
                {maskToLabel(bit)}
              </button>
            );
          })}
        </div>
      </FieldRow>

      {/* 指定结果写出来：按钮点亮是「选了」，这行才是「于是会怎样」 */}
      <div className="px-2 pb-1 text-[10px] text-[var(--color-editor-text-dim)]">
        {fogMask === 0
          ? "还没指定雾区：先点上面的区域按钮，Mask 窗口才会打开"
          : `已指定 ${regions.map((bit) => maskToLabel(bit)).join("、")}：玩家进入这些区域会揭示整片区域（运行时的按区域揭示）`}
      </div>

      <FieldRow label="已覆盖">
        <span
          className="min-w-0 flex-1 font-mono text-[11px]"
          data-testid="fog-cell-count"
          title="含任意一个已指定雾区位的格子数"
        >
          {covered} 格
        </span>
        <button
          type="button"
          data-testid="fog-mask-open"
          disabled={fogMask === 0}
          title={fogMask === 0 ? "先指定至少一个雾区" : "在贴图上按雾区涂 / 擦"}
          className="toolbar-button flex-none hover:toolbar-button-hover disabled:opacity-40"
          onClick={() => openFogMask(object.id)}
        >
          打开 Mask 窗口…
        </button>
      </FieldRow>

      {/*
        「显示」与「编辑」组里的网格线 / 网格标注同族：纯显示开关，作用于画布上的**所有地图**，
        记在浏览器本地（编辑器偏好），不进文档。
      */}
      <FieldRow label="显示">
        <label
          className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px]"
          title="按运行时的样子在有雾的格子上盖一层雾罩（只影响画布显示，不动数据）"
        >
          <input
            type="checkbox"
            data-testid="fog-preview-toggle"
            checked={showFog}
            className="h-3.5 w-3.5 flex-none accent-[var(--color-editor-accent)]"
            onChange={(event) => setFogPreviewVisible(event.target.checked)}
          />
          <span>战争雾</span>
        </label>
      </FieldRow>
    </>
  );
}

/**
 * 含任意一个已指定雾区位的格子数。
 *
 * 与「已标注」一样是解码后现数：属性面板本来就随文档重渲染，几千格的解码可以忽略不计，
 * 解码走带缓存、坏数据返回空数组的那个入口，所以这里不必再兜错。
 */
function fogCellCount(object: SceneObjectDoc, fogMask: number): number {
  const map = object.map;
  if (map === undefined || fogMask === 0) {
    return 0;
  }

  const cells = decodeCellsCached(map.cells.runs, map.grid.width * map.grid.height);
  let count = 0;
  for (const mask of cells) {
    if (hasMask(mask, fogMask)) {
      count += 1;
    }
  }

  return count;
}
