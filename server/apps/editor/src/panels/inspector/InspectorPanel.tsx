import { useEditorStore } from "../../state/editor-store";

/** 右侧属性面板：当前选中对象/地图的属性。编辑能力在 M2/M3 接入。 */
export function InspectorPanel(): React.JSX.Element {
  const doc = useEditorStore((state) => state.doc);
  const activeMapId = useEditorStore((state) => state.activeMapId);
  const selection = useEditorStore((state) => state.selectedObjectIds);

  const activeMap = doc.maps.find((map) => map.id === activeMapId);
  const selected =
    activeMap === undefined
      ? undefined
      : activeMap.objects.find((object) => object.id === selection[0]);

  return (
    <div className="flex h-full min-h-0 flex-col panel border-l">
      <div className="panel-header">
        <span>属性</span>
        <span className="text-[10px]">{selected !== undefined ? "对象" : activeMap !== undefined ? "地图" : "空"}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2 text-[12px]">
        {selected !== undefined ? (
          <FieldGroup title="对象">
            <Field label="名称" value={selected.name} />
            <Field label="ID" value={selected.id} mono />
            <Field label="类型" value={selected.kind} />
            <Field
              label="位置"
              value={
                selected.position === null
                  ? "未放置"
                  : `${selected.position.x.toFixed(3)}, ${selected.position.y.toFixed(3)}`
              }
              mono
            />
            <Field label="组件" value={String(selected.components.length)} />
          </FieldGroup>
        ) : activeMap !== undefined ? (
          <FieldGroup title="地图">
            <Field label="名称" value={activeMap.name} />
            <Field label="网格" value={`${activeMap.grid.width} × ${activeMap.grid.height}`} mono />
            <Field label="每格尺寸" value={String(activeMap.grid.cellSize)} mono />
            <Field label="贴图" value={activeMap.image.id} mono />
            <Field label="行序" value={activeMap.rowOrder} mono />
            <Field label="对象" value={String(activeMap.objects.length)} />
          </FieldGroup>
        ) : (
          <div className="px-1 py-3 text-[11px] leading-relaxed text-[var(--color-editor-text-dim)]">
            未选中任何内容。创建地图并选中对象后，这里会显示可编辑的属性与动作。
          </div>
        )}
      </div>
    </div>
  );
}

function FieldGroup({
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

function Field({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--color-editor-border)] px-2 py-1 last:border-b-0">
      <span className="w-20 flex-none text-[11px] text-[var(--color-editor-text-dim)]">{label}</span>
      <span className={`min-w-0 flex-1 truncate ${mono ? "font-mono text-[11px]" : ""}`}>{value}</span>
    </div>
  );
}
