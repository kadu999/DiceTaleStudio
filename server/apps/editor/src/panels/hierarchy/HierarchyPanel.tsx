import type { ObjectKind } from "@dts/document";
import { useEditorStore } from "../../state/editor-store";
import { EmptyState } from "../EmptyState";

const KIND_LABELS: Record<ObjectKind, string> = {
  Map: "地图",
  SceneObject: "场景物体",
  Player: "玩家",
  Item: "道具",
  Event: "事件",
};

/** 展示顺序：地图对象排在最前（它是场景的背景层）。 */
const KIND_ORDER: readonly ObjectKind[] = ["Map", "SceneObject", "Item", "Event", "Player"];

/**
 * 场景对象：当前场景内的全部对象（**地图也只是其中之一**），只读列出。
 *
 * 增删改**不在编辑器里做**（与资源面板一致：内容由外部提交，编辑器先只负责查看）。
 */
export function HierarchyPanel(): React.JSX.Element {
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const selection = useEditorStore((state) => state.selectedObjectIds);
  const setSelection = useEditorStore((state) => state.setSelection);

  const activeScene = scenes.find((scene) => scene.name === activeSceneName);

  return (
    <div className="flex h-full min-h-0 flex-col panel border-r">
      <div className="panel-header">
        <span>场景对象</span>
        <span className="text-[10px]">{activeScene?.name ?? "无场景"}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-1 text-[12px]" data-testid="object-tree">
        {activeScene === undefined ? (
          <EmptyState />
        ) : (
          KIND_ORDER.map((kind) => {
            const objects = activeScene.objects.filter((object) => object.kind === kind);
            if (objects.length === 0) {
              return null;
            }

            return (
              <Group key={kind} label={KIND_LABELS[kind]} count={objects.length}>
                {objects.map((object) => (
                  <button
                    key={object.id}
                    type="button"
                    data-testid="object-row"
                    data-name={object.name}
                    onClick={() => setSelection([object.id])}
                    className={`flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left ${
                      selection.includes(object.id)
                        ? "bg-[var(--color-editor-accent-dim)] text-white"
                        : "hover:bg-[var(--color-editor-panel-alt)]"
                    }`}
                  >
                    <span className="truncate">{object.name}</span>
                    <span className="text-[10px] text-[var(--color-editor-text-dim)]">
                      {object.kind === "Map"
                        ? `${object.map?.grid.width ?? 0}×${object.map?.grid.height ?? 0}`
                        : `${object.components.length} 组件`}
                    </span>
                  </button>
                ))}
              </Group>
            );
          })
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
