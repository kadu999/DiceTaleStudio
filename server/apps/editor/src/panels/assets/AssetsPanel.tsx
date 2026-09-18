import { Fragment, useCallback, useEffect, useState } from "react";
import { PROJECT_FOLDERS, PROJECT_SCENE_FILE_EXTENSION } from "@dts/resources";
import type { ResourceTreeNode } from "../../services/project-api";
import { useEditorStore } from "../../state/editor-store";
import { formatSize, assetDisplayName } from "../asset-info";

/**
 * 资源面板（对齐 Unity 的 Project 窗口：**左目录树 + 右内容**）。
 *
 * - **根就是 `Assets`**：项目名不出现在树里；`Assets/` 之外的东西也不显示
 *   （与 Unity 一致——Project 窗口只反映 `Assets/`，别的交给文件管理器）。
 * - **左列**：目录树，只列文件夹；点一行即选中并展开/收起。
 * - **右列**：选中目录的**直属内容**（文件夹在前、文件在后），顶部用路径定位；
 *   点右列的文件夹可以逐级往下走。
 *
 * **只读**：素材由人 / 外部工具**提交到指定目录**（子目录约定见 `@dts/resources`
 * 的 `PROJECT_FOLDERS`），编辑器只负责查看与引用，不写入资源。
 */
export function AssetsPanel(): React.JSX.Element {
  const project = useEditorStore((state) => state.project);
  const refreshTree = useEditorStore((state) => state.refreshTree);
  const selectedAssetId = useEditorStore((state) => state.selectedAssetId);
  const selectAsset = useEditorStore((state) => state.selectAsset);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const openScene = useEditorStore((state) => state.openScene);

  // selectedPath 是「项目内相对路径」，空串表示面板根（= Assets）
  const [selectedPath, setSelectedPath] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set([""]));

  // 切换项目时回到根
  useEffect(() => {
    setSelectedPath("");
    setExpanded(new Set([""]));
  }, [project.current]);

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

  /** 点右列的文件夹：进去（并保证左树展开到它），不折叠。 */
  const enterFolder = useCallback((path: string) => {
    setSelectedPath(path);
    setExpanded((previous) => (previous.has(path) ? previous : new Set(previous).add(path)));
  }, []);

  // 左树点一行：选中 + 展开/收起
  const toggleFolder = useCallback(
    (path: string) => {
      setSelectedPath(path);
      toggle(path);
    },
    [toggle],
  );

  if (project.current === null) {
    return (
      <div className="flex h-full min-h-0 flex-col panel">
        <div className="panel-header">
          <span>资源</span>
        </div>
        <div className="px-2 py-3 text-[11px] leading-relaxed text-[var(--color-editor-text-dim)]">
          还没有打开项目。
          <br />
          用顶部菜单「工程 → 新建项目」创建一个项目，或用「工程 → 打开项目」打开已有的。
        </div>
      </div>
    );
  }

  // 面板根 = 项目的 Assets 目录；找不到（手搓的项目）就退化为项目根，面板不至于空白
  const assetsRoot = project.tree.find(
    (node) => node.type === "folder" && node.name === PROJECT_FOLDERS.assets,
  );
  const rootName = assetsRoot?.name ?? project.current;
  const rootChildren = assetsRoot?.children ?? project.tree;

  // 选中的目录没了（外部删掉了）就退回根，不让右列悬空
  const selected = selectedPath === "" ? undefined : findFolder(project.tree, selectedPath);
  const currentPath = selected?.path ?? "";
  const contents = currentPath === "" ? rootChildren : (selected?.children ?? []);

  return (
    <div className="flex h-full min-h-0 flex-col panel">
      <div className="panel-header">
        <span>资源</span>
        <button
          type="button"
          className="toolbar-button hover:toolbar-button-hover"
          onClick={() => void refreshTree()}
        >
          刷新
        </button>
      </div>

      {project.error.length > 0 ? (
        <div className="flex-none border-b border-[var(--color-editor-border)] px-2 py-1 text-[11px] text-[var(--color-editor-danger)]">
          {project.error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* 左列：目录树（只列文件夹） */}
        <div
          data-testid="folder-tree"
          className="flex w-2/5 min-w-[92px] flex-none flex-col border-r border-[var(--color-editor-border)]"
        >
          <div className="min-h-0 flex-1 overflow-auto py-1 text-[12px]">
            <FolderRow
              path=""
              name={rootName}
              depth={0}
              expanded={expanded.has("")}
              selected={currentPath === ""}
              onSelect={() => toggleFolder("")}
            />
            {expanded.has("") ? (
              <FolderBranch
                nodes={rootChildren}
                depth={1}
                expanded={expanded}
                currentPath={currentPath}
                onSelect={toggleFolder}
              />
            ) : null}
          </div>
        </div>

        {/* 右列：选中目录的直属内容 */}
        <div data-testid="folder-contents" className="flex min-w-0 flex-1 flex-col">
          <div
            data-testid="folder-breadcrumb"
            title={`${PROJECT_FOLDERS.assets}/${assetsRelative(currentPath)}`}
            className="flex-none truncate border-b border-[var(--color-editor-border)] px-2 py-0.5 text-[10px] text-[var(--color-editor-text-dim)]"
          >
            {`/${assetsRelative(currentPath)}`}
          </div>

          <div className="min-h-0 flex-1 overflow-auto py-1 text-[12px]">
            {contents.map((node) => {
              const sceneName = sceneNameOf(node);
              return (
                <ContentRow
                  key={node.path}
                  node={node}
                  // 当前场景的那一行也高亮：目录里一眼看出自己在哪个场景
                  selected={
                    node.id === selectedAssetId ||
                    (sceneName !== undefined && sceneName === activeSceneName)
                  }
                  onEnter={() => enterFolder(node.path)}
                  onSelect={() => {
                    if (sceneName === undefined) {
                      selectAsset(node.id);
                      return;
                    }

                    openScene(sceneName);
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex-none border-t border-[var(--color-editor-border)] px-2 py-0.5 text-[10px] text-[var(--color-editor-text-dim)]">
        {project.busy ? "处理中…" : `${contents.length} 项`}
      </div>
    </div>
  );
}

interface FolderBranchProps {
  readonly nodes: readonly ResourceTreeNode[];
  readonly depth: number;
  readonly expanded: ReadonlySet<string>;
  readonly currentPath: string;
  readonly onSelect: (path: string) => void;
}

/** 递归渲染文件夹（文件不进左树）。 */
function FolderBranch({
  nodes,
  depth,
  expanded,
  currentPath,
  onSelect,
}: FolderBranchProps): React.JSX.Element {
  return (
    <>
      {nodes
        .filter((node) => node.type === "folder")
        .map((node) => (
          <Fragment key={node.path}>
            <FolderRow
              path={node.path}
              name={node.name}
              depth={depth}
              expanded={expanded.has(node.path)}
              selected={currentPath === node.path}
              onSelect={() => onSelect(node.path)}
            />
            {expanded.has(node.path) ? (
              <FolderBranch
                nodes={node.children ?? []}
                depth={depth + 1}
                expanded={expanded}
                currentPath={currentPath}
                onSelect={onSelect}
              />
            ) : null}
          </Fragment>
        ))}
    </>
  );
}

interface FolderRowProps {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly expanded: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

function FolderRow({
  path,
  name,
  depth,
  expanded,
  selected,
  onSelect,
}: FolderRowProps): React.JSX.Element {
  return (
    <div
      data-testid="folder-tree-row"
      data-path={path}
      data-selected={selected}
      className={`flex items-center gap-1 rounded px-1 py-0.5 ${
        selected
          ? "bg-[var(--color-editor-accent-dim)] text-white"
          : "hover:bg-[var(--color-editor-panel-alt)]"
      }`}
      style={{ paddingLeft: `${4 + depth * 12}px` }}
    >
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left" onClick={onSelect}>
        <span className="w-3 flex-none text-[10px] text-[var(--color-editor-text-dim)]">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="truncate">{name}</span>
      </button>
    </div>
  );
}

interface ContentRowProps {
  readonly node: ResourceTreeNode;
  readonly selected: boolean;
  readonly onEnter: () => void;
  readonly onSelect: () => void;
}

/** 右列的一行：文件夹点进去，**文件点选中**（属性面板会显示它的属性）。 */
function ContentRow({ node, selected, onEnter, onSelect }: ContentRowProps): React.JSX.Element {
  const isFolder = node.type === "folder";

  return (
    <div
      data-testid="folder-content-row"
      data-path={node.path}
      data-type={node.type}
      data-selected={selected}
      className={`flex items-center gap-1 rounded px-1 py-0.5 ${
        selected
          ? "bg-[var(--color-editor-accent-dim)] text-white"
          : "hover:bg-[var(--color-editor-panel-alt)]"
      }`}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left"
        onClick={isFolder ? onEnter : onSelect}
      >
        <span className="w-3 flex-none text-[10px] text-[var(--color-editor-text-dim)]">
          {isFolder ? "▸" : ""}
        </span>
        <span className="truncate">{isFolder ? node.name : assetDisplayName(node.name)}</span>
        {!isFolder && node.size !== undefined ? (
          <span className="ml-auto flex-none pl-2 text-[10px] text-[var(--color-editor-text-dim)]">
            {formatSize(node.size)}
          </span>
        ) : null}
      </button>
    </div>
  );
}

/** 按路径找目录节点（找不到返回 undefined）。 */
function findFolder(
  nodes: readonly ResourceTreeNode[],
  path: string,
): ResourceTreeNode | undefined {
  for (const node of nodes) {
    if (node.type !== "folder") {
      continue;
    }

    if (node.path === path) {
      return node;
    }

    const found = findFolder(node.children ?? [], path);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

/** 相对 `Assets/` 的路径：树里面板根就是 Assets，所以路径指示从它开始算。 */
function assetsRelative(path: string): string {
  const prefix = `${PROJECT_FOLDERS.assets}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * 是 `Assets/scenes/<场景名>.json` 的话返回场景名。
 *
 * 场景文件不是「看看属性的素材」，而是**可打开的东西**：点一下就应该切到那个场景
 * （对齐 Unity：Project 窗口里双击场景就打开它）。
 */
function sceneNameOf(node: ResourceTreeNode): string | undefined {
  if (node.type !== "file") {
    return undefined;
  }

  const prefix = `${PROJECT_FOLDERS.scenes}/`;
  if (!node.path.startsWith(prefix) || !node.path.endsWith(PROJECT_SCENE_FILE_EXTENSION)) {
    return undefined;
  }

  return node.path.slice(prefix.length, node.path.length - PROJECT_SCENE_FILE_EXTENSION.length);
}
