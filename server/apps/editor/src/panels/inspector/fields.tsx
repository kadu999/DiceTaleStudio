import { useState } from "react";

/**
 * 属性面板的行 / 分组外壳。
 *
 * 单独成文件是因为**不止一个属性视图**要用它：对象 / 场景 / 资源 / 项目属性，
 * 以及地图的「网格标注」调色板（`GridAnnotationFields`）。放在谁那里都会让另一边反向依赖。
 */

/**
 * 一组属性：**带表头的可折叠卡片**（对齐 Unity 组件头 / 参考实现的 `PropertySections`——
 * 箭头 + 点整条标题收起 / 展开，默认全展开，切换对象时回到展开）。
 *
 * 三处是刻意这么定的（看相问题都在这里）：
 * - 表头是一条**始终有底色**的「条」（`panel-alt`，与 `panel-header` 同族），不是一行小字：
 *   「能不能点、点开还是收起」得一眼看得出来；
 * - 箭头是**内联 SVG**（16px、粗描边、展开时旋转 90°），不用 `▾` / `▸` 字形——
 *   字形只有 10px 左右，在 13px 正文里几乎看不清；
 * - 组内**不放行分隔线**（`FieldRow` 没有边框）：靠表头条与卡片外框分组就够了，
 *   每行再画一条线会把属性面板变成一张表格。
 */
export function FieldGroup({
  title,
  group,
  defaultOpen = true,
  children,
}: {
  readonly title: string;
  /** 分组标识（英文 slug）：写到 `data-group` 上供测试与调试定位；中文标题只负责显示 */
  readonly group?: string;
  readonly defaultOpen?: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section
      className="mb-3 overflow-hidden rounded border border-[var(--color-editor-border)]"
      data-testid="field-group"
      data-group={group}
      data-open={open}
    >
      {/*
        标题整条可点（箭头 + 文字）；箭头 `aria-hidden`，于是无障碍名字就是分组名，
        测试也能直接按名字点：`getByRole("button", { name: "区域" })`。
      */}
      <button
        type="button"
        data-testid="field-group-header"
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1.5 bg-[var(--color-editor-bar)] px-2 py-1 text-left text-[11px] font-semibold text-[var(--color-editor-text)] hover:bg-[var(--color-editor-bar-hover)]"
        onClick={() => setOpen((previous) => !previous)}
      >
        <ChevronIcon open={open} />
        <span className="truncate">{title}</span>
      </button>

      {/* 收起时**不渲染**内容：只影响看见什么——数据、输入框的值都在 store / 文档里 */}
      {open ? (
        <div
          data-testid="field-group-body"
          className="border-t border-[var(--color-editor-border)]"
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}

/**
 * 折叠箭头：内联 SVG，**展开朝下、收起朝右**（旋转 90°，带过渡）。
 *
 * 不用 `▾` / `▸` 字形：那两个字符在多数字体里只有 8-10px，调大字号又会把行高顶起来；
 * SVG 想多大就多大、描边够粗，也不依赖字体。
 */
function ChevronIcon({ open }: { readonly open: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-4 w-4 flex-none text-[var(--color-editor-text-dim)] transition-transform duration-150 ${
        open ? "rotate-90" : ""
      }`}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** 只读的一行属性（标签 + 文本值）。 */
export function Field({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}): React.JSX.Element {
  return (
    <FieldRow label={label}>
      <span className={`min-w-0 flex-1 truncate ${mono ? "font-mono text-[11px]" : ""}`}>{value}</span>
    </FieldRow>
  );
}

/**
 * 属性行：标签 + 任意内容（只读值或输入框共用同一套排布）。
 *
 * **没有行分隔线**：标签定宽（`w-20`）左对齐、控件撑满剩下的宽度，靠这两条对齐就够了。
 * 标签必须是本行的**第一个子元素**——e2e 的几何用例按 `xpath=../../../span[1]` 取它。
 */
export function FieldRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <span className="w-20 flex-none text-[11px] text-[var(--color-editor-text-dim)]">{label}</span>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------
   播放类按钮：**「声音」与「视频」两个播放组共用同一套**
   （播放 / 暂停 · 继续 / 停止 + 下面那行状态）。

   为什么单独抽出来：
   1. **统一**：两组是同一件事（后台记账 + 尽力下发，编辑器自己不出声 / 不放画面），
      长得不一样只会让人以为是两套用法——类名放在一处，改一次两边一起变；
   2. **好点**：这几个键是跑团现场真的在按的（平板上尤其），所以比面板里其它小按钮
      大一圈：高度 34px、字 13px、左右内距宽一些、键与键之间留 8px。
      其它按钮暂不跟着放大（要放大的是「手在点的这几个」）。
   ------------------------------------------------------------------ */

const PLAYBACK_BUTTON_BASE =
  "inline-flex flex-none items-center justify-center gap-1 rounded border px-3 text-[13px] min-h-[34px]";

/** 常态（次级操作：没在播时的「播放」「停止」）。 */
export const PLAYBACK_BUTTON_CLASS = `${PLAYBACK_BUTTON_BASE} border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel-alt)] disabled:opacity-40 disabled:hover:bg-transparent`;

/** 高亮（当前状态的那一个：「播放中」/「已暂停」）。 */
export const PLAYBACK_BUTTON_ACTIVE_CLASS = `${PLAYBACK_BUTTON_BASE} border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white hover:bg-[var(--color-editor-panel-alt)] disabled:opacity-40`;

/**
 * 播放那一行：**三个键铺满整行**（不占左边那 80px 的标签列）。
 *
 * 为什么不用 `FieldRow`：这几个键比面板里其它控件大一圈，再让出标签列的话，
 * 窄面板（抽屉收窄、平板竖屏）上「播放 / 暂停 / 停止」会折成两行——一排三个键才是
 * 现场要的手感。行名由按钮自己（「▶ 播放」）与下面那行状态（「正在播放：…」）说清楚。
 */
export function PlaybackRow({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 px-2 py-1" data-testid="playback-row">
      {children}
    </div>
  );
}

/** 状态行的四种状态（`busy` = 本层被别的对象占着，只有按层级管的声音才有这一档）。 */
export type PlaybackState = "playing" | "paused" | "idle" | "busy";

/**
 * 播放状态那一行（自己占一行，与上面几个键左对齐）。
 *
 * 这行字是「点下去到底有没有生效」的答案，所以两组用**同一套措辞**：
 * 正在播放 / 已暂停 / 没在播放（+ 声音那组多一档「本层正被「X」占着」）。
 */
export function PlaybackStatus({
  testId,
  state,
  note,
}: {
  readonly testId: string;
  readonly state: PlaybackState;
  readonly note: string;
}): React.JSX.Element {
  return (
    <FieldRow label="">
      <span
        data-testid={testId}
        data-state={state}
        title={note}
        className={`min-w-0 flex-1 truncate text-[11px] ${
          state === "idle" || state === "busy"
            ? "text-[var(--color-editor-text-dim)]"
            : "text-[var(--color-editor-accent)]"
        }`}
      >
        {note}
      </span>
    </FieldRow>
  );
}
