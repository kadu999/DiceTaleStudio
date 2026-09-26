import { useState } from "react";
import {
  magnifierDataOf,
  magnifierImageOf,
  type GameObjectDoc,
  type ImageRef,
} from "@dts/document";
import { useEditorStore } from "../../state/editor-store";
import { ResourcePickerDialog } from "../../app/ResourcePickerDialog";
import { AssetImage } from "../asset-image";
import { FieldRow } from "./fields";

/**
 * 放大镜（动作对象，v30）的字段：**图片列表** + **触发这个动作**。
 *
 * 两件事分得清楚（界面上就是两行，别混）：
 * - 「图片」那一行是**文档数据**：加 / 移出图片（每一条从精灵素材里挑，可以取图集里的一格）、
 *   点一条就换成展示它（`picked` 是下标）——**进撤销栈、随场景存盘下发**；
 * - 「窗口」那一行是**动作**：打开窗口（编辑器那扇，预览 + 挑图；运行态下同时投到前端）、
 *   以及「关闭画面」——前端那扇窗只能由后端开、由后端关（它自己没有按钮）。
 *
 * 选图走既有的通用选择框（`allowSprite`：只列精灵素材，可整张也可取一格）——与精灵对象
 * 挑图是同一条路；换图**不是**命令：运行态下文档一改，整份 `scene_push` 就把新值带到前端。
 */
export function MagnifierFields({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
  const magnifier = magnifierDataOf(object);
  const images = magnifier?.images ?? [];
  const picked = magnifier?.picked;
  const shown = magnifierImageOf(object) !== undefined;

  const addImage = useEditorStore((state) => state.addMagnifierImage);
  const removeImage = useEditorStore((state) => state.removeMagnifierImage);
  const selectImage = useEditorStore((state) => state.selectMagnifierImage);
  const showMagnifier = useEditorStore((state) => state.showMagnifier);
  const closeMagnifierWindow = useEditorStore((state) => state.closeMagnifierWindow);
  const mode = useEditorStore((state) => state.mode);
  const windowShown = useEditorStore((state) => state.magnifierShown);

  /** 「选择图片」弹框开着没有（换个对象就收起来）。 */
  const [picking, setPicking] = useState(false);

  const running = mode === "run";
  const showingHere = windowShown === object.id;

  return (
    <>
      {/*
        图片那一行：**加进来的全列出来**（点一条 = 换成展示它），管理也全在这一行：
        每条上那个 `×` 移出、末尾的 `＋` 从项目素材里挑（虚线框 = 「加」）。
      */}
      <FieldRow label="图片">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" data-testid="magnifier-images">
          {images.length === 0 ? (
            <span
              data-testid="magnifier-empty"
              className="text-[11px] text-[var(--color-editor-text-dim)]"
              title="点「＋」从项目里的精灵素材里挑（可以只取图集里的一格）"
            >
              还没加图片
            </span>
          ) : (
            images.map((image, index) => {
              const selected = index === picked;
              return (
                <span
                  key={`${image.id}#${index}`}
                  data-testid="magnifier-image"
                  data-index={index}
                  data-selected={selected}
                  title={
                    selected
                      ? "窗口里现在放的就是它（再点一下取消展示）"
                      : "点一下换成展示它（窗口下面那排小图也是它）"
                  }
                  className={`flex items-center gap-1 rounded border p-0.5 ${
                    selected
                      ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)]"
                      : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel-alt)]"
                  }`}
                >
                  <button
                    type="button"
                    data-testid="magnifier-image-pick"
                    aria-pressed={selected}
                    aria-label={`展示第 ${index + 1} 张`}
                    className="flex flex-none items-center"
                    onClick={() => selectImage(object.id, selected ? null : index)}
                  >
                    <AssetImage image={image} className="h-8 w-8 rounded bg-black/30" />
                  </button>
                  {/*
                    × 用 CSS 画（::after content）：不进 textContent，e2e 对小方块
                    的断言才不会被这个符号弄脏（与视频那一行同一套）。
                  */}
                  <button
                    type="button"
                    data-testid="magnifier-image-remove"
                    data-index={index}
                    aria-label={`移出第 ${index + 1} 张`}
                    title="移出这一条（素材文件不会被删）"
                    className="flex-none self-stretch px-1 text-[var(--color-editor-text-dim)] after:content-['×'] hover:text-[var(--color-editor-danger)]"
                    onClick={() => removeImage(object.id, index)}
                  />
                </span>
              );
            })
          )}

          <button
            type="button"
            data-testid="magnifier-add"
            title="从项目里的精灵素材里挑（可以整张，也可以只取图集里的一格）"
            aria-label="添加图片"
            className="flex h-9 w-9 flex-none items-center justify-center rounded border border-dashed border-[var(--color-editor-border)] text-[13px] leading-none text-[var(--color-editor-text-dim)] hover:border-[var(--color-editor-accent)] hover:text-[var(--color-editor-text)]"
            onClick={() => setPicking(true)}
          >
            ＋
          </button>
        </div>
      </FieldRow>

      {/* 选图：选中一张（可选一格）→ 加入列表。与精灵对象挑图同一个选择框 */}
      <ResourcePickerDialog
        kind="image"
        allowSprite
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(image: ImageRef, sprite) => {
          const meta = useEditorStore.getState().ensureAssetMeta(image.id);
          addImage(object.id, sprite === null ? { ...image, guid: meta.guid } : { ...image, guid: meta.guid, sprite });
        }}
      />

      {/*
        窗口那一行：「打开窗口」= 开编辑器这扇（运行态下同时投到前端）；「关闭画面」只在
        **这个对象正被投影**时出现——前端那扇窗没有关闭按钮，只能从这里关。
      */}
      <FieldRow label="窗口">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" data-testid="magnifier-window">
          <button
            type="button"
            data-testid="magnifier-open"
            title={
              running
                ? "打开窗口，并让前端也弹一扇（画布上双击徽标也一样）"
                : "打开窗口（预览 + 挑图）；进运行态后点它会同时投到前端"
            }
            className="flex-none rounded border border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] px-3 py-0.5 text-[11px] text-white hover:brightness-125"
            onClick={() => showMagnifier(object.id)}
          >
            打开窗口
          </button>

          {showingHere ? (
            <button
              type="button"
              data-testid="magnifier-close"
              title="让前端把那扇窗收起来（它自己没有关闭按钮）"
              className="flex-none rounded border border-[var(--color-editor-border)] px-2 py-0.5 text-[11px] hover:border-[var(--color-editor-danger)] hover:text-[var(--color-editor-danger)]"
              onClick={() => closeMagnifierWindow()}
            >
              关闭画面
            </button>
          ) : null}

          <span
            data-testid="magnifier-window-state"
            className="text-[10px] text-[var(--color-editor-text-dim)]"
          >
            {!running
              ? "编辑态只有窗口预览（进运行态才投到前端）"
              : showingHere
                ? shown
                  ? "画面上开着这一张"
                  : "画面上开着（但还没选图）"
                : "画面上没开"}
          </span>
        </div>
      </FieldRow>
    </>
  );
}
