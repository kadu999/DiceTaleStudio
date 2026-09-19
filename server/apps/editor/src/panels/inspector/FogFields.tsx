import { PAINTABLE_MASKS, maskToLabel, regionsToMask } from "@dts/grid";
import type { SceneObjectDoc } from "@dts/document";
import { useEditorStore } from "../../state/editor-store";
import { FieldRow } from "./fields";

/**
 * 战争雾的**编辑区**：放进属性面板的「战争雾」分组里（分组标题由外面给，这里只出行）。
 *
 * 整组由**第一行的开关**管着：关着时只留那一个开关，打开以后才露出雾区设置——
 * 「没开战争雾的地图」不该摆着一排用不上的按钮。它是**编辑器偏好**
 * （`services/grid-paint-prefs` 的 `showFog`：与网格线 / 网格标注同一份本地偏好、不进文档），
 * 而这张地图到底有没有雾由文档里的 `map.fog.regions` 说了算。
 *
 * **雾不在画布上画**：战争雾用的就是区域数据（`map.cells` 的 8 个区域位），画布上只有
 * 「区域」那一套着色；雾的呈现（未探索的罩子 + 擦除）全在它自己的 Mask 窗口里。
 *
 * 打开以后解决的是「**哪些区域算雾**」：格子上的 8 个类型位是中性的「区域」（面板上叫区域1–区域8），
 * 不与玩法绑定，所以雾区要在这里**手动指定**；指定之后才能在 Mask 窗口里擦除 / 整区开合
 * （真正的编辑在窗口里做，这里只负责指定与入口）。
 */
export function FogFields({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  const setFogRegions = useEditorStore((state) => state.setFogRegions);
  const openFogMask = useEditorStore((state) => state.openFogMask);
  const showFog = useEditorStore((state) => state.gridPaint.showFog);
  const setFogVisible = useEditorStore((state) => state.setFogVisible);

  const map = object.map;
  if (map === undefined) {
    return <></>;
  }

  // 绑定可能来自手写文件（含未知位）：这里只做展示与判断，规范化交给文档命令
  const regions = map.fog?.regions ?? [];
  const fogMask = regionsToMask(regions);

  const toggle = (bit: number): void => {
    setFogRegions(
      object.id,
      regions.includes(bit) ? regions.filter((value) => value !== bit) : [...regions, bit],
    );
  };

  // 关着就只留开关：没开战争雾的地图不该摆一排用不上的按钮
  if (!showFog) {
    return <FogSwitch checked={false} onChange={setFogVisible} />;
  }

  return (
    <>
      <FogSwitch checked onChange={setFogVisible} />

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

      {/* 入口：真正的编辑（擦除 / 整区开合）在 Mask 窗口里做 */}
      <FieldRow label="雾格子">
        <button
          type="button"
          data-testid="fog-mask-open"
          disabled={fogMask === 0}
          title={fogMask === 0 ? "先指定至少一个雾区" : "打开战争雾 Mask 窗口：擦除 / 整区开合"}
          className="flex-none rounded bg-[var(--color-editor-accent)] px-2 py-0.5 text-[11px] text-black hover:opacity-90 disabled:opacity-40"
          onClick={() => openFogMask(object.id)}
        >
          编辑
        </button>
      </FieldRow>
    </>
  );
}

/**
 * 「战争雾」开关：整组的闸门。
 *
 * 只决定**这一组设置露不露面**——雾罩本身不画在画布上（画布只有区域着色），
 * 要看雾就打开 Mask 窗口。它是编辑器偏好，不进文档。
 */
function FogSwitch({
  checked,
  onChange,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <FieldRow label="战争雾">
      <label
        className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px]"
        title="打开以后才显示雾区设置（雾本身在 Mask 窗口里看，画布上不画；只影响编辑器显示，不动数据）"
      >
        <input
          type="checkbox"
          data-testid="fog-enable"
          checked={checked}
          className="h-3.5 w-3.5 flex-none accent-[var(--color-editor-accent)]"
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>启用</span>
      </label>
    </FieldRow>
  );
}
