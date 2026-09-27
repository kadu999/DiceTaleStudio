import { useEffect, useMemo, useState } from "react";
import {
  magnifierDataOf,
  magnifierImageOf,
  spriteCellSizeOf,
  spriteSheetOfMeta,
  type ImageRef,
  type MagnifierTween,
} from "@dts/document";
import { AssetImage } from "../panels/asset-image";
import { mediaClipName } from "../panels/inspector/VideoFields";
import {
  STRUCTURE_LOCK_HINT,
  structureLockedClass,
  useStructureLocked,
} from "../panels/inspector/structure-lock";
import { useAssetSize } from "../hooks/useAssetSize";
import { useEditorStore } from "../state/editor-store";
import { ResourcePickerDialog } from "./ResourcePickerDialog";
import { useFittedBox } from "./dialog-size";
import { MapDialogShell, useSceneObject } from "./map-dialog-shell";

/** 媒体那块的动画预设（v33）：与前端 `MagnifierWindow` / `MAGNIFIER_TWEENS` 同一套。 */
const TWEEN_OPTIONS: ReadonlyArray<{ readonly value: MagnifierTween; readonly label: string }> = [
  { value: "none", label: "无" },
  { value: "shake", label: "震动" },
  { value: "breathe", label: "呼吸" },
  { value: "float", label: "漂浮" },
  { value: "sway", label: "摇摆" },
];

/** 媒体工具条 / 视频块上小按钮的样子（选中态一眼看得出）。 */
const MEDIA_BUTTON_CLASS =
  "flex-none rounded border px-1.5 py-0.5 text-[10px] leading-none";
const MEDIA_BUTTON_ON = "border-[#8c2f1e] bg-[#e6cfa8] text-[#3a2a16]";
const MEDIA_BUTTON_OFF = "border-[#bc9b60] text-[#8a6d3b] hover:border-[#8c2f1e] hover:text-[#3a2a16]";

/**
 * 「放大镜窗口」：**上面一块是选中状态的画面（标题 + 图 + 文字），下面一排是状态槽**。
 *
 * 与前端那扇窗（`client/.../MagnifierWindow.cs`）长得一样，差别只有一处：
 * 编辑器这一扇**多下面那排状态槽与「添加状态」**，前端的只有上面那块画面
 * （用户原话：「前端也是弹一个这样的界面，只是中间显示图片，没有显示选择按钮，
 * 没有关闭按钮，只能后端来关闭」）。
 *
 * **这扇窗的开 / 关就是前端那扇窗的开 / 关**（用户在底栏与面板都不想要额外的按钮）：
 * 编辑器这扇一开（`openMagnifierEditor(id)`）就往前端投、一关（`openMagnifierEditor(null)`）
 * 就收掉前端那扇——`EditorShell` 的 `onClose` 与 Radix 的遮罩 / Esc 都走这条路。
 *
 * **配色与前端那扇窗对齐（羊皮纸线索卡，2026-09-27）**：暖米黄纸面（`#F1E5C6`）+ 深棕字
 * （标题 `#3A2A16` / 正文 `#4A381F`）+ 棕描边（`#BC9B60`）+ 红蜡色强调条（`#8C2F1E`）——
 * 这里改完，前端 `MagnifierWindow` 那份 prefab 要跟着同步（两边是一套）。
 *
 * 数据全在这里改（属性面板那边**整行搬走**了）：
 * - 下排状态槽：点一个 = **换成展示它**（写 `picked`）；每条带 `×` 移出；末尾「添加状态」加空槽；
 * - 上面那块：**给选中的那个状态填内容**——标题输入框、点图那块弹选图框（支持精灵）、
 *   右边一个多行文本框。改的都是**文档数据**，进撤销栈、随场景存盘；运行态下文档一改，
 *   整份 `scene_push` 就把新值带到前端（**没有**「换状态 / 换图」这类命令）。
 *
 * 编辑器**不解码任何东西**：图走既有取图那条路（原图），精灵素材的那一格用 CSS 背景取
 * （`AssetImage`）——与素材面板里的精灵预览同一套算式。
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
  const setStateVideo = useEditorStore((store) => store.setMagnifierStateVideo);
  const setStateVideoSwitch = useEditorStore((store) => store.setMagnifierStateVideoSwitch);
  const setStateTween = useEditorStore((store) => store.setMagnifierStateTween);
  const setStateShow = useEditorStore((store) => store.setMagnifierStateShow);
  const setStateTitle = useEditorStore((store) => store.setMagnifierStateTitle);
  const setStateText = useEditorStore((store) => store.setMagnifierStateText);
  const metaTable = useEditorStore((store) => store.assetMetaTable);
  const tree = useEditorStore((store) => store.project.tree);
  const assetMetas = useEditorStore((store) => store.assetMetas);

  /** 「选择图片 / 选择视频」弹框开着没有（关掉窗口 / 换一个状态就收起来）。 */
  const [picking, setPicking] = useState(false);
  const [pickingVideo, setPickingVideo] = useState(false);
  // 运行态锁住**加 / 删条目**（值照旧能改）
  const structureLocked = useStructureLocked();
  useEffect(() => {
    if (!open) {
      setPicking(false);
      setPickingVideo(false);
    }
  }, [open]);

  // 一屏的媒体**二选一**（v33）：视频在就放视频，否则放图（渲染按视频优先，与校验口径一致）
  const video = state?.video;
  const hasVideo = video !== undefined;
  const videoName = video === undefined ? "" : mediaClipName(tree, assetMetas, metaTable, video.id);

  // v34：三块的**显示开关**——管显示，不看有没有值（与前端 `MagnifierWindow` 同一口径）
  const showTitle = state?.showTitle === true;
  const showMedia = state?.showMedia === true;
  const showText = state?.showText === true;

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

  return (
    <MapDialogShell
      open={open}
      onClose={onClose}
      prefix="magnifier"
      title={object === undefined ? "放大镜" : `放大镜：${object.name}`}
      found={object !== undefined}
      missing="找不到这个放大镜（可能已经被删掉了）"
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
              标题带（**开关开着才出现**，v34）：与前端那扇窗同款——左边一条**红蜡色**强调条，
              整张卡是**羊皮纸**（暖米黄纸面 + 深棕字 + 棕描边）。
            */}
            {showTitle ? (
            <div className="flex flex-none items-center gap-3 rounded-lg border border-[#bc9b60] bg-[#f1e5c6] px-3 py-2 focus-within:border-[#8c2f1e]">
              <span aria-hidden className="h-6 w-1 flex-none rounded-full bg-[#8c2f1e]" />
              <input
                key={`title-${picked}`}
                data-testid="magnifier-title"
                defaultValue={state.title ?? ""}
                placeholder="标题（可以没有）"
                title="这一个状态最上面那行标题；留空 = 没有标题"
                className="min-w-0 flex-1 rounded bg-transparent text-center text-[15px] font-semibold text-[#3a2a16] outline-none placeholder:font-normal placeholder:text-[#a08a63] focus:bg-black/5"
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
            ) : null}

            {/*
              媒体工具条（v33）：**媒体类型**（图片 / 视频，二选一）+ **媒体那块的动画**（下拉框）。
              点「图片」弹选图框、点「视频」弹选视频框——写入命令会把另一种媒体删掉。
            */}
            <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#8a6d3b]">
              <span className="flex items-center gap-1">
                <span>媒体</span>
                <button
                  type="button"
                  data-testid="magnifier-media-image"
                  data-active={!hasVideo}
                  className={`${MEDIA_BUTTON_CLASS} ${hasVideo ? MEDIA_BUTTON_OFF : MEDIA_BUTTON_ON}`}
                  onClick={() => setPicking(true)}
                >
                  图片
                </button>
                <button
                  type="button"
                  data-testid="magnifier-media-video"
                  data-active={hasVideo}
                  className={`${MEDIA_BUTTON_CLASS} ${hasVideo ? MEDIA_BUTTON_ON : MEDIA_BUTTON_OFF}`}
                  onClick={() => setPickingVideo(true)}
                >
                  视频
                </button>
              </span>

              <label className="flex items-center gap-1">
                <span>动画</span>
                <select
                  data-testid="magnifier-tween"
                  value={state.tween ?? "none"}
                  title="媒体那块的动画（只作用在图 / 视频那一块）"
                  className="rounded border border-[#bc9b60] bg-[#f1e5c6] px-1.5 py-0.5 text-[10px] leading-none text-[#3a2a16] outline-none hover:border-[#8c2f1e]"
                  onChange={(event) => {
                    if (object !== undefined && picked !== undefined) {
                      setStateTween(object.id, picked, event.target.value as MagnifierTween);
                    }
                  }}
                >
                  {TWEEN_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              {/* v34：三块的显示开关——管显示，不看有没有值（与前端同一口径） */}
              <span className="flex items-center gap-2">
                <span>显示</span>
                {(
                  [
                    ["title", "标题", showTitle],
                    ["media", "贴图", showMedia],
                    ["text", "描述", showText],
                  ] as const
                ).map(([part, label, on]) => (
                  <label key={part} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      data-testid={`magnifier-show-${part}`}
                      checked={on}
                      onChange={(event) => {
                        if (object !== undefined && picked !== undefined) {
                          setStateShow(object.id, picked, part, event.target.checked);
                        }
                      }}
                    />
                    {label}
                  </label>
                ))}
              </span>
            </div>

            <div className="flex min-h-0 flex-1 gap-2">
              {/*
                左边：**这个状态的媒体**（v33 起图与视频二选一）。
                - 图：整块就是一个按钮（点哪儿都弹选图框），右上角 `×` 把图移出；
                - 视频：编辑器**不预览**（不解码），显示素材名 + 循环 / 声音开关 + 换 / 清除。
                媒体这块是**羊皮纸面**——与前端那扇窗同款。
              */}
              {!showMedia ? null : hasVideo ? (
                <div
                  data-testid="magnifier-video-stage"
                  className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden rounded-lg border border-[#bc9b60] bg-[#e8d8b4] p-3 text-center"
                >
                  <span className="text-[11px] text-[#8a6d3b]">视频（编辑器不预览）</span>
                  <span
                    data-testid="magnifier-video-name"
                    title={video?.id}
                    className="max-w-full truncate text-[13px] font-semibold text-[#3a2a16]"
                  >
                    {videoName}
                  </span>
                  <span className="flex items-center gap-3 text-[11px] text-[#4a381f]">
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        data-testid="magnifier-video-loop"
                        checked={video?.loop ?? true}
                        onChange={(event) => {
                          if (object !== undefined && picked !== undefined) {
                            setStateVideoSwitch(object.id, picked, { loop: event.target.checked });
                          }
                        }}
                      />
                      循环
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        data-testid="magnifier-video-audio"
                        checked={video?.audio ?? false}
                        onChange={(event) => {
                          if (object !== undefined && picked !== undefined) {
                            setStateVideoSwitch(object.id, picked, { audio: event.target.checked });
                          }
                        }}
                      />
                      声音
                    </label>
                  </span>
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      data-testid="magnifier-video-pick"
                      className={`${MEDIA_BUTTON_CLASS} ${MEDIA_BUTTON_OFF}`}
                      onClick={() => setPickingVideo(true)}
                    >
                      换视频
                    </button>
                    <button
                      type="button"
                      data-testid="magnifier-video-clear"
                      className={`${MEDIA_BUTTON_CLASS} ${MEDIA_BUTTON_OFF}`}
                      onClick={() => {
                        if (object !== undefined && picked !== undefined) {
                          setStateVideo(object.id, picked, null);
                        }
                      }}
                    >
                      清除视频
                    </button>
                  </span>
                </div>
              ) : (
              <div
                ref={setStageNode}
                className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-[#bc9b60] bg-[#f1e5c6]"
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
                      className="px-3 text-center text-[11px] text-[#a08a63]"
                    >
                      点这里挑一张图
                      <br />
                      （可以只取图集里的一格）
                    </span>
                  ) : (
                    <span
                      data-testid="magnifier-stage"
                      className="block bg-[#f1e5c6]"
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
                    className="absolute right-1 top-1 z-10 rounded border border-[#bc9b60] bg-[#e8d8b4] px-1 text-[12px] leading-none text-[#8a6d3b] after:content-['×'] hover:border-[var(--color-editor-danger)] hover:text-[var(--color-editor-danger)]"
                    onClick={() => {
                      if (object !== undefined) {
                        setStateImage(object.id, picked, null);
                      }
                    }}
                  />
                )}
              </div>
              )}

              {/*
                右边：**这个状态的文字描述**（**开关开着才出现**，v34）。多行纯文本，换行照原样。
                与标题 / 图同款**羊皮纸面**，字是深棕——一眼分得清「图」与「文字」。
              */}
              {showText ? (
              <div className="flex min-h-0 w-[38%] flex-none flex-col rounded-lg border border-[#bc9b60] bg-[#f1e5c6] focus-within:border-[#8c2f1e]">
                <textarea
                  key={`text-${picked}`}
                  data-testid="magnifier-text"
                  defaultValue={state.text ?? ""}
                  placeholder="文字描述（可以没有，可以换行）"
                  title="这一个状态右边那段文字；留空 = 没有文字。失焦时保存"
                  className="min-h-0 flex-1 resize-none rounded-lg bg-transparent p-3 text-[13px] leading-relaxed text-[#4a381f] outline-none placeholder:text-[#a08a63] focus:bg-black/5"
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
              ) : null}
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
                    ? "border-[#8c2f1e] bg-[#e6cfa8]"
                    : "border-[#bc9b60] bg-[#f1e5c6] hover:border-[#8c2f1e]"
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
                      className="flex h-12 w-12 items-center justify-center rounded border border-dashed border-[#bc9b60] text-[11px] text-[#a08a63]"
                    >
                      {index + 1}
                    </span>
                  ) : (
                    <AssetImage image={item.image} className="h-12 w-12 rounded bg-[#f1e5c6]" />
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
                  disabled={structureLocked}
                  aria-label={`移出第 ${index + 1} 个状态`}
                  title={structureLocked ? STRUCTURE_LOCK_HINT : "移出这一个状态（素材文件不会被删）"}
                  className={`flex-none self-stretch px-1 text-[#8a6d3b] after:content-['×'] hover:text-[var(--color-editor-danger)]${structureLockedClass(structureLocked)}`}
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
            disabled={structureLocked}
            title={
              structureLocked
                ? STRUCTURE_LOCK_HINT
                : "加一个空状态（标题 / 图 / 文字都可以之后再填）"
            }
            className={`flex h-[52px] flex-none items-center gap-1 rounded-lg border border-dashed border-[#bc9b60] px-3 text-[11px] leading-none text-[#a08a63] hover:border-[#8c2f1e] hover:text-[#3a2a16]${structureLockedClass(structureLocked)}`}
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

      {/* 选视频（v33）：选中一条 → 填进当前这个状态（会把这一屏的图删掉：媒体二选一） */}
      <ResourcePickerDialog
        kind="video"
        open={pickingVideo}
        onClose={() => setPickingVideo(false)}
        onPick={(id: string) => {
          if (object !== undefined && picked !== undefined) {
            setStateVideo(object.id, picked, id);
          }

          setPickingVideo(false);
        }}
      />
    </MapDialogShell>
  );
}
