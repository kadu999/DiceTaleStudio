import { useState } from "react";

/**
 * 属性面板的行 / 分组外壳。
 *
 * 单独成文件是因为**不止一个属性视图**要用它：对象 / 场景 / 资源 / 项目属性，
 * 以及地图的「网格标注」调色板（`GridAnnotationFields`）。放在谁那里都会让另一边反向依赖。
 */

/**
 * 一组属性：**可折叠的小卡片**（对齐 Unity 组件头 / 参考实现的 `PropertySections`——
 * 箭头 + 点标题收起 / 展开，默认全展开，切换对象时回到展开）。
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
    <section className="mb-3" data-testid="field-group" data-group={group} data-open={open}>
      {/*
        标题整行可点（箭头 + 文字）；箭头 `aria-hidden`，于是无障碍名字就是分组名，
        测试也能直接按名字点：`getByRole("button", { name: "编辑" })`。
      */}
      <button
        type="button"
        data-testid="field-group-header"
        aria-expanded={open}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-editor-text-dim)] hover:bg-[var(--color-editor-panel-alt)]"
        onClick={() => setOpen((previous) => !previous)}
      >
        <span aria-hidden="true" className="w-3 flex-none">
          {open ? "▾" : "▸"}
        </span>
        <span className="truncate">{title}</span>
      </button>

      {/* 收起时**不渲染**内容：只影响看见什么——数据、输入框的值都在 store / 文档里 */}
      {open ? (
        <div
          data-testid="field-group-body"
          className="mt-0.5 overflow-hidden rounded border border-[var(--color-editor-border)]"
        >
          {children}
        </div>
      ) : null}
    </section>
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

/** 属性行：标签 + 任意内容（只读值或输入框共用同一套排布）。 */
export function FieldRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--color-editor-border)] px-2 py-1 last:border-b-0">
      <span className="w-20 flex-none text-[11px] text-[var(--color-editor-text-dim)]">{label}</span>
      {children}
    </div>
  );
}
