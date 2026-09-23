import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { PROJECT_SCENE_FILE_EXTENSION, projectAssetId, validateProjectName } from "@dts/resources";
import type { ResourceTreeNode } from "../services/project-api";
import { useEditorStore } from "../state/editor-store";

export function AssetRenameDialog({
  asset,
  onClose,
  onRenamed,
}: {
  readonly asset: ResourceTreeNode | null;
  readonly onClose: () => void;
  readonly onRenamed: (node: ResourceTreeNode, id: string, path: string) => void;
}): React.JSX.Element {
  const renameResource = useEditorStore((state) => state.renameResource);
  const renameScene = useEditorStore((state) => state.renameScene);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const isScene = asset?.type === "file" && isScenePath(asset.path);
  const fileExtension = asset?.type === "file" ? extensionOf(asset.name) : "";
  const extension = isScene ? "" : fileExtension;

  useEffect(() => {
    if (asset === null) {
      return;
    }

    setName(isScene ? asset.name.slice(0, -PROJECT_SCENE_FILE_EXTENSION.length) : stripExtension(asset.name, extension));
    setError("");
  }, [asset?.id, asset?.name, extension, isScene]);

  const submit = async (): Promise<void> => {
    if (asset === null || busy) {
      return;
    }

    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("请输入新名称");
      return;
    }

    if (!isScene) {
      const nameError = validateProjectName(trimmed);
      if (nameError !== undefined) {
        setError(nameError);
        return;
      }
    }

    const separator = asset.path.lastIndexOf("/");
    const parent = separator < 0 ? "" : asset.path.slice(0, separator + 1);
    const nextName = `${trimmed}${fileExtension}`;
    const nextPath = `${parent}${nextName}`;
    if (nextPath === asset.path) {
      onClose();
      return;
    }

    setBusy(true);
    const reason = isScene
      ? await renameScene(trimmed, asset.name.slice(0, -PROJECT_SCENE_FILE_EXTENSION.length))
      : await renameResource(asset.id, projectAssetId(useEditorStore.getState().project.current ?? "", nextPath), asset.path);
    setBusy(false);

    if (reason !== undefined) {
      setError(reason);
      return;
    }

    onRenamed(asset, projectAssetId(useEditorStore.getState().project.current ?? "", nextPath), nextPath);
    onClose();
  };

  return (
    <Dialog.Root open={asset !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid="asset-rename-dialog"
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 -translate-y-1/2 rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 text-[13px] font-semibold">重命名资源</Dialog.Title>
          <label className="mb-1 block text-[11px] text-[var(--color-editor-text-dim)]" htmlFor="asset-rename-name">
            {asset?.type === "folder" ? "文件夹名称" : "文件名称"}
          </label>
          <div className="flex min-w-0 items-center gap-1">
            <input
              id="asset-rename-name"
              data-testid="asset-rename-input"
              autoFocus
              value={name}
              className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-2 py-1 text-[12px] outline-none"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
            {extension.length > 0 ? <span className="flex-none text-[12px] text-[var(--color-editor-text-dim)]">{extension}</span> : null}
          </div>
          {error.length > 0 ? <div className="mt-2 text-[11px] text-[var(--color-editor-danger)]">{error}</div> : null}
          <div className="mt-3 flex items-center justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" data-testid="asset-rename-cancel" className="toolbar-button hover:toolbar-button-hover">取消</button>
            </Dialog.Close>
            <button
              type="button"
              data-testid="asset-rename-confirm"
              disabled={busy}
              className="rounded bg-[var(--color-editor-accent)] px-3 py-1 text-[12px] text-black disabled:opacity-50"
              onClick={() => void submit()}
            >
              {busy ? "处理中…" : "重命名"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function isScenePath(path: string): boolean {
  return path.startsWith("Assets/scenes/") && path.endsWith(PROJECT_SCENE_FILE_EXTENSION);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

function stripExtension(name: string, extension: string): string {
  return extension.length > 0 ? name.slice(0, -extension.length) : name;
}
