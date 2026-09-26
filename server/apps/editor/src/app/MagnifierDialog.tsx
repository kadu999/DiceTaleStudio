import { useMemo } from "react";
import { magnifierDataOf, magnifierImageOf, spriteCellSizeOf, spriteSheetOfMeta } from "@dts/document";
import { AssetImage } from "../panels/asset-image";
import { useAssetSize } from "../hooks/useAssetSize";
import { useEditorStore } from "../state/editor-store";
import { useFittedBox } from "./dialog-size";
import { MapDialogShell, useSceneObject } from "./map-dialog-shell";

/**
 * 「放大镜窗口」：**中间一张大图 + 下面一排可以选的图**。
 *
 * 与前端那扇窗（`client/.../MagnifierWindow.cs`）长得一样，只有两处差别（用户原话：
 * 「前端也是弹一个这样的界面，只是中间显示图片，没有显示选择按钮，没有关闭按钮，
 * 只能后端来关闭」）：
 * - 编辑器这一扇**多下面那排小图**（点一张 = 换成展示它）——那是**文档数据**（`picked`），
 *   运行态下文档一改，整份 `scene_push` 就把新值带到前端；
 * - 前端那一扇**没有按钮**，开 / 关只能由编辑器下发的两条命令驱动（底栏那两个按钮）。
 *
 * 编辑器**不解码任何东西**：中间那张与下面那排都走既有取图那条路（原图 / 缩略图），
 * 精灵素材的那一格用 CSS 背景取（`AssetImage`）——与素材面板里的精灵预览同一套算式。
 *
 * 关掉这扇窗**不**连带关前端那扇（DM 要能关掉窗口继续编辑）——要收前端那扇得点「关闭画面」。
 */
export function MagnifierDialog({
  open,
  objectId,
  onClose,
}: {
  readonly open: boolean;
  readonly objectId: string | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  // 目标对象现查一次：它可能已经被删掉（删了窗口就该关，这里只是兜底不崩）
  const object = useSceneObject(objectId);
  const magnifier = object === undefined ? undefined : magnifierDataOf(object);
  const images = magnifier?.images ?? [];
  const picked = magnifier?.picked;
  const image = object === undefined ? undefined : magnifierImageOf(object);

  const selectImage = useEditorStore((state) => state.selectMagnifierImage);
  const openWindow = useEditorStore((state) => state.openMagnifierWindow);
  const closeWindow = useEditorStore((state) => state.closeMagnifierWindow);
  const windowShown = useEditorStore((state) => state.magnifierShown);
  const running = useEditorStore((state) => state.mode === "run");
  const metaTable = useEditorStore((state) => state.assetMetaTable);

  const showingHere = object !== undefined && windowShown === object.id;

  /*
    舞台按**这一张图**的长宽比等比装进可视区（与两个 Mask 窗口同一套 `useFittedBox`）。
    长宽比取**素材的真实像素尺寸**（`?info=1` 探一下），不是引用里声明的宽高：
    后者只决定「在世界里画多大」，重切图集 / 手写文件之后它可能与真实尺寸对不上——
    那时按它算就会把一格画歪，而**前端那边是按纹理真实的那一格铺的**（`preserveAspect`），
    两扇窗就对不上了。探不到时退回声明宽高（比不显示强）。
  */
  const natural = useAssetSize(image?.id);
  const sheet = spriteSheetOfMeta(image === undefined ? undefined : metaTable[image.id]);
  const aspect = useMemo(() => {
    if (image === undefined) {
      return 16 / 9;
    }

    const cell =
      natural === undefined
        ? { width: image.width, height: image.height }
        : image.sprite === undefined
          ? natural
          : spriteCellSizeOf(sheet, natural);
    return cell.width / Math.max(1, cell.height);
  }, [image, natural, sheet]);

  const [stageBox, setStageNode] = useFittedBox(aspect);

  const hint = !running
    ? "编辑态只是预览：进运行态才能在画面上打开"
    : image === undefined
      ? "先选一张图（下面点一下）"
      : showingHere
        ? "画面上正开着这一张"
        : "画面上没开：点「在画面上打开」";

  return (
    <MapDialogShell
      open={open}
      onClose={onClose}
      prefix="magnifier"
      title={object === undefined ? "放大镜" : `放大镜：${object.name}`}
      found={object !== undefined}
      missing="找不到这个放大镜（可能已经被删掉了）"
      footer={
        <>
          <button
            type="button"
            data-testid="magnifier-show"
            disabled={!running || image === undefined || showingHere}
            title={
              !running
                ? "先进入运行态（顶栏「运行」）"
                : image === undefined
                  ? "先在下面选一张图"
                  : showingHere
                    ? "画面上已经开着它了"
                    : "让前端弹一扇窗显示这一张（画面上没有选择 / 关闭按钮，只能从这里控制）"
            }
            className={FOOTER_BUTTON_CLASS}
            onClick={() => {
              if (object !== undefined) {
                openWindow(object.id);
              }
            }}
          >
            在画面上打开
          </button>
          <button
            type="button"
            data-testid="magnifier-hide"
            disabled={!showingHere}
            title={showingHere ? "让前端把那扇窗收起来" : "画面上现在没开着它"}
            className={FOOTER_BUTTON_CLASS}
            onClick={() => closeWindow()}
          >
            关闭画面
          </button>
          <span data-testid="magnifier-dialog-state" className="min-w-0 truncate">
            {hint}
          </span>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {/* 中间：当前展示的那一张（等比装进可视区；前端那扇窗显示的就是它） */}
        <div
          ref={setStageNode}
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded border border-[var(--color-editor-border)] bg-black/40"
        >
          {image === undefined ? (
            <span
              data-testid="magnifier-stage-empty"
              className="text-[11px] text-[var(--color-editor-text-dim)]"
            >
              {images.length === 0
                ? "还没加图片（属性面板 → 放大镜 → 图片 → ＋）"
                : "还没选要展示哪一张（下面点一张）"}
            </span>
          ) : (
            <div
              data-testid="magnifier-stage"
              className="bg-black"
              style={{ width: stageBox.width, height: stageBox.height }}
            >
              <AssetImage image={image} source="raw" className="h-full w-full" />
            </div>
          )}
        </div>

        {/* 下面：**可以选择的图片**（点一张 = 换成展示它，也进撤销栈） */}
        <div
          data-testid="magnifier-picks"
          className="flex flex-none flex-wrap items-center justify-center gap-1"
        >
          {images.length === 0 ? (
            <span className="text-[10px] text-[var(--color-editor-text-dim)]">
              图片列表是空的（属性面板 → 放大镜 → 图片 → ＋）
            </span>
          ) : (
            images.map((item, index) => {
              const selected = index === picked;
              return (
                <button
                  key={`${item.id}#${index}`}
                  type="button"
                  data-testid="magnifier-pick"
                  data-index={index}
                  data-selected={selected}
                  aria-pressed={selected}
                  title={`展示第 ${index + 1} 张`}
                  className={`rounded border p-0.5 ${
                    selected
                      ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)]"
                      : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel-alt)]"
                  }`}
                  onClick={() => {
                    if (object !== undefined) {
                      selectImage(object.id, index);
                    }
                  }}
                >
                  <AssetImage image={item} className="h-12 w-12 rounded bg-black/30" />
                </button>
              );
            })
          )}
        </div>
      </div>
    </MapDialogShell>
  );
}

/**
 * 底栏那两个按钮的样子：**一眼要看出能按**。
 *
 * 外壳的底栏是一行 `text-[10px]` 小字，`toolbar-button` 那种「透明底 + 透明边」摆在这里
 * 同样像纯文字（视频混合窗口那次踩过同一个坑），所以自己给边框与底；
 * 禁用（不在运行态 / 没选图 / 已经开着）退回灰字、不可点。
 */
const FOOTER_BUTTON_CLASS =
  "flex-none rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-bar)] px-2 py-0.5 text-[11px] text-[var(--color-editor-text)] hover:border-[var(--color-editor-accent)] hover:bg-[var(--color-editor-bar-hover)] hover:text-white disabled:border-[var(--color-editor-border)] disabled:bg-transparent disabled:text-[var(--color-editor-text-dim)] disabled:hover:border-[var(--color-editor-border)] disabled:hover:bg-transparent disabled:hover:text-[var(--color-editor-text-dim)]";
