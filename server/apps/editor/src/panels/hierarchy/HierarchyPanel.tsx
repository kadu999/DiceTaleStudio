import { useState } from "react";
import type { ObjectKind } from "@dts/document";
import { useEditorStore } from "../../state/editor-store";

const KIND_LABELS: Record<ObjectKind, string> = {
  Map: "地图",
  SceneObject: "场景物体",
  Player: "玩家",
  Item: "道具",
  Event: "事件",
};

/** 展示顺序：地图对象排在最前（它是场景的背景层）。 */
const KIND_ORDER: readonly ObjectKind[] = ["Map", "SceneObject", "Item", "Event", "Player"];

/** 可从面板直接新建的对象类型（地图对象走「添加地图」，它要带网格数据）。 */
const CREATE_KINDS: readonly ObjectKind[] = ["SceneObject", "Item", "Event", "Player"];

/**
 * 对象容器：当前场景内的全部对象（**地图也只是其中之一**）。
 *
 * 对象挂在场景上，因此这里不需要地图就能新建对象。
 */
export function HierarchyPanel(): React.JSX.Element {
  const doc = useEditorStore((state) => state.doc);
  const activeSceneId = useEditorStore((state) => state.activeMapId);
  const selection = useEditorStore((state) => state.selectedObjectIds);
  const setSelection = useEditorStore((state) => state.setSelection);
  const createObject = useEditorStore((state) => state.createObject);
  const addMapObject = useEditorStore((state) => state.addMapObject);

  const [creatingKind, setCreatingKind] = useState<ObjectKind | null>(null);
  const [draftName, setDraftName] = useState("");

  const activeScene = doc.scenes.find((scene) => scene.id === activeSceneId);

  const submit = (): void => {
    if (creatingKind === null) {
      return;
    }

    const name = draftName.trim();
    if (name.length === 0) {
      setCreatingKind(null);
      return;
    }

    if (createObject(creatingKind, name)) {
      setDraftName("");
      setCreatingKind(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col panel border-r">
      <div className="panel-header">
        <span>对象容器</span>
        <span className="text-[10px]">{activeScene?.name ?? "无场景"}</span>
      </div>

      <div className="flex flex-none items-center gap-1 border-b border-[var(--color-editor-border)] px-1 py-1">
        <button
          type="button"
          data-testid="new-object"
          disabled={activeScene === undefined}
          className="toolbar-button hover:toolbar-button-hover disabled:opacity-40"
          onClick={() => {
            setDraftName("");
            setCreatingKind("SceneObject");
          }}
        >
          新建对象
        </button>
        <button
          type="button"
          data-testid="add-map"
          disabled={activeScene === undefined}
          className="toolbar-button hover:toolbar-button-hover disabled:opacity-40"
          onClick={() => addMapObject()}
        >
          添加地图
        </button>
      </div>

      {creatingKind !== null ? (
        <div className="flex flex-none items-center gap-1 border-b border-[var(--color-editor-border)] px-1 py-1">
          <select
            value={creatingKind}
            data-testid="object-kind"
            className="rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 text-[11px] outline-none"
            onChange={(event) => setCreatingKind(event.target.value as ObjectKind)}
          >
            {CREATE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
          {/* biome-ignore lint/a11y/noAutofocus: 新建对象时立刻输入名称是主要路径 */}
          <input
            autoFocus
            value={draftName}
            placeholder="对象名"
            data-testid="object-name-input"
            className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1.5 py-0.5 text-[11px] outline-none"
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                submit();
              } else if (event.key === "Escape") {
                setCreatingKind(null);
              }
            }}
          />
          <button
            type="button"
            data-testid="confirm-object"
            className="toolbar-button hover:toolbar-button-hover"
            onClick={submit}
          >
            确定
          </button>
          <button
            type="button"
            className="toolbar-button hover:toolbar-button-hover"
            onClick={() => setCreatingKind(null)}
          >
            取消
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-1 text-[12px]" data-testid="object-tree">
        {activeScene === undefined ? (
          <EmptyState text="还没有场景。到「场景」页签新建一个场景——对象都挂在场景上。" />
        ) : (
          <>
            <Group label="出生点" count={activeScene.spawnPoints.length}>
              {activeScene.spawnPoints.map((spawn) => (
                <Row key={spawn.id} label={spawn.name} hint={spawn.id} />
              ))}
            </Group>

            {activeScene.objects.length === 0 ? (
              <EmptyState text="场景里还没有对象。点上面的「新建对象」即可——地图只是对象之一，不建地图也能放对象。" />
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
  return (
    <div className="px-2 py-3 text-[11px] leading-relaxed text-[var(--color-editor-text-dim)]">
      {text}
    </div>
  );
}
