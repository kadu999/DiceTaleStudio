import { useEffect, useMemo, useState } from "react";
import {
  magnifierDataOf,
  magnifierImageOf,
  magnifierStateIsEmpty,
  spriteCellSizeOf,
  spriteSheetOfMeta,
  type ImageRef,
} from "@dts/document";
import { AssetImage } from "../panels/asset-image";
import { useAssetSize } from "../hooks/useAssetSize";
import { useEditorStore } from "../state/editor-store";
import { ResourcePickerDialog } from "./ResourcePickerDialog";
import { useFittedBox } from "./dialog-size";
import { MapDialogShell, useSceneObject } from "./map-dialog-shell";

/**
 * 「放大镜窗口」：**上面一块是选中状态的画面（标题 + 图 + 文字），下面一排是状态槽**。
 *
 * 与前端那扇窗（`client/.../MagnifierWindow.cs`）长得一样，差别正是用户说的那两点：
 * 编辑器这一扇**多下面那排状态槽与「添加状态」**、**多底栏那两个按钮**，前端的只有上面那块
 * 画面（用户原话：「前端也是弹一个这样的界面，只是中间显示图片，没有显示选择按钮，
 * 没有关闭按钮，只能后端来关闭」）。
 *
 * 数据全在这里改（属性面板那边**整行搬走**了）：
 * - 下排状态槽：点一个 = **换成展示它**（写 `picked`）；每条带 `×` 移出；末尾「添加状态」加空槽；
 * - 上面那块：**给选中的那个状态填内容**——标题输入框、点图那块弹选图框（支持精灵）、
 *   右边一个多行文本框。改的都是**文档数据**，进撤销栈、随场景存盘；运行态下文档一改，
 *   整份 `scene_push` 就把新值带到前端（**没有**「换状态 / 换图」这类命令）。
 *
 * 编辑器**不解码任何东西**：图走既有取图那条路（原图），精灵素材的那一格用 CSS 背景取
 * （`AssetImage`）——与素材面板里的精灵预览同一套算式。
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
  const states = magnifier?.states ?? [];
  const picked = magnifier?.picked;
  const state = picked === undefined ? undefined : states[picked];
  const image = object === undefined ? undefined : magnifierImageOf(object);

  const selectState = useEditorStore((store) => store.selectMagnifierState);
  const addState = useEditorStore((store) => store.addMagnifierState);
  const removeState = useEditorStore((store) => store.removeMagnifierState);
  const setStateImage = useEditorStore((store) => store.setMagnifierStateImage);
  const setStateTitle = useEditorStore((store) => store.setMagnifierStateTitle);
  const setStateText = useEditorStore((store) => store.setMagnifierStateText);
  const openWindow = useEditorStore((store) => store.openMagnifierWindow);
  const closeWindow = useEditorStore((store) => store.closeMagnifierWindow);
  const windowShown = useEditorStore((store) => store.magnifierShown);
  const running = useEditorStore((store) => store.mode === "run");
  const metaTable = useEditorStore((store) => store.assetMetaTable);

  /** 「选择图片」弹框开着没有（关掉窗口 / 换一个状态就收起来）。 */
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (!open) {
      setPicking(false);
    }
  }, [open]);

  const showingHere = object !== undefined && windowShown === object.id;

  /** 选中的那个状态**有东西可展示**（标题 / 图 / 文字至少一项）——没有图也行（纯文字线索卡）。 */
  const showable = !magnifierStateIsEmpty(state);

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
    : !showable
      ? "选中的状态还是空的：给它填点东西（标题 / 图 / 文字都行）"
      : showingHere
        ? "画面上正开着这一个状态"
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
            disabled={!running || !showable || showingHere}
            title={
              !running
                ? "先进入运行态（顶栏「运行」）"
                : !showable
                  ? "先给选中的状态填点东西（标题 / 图 / 文字都行）"
                  : showingHere
                    ? "画面上已经开着它了"
                    : "让前端弹一扇窗显示这一个状态（画面上没有选择 / 关闭按钮，只能从这里控制）"
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
        {/* 上面：**选中状态的那一屏**（没有选中 / 一个状态都没有时给一句话） */}
        {state === undefined ? (
          <div
            data-testid="magnifier-stage-empty"
            className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]"
          >
            {states.length === 0
              ? "还没有状态：点下面的「添加状态」加一个"
              : "下面点一个状态，上面这块就是它的画面（标题 + 图 + 文字）"}
          </div>
        ) : (
          <>
            {/*
              标题带：**一块卡片**（与前端那扇窗同款）——左边一条暖黄强调条，
              与画布上那枚放大镜徽标同色（`SceneLayer` 的 `KIND_MARKER_COLORS.Magnifier`）。
            */}
            <div className="flex flex-none items-center gap-3 rounded-lg border border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] px-3 py-2 focus-within:border-[var(--color-editor-accent)]">
              <span aria-hidden className="h-6 w-1 flex-none rounded-full bg-[#e8c840]" />
              <input
                key={`title-${picked}`}
                data-testid="magnifier-title"
                defaultValue={state.title ?? ""}
                placeholder="标题（可以没有）"
                title="这一个状态最上面那行标题；留空 = 没有标题"
                className="min-w-0 flex-1 rounded bg-transparent text-center text-[15px] font-semibold text-[var(--color-editor-text)] outline-none placeholder:font-normal placeholder:text-[var(--color-editor-text-dim)] focus:bg-black/20"
                onBlur={(event) => {
                  if (object !== undefined && picked !== undefined) {
                    setStateTitle(object.id, picked, event.target.value);
                  }
                }}
                onKeyDown={(event) => {
                  // Enter = 提交并失焦；Esc 也提交（弹窗会跟着关掉，别把刚敲的字丢了）
                  if (event.key === "Enter" || event.key === "Escape") {
                    if (object !== undefined && picked !== undefined) {
                      setStateTitle(object.id, picked, event.currentTarget.value);
                    }
                  }

                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
              />
              {/* 右边留一块与强调条同宽的空位：这样标题是**整张卡**居中，不会被那条挤偏 */}
              <span aria-hidden className="h-6 w-1 flex-none" />
            </div>

            <div className="flex min-h-0 flex-1 gap-2">
              {/*
                左边：**这个状态的图**。整块就是一个按钮（点哪儿都弹选图框），
                有图时里面按真实长宽比等比装下；右上角那个 `×` 把图移出（状态还在，只是没图了）。
                这一格**比面板更暗**（像嵌进相框）——与前端那扇窗同一套层次。
              */}
              <div
                ref={setStageNode}
                className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-[var(--color-editor-border)] bg-[#0a0e14]"
              >
                <button
                  type="button"
                  data-testid="magnifier-image-pick"
                  title={
                    image === undefined
                      ? "从项目里的精灵素材里挑（可以整张，也可以只取图集里的一格）"
                      : "换一张图（可以只取图集里的一格）"
                  }
                  className="absolute inset-0 flex items-center justify-center"
                  onClick={() => setPicking(true)}
                >
                  {image === undefined ? (
                    <span
                      data-testid="magnifier-image-empty"
                      className="px-3 text-center text-[11px] text-[var(--color-editor-text-dim)]"
                    >
                      点这里挑一张图
                      <br />
                      （可以只取图集里的一格）
                    </span>
                  ) : (
                    <span
                      data-testid="magnifier-stage"
                      className="block bg-black"
                      style={{ width: stageBox.width, height: stageBox.height }}
                    >
                      <AssetImage image={image} source="raw" className="h-full w-full" />
                    </span>
                  )}
                </button>

                {image === undefined || picked === undefined ? null : (
                  <button
                    type="button"
                    data-testid="magnifier-image-clear"
                    aria-label="移出这张图"
                    title="把这张图移出这个状态（状态还在，只是没图了）"
                    className="absolute right-1 top-1 z-10 rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-bar)] px-1 text-[12px] leading-none text-[var(--color-editor-text-dim)] after:content-['×'] hover:border-[var(--color-editor-danger)] hover:text-[var(--color-editor-danger)]"
                    onClick={() => {
                      if (object !== undefined) {
                        setStateImage(object.id, picked, null);
                      }
                    }}
                  />
                )}
              </div>

              {/*
                右边：**这个状态的文字描述**（多行纯文本，换行照原样）。
                这一格**比面板更亮**（浮起来的一层）——与左边那格「一暗一亮」，一眼分得清。
              */}
              <div className="flex min-h-0 w-[38%] flex-none flex-col rounded-lg border border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] focus-within:border-[var(--color-editor-accent)]">
                <textarea
                  key={`text-${picked}`}
                  data-testid="magnifier-text"
                  defaultValue={state.text ?? ""}
                  placeholder="文字描述（可以没有，可以换行）"
                  title="这一个状态右边那段文字；留空 = 没有文字。失焦时保存"
                  className="min-h-0 flex-1 resize-none rounded-lg bg-transparent p-3 text-[13px] leading-relaxed text-[var(--color-editor-text)] outline-none placeholder:text-[var(--color-editor-text-dim)] focus:bg-black/20"
                  onBlur={(event) => {
                    if (object !== undefined && picked !== undefined) {
                      setStateText(object.id, picked, event.target.value);
                    }
                  }}
                  onKeyDown={(event) => {
                    // Esc 会把整扇窗关掉（弹窗外壳管的）：先把这一格提交，别丢刚敲的字
                    if (event.key === "Escape" && object !== undefined && picked !== undefined) {
                      setStateText(object.id, picked, event.currentTarget.value);
                    }
                  }}
                />
              </div>
            </div>
          </>
        )}

        {/* 下面：**状态槽**（点一个 = 换成展示它）+ 末尾的「添加状态」 */}
        <div
          data-testid="magnifier-states"
          className="flex flex-none flex-wrap items-center justify-center gap-1"
        >
          {states.map((item, index) => {
            const selected = index === picked;
            return (
              <span
                key={index}
                className={`flex items-center gap-1 rounded-lg border p-0.5 ${
                  selected
                    ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)]"
                    : "border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] hover:border-[var(--color-editor-bar-hover)]"
                }`}
              >
                <button
                  type="button"
                  data-testid="magnifier-state"
                  data-index={index}
                  data-selected={selected}
                  aria-pressed={selected}
                  title={`展示第 ${index + 1} 个状态${item.title === undefined ? "" : `：${item.title}`}`}
                  className="flex flex-none items-center"
                  onClick={() => {
                    if (object !== undefined) {
                      selectState(object.id, index);
                    }
                  }}
                >
                  {item.image === undefined ? (
                    <span
                      data-testid="magnifier-state-blank"
                      className="flex h-12 w-12 items-center justify-center rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]"
                    >
                      {index + 1}
                    </span>
                  ) : (
                    <AssetImage image={item.image} className="h-12 w-12 rounded bg-black/30" />
                  )}
                </button>
                {/*
                  × 用 CSS 画（::after content）：不进 textContent，e2e 对小方块的断言
                  才不会被这个符号弄脏（与视频那一行同一套）。
                */}
                <button
                  type="button"
                  data-testid="magnifier-state-remove"
                  data-index={index}
                  aria-label={`移出第 ${index + 1} 个状态`}
                  title="移出这一个状态（素材文件不会被删）"
                  className="flex-none self-stretch px-1 text-[var(--color-editor-text-dim)] after:content-['×'] hover:text-[var(--color-editor-danger)]"
                  onClick={() => {
                    if (object !== undefined) {
                      removeState(object.id, index);
                    }
                  }}
                />
              </span>
            );
          })}

          <button
            type="button"
            data-testid="magnifier-add-state"
            title="加一个空状态（标题 / 图 / 文字都可以之后再填）"
            className="flex h-[52px] flex-none items-center gap-1 rounded-lg border border-dashed border-[var(--color-editor-border)] px-3 text-[11px] leading-none text-[var(--color-editor-text-dim)] hover:border-[var(--color-editor-accent)] hover:text-[var(--color-editor-text)]"
            onClick={() => {
              if (object !== undefined) {
                addState(object.id);
              }
            }}
          >
            ＋ 添加状态
          </button>
        </div>
      </div>

      {/* 选图：选中一张（可选一格）→ 填进当前这个状态。与精灵对象挑图同一个选择框 */}
      <ResourcePickerDialog
        kind="image"
        allowSprite
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(next: ImageRef, sprite) => {
          if (object !== undefined && picked !== undefined) {
            const meta = useEditorStore.getState().ensureAssetMeta(next.id);
            setStateImage(
              object.id,
              picked,
              sprite === null ? { ...next, guid: meta.guid } : { ...next, guid: meta.guid, sprite },
            );
          }

          // 一次挑一张：选完就收起（与「选择贴图」那条路一致）
          setPicking(false);
        }}
      />
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
