import { useEditorStore } from "../../state/editor-store";
import type { ObjectKind } from "@dts/document";

const KIND_LABELS: Record<ObjectKind, string> = {
  SceneObject: "场景物体",
  Player: "玩家",
  Item: "道具",
  Event: "事件",
};

const KIND_ORDER: readonly ObjectKind[] = ["SceneObject", "Item", "Event", "Player"];

/** 左侧对象容器：地图 → 出生点 / 分类对象 → 对象。 */
export function HierarchyPanel(): React.JSX.Element {
  const doc = useEditorStore((state) => state.doc);
  const activeMapId = useEditorStore((state) => state.activeMapId);
  const setActiveMap = useEditorStore((state) => state.setActiveMap);
  const selection = useEditorStore((state) => state.selectedObjectIds);
  const setSelection = useEditorStore((state) => state.setSelection);

  const activeMap = doc.maps.find((map) => map.id === activeMapId);

  return (
    <div className="flex h-full min-h-0 flex-col panel border-r">
      <div className="panel-header">
        <span>对象容器</span>
        <span className="text-[10px]">{activeMap?.name ?? "无地图"}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-1 text-[12px]">
        {doc.maps.length === 0 ? (
          <EmptyState text="还没有地图。创建地图后会在这里按分类列出对象。" />
        ) : (
          <>
            <div className="mb-1">
              {doc.maps.map((map) => (
                <button
                  key={map.id}
                  type="button"
                  onClick={() => setActiveMap(map.id)}
                  className={`flex w-full items-center gap-1 rounded px-1.5 py-1 text-left ${
                    map.id === activeMapId
                      ? "bg-[var(--color-editor-accent-dim)] text-white"
                      : "hover:bg-[var(--color-editor-panel-alt)]"
                  }`}
                >
                  <span className="text-[10px] text-[var(--color-editor-text-dim)]">地图</span>
                  <span>{map.name}</span>
                </button>
              ))}
            </div>

            {activeMap !== undefined ? (
              <>
                <Group label="出生点" count={activeMap.spawnPoints.length}>
                  {activeMap.spawnPoints.map((spawn) => (
                    <Row key={spawn.id} label={spawn.name} hint={spawn.id} />
                  ))}
                </Group>

                {KIND_ORDER.map((kind) => {
                  const objects = activeMap.objects.filter((object) => object.kind === kind);
                  if (objects.length === 0) {
                    return null;
                  }

                  return (
                    <Group key={kind} label={KIND_LABELS[kind]} count={objects.length}>
                      {objects.map((object) => (
                        <button
                          key={object.id}
                          type="button"
                          onClick={() => setSelection([object.id])}
                          className={`flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left ${
                            selection.includes(object.id)
                              ? "bg-[var(--color-editor-accent-dim)] text-white"
                              : "hover:bg-[var(--color-editor-panel-alt)]"
                          }`}
                        >
                          <span className="truncate">{object.name}</span>
                          <span className="text-[10px] text-[var(--color-editor-text-dim)]">
                            {object.components.length} 组件
                          </span>
                        </button>
                      ))}
                    </Group>
                  );
                })}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function Group({
  label,
  count,
  children,
}: {
  readonly label: string;
  readonly count: number;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-1">
      <div className="flex items-center justify-between px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-editor-text-dim)]">
        <span>{label}</span>
        <span>{count}</span>
      </div>
      <div className="pl-2">{children}</div>
    </div>
  );
}

function Row({ label, hint }: { readonly label: string; readonly hint: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-[var(--color-editor-text-dim)]">
      <span className="truncate">{label}</span>
      <span className="font-mono text-[10px]">{hint}</span>
    </div>
  );
}

function EmptyState({ text }: { readonly text: string }): React.JSX.Element {
  return <div className="px-2 py-3 text-[11px] leading-relaxed text-[var(--color-editor-text-dim)]">{text}</div>;
}
