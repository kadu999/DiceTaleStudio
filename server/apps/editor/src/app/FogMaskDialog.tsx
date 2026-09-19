import { useEffect, useState } from "react";
import { CellMask, MAX_BRUSH_SIZE, MIN_BRUSH_SIZE, brushEffectiveSize, maskToLabel, regionsToMask } from "@dts/grid";
import { useEditorStore } from "../state/editor-store";
import { CellPaintDialog } from "./CellPaintDialog";

/**
 * 「战争雾 Mask 窗口」：在贴图上**按雾区**涂 / 擦。
 *
 * 画布 / 视口 / 指针那套机器在 `CellPaintDialog` 里（与网格编辑窗口共用），这里只出：
 * 工具条（只列**已绑定的雾区** + 橡皮 + 画笔大小）与工具状态、以及「这一笔 / 清空」接到哪个 store 动作。
 *
 * 三件事是刻意的：
 * - 画笔**只列已指定的雾区**：哪个区域算雾是属性面板指定的事，窗口里不重复决定；
 * - 画布上只给**已指定的雾区**着色（编辑视图）：别的区域位不是这个窗口在编辑的东西；
 * - **橡皮只擦已指定的雾区位**——这是与标注橡皮（整格清零）唯一但关键的区别：
 *   一格可能同时是「区域1 + 区域4」，擦雾不该把区域1 也抹掉。擦除范围交给 store 里的
 *   `paintFogStroke` 现从文档读（绑定刚改过就按新的算）。
 */
interface FogMaskDialogProps {
  readonly open: boolean;
  /** 正在编辑的地图对象 id；null 表示窗口没打开 */
  readonly objectId: string | null;
  readonly onClose: () => void;
}

export function FogMaskDialog({
  open,
  objectId,
  onClose,
}: FogMaskDialogProps): React.JSX.Element {
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const colors = useEditorStore((state) => state.gridPaint.colors);
  const paintFogStroke = useEditorStore((state) => state.paintFogStroke);
  const endFogStroke = useEditorStore((state) => state.endFogStroke);
  const clearFog = useEditorStore((state) => state.clearFog);

  // 目标对象现查一次：绑定与画笔都看它（对象可能已经被删掉，共用外壳会给出提示）
  const map =
    objectId === null
      ? undefined
      : scenes
          .find((scene) => scene.name === activeSceneName)
          ?.objects.find((item) => item.id === objectId)?.map;

  const regions = map?.fog?.regions ?? [];
  const fogMask = regionsToMask(regions);

  /** 选中的雾区画笔；null = 还没选过（默认落在第一个已指定的雾区上）。 */
  const [picked, setPicked] = useState<number | null>(null);
  const [erasing, setErasing] = useState(false);
  const [brushSize, setBrushSize] = useState(1);

  // 每次打开都回到「第一个雾区、画笔 1、涂抹模式」：窗口是临时工具，不留上一次的怪状态
  useEffect(() => {
    if (open) {
      setPicked(null);
      setErasing(false);
      setBrushSize(1);
    }
  }, [open]);

  const activeBit = picked !== null && regions.includes(picked) ? picked : (regions[0] ?? null);
  const paintMask = erasing || activeBit === null ? CellMask.Empty : activeBit;
  const paintable = objectId !== null && map !== undefined && fogMask !== 0;

  return (
    <CellPaintDialog
      open={open}
      objectId={objectId}
      onClose={onClose}
      slug="fog-mask"
      title="战争雾 Mask"
      // 窗口是编辑视图：只画**已指定的雾区**（没绑定的区域位不是这里在编辑的东西）
      visibleMask={fogMask}
      clearDisabled={fogMask === 0}
      hint="左键涂抹、拖动连成一片；橡皮只擦掉已指定的雾区（同格的其它区域保留）"
      onClear={() => objectId !== null && clearFog(objectId)}
      onStroke={(from, to) => {
        if (!paintable || objectId === null) {
          return;
        }

        paintFogStroke(objectId, from, to, { mask: paintMask, brushSize });
      }}
      onStrokeEnd={endFogStroke}
      toolbar={
        <div className="mb-2 flex flex-none flex-wrap items-center gap-1.5 rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] px-2 py-1 text-[11px]">
          <span className="text-[var(--color-editor-text-dim)]">画笔</span>
          {regions.length === 0 ? (
            <span className="text-[var(--color-editor-warn)]">
              还没有指定雾区：先关掉窗口，在属性面板的「战争雾 → 指定雾区」里点几个区域
            </span>
          ) : (
            regions.map((bit) => {
              const selected = !erasing && bit === activeBit;
              return (
                <button
                  key={bit}
                  type="button"
                  data-testid={`fog-brush-bit-${bit}`}
                  data-active={selected}
                  aria-pressed={selected}
                  className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${
                    selected
                      ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                      : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel)]"
                  }`}
                  onClick={() => {
                    setPicked(bit);
                    setErasing(false);
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 flex-none rounded-sm border border-black/40"
                    style={{ background: colors[bit] ?? "#ffffff" }}
                  />
                  {maskToLabel(bit)}
                </button>
              );
            })
          )}

          <button
            type="button"
            data-testid="fog-brush-erase"
            data-active={erasing}
            aria-pressed={erasing}
            disabled={fogMask === 0}
            className={`rounded border px-1.5 py-0.5 disabled:opacity-40 ${
              erasing
                ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel)]"
            }`}
            onClick={() => setErasing(true)}
          >
            橡皮擦
          </button>

          <span className="ml-auto flex items-center gap-1.5">
            <span className="text-[var(--color-editor-text-dim)]">大小</span>
            <input
              type="range"
              data-testid="fog-brush-size"
              aria-label="画笔大小"
              min={MIN_BRUSH_SIZE}
              max={MAX_BRUSH_SIZE}
              step={1}
              value={brushSize}
              className="w-24 accent-[var(--color-editor-accent)]"
              onChange={(event) => setBrushSize(Number(event.target.value))}
            />
            <span className="font-mono" data-testid="fog-brush-size-label">
              {brushSize}（{brushEffectiveSize(brushSize)}×{brushEffectiveSize(brushSize)} 格）
            </span>
          </span>
        </div>
      }
    />
  );
}
