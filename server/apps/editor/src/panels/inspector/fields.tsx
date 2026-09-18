/**
 * 属性面板的行 / 分组外壳。
 *
 * 单独成文件是因为**不止一个属性视图**要用它：对象 / 场景 / 资源 / 项目属性，
 * 以及地图的「网格标注」调色板（`GridAnnotationFields`）。放在谁那里都会让另一边反向依赖。
 */

/** 一组属性（带标题的小卡片）。 */
export function FieldGroup({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="mb-3">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-editor-text-dim)]">{title}</div>
      <div className="overflow-hidden rounded border border-[var(--color-editor-border)]">{children}</div>
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
