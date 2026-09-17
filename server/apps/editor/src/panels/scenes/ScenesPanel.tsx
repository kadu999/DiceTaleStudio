import { useState } from "react";
import { useEditorStore } from "../../state/editor-store";

/**
 * 场景列表面板。
 *
 * 场景 = 跑团里的一张地图/关卡（对齐前端 `MapManager.LoadMap` 加载的 map）。
 * 这里负责：列出场景、新建、删除、重命名、切换当前编辑的场景。
 */
export function ScenesPanel(): React.JSX.Element {
  const doc = useEditorStore((state) => state.doc);
  const activeMapId = useEditorStore((state) => state.activeMapId);
  const campaignName = useEditorStore((state) => state.campaign.current);
  const switchScene = useEditorStore((state) => state.switchScene);
  const createScene = useEditorStore((state) => state.createScene);
  const deleteScene = useEditorStore((state) => state.deleteScene);
  const renameScene = useEditorStore((state) => state.renameScene);

  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const submitCreate = (): void => {
    const name = draftName.trim();
    if (name.length === 0) {
      setCreating(false);
      return;
    }

    if (createScene(name)) {
      setDraftName("");
      setCreating(false);
    }
  };

  const submitRename = (sceneId: string): void => {
    const name = draftName.trim();
    if (name.length === 0) {
      setRenamingId(null);
      return;
    }

    if (renameScene(sceneId, name)) {
      setDraftName("");
      setRenamingId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col panel">
      <div className="panel-header">
        <span>场景</span>
        <span className="text-[10px]">{doc.scenes.length} 个</span>
      </div>

      <div className="flex flex-none items-center gap-1 border-b border-[var(--color-editor-border)] px-1 py-1">
        <button
          type="button"
          data-testid="new-scene"
          className="toolbar-button hover:toolbar-button-hover"
          onClick={() => {
            setDraftName("");
            setRenamingId(null);
            setCreating(true);
          }}
        >
          新建场景
        </button>
        <span className="ml-auto text-[10px] text-[var(--color-editor-text-dim)]">
          {campaignName === null ? "未打开跑团" : "点击切换当前场景"}
        </span>
      </div>

      {creating || renamingId !== null ? (
        <div className="flex flex-none items-center gap-1 border-b border-[var(--color-editor-border)] px-1 py-1">
          <input
            autoFocus
            value={draftName}
            placeholder="场景名，例如 Map001"
            data-testid="scene-name-input"
            className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1.5 py-0.5 text-[11px] outline-none"
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                if (renamingId !== null) {
                  submitRename(renamingId);
                } else {
                  submitCreate();
                }
              } else if (event.key === "Escape") {
                setCreating(false);
                setRenamingId(null);
              }
            }}
          />
          <button
            type="button"
            data-testid="confirm-scene"
            className="toolbar-button hover:toolbar-button-hover"
            onClick={() => {
              if (renamingId !== null) {
                submitRename(renamingId);
              } else {
                submitCreate();
              }
            }}
          >
            确定
          </button>
          <button
            type="button"
            className="toolbar-button hover:toolbar-button-hover"
            onClick={() => {
              setCreating(false);
              setRenamingId(null);
            }}
          >
            取消
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto py-1 text-[12px]" data-testid="scene-list">
        {doc.scenes.length === 0 ? (
          <div className="px-2 py-3 text-[11px] leading-relaxed text-[var(--color-editor-text-dim)]">
            {campaignName === null
              ? "还没有打开跑团。先用「工程 → 新建项目 / 打开项目」。"
              : "这个跑团还没有场景。点上面的「新建场景」创建第一个。"}
          </div>
        ) : (
          doc.scenes.map((scene) => {
            const active = scene.id === activeMapId;
            return (
              <div
                key={scene.id}
                data-testid="scene-row"
                data-name={scene.name}
                data-active={active}
                className={`group flex items-center gap-1 rounded px-1 py-1 ${
                  active ? "bg-[var(--color-editor-accent-dim)] text-white" : "hover:bg-[var(--color-editor-panel-alt)]"
                }`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => switchScene(scene.id)}
                >
                  <span className="truncate">{scene.name}</span>
                  <span className="ml-2 text-[10px] text-[var(--color-editor-text-dim)]">
                    {scene.objects.length} 对象
                    {scene.objects.some((object) => object.kind === "Map") ? " · 有地图" : ""}
                  </span>
                </button>

                <button
                  type="button"
                  className="toolbar-button flex-none opacity-0 hover:toolbar-button-hover group-hover:opacity-100"
                  data-testid="rename-scene"
                  onClick={() => {
                    setCreating(false);
                    setDraftName(scene.name);
                    setRenamingId(scene.id);
                  }}
                >
                  重命名
                </button>
                <button
                  type="button"
                  aria-label={`删除场景 ${scene.name}`}
                  className="toolbar-button flex-none opacity-0 hover:toolbar-button-hover group-hover:opacity-100"
                  onClick={() => {
                    if (confirm(`确定删除场景「${scene.name}」？该场景的网格与对象会一并删除。`)) {
                      deleteScene(scene.id);
                    }
                  }}
                >
                  删除
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="flex-none border-t border-[var(--color-editor-border)] px-2 py-0.5 text-[10px] text-[var(--color-editor-text-dim)]">
        当前：{doc.scenes.find((scene) => scene.id === activeMapId)?.name ?? "—"}
      </div>
    </div>
  );
}
