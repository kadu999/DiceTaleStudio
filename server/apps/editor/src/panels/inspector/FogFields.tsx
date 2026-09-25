import { PAINTABLE_MASKS, maskToLabel, regionsToMask } from "@dts/grid";
import { fogOf, isFogEnabled, mapDataOf, type GameObjectDoc } from "@dts/document";
import { useEditorStore } from "../../state/editor-store";
import { FieldRow } from "./fields";

/**
 * 战争雾的**编辑区**：放进属性面板的「战争雾」分组里（分组标题由外面给，这里只出行）。
 *
 * v27 起雾是**独立的 `Fog` 对象**：数据在它自己身上的 `FogOfWar` 组件里（`fogOf(object)`），
 * 组件里第一项是**引用哪张地图**（`mapId`）——雾区与格子都取自那张地图的 `GridMap`。
 * 一张地图最多一个雾对象（校验强制）。
 *
 * 整组由**总开关**管着：关着时只留那一个开关，打开以后才露出雾区设置——
 * 「没开战争雾的雾对象」不该摆着一排用不上的按钮。这个开关是**场景文档数据**
 * （`FogOfWar.enabled`，可撤销、跟着场景存盘下发）：**只有开着前端才生成那一层雾**，
 * 所以它不能记在浏览器本地——那是「新旧看到的不是同一件事」的老 bug。
 *
 * **雾不在画布上画**：画布上这个对象只画一枚图标（可选中 / 可拖动），雾的呈现
 * （未探索的罩子 + 擦除）在它自己的 Mask 窗口里与前端。
 */
export function FogFields({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const setFogMap = useEditorStore((state) => state.setFogMap);
  const setFogRegions = useEditorStore((state) => state.setFogRegions);
  const setFogEnabled = useEditorStore((state) => state.setFogEnabled);
  const openFogMask = useEditorStore((state) => state.openFogMask);

  const fog = fogOf(object);
  if (fog === undefined) {
    // registry 只在组件在（或可修复）时渲染这里；保险起见给个兜底
    return <></>;
  }

  const regions = fog.regions ?? [];
  const fogMask = regionsToMask(regions);
  const enabled = isFogEnabled(object);
  const mapId = fog.mapId ?? "";

  const scene = scenes.find((item) => item.name === activeSceneName);
  const maps = (scene?.objects ?? []).filter((item) => mapDataOf(item) !== undefined);

  const toggle = (bit: number): void => {
    setFogRegions(
      object.id,
      regions.includes(bit) ? regions.filter((value) => value !== bit) : [...regions, bit],
    );
  };

  return (
    <>
      {/* 引用哪张地图：雾区（`regions`）与格子（`cells`）都取自它 */}
      <FieldRow label="引用地图">
        <select
          data-testid="fog-map"
          aria-label="引用的地图"
          value={mapId}
          title="这个雾层盖在哪张地图上；雾区取自那张地图的格子"
          className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 text-[11px]"
          onChange={(event) => setFogMap(object.id, event.target.value)}
        >
          <option value="">（未选择）</option>
          {maps.map((map) => (
            <option key={map.id} value={map.id}>
              {map.name}
            </option>
          ))}
        </select>
      </FieldRow>

      {mapId.length === 0 ? (
        <div className="px-2 pb-1 pl-[5.5rem] text-[10px] leading-4 text-[var(--color-editor-warn)]">
          先选一张地图，雾区取自它的格子。场景里一张地图都没有时，先去建一张网格地图。
        </div>
      ) : null}

      {/* 开关：没指定地图时区域设置没有意义，只留开关 */}
      <FogSwitch checked={enabled} onChange={(next) => setFogEnabled(object.id, next)} />

      {!enabled || mapId.length === 0 ? null : (
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
      )}
    </>
  );
}

/**
 * 「战争雾」开关：整组的闸门，也是**这个雾对象的文档数据**（`FogOfWar` 组件的 `enabled`）。
 *
 * 行名在左（就叫**启用**）、右边只有勾选框——与「基础」组里的激活 / 锁定、以及「视频」组里
 * 那个开关同一套写法；说明收进 title，不在行里再写一遍。
 *
 * 它决定的不只是这一组设置露不露面——**关着时前端一层的雾都不生成**。
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
        title="这个雾对象开不开战争雾；只有打开才生成雾层（关掉不等于删掉雾区——指定的雾区留着，再打开就回来）"
        className="h-3.5 w-3.5 flex-none accent-[var(--color-editor-accent)]"
        onChange={(event) => onChange(event.target.checked)}
      />
    </FieldRow>
  );
}
