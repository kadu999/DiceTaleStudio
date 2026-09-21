import { PAINTABLE_MASKS, maskToLabel, regionsToMask } from "@dts/grid";
import { isMapFogEnabled, type SceneObjectDoc } from "@dts/document";
import { useEditorStore } from "../../state/editor-store";
import { FieldRow } from "./fields";

/**
 * 战争雾的**编辑区**：放进属性面板的「战争雾」分组里（分组标题由外面给，这里只出行）。
 *
 * 整组由**第一行的总开关**管着：关着时只留那一个开关，打开以后才露出雾区设置——
 * 「没开战争雾的地图」不该摆着一排用不上的按钮。这个开关是**这张地图的文档数据**
 * （`map.fog.enabled`，可撤销、跟着场景存盘下发）：**只有开着前端才生成那一层雾**，
 * 所以它不能记在浏览器本地——那是「新旧看到的不是同一件事」的老 bug。
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
  const setFogEnabled = useEditorStore((state) => state.setFogEnabled);
  const openFogMask = useEditorStore((state) => state.openFogMask);

  const map = object.map;
  if (map === undefined) {
    return <></>;
  }

  // 绑定可能来自手写文件（含未知位）：这里只做展示与判断，规范化交给文档命令
  const regions = map.fog?.regions ?? [];
  const fogMask = regionsToMask(regions);
  const enabled = isMapFogEnabled(map);

  const toggle = (bit: number): void => {
    setFogRegions(
      object.id,
      regions.includes(bit) ? regions.filter((value) => value !== bit) : [...regions, bit],
    );
  };

  // 关着就只留开关：没开战争雾的地图不该摆一排用不上的按钮。
  // 注意这张地图**存着的雾区还在**（关掉只是不生成雾），再打开就回来。
  if (!enabled) {
    return <FogSwitch checked={false} onChange={(next) => setFogEnabled(object.id, next)} />;
  }

  return (
    <>
      <FogSwitch checked onChange={(next) => setFogEnabled(object.id, next)} />

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

      {/* 指定结果不用再写一遍：小方块自己亮着就是「选了」，其余交给 tooltip */}
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
 * 「战争雾」开关：整组的闸门，也是**这张地图的文档数据**（`map.fog.enabled`）。
 *
 * 行名在左（就叫**启用**）、右边只有勾选框——与「基础」组里的激活 / 锁定、以及「视频」组里
 * 那个开关同一套写法；说明收进 title，不在行里再写一遍。
 *
 * 它决定的不只是这一组设置露不露面——**关着时前端一层的雾都不生成**。
 * 雾罩本身仍然不画在画布上（画布只有区域着色），要看雾就打开 Mask 窗口。
 */
function FogSwitch({
  checked,
  onChange,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <FieldRow label="启用">
      <input
        type="checkbox"
        data-testid="fog-enable"
        aria-label="启用战争雾"
        checked={checked}
        title="这张地图开不开战争雾；只有打开才生成雾层（关掉不等于删掉雾区——指定的雾区留着，再打开就回来）"
        className="h-3.5 w-3.5 flex-none accent-[var(--color-editor-accent)]"
        onChange={(event) => onChange(event.target.checked)}
      />
    </FieldRow>
  );
}
