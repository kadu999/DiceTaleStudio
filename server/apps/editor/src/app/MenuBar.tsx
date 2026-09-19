import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ProjectDialog } from "./ProjectDialog";
import { SceneDialog } from "./SceneDialog";
import { ObjectDialog } from "./ObjectDialog";
import { useEditorStore } from "../state/editor-store";

/**
 * 顶部菜单栏。
 *
 * 平板没有键盘快捷键，因此**所有命令都必须能从菜单触发**——这里不做「只有快捷键」的命令。
 */

interface MenuBarProps {
  readonly compact: boolean;
}

export function MenuBar({ compact }: MenuBarProps): React.JSX.Element {
  // 对话框模式放在 store 里：启动引导也要能弹出它，不能只由菜单驱动
  const projectDialog = useEditorStore((state) => state.projectDialog);
  const openProjectDialog = useEditorStore((state) => state.openProjectDialog);
  const currentProject = useEditorStore((state) => state.project.current);
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const sceneDialog = useEditorStore((state) => state.sceneDialog);
  const openSceneDialog = useEditorStore((state) => state.openSceneDialog);
  const deleteScene = useEditorStore((state) => state.deleteScene);
  const selection = useEditorStore((state) => state.selectedObjectIds);
  const duplicateObjects = useEditorStore((state) => state.duplicateObjects);
  const deleteObjects = useEditorStore((state) => state.deleteObjects);
  const saveSceneNow = useEditorStore((state) => state.saveSceneNow);
  const saveState = useEditorStore((state) => state.sceneSaveState);
  const objectDialog = useEditorStore((state) => state.objectDialog);
  const openObjectDialog = useEditorStore((state) => state.openObjectDialog);
  const closeProject = useEditorStore((state) => state.closeProject);
  const ui = useEditorStore((state) => state.ui);
  const setUi = useEditorStore((state) => state.setUi);
  const mode = useEditorStore((state) => state.mode);
  const setMode = useEditorStore((state) => state.setMode);
  const canUndo = useEditorStore((state) => state.canUndo);
  const canRedo = useEditorStore((state) => state.canRedo);
  const undoLabel = useEditorStore((state) => state.undoLabel);
  const redoLabel = useEditorStore((state) => state.redoLabel);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const fitToViewport = useEditorStore((state) => state.fitToViewport);

  return (
    // `data-testid` 给测试一个**稳定的作用域**：菜单栏里叫「场景 / 编辑 / 项目」的按钮，
    // 属性面板的分组标题可能同名（两边都合理），按名字找会歧义，按区域找才对
    <header
      data-testid="menu-bar"
      className="flex h-9 flex-none items-center gap-1 border-b border-[var(--color-editor-border)] bg-[var(--color-editor-panel-alt)] px-2"
    >
      <span className="mr-2 text-[12px] font-semibold tracking-wide text-[var(--color-editor-text)]">
        DiceTale<span className="text-[var(--color-editor-accent)]">Studio</span>
      </span>

      <Menu label="工程">
        <MenuItem label="新建项目…" onSelect={() => openProjectDialog("create")} />
        <MenuItem label="打开项目…" onSelect={() => openProjectDialog("open")} />
        <MenuSeparator />
        <MenuItem
          label={currentProject === null ? "关闭当前项目" : `关闭项目（${currentProject}）`}
          disabled={currentProject === null}
          onSelect={closeProject}
        />
      </Menu>

      <Menu label="场景">
        <MenuItem
          label="新建场景…"
          disabled={currentProject === null}
          onSelect={() => openSceneDialog("create")}
        />
        <MenuItem
          label={activeSceneName === null ? "重命名场景…" : `重命名「${activeSceneName}」…`}
          disabled={activeSceneName === null}
          onSelect={() => openSceneDialog("rename")}
        />
        <MenuItem
          label={activeSceneName === null ? "删除场景" : `删除「${activeSceneName}」`}
          disabled={activeSceneName === null || scenes.length <= 1}
          onSelect={() => {
            if (
              activeSceneName !== null &&
              confirm(`确定删除场景「${activeSceneName}」？该操作会删除场景文件，且不可恢复。`)
            ) {
              void deleteScene();
            }
          }}
        />
      </Menu>

      <Menu label="编辑">
        <MenuItem label={canUndo ? `撤销 ${undoLabel}` : "撤销"} disabled={!canUndo} onSelect={undo} />
        <MenuItem label={canRedo ? `重做 ${redoLabel}` : "重做"} disabled={!canRedo} onSelect={redo} />
        <MenuSeparator />
        <MenuItem
          label="新建对象…"
          disabled={activeSceneName === null}
          onSelect={() => openObjectDialog(true)}
        />
        <MenuItem
          label="复制选中对象"
          disabled={selection.length === 0}
          onSelect={() => duplicateObjects()}
        />
        <MenuItem
          label="删除选中对象"
          disabled={selection.length === 0}
          onSelect={() => deleteObjects()}
        />
        <MenuSeparator />
        <MenuItem
          label="保存场景"
          disabled={activeSceneName === null || saveState === "saved"}
          onSelect={() => void saveSceneNow()}
        />
      </Menu>

      <Menu label="视图">
        <MenuItem
          label={ui.leftOpen ? "隐藏场景对象" : "显示场景对象"}
          onSelect={() => setUi({ leftOpen: !ui.leftOpen })}
        />
        <MenuItem
          label={ui.rightOpen ? "隐藏属性面板" : "显示属性面板"}
          onSelect={() => setUi({ rightOpen: !ui.rightOpen })}
        />
        <MenuItem
          label={ui.runtimeOpen ? "隐藏运行态面板" : "显示运行态面板"}
          onSelect={() => setUi({ runtimeOpen: !ui.runtimeOpen })}
        />
        <MenuSeparator />
        <MenuItem label="适配视口" onSelect={fitToViewport} />
      </Menu>

      <Menu label="运行">
        <MenuItem
          label={mode === "edit" ? "进入运行状态" : "退出运行状态"}
          onSelect={() => setMode(mode === "edit" ? "run" : "edit")}
        />
      </Menu>

      <div className="ml-auto flex items-center gap-2">
        {compact ? (
          <>
            <ToolbarToggle active={ui.leftOpen} onClick={() => setUi({ leftOpen: !ui.leftOpen })}>
              项目
            </ToolbarToggle>
            <ToolbarToggle active={ui.rightOpen} onClick={() => setUi({ rightOpen: !ui.rightOpen })}>
              属性
            </ToolbarToggle>
            <ToolbarToggle
              active={ui.runtimeOpen}
              onClick={() => setUi({ runtimeOpen: !ui.runtimeOpen })}
            >
              运行态
            </ToolbarToggle>
          </>
        ) : null}

        <ModeSwitch mode={mode} onChange={setMode} />
        <ClientBadge />
      </div>

      <ProjectDialog mode={projectDialog} onClose={() => openProjectDialog(null)} />
      <SceneDialog mode={sceneDialog} onClose={() => openSceneDialog(null)} />
      <ObjectDialog open={objectDialog} onClose={() => openObjectDialog(false)} />
    </header>
  );
}

function Menu({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="toolbar-button hover:toolbar-button-hover">
          {label}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-50 min-w-[200px] rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-1 shadow-xl"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function MenuItem({
  label,
  onSelect,
  disabled = false,
}: {
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
}): React.JSX.Element {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className="cursor-default rounded px-2 py-1 text-[12px] text-[var(--color-editor-text)] outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-[var(--color-editor-accent-dim)]"
    >
      {label}
    </DropdownMenu.Item>
  );
}

function MenuSeparator(): React.JSX.Element {
  return <DropdownMenu.Separator className="my-1 h-px bg-[var(--color-editor-border)]" />;
}

function ToolbarToggle({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`toolbar-button ${active ? "!bg-[var(--color-editor-accent-dim)]" : "hover:toolbar-button-hover"}`}
    >
      {children}
    </button>
  );
}

/**
 * 「前端连上了没」的徽标：只在对运行态时才出现。
 *
 * 放在模式开关旁边（而不是只在状态栏 / 运行面板里说），是因为「点了运行，前端到底连上没有」
 * 是这个界面此刻最要紧的一件事——连上时绿灯**呼吸**一下，一眼就能看见。
 */
function ClientBadge(): React.JSX.Element | null {
  const mode = useEditorStore((state) => state.mode);
  const runtimeActive = useEditorStore((state) => state.runtime.runtimeActive);
  const client = useEditorStore((state) => state.runtime.client);
  const status = useEditorStore((state) => state.runtime.status);

  if (mode !== "run") {
    return null;
  }

  const connected = client !== null;
  const label = connected
    ? `前端已连接${client === null || client.version === "" ? "" : `（${client.name} v${client.version}）`}`
    : status === "open" && runtimeActive
      ? "等待前端连接"
      : "正在连接服务端…";

  return (
    <span
      data-testid="client-badge"
      data-connected={connected ? "yes" : "no"}
      title={label}
      className="ml-1 flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[10px]"
      style={{
        borderColor: connected ? "var(--color-editor-ok)" : "var(--color-editor-border)",
        color: connected ? "var(--color-editor-ok)" : "var(--color-editor-text-dim)",
      }}
    >
      <span
        className={`inline-block h-2 w-2 rounded-full ${connected ? "animate-pulse" : ""}`}
        style={{ background: connected ? "var(--color-editor-ok)" : "var(--color-editor-warn)" }}
      />
      {connected ? "前端已连接" : "等待前端连接"}
    </span>
  );
}

function ModeSwitch({
  mode,
  onChange,
}: {
  readonly mode: "edit" | "run";
  readonly onChange: (mode: "edit" | "run") => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center overflow-hidden rounded border border-[var(--color-editor-border)]">
      <button
        type="button"
        data-testid="mode-edit"
        onClick={() => onChange("edit")}
        className={`px-2 py-0.5 text-[11px] ${
          mode === "edit"
            ? "bg-[var(--color-editor-accent)] text-black"
            : "text-[var(--color-editor-text-dim)]"
        }`}
      >
        编辑
      </button>
      <button
        type="button"
        data-testid="mode-run"
        onClick={() => onChange("run")}
        className={`px-2 py-0.5 text-[11px] ${
          mode === "run"
            ? "bg-[var(--color-editor-ok)] text-black"
            : "text-[var(--color-editor-text-dim)]"
        }`}
      >
        运行
      </button>
    </div>
  );
}
