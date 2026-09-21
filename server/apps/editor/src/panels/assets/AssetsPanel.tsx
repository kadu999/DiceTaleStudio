import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PROJECT_FOLDERS, PROJECT_SCENE_FILE_EXTENSION } from "@dts/resources";
import type { ResourceTreeNode } from "../../services/project-api";
import { useEditorStore } from "../../state/editor-store";
import { assetDisplayName, assetIconKind, formatSize } from "../asset-info";
import { AssetChevron, AssetFileIcon, FolderIcon } from "./AssetIcon";

/**
 * 资源面板（对齐 Unity 的 Project 窗口：**左目录树 + 右内容**）。
 *
 * - **根就是 `Assets`**：项目名不出现在树里；`Assets/` 之外的东西也不显示
 *   （与 Unity 一致——Project 窗口只反映 `Assets/`，别的交给文件管理器）。
 * - **左列**：目录树，只列文件夹；点行名 = 进这一层并展开/收起它，点行首的小三角**只**开关它。
 * - **右列**：选中目录的**直属内容**（文件夹在前、文件在后），顶部用路径定位；
 *   点右列的文件夹可以逐级往下走。
 * - **打开目录**打开的是**当前所在的目录**（选中文件时是它所在的目录），不再是永远项目根。
 *
 * **只读**：素材由人 / 外部工具**提交到指定目录**（子目录约定见 `@dts/resources`
 * 的 `PROJECT_FOLDERS`），编辑器只负责查看与引用，不写入资源。
 *
 * 行渲染的账要算清：左树拍成**一维数组**交给 React（增删就是一次 keyed list diff），
 * 行的回调按路径记忆、右列的行整体 `memo`。展开集合与它的派生结果都走 `useMemo` /
 * `useCallback`，所以一次点击不会把整棵已展开的子树重建一遍——目录深了以后这就是
 * 「点一下卡一下」的来源。
 */
export function AssetsPanel(): React.JSX.Element {
  const project = useEditorStore((state) => state.project);
  const refreshTree = useEditorStore((state) => state.refreshTree);
  const openProjectFolder = useEditorStore((state) => state.openProjectFolder);
  const selectedAssetId = useEditorStore((state) => state.selectedAssetId);
  const selectAsset = useEditorStore((state) => state.selectAsset);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const openScene = useEditorStore((state) => state.openScene);

  // selectedPath 是「项目内相对路径」，空串表示面板根（= Assets）
  const [selectedPath, setSelectedPath] = useState("");

  /**
   * 展开的文件夹（面板内的相对路径，空串 = 面板根）。用**数组**而不是 `Set`：
   * 数组是不可变的纯数据，切换时直接换一份新的。
   *
   * 真源是 `expandedRef`（**不给 state 传函数**）：React 在事件里会对函数式更新做急切求值，
   * 必要时再算第二次，而这个 updater 每次都返回新数组，两次结果会互相抵消/串状态
   * （表现出来就是「点了没反应、或收了又自己弹回来」）。这里由 ref 现算一份确定的数组、
   * 只把**结果**交给 state，行为就完全可预期。
   */
  const [expanded, setExpanded] = useState<readonly string[]>([""]);
  const expandedRef = useRef<readonly string[]>(expanded);

  const commitExpanded = useCallback((next: readonly string[]) => {
    expandedRef.current = next;
    setExpanded(next);
  }, []);

  /** 展开 / 收起一个文件夹。 */
  const toggle = useCallback(
    (path: string) => {
      const previous = expandedRef.current;
      commitExpanded(
        previous.includes(path)
          ? previous.filter((item) => item !== path)
          : [...previous, path],
      );
    },
    [commitExpanded],
  );

  /** 批量展开（进目录 / 自动定位把祖先补上）；已经都在里面就什么都不做，不触发重渲染。 */
  const expand = useCallback(
    (paths: readonly string[]) => {
      const previous = expandedRef.current;
      const missing = paths.filter((path) => !previous.includes(path));
      if (missing.length > 0) {
        commitExpanded([...previous, ...missing]);
      }
    },
    [commitExpanded],
  );

  // 切换项目时回到根。
  // 依赖**只有项目名**（一个字符串）：`project` 对象在选资源 / 刷新树时都会换新引用，
  // 依赖整个对象会让「选中一个文件」把整棵树收回去——那正是「点一下面板就跳」的来源。
  useEffect(() => {
    setSelectedPath("");
    commitExpanded([""]);
  }, [project.current, commitExpanded]);

  /**
   * 进目录（右列点文件夹）：选中它并保证左树展开到它，**不折叠**。
   *
   * 与左树点行名不同：右列点文件夹是「往里走一步」，把已经在看的目录收起来没有意义。
   */
  const enterFolder = useCallback(
    (path: string) => {
      setSelectedPath(path);
      expand([path]);
    },
    [expand],
  );

  // 面板根 = 项目的 Assets 目录；找不到（手搓的项目）就退化为项目根，面板不至于空白
  const assetsRoot = project.tree.find(
    (node) => node.type === "folder" && node.name === PROJECT_FOLDERS.assets,
  );
  const rootName = assetsRoot?.name ?? project.current ?? "";
  const rootChildren = assetsRoot?.children ?? project.tree;

  /**
   * 面板根那一行：`Assets/` 本身不出现在项目树里（项目树的口径是「Assets 之下」），
   * 所以这一行是面板自己造出来的 —— path 空串表示面板根，id 借用它的逻辑 ID。
   */
  const rootRow = useMemo<{ node: ResourceTreeNode; depth: number }>(
    () => ({
      node: {
        name: rootName,
        path: "",
        id: assetsRoot?.id ?? "",
        type: "folder",
      },
      depth: 0,
    }),
    [rootName, assetsRoot?.id],
  );
  /**
   * 左树要显示的文件夹行：**拍成一维数组**（面板根 + 已展开的各级子目录）。
   *
   * 为什么不用递归组件拼 JSX：一维数组交给 React 时，展开 / 收起就是一次普通的
   * keyed list diff（该行的子树按 key 增删），没有多层嵌套的条件子树要拆。
   * 目录树最深不过几层，但行数是零碎的前端工作里最容易涨上去的一项。
   */
  const visibleRows = useMemo(
    () => [rootRow, ...folderRows(rootChildren, expanded, 1)],
    [rootRow, rootChildren, expanded],
  );

  // 选中的目录没了（外部删掉了）就退回根，不让右列悬空
  const selected = selectedPath === "" ? undefined : findFolder(project.tree, selectedPath);
  const currentPath = selected?.path ?? "";
  const contents = currentPath === "" ? rootChildren : (selected?.children ?? []);

  /** 每个节点 → 它的直属父目录（空串 = 面板根）。自动定位要高亮、滚动到父目录时用。 */
  const parentOf = useMemo(() => buildParentMap(rootChildren, ""), [rootChildren]);

  /**
   * 在右列选中的那个文件（「打开目录」的目标 / 左树的高亮都用它）。
   *
   * 「选中文件」与「进过的目录」是两条独立的记忆：一次选中**只有一个**会生效，
   * 所以取值时**文件优先**——选中的文件才是人刚刚点的那个东西，而 `currentPath`
   * 可能只是他上一站待过的目录。这一点弄反了，「打开目录」就会开成你浏览的目录而不是
   * 文件所在的目录（这正是它之前不听话的原因）。
   */
  const selectedFile =
    selectedAssetId === null
      ? undefined
      : findNode(project.tree, (node) => node.id === selectedAssetId && node.type === "file");

  /**
   * 当前「所在目录」：选中文件就是它所在的那一层；否则就是进过的那个目录；
   * 都没有就是面板根。左树高亮、右列内容、「打开目录」的目标都用它，三处永远一致。
   */
  const selectedFilePath = selectedFile?.path ?? "";
  const highlightPath =
    selectedFilePath.length > 0
      ? (parentOf.get(selectedFilePath) ?? "")
      : currentPath !== ""
        ? currentPath
        : "";

  // 选中文件 / 进目录之后，把左树滚到「当前所在的目录」。
  // **layout effect**：滚动要在同一次提交完成、DOM 已经就位时做，晚一帧会滚空。
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const scrollTarget = highlightPath;
  const scrollVisible = expanded.includes(highlightPath);
  useLayoutEffect(() => {
    if (scrollTarget === "" || !scrollVisible) {
      return;
    }

    rowRefs.current.get(scrollTarget)?.scrollIntoView({ block: "nearest" });
  }, [scrollTarget, scrollVisible]);

  /**
   * 「当前所在的目录」的**祖先链**（不含它自己）。
   *
   * 它的用处是：从右列点进一个深目录、或选中一个深目录里的文件时，左树跟着展开到那一层
   * ——不用人自己一路点三角点下去。左树里「文件夹行」本身不折叠，所以保证路径可见就够了。
   */
  const targetAncestors = useMemo(() => {
    const ancestors: string[] = [];
    let current = parentOf.get(highlightPath);
    while (current !== undefined && current !== "") {
      ancestors.push(current);
      current = parentOf.get(current);
    }

    return ancestors;
  }, [parentOf, highlightPath]);
  useLayoutEffect(() => {
    expand(targetAncestors);
  }, [targetAncestors, expand]);

  const registerRow = useCallback((path: string, element: HTMLDivElement | null) => {
    if (element === null) {
      rowRefs.current.delete(path);
      return;
    }

    rowRefs.current.set(path, element);
  }, []);

  /**
   * 右列点文件夹：进目录（并展开它）。
   *
   * 回调**按 path 缓存**：每次渲染都新建闭包会让行的 `memo` 全部失效，
   * 一次点击就重渲染整棵已展开的子树——目录深了以后这就是「点一下卡一下」的来源。
   *
   * 两条「当前所在」的记忆在这里分工：进目录 → 写 `selectedPath` 并**清掉文件选中**，
   * 这样「打开目录」开的一定是刚点的这个目录。
   */
  const enterCallbacks = useMemo(() => {
    const cache = new Map<string, () => void>();
    return (path: string): (() => void) => {
      const existing = cache.get(path);
      if (existing !== undefined) {
        return existing;
      }

      const handler = (): void => {
        selectAsset(null);
        enterFolder(path);
      };
      cache.set(path, handler);
      return handler;
    };
  }, [enterFolder, selectAsset]);

  /**
   * 左树点行名：进这一层 + 展开 / 收起它。
   *
   * 与右列点文件夹同一套分工：选中文件夹就**忘掉上一个文件**，
   * 免得「我明明点的是这个文件夹，打开目录却开到别处」。
   */
  const folderCallbacks = useMemo(() => {
    const cache = new Map<string, () => void>();
    return (path: string): (() => void) => {
      const existing = cache.get(path);
      if (existing !== undefined) {
        return existing;
      }

      const handler = (): void => {
        selectAsset(null);
        setSelectedPath(path);
        toggle(path);
      };
      cache.set(path, handler);
      return handler;
    };
  }, [toggle, selectAsset]);

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

  /**
   * 打开目录 = 按**选中的东西**打开：选中的是文件就把这个文件交给后端（打开它所在的目录
   * 并选中它）；选中的是文件夹就打开那个文件夹；什么都没选就打开项目根。
   *
   * 只有一个入口：选中谁就开谁，人不用先想「我该点哪个按钮」。
   */
  const openHere = (): void => {
    void openProjectFolder(selectedFile?.path ?? highlightPath, selectedFile !== undefined);
  };

  return (
    <div className="flex h-full min-h-0 flex-col panel">
      <div className="panel-header">
        <span>资源</span>
        {/* 按钮靠右抱团（标题栏是 space-between，散开摆会变成「中间一个」） */}
        <div className="ml-auto flex flex-none items-center gap-1">
          <button
            type="button"
            data-testid="open-project-folder"
            // 打开的是**服务端那台机器**上的目录：浏览器不能替用户开文件夹，这件事只能后端做
            title={
              selectedFile === undefined
                ? `用文件管理器打开「/${assetsRelative(highlightPath)}」（在运行服务端的那台机器上）`
                : `打开「${selectedFile.name}」所在的目录，并选中这个文件（在运行服务端的那台机器上）`
            }
            className="toolbar-button hover:toolbar-button-hover"
            onClick={openHere}
          >
            打开目录
          </button>
          <button
            type="button"
            className="toolbar-button hover:toolbar-button-hover"
            onClick={() => void refreshTree()}
          >
            刷新
          </button>
        </div>
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
          <div ref={treeScrollRef} className="min-h-0 flex-1 overflow-auto py-1 text-[12px]">
            {visibleRows.map(({ node, depth }, index) => (
              <FolderRow
                key={`${String(index)}:${node.path}`}
                path={node.path}
                name={node.path === "" ? rootName : node.name}
                depth={depth}
                expanded={expanded.includes(node.path)}
                selected={highlightPath === node.path}
                onSelect={folderCallbacks(node.path)}
                onToggle={toggle}
                registerRow={registerRow}
              />
            ))}
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
                  onEnter={enterCallbacks(node.path)}
                  onSelect={selectAsset}
                  onOpenScene={openScene}
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

interface FolderRowProps {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly expanded: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onToggle: (path: string) => void;
  readonly registerRow: (path: string, element: HTMLDivElement | null) => void;
}

const FolderRow = function FolderRow({
  path,
  name,
  depth,
  expanded,
  selected,
  onSelect,
  onToggle,
  registerRow,
}: FolderRowProps): React.JSX.Element {
  const handleToggle = useCallback(() => onToggle(path), [onToggle, path]);
  const setRef = useCallback(
    (element: HTMLDivElement | null) => registerRow(path, element),
    [registerRow, path],
  );

  return (
    <div
      ref={setRef}
      data-testid="folder-tree-row"
      data-path={path}
      data-icon="folder"
      data-selected={selected}
      className={`flex items-center rounded pr-1 ${
        selected
          ? "bg-[var(--color-editor-accent-dim)] text-white"
          : "hover:bg-[var(--color-editor-panel-alt)]"
      }`}
      style={{ paddingLeft: `${2 + depth * 12}px` }}
    >
      {/* 小三角是**独立的按钮**且有自己的命中区（≥18px）：点它只开关，不改变当前目录 */}
      <button
        type="button"
        data-testid="folder-tree-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? `收起 ${name}` : `展开 ${name}`}
        className="asset-row-button flex h-[18px] w-[18px] flex-none items-center justify-center rounded text-[var(--color-editor-text-dim)] hover:bg-[var(--color-editor-panel-alt)] hover:text-[var(--color-editor-text)]"
        onClick={handleToggle}
      >
        <AssetChevron expanded={expanded} />
      </button>
      <button
        type="button"
        data-testid="folder-tree-label"
        className="asset-row-button flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left"
        onClick={onSelect}
      >
        <FolderIcon open={expanded} />
        <span className="truncate">{name}</span>
      </button>
    </div>
  );
};

interface ContentRowProps {
  readonly node: ResourceTreeNode;
  readonly selected: boolean;
  readonly onEnter: () => void;
  readonly onSelect: (id: string) => void;
  readonly onOpenScene: (name: string) => void;
}

/** 右列的一行：文件夹点进去，**文件点选中**（属性面板会显示它的属性），场景文件点是打开场景。 */
const ContentRow = memo(function ContentRow({
  node,
  selected,
  onEnter,
  onSelect,
  onOpenScene,
}: ContentRowProps): React.JSX.Element {
  const isFolder = node.type === "folder";
  const sceneName = sceneNameOf(node);
  const fileKind = assetIconKind(node.name);
  const kind = isFolder ? "folder" : fileKind;
  const handleClick = useCallback(() => {
    if (isFolder) {
      onEnter();
      return;
    }

    // 选中文件**不动右列**：`selectedPath` 是「我正看着哪个目录」，点文件不该把它清掉，
    // 否则右列会跳回上一层（这正是它之前的毛病）。「打开目录」的目标由 `highlightPath`
    // 单独算（文件优先），两条记忆各管各的。
    if (sceneName === undefined) {
      onSelect(node.id);
      return;
    }

    onOpenScene(sceneName);
  }, [isFolder, node.id, sceneName, onEnter, onSelect, onOpenScene]);

  return (
    <div
      data-testid="folder-content-row"
      data-path={node.path}
      data-type={node.type}
      data-icon={kind}
      data-selected={selected}
      className={`flex items-center rounded px-1 ${
        selected
          ? "bg-[var(--color-editor-accent-dim)] text-white"
          : "hover:bg-[var(--color-editor-panel-alt)]"
      }`}
    >
      <button
        type="button"
        data-testid="folder-content-label"
        className="asset-row-button flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left"
        onClick={handleClick}
      >
        {isFolder ? <FolderIcon open={false} /> : <AssetFileIcon kind={fileKind} />}
        <span className="truncate">{isFolder ? node.name : assetDisplayName(node.name)}</span>
        {!isFolder && node.size !== undefined ? (
          <span className="ml-auto flex-none pl-2 text-[10px] text-[var(--color-editor-text-dim)]">
            {formatSize(node.size)}
          </span>
        ) : null}
      </button>
    </div>
  );
});

/**
 * 某个目录的**直属**文件夹行（不含面板根），并按「父目录是否展开」往下列；文件不进左树。
 *
 * **纯函数、每层返回新数组**：不借用外部累加器，所以任何一次调用都不会碰到上一次的结果
 * ——这个面板踩过一回共享可变累加器的坑（上一轮的行会跟着 `useMemo` 的缓存串到下一轮）。
 *
 * 面板根的行由面板自己拼（`Assets/` 不在项目树里），它下面这一层只要根是展开的就都在。
 */
function folderRows(
  nodes: readonly ResourceTreeNode[],
  expanded: readonly string[],
  depth: number,
): { node: ResourceTreeNode; depth: number }[] {
  const rows: { node: ResourceTreeNode; depth: number }[] = [];
  for (const node of nodes) {
    if (node.type !== "folder") {
      continue;
    }

    rows.push({ node, depth });
    if (expanded.includes(node.path)) {
      rows.push(...folderRows(node.children ?? [], expanded, depth + 1));
    }
  }

  return rows;
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

/** 在资源树里按条件找节点（自动定位选中文件时用）。 */
function findNode(
  nodes: readonly ResourceTreeNode[],
  match: (node: ResourceTreeNode) => boolean,
): ResourceTreeNode | undefined {
  for (const node of nodes) {
    if (match(node)) {
      return node;
    }

    const found = findNode(node.children ?? [], match);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

/** 每个节点 → 直属父目录（空串 = 面板根）。一次遍历建好，之后定位都是 O(1)。 */
function buildParentMap(  nodes: readonly ResourceTreeNode[],
  parent: string,
  map: Map<string, string> = new Map(),
): Map<string, string> {
  for (const node of nodes) {
    map.set(node.path, parent);
    if (node.children !== undefined) {
      buildParentMap(node.children, node.path, map);
    }
  }

  return map;
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
