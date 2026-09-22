import { useEffect, useRef, useState } from "react";
import {
  SPRITE_SHEET_MAX,
  imageOf,
  normalizeSpriteSheet,
  spriteCellAtFraction,
  spriteUvRectOf,
  type ImageSpriteRef,
  type SceneDoc,
} from "@dts/document";
import { useEditorStore } from "../state/editor-store";
import { assetRawUrl } from "../panels/asset-picker";

/**
 * 「选择贴图」窗口右侧的**切分面板**（v20 的精灵）：把一张图按「列 × 行」切成格子，
 * 点预览图上的某一格 = 选那一格。
 *
 * 三条分工，别混：
 *
 * 1. **切分（列 × 行）是项目级数据**——它只存一份（工程文件的 `spriteSheets`，key = 图片逻辑 ID），
 *    所以这里改它 = `setSpriteSheet` = 改工程文件，**所有引用这张图的对象一起变**
 *    （这就是「一张图怎么切」只能有一份的落地方式）。所以它**不是**窗口的本地状态，
 *    而是直接读写 store；取消窗口也不会回退它（改的确实是项目数据）。
 * 2. **选哪一格是对象自己的数据**（场景文件里的 `ImageRef.sprite`）：这里只把选择**报给外层**，
 *    由窗口的「使用这一格」一次性写进对象（一条撤销记录）。
 * 3. **预览怎么画**：图与格子按「加载到的图片尺寸」算（真实像素说了算），
 *    与画布、与前端同一套除法（`spriteUvRectOf`），所以「点哪一格」与「画哪一块」永远一致。
 *
 * **格序数从左上数**（`row: 0` = 最上、`column: 0` = 最左），对齐 Unity 的 Sprite Editor。
 */
export interface SpriteSheetPanelProps {
  /** 当前挑中的图片逻辑 ID。 */
  readonly imageId: string;
  /** 这张图的实际尺寸（缩略图加载时读到的自然尺寸）；还没读到时为 `undefined`。 */
  readonly imageSize?: { readonly width: number; readonly height: number };
  /** 当前选中的格子（外层持有：它属于「这个对象」而不是「这张图」）。 */
  readonly cell: ImageSpriteRef | null;
  readonly onCellChange: (cell: ImageSpriteRef | null) => void;
  /**
   * 在哪用：
   * - `object`（缺省）= 「选择贴图 / 精灵」弹框的右侧：**点预览选一格**（格子是这个对象的）；
   * - `asset` = 资源面板选中一张图时的属性区：只切、不选格（格子归各个对象自己），
   *   点击预览不再有意义，所以不响应点击、也不显示「当前格子」那一行。
   */
  readonly mode?: "object" | "asset";
}

export function SpriteSheetPanel({
  imageId,
  imageSize,
  cell,
  onCellChange,
  mode = "object",
}: SpriteSheetPanelProps): React.JSX.Element {
  const spriteSheets = useEditorStore((state) => state.doc.spriteSheets);
  const setSpriteSheet = useEditorStore((state) => state.setSpriteSheet);
  const scenes = useEditorStore((state) => state.scenes);

  const stored = spriteSheets?.[imageId];
  const sheet = normalizeSpriteSheet(stored ?? { columns: 1, rows: 1 });
  const trivial = sheet.columns <= 1 && sheet.rows <= 1;
  // 有多少个对象正在用这张图切出来的格子（清掉切分之前要说清楚会牵连谁）
  const referrers = countSpriteReferrers(scenes, imageId);

  // 两个输入框各自持草稿：失焦 / 回车提交（与属性面板的缩放、显示顺序同一套写法），
  // 连续敲（4 → 4×… 那种）由 store 的 coalesceKey 合成一条撤销记录
  const [columnsDraft, setColumnsDraft] = useState(String(sheet.columns));
  const [rowsDraft, setRowsDraft] = useState(String(sheet.rows));
  const columnsRef = useRef<HTMLInputElement>(null);
  const rowsRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 正在输入的框不被 store 回灌（否则提交后的同步会把刚敲的值冲掉）
    if (document.activeElement !== columnsRef.current) {
      setColumnsDraft(String(sheet.columns));
    }

    if (document.activeElement !== rowsRef.current) {
      setRowsDraft(String(sheet.rows));
    }
  }, [imageId, sheet.columns, sheet.rows]);

  const commit = (): void => {
    const columns = parseSheetValue(columnsDraft, sheet.columns);
    const rows = parseSheetValue(rowsDraft, sheet.rows);
    setSpriteSheet(imageId, { columns, rows });
    // 提交后回填 store 实际采用的值（会被取整 / 夹取）
    setColumnsDraft(String(columns));
    setRowsDraft(String(rows));

    // 切分一改，原来选的格子可能就越界了：夹到有效范围（渲染与推送也会夹，
    // 但那要等下一次解析；这里当场把它对齐，界面上不留「选了却越界」的状态）
    if (cell !== null && (cell.column >= columns || cell.row >= rows)) {
      onCellChange({ column: Math.min(cell.column, columns - 1), row: Math.min(cell.row, rows - 1) });
    }

    // **刚切了就顺手选上第一格**：否则「填了行列」之后按钮还是「使用这张贴图」，
    // 看起来像「没有把贴图转成精灵的按钮」（用户实际反馈过的困惑）。
    // 只在**这一次改切分**时补，打开窗口时不动（那时对象本来就可能是「整图」）。
    if (mode === "object" && cell === null && columns * rows > 1) {
      onCellChange({ column: 0, row: 0 });
    }
  };

  return (
    <div
      data-testid="sprite-sheet-panel"
      className={`flex min-h-0 flex-col gap-2 ${
        mode === "asset" ? "w-full" : "w-[300px] flex-none border-l border-[var(--color-editor-border)] pl-3"
      }`}
    >
      <div className="flex-none text-[12px] font-semibold">切成精灵（子图）</div>

      <p className="flex-none text-[10px] leading-4 text-[var(--color-editor-text-dim)]">
        {mode === "asset"
          ? "把这张图切成网格，用它的对象各自挑一格（对象的属性面板 → 渲染 → 贴图 → 选择）"
          : "① 填列 / 行把它切成网格（4×4 = 16 个精灵）② 在预览里点一格 ③ 按底下的按钮用它"}
      </p>

      {/* 两个输入：列 × 行。项目级数据，改动立刻落到工程文件上 */}
      <div className="flex flex-none items-center gap-1 text-[11px]">
        <span className="text-[var(--color-editor-text-dim)]">列</span>
        <input
          ref={columnsRef}
          value={columnsDraft}
          data-testid="sprite-sheet-columns"
          aria-label="列数"
          inputMode="numeric"
          type="number"
          min="1"
          max={SPRITE_SHEET_MAX}
          className="w-14 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 font-mono text-[11px] outline-none"
          onChange={(event) => setColumnsDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commit();
              event.currentTarget.blur();
            }
          }}
        />
        <span className="text-[var(--color-editor-text-dim)]">行</span>
        <input
          ref={rowsRef}
          value={rowsDraft}
          data-testid="sprite-sheet-rows"
          aria-label="行数"
          inputMode="numeric"
          type="number"
          min="1"
          max={SPRITE_SHEET_MAX}
          className="w-14 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 font-mono text-[11px] outline-none"
          onChange={(event) => setRowsDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commit();
              event.currentTarget.blur();
            }
          }}
        />
        <span className="text-[var(--color-editor-text-dim)]">（1~{SPRITE_SHEET_MAX}）</span>
      </div>

      <p
        data-testid="sprite-sheet-scope-note"
        className="flex-none text-[10px] leading-4 text-[var(--color-editor-text-dim)]"
      >
        切分是这张图自己的（项目级）：改行 / 列会立刻存进工程文件，
        {referrers > 0 ? `${referrers} 个对象` : "别的对象"}用这张图时会一起跟着变。
        对象在场景里的大小不变（要改大小用缩放）。
      </p>

      <SpritePreview
        imageId={imageId}
        columns={sheet.columns}
        rows={sheet.rows}
        cell={cell}
        onPickCell={mode === "object" ? onCellChange : undefined}
        // 资源面板那一档窄：预览别顶满宽度（长条图会占掉整屏），居中给个上限
        extraClass={mode === "asset" ? "max-w-[220px] self-center" : ""}
      />

      <div className="flex flex-none items-center gap-2 text-[11px]">
        {mode === "object" ? (
          <span data-testid="sprite-current-cell" className="min-w-0 flex-1 truncate font-mono">
            {cell === null
              ? "整张图"
              : `第${cell.row + 1}行第${cell.column + 1}列 · ${sheet.columns}×${sheet.rows}`}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--color-editor-text-dim)]">
            {trivial ? "现在按整图用" : `已切成 ${sheet.columns}×${sheet.rows}`}
          </span>
        )}
        <button
          type="button"
          data-testid="sprite-clear-sheet"
          disabled={trivial || referrers > 0}
          className="toolbar-button flex-none hover:toolbar-button-hover disabled:opacity-40"
          title={
            referrers > 0
              ? `还有 ${referrers} 个对象在用这张图的格子：先把它们「改回整图」（属性面板上）再清除切分`
              : "把这张图的切分恢复成整图（等于删掉这一项）"
          }
          onClick={() => setSpriteSheet(imageId, null)}
        >
          清除切分
        </button>
      </div>

      {imageSize === undefined ? (
        <p className="flex-none text-[10px] text-[var(--color-editor-text-dim)]">
          图片还没加载好，先按比例预览；一格的声明尺寸要等图加载出来才知道。
        </p>
      ) : null}
    </div>
  );
}

/**
 * 预览图：整张图按自己的长宽比铺满这块盒子，点哪一格就选哪一格。
 *
 * 盒子用 `aspect-ratio` 顶出图的长宽比，于是**盒子就是图片实际占的那块面积**——
 * 点击比例不必去猜 object-contain 留下的留白，与 `spriteCellAtFraction` 的除法严丝合缝。
 *
 * `onPickCell` 不传 = **只看不选**（资源面板那一档：格子归各个对象自己挑，
 * 在这一层选格没有意义），此时光标与提示也跟着换。
 */
function SpritePreview({
  imageId,
  columns,
  rows,
  cell,
  onPickCell,
  extraClass = "",
}: {
  readonly imageId: string;
  readonly columns: number;
  readonly rows: number;
  readonly cell: ImageSpriteRef | null;
  readonly onPickCell?: (cell: ImageSpriteRef) => void;
  readonly extraClass?: string;
}): React.JSX.Element {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const pickable = onPickCell !== undefined;

  return (
    <div
      data-testid="sprite-preview"
      data-columns={columns}
      data-rows={rows}
      data-cell={cell === null ? "" : `${cell.column},${cell.row}`}
      data-pickable={pickable}
      title={pickable ? "点一格 = 选它" : "这张图切成几格（哪一格由用它的对象各自挑）"}
      className={`relative min-h-0 flex-1 overflow-hidden rounded border border-[var(--color-editor-border)] bg-black/40 ${
        pickable ? "cursor-crosshair" : "cursor-default"
      } ${extraClass}`}
      style={size === null ? { minHeight: 160 } : { aspectRatio: `${size.width} / ${size.height}` }}
      onClick={(event) => {
        if (onPickCell === undefined) {
          return;
        }

        const box = event.currentTarget.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) {
          return;
        }

        onPickCell(
          spriteCellAtFraction(
            { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height },
            { columns, rows },
          ),
        );
      }}
    >
      <img
        src={assetRawUrl(imageId)}
        alt=""
        draggable={false}
        className="pointer-events-none absolute inset-0 h-full w-full select-none"
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget;
          if (naturalWidth > 0 && naturalHeight > 0) {
            setSize({ width: naturalWidth, height: naturalHeight });
          }
        }}
      />

      {/* 格子线：每一条都是一根 1px 的绝对定位细线（列 / 行各自最多 63 条，够用且精确） */}
      {Array.from({ length: Math.max(0, columns - 1) }, (_, index) => (
        <span
          key={`v${index}`}
          aria-hidden
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-white/35"
          style={{ left: `${((index + 1) / columns) * 100}%` }}
        />
      ))}
      {Array.from({ length: Math.max(0, rows - 1) }, (_, index) => (
        <span
          key={`h${index}`}
          aria-hidden
          className="pointer-events-none absolute left-0 right-0 h-px bg-white/35"
          style={{ top: `${((index + 1) / rows) * 100}%` }}
        />
      ))}

      {/* 当前选中那一格：与画布上取的那块是同一套归一化矩形 */}
      {cell === null ? null : (
        <span
          data-testid="sprite-preview-cell"
          aria-hidden
          className="pointer-events-none absolute border-2 border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)]"
          style={{
            left: `${spriteUvRectOf({ columns, rows, column: cell.column, row: cell.row }).x * 100}%`,
            top: `${spriteUvRectOf({ columns, rows, column: cell.column, row: cell.row }).y * 100}%`,
            width: `${(1 / columns) * 100}%`,
            height: `${(1 / rows) * 100}%`,
          }}
        />
      )}
    </div>
  );
}

/** 有几个对象正在用「这张图切出来的格子」（清除切分前的提醒用；只数有子图引用的）。 */
function countSpriteReferrers(scenes: readonly SceneDoc[], imageId: string): number {
  let count = 0;
  for (const scene of scenes) {
    for (const object of scene.objects) {
      const image = imageOf(object);
      if (image?.id === imageId && image.sprite !== undefined) {
        count += 1;
      }
    }
  }

  return count;
}

/** 输入框里敲的值 → 合法的行列数（非法 / 留空退回当前值，越界夹到 1~上限）。 */
function parseSheetValue(draft: string, current: number): number {
  const parsed = Number.parseInt(draft, 10);
  if (!Number.isFinite(parsed)) {
    return current;
  }

  return Math.min(SPRITE_SHEET_MAX, Math.max(1, parsed));
}
