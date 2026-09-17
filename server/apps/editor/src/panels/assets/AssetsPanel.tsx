import { useCallback, useEffect, useRef, useState } from "react";
import type { ResourceTreeNode } from "../../services/campaign-api";
import { useEditorStore } from "../../state/editor-store";

/**
 * 项目资源面板（类似 Unity 的 Project / Assets 窗口）。
 *
 * 显示**当前跑团文件夹**的内容，支持：新建文件夹、导入资源、删除资源。
 * 目录结构完全来自后端扫描的真实目录，不做任何硬编码。
 */
export function AssetsPanel(): React.JSX.Element {
  const campaign = useEditorStore((state) => state.campaign);
  const refreshTree = useEditorStore((state) => state.refreshTree);
  const createFolder = useEditorStore((state) => state.createFolder);
  const uploadFiles = useEditorStore((state) => state.uploadFiles);
  const deleteResource = useEditorStore((state) => state.deleteResource);

  const [selectedDir, setSelectedDir] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 切换跑团时重置选择与展开状态
  useEffect(() => {
    setSelectedDir("");
    setExpanded(new Set());
    setNewFolder(null);
  }, [campaign.current]);

  const toggle = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }

      return next;
    });
  }, []);

  const submitNewFolder = useCallback(async () => {
    const name = newFolder?.trim() ?? "";
    if (name.length === 0) {
      setNewFolder(null);
      return;
    }

    const path = selectedDir.length > 0 ? `${selectedDir}/${name}` : name;
    const ok = await createFolder(path);
    if (ok) {
      setNewFolder(null);
    }
  }, [createFolder, newFolder, selectedDir]);

  if (campaign.current === null) {
    return (
      <div className="flex h-full min-h-0 flex-col panel">
        <div className="panel-header">
          <span>项目资源</span>
        </div>
        <div className="px-2 py-3 text-[11px] leading-relaxed text-[var(--color-editor-text-dim)]">
          还没有打开跑团。
          <br />
          用顶部菜单「工程 → 新建项目」创建一个跑团，或用「工程 → 打开项目」打开已有的。
        </div>
      </div>
    );
  }

  const rows = flatten(campaign.tree, expanded);

  return (
    <div className="flex h-full min-h-0 flex-col panel">
      <div className="panel-header">
        <span className="truncate" title={campaign.current}>
          项目资源 · {campaign.current}
        </span>
        <button
          type="button"
          className="toolbar-button hover:toolbar-button-hover"
          onClick={() => void refreshTree()}
        >
          刷新
        </button>
      </div>

      <div className="flex flex-none items-center gap-1 border-b border-[var(--color-editor-border)] px-1 py-1">
        <button
          type="button"
          className="toolbar-button hover:toolbar-button-hover"
          onClick={() => setNewFolder("")}
        >
          新建文件夹
        </button>
        <button
          type="button"
          className="toolbar-button hover:toolbar-button-hover"
          onClick={() => fileInputRef.current?.click()}
        >
          导入资源
        </button>
        <span className="ml-auto truncate text-[10px] text-[var(--color-editor-text-dim)]">
          {selectedDir.length > 0 ? `导入到 ${selectedDir}/` : "导入到跑团根目录"}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="asset-file-input"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void uploadFiles(selectedDir, files);
          }}
        />
      </div>

      {newFolder !== null ? (
        <div className="flex flex-none items-center gap-1 border-b border-[var(--color-editor-border)] px-1 py-1">
          <input
            autoFocus
            value={newFolder}
            placeholder="新文件夹名"
            data-testid="new-folder-input"
            className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1.5 py-0.5 text-[11px] outline-none"
            onChange={(event) => setNewFolder(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void submitNewFolder();
              } else if (event.key === "Escape") {
                setNewFolder(null);
              }
            }}
          />
          <button
            type="button"
            className="toolbar-button hover:toolbar-button-hover"
            data-testid="confirm-new-folder"
            onClick={() => void submitNewFolder()}
          >
            确定
          </button>
          <button
            type="button"
            className="toolbar-button hover:toolbar-button-hover"
            onClick={() => setNewFolder(null)}
          >
            取消
          </button>
        </div>
      ) : null}

      {campaign.error.length > 0 ? (
        <div className="flex-none border-b border-[var(--color-editor-border)] px-2 py-1 text-[11px] text-[var(--color-editor-danger)]">
          {campaign.error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto py-1 text-[12px]" data-testid="asset-tree">
        {rows.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-[var(--color-editor-text-dim)]">
            跑团目录是空的。
          </div>
        ) : (
          rows.map((row) => (
            <AssetRow
              key={row.node.id}
              node={row.node}
              depth={row.depth}
              expanded={expanded.has(row.node.path)}
              selected={selectedDir === row.node.path}
              onToggle={() => toggle(row.node.path)}
              onSelect={() => setSelectedDir(row.node.path)}
              onDelete={() => {
                void deleteResource(row.node.id, row.node.name);
              }}
            />
          ))
        )}
      </div>

      <div className="flex-none border-t border-[var(--color-editor-border)] px-2 py-0.5 text-[10px] text-[var(--color-editor-text-dim)]">
        {campaign.busy ? "处理中…" : `${rows.length} 项`}
      </div>
    </div>
  );
}

interface AssetRowProps {
  readonly node: ResourceTreeNode;
  readonly depth: number;
  readonly expanded: boolean;
  readonly selected: boolean;
  readonly onToggle: () => void;
  readonly onSelect: () => void;
  readonly onDelete: () => void;
}

function AssetRow({
  node,
  depth,
  expanded,
  selected,
  onToggle,
  onSelect,
  onDelete,
}: AssetRowProps): React.JSX.Element {
  const isFolder = node.type === "folder";

  return (
    <div
      data-testid="asset-row"
      data-path={node.path}
      className={`group flex items-center gap-1 rounded px-1 py-0.5 ${
        selected ? "bg-[var(--color-editor-accent-dim)] text-white" : "hover:bg-[var(--color-editor-panel-alt)]"
      }`}
      style={{ paddingLeft: `${4 + depth * 12}px` }}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left"
        onClick={() => {
          if (isFolder) {
            onSelect();
            onToggle();
          }
        }}
      >
        <span className="w-3 flex-none text-[10px] text-[var(--color-editor-text-dim)]">
          {isFolder ? (expanded ? "▾" : "▸") : ""}
        </span>
        <span className="truncate">{node.name}</span>
        {!isFolder && node.size !== undefined ? (
          <span className="flex-none text-[10px] text-[var(--color-editor-text-dim)]">
            {formatSize(node.size)}
          </span>
        ) : null}
      </button>

      <button
        type="button"
        title={`删除 ${node.name}`}
        aria-label={`删除 ${node.name}`}
        className="toolbar-button flex-none opacity-0 hover:toolbar-button-hover group-hover:opacity-100"
        onClick={onDelete}
      >
        删除
      </button>
    </div>
  );
}

function flatten(
  nodes: readonly ResourceTreeNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
): Array<{ node: ResourceTreeNode; depth: number }> {
  const rows: Array<{ node: ResourceTreeNode; depth: number }> = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.type === "folder" && expanded.has(node.path)) {
      rows.push(...flatten(node.children ?? [], expanded, depth + 1));
    }
  }

  return rows;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
