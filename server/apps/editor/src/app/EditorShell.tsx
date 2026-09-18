import { useEffect, useRef } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useCompactLayout } from "../hooks/useMediaQuery";
import { useEditorStore } from "../state/editor-store";
import { LeftPanel } from "../panels/LeftPanel";
import { InspectorPanel } from "../panels/inspector/InspectorPanel";
import { RuntimePanel } from "../panels/runtime/RuntimePanel";
import { ScenePanel } from "../panels/scene/ScenePanel";
import { MenuBar } from "./MenuBar";
import { StatusBar } from "./StatusBar";

/**
 * 编辑器外壳：Unity3D 式四区布局。
 *
 * - 桌面（宽屏 + 精确指针）：顶栏 + 左中右三栏可拖拽分栏 + 底部状态栏。
 * - 平板 / 触控优先：场景铺满，层级与属性改为滑出抽屉，避免在窄屏硬挤三栏。
 */
export function EditorShell(): React.JSX.Element {
  const compact = useCompactLayout();
  const ui = useEditorStore((state) => state.ui);
  const setUi = useEditorStore((state) => state.setUi);
  const bootstrapped = useEditorStore((state) => state.bootstrapped);
  const projectDialog = useEditorStore((state) => state.projectDialog);
  const bootstrapEditor = useEditorStore((state) => state.bootstrapEditor);
  const saveSceneNow = useEditorStore((state) => state.saveSceneNow);
  const duplicateObjects = useEditorStore((state) => state.duplicateObjects);
  const deleteObjects = useEditorStore((state) => state.deleteObjects);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const openObjectDialog = useEditorStore((state) => state.openObjectDialog);

  // 启动引导：自动打开上次的项目 / 一个项目都没有时弹新建 / 有项目但没记录时弹打开列表。
  // store 内部有幂等保护，StrictMode 下重复调用不会弹两次。
  useEffect(() => {
    void bootstrapEditor();
  }, [bootstrapEditor]);

  /**
   * 快捷键。
   *
   * 平板没有键盘，所以每一项都能从菜单/按钮触发；这里只是让桌面顺手：
   * **输入框里打字时不拦截**（除 Ctrl+S），否则 Enter/退格都会被吃掉。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = event.ctrlKey || event.metaKey;
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "SELECT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (modifier && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveSceneNow();
        return;
      }

      if (modifier && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        openObjectDialog(true);
        return;
      }

      if (typing) {
        return;
      }

      if (modifier && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateObjects();
        return;
      }

      if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }

        return;
      }

      if (modifier && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteObjects();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [deleteObjects, duplicateObjects, openObjectDialog, redo, saveSceneNow, undo]);

  // 跨越断点（窗口缩放 / 接上触屏）时重置面板开合，避免平板下三栏互相挤压
  const previousCompact = useRef<boolean | null>(null);
  useEffect(() => {
    if (previousCompact.current === null) {
      previousCompact.current = compact;
      return;
    }

    if (previousCompact.current !== compact) {
      previousCompact.current = compact;
      setUi({ leftOpen: !compact, rightOpen: !compact });
    }
  }, [compact, setUi]);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-bootstrapped={bootstrapped}
      data-project-dialog={projectDialog ?? "none"}
    >
      <MenuBar compact={compact} />

      <div className="relative flex min-h-0 flex-1">
        {compact ? (
          <>
            <div className="min-h-0 flex-1">
              <ScenePanel />
            </div>

            {ui.leftOpen ? (
              <Drawer side="left" title="项目" onClose={() => setUi({ leftOpen: false })}>
                <LeftPanel />
              </Drawer>
            ) : null}

            {ui.rightOpen ? (
              <Drawer side="right" title="属性" onClose={() => setUi({ rightOpen: false })}>
                <InspectorPanel />
              </Drawer>
            ) : null}

            {ui.runtimeOpen ? (
              <Drawer side="right" title="运行态" onClose={() => setUi({ runtimeOpen: false })}>
                <RuntimePanel />
              </Drawer>
            ) : null}
          </>
        ) : (
          <Group orientation="horizontal" className="flex min-h-0 flex-1">
            <Panel defaultSize="18" minSize="12" className="min-h-0">
              <LeftPanel />
            </Panel>

            <Separator className="w-px bg-[var(--color-editor-border)] hover:bg-[var(--color-editor-accent-dim)] active:bg-[var(--color-editor-accent)]" />

            <Panel defaultSize="58" minSize="30" className="min-h-0">
              <div className="flex h-full min-h-0 flex-col">
                <div className="min-h-0 flex-1">
                  <ScenePanel />
                </div>
                {ui.runtimeOpen ? (
                  <div className="h-64 min-h-0 border-t border-[var(--color-editor-border)]">
                    <RuntimePanel />
                  </div>
                ) : null}
              </div>
            </Panel>

            <Separator className="w-px bg-[var(--color-editor-border)] hover:bg-[var(--color-editor-accent-dim)] active:bg-[var(--color-editor-accent)]" />

            <Panel defaultSize="24" minSize="14" className="min-h-0">
              <InspectorPanel />
            </Panel>
          </Group>
        )}
      </div>

      <StatusBar />
    </div>
  );
}

interface DrawerProps {
  readonly side: "left" | "right";
  readonly title: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}

/** 平板下的滑出抽屉（覆盖式，不挤压场景）。 */
function Drawer({ side, title, onClose, children }: DrawerProps): React.JSX.Element {
  return (
    <div className="absolute inset-y-0 z-20 flex" style={side === "left" ? { left: 0 } : { right: 0 }}>
      <div
        className="flex h-full w-[min(88vw,340px)] flex-col bg-[var(--color-editor-panel)] shadow-2xl"
        style={
          side === "left"
            ? { borderRight: "1px solid var(--color-editor-border)" }
            : { borderLeft: "1px solid var(--color-editor-border)" }
        }
      >
        <div className="panel-header">
          <span>{title}</span>
          <button type="button" className="toolbar-button hover:toolbar-button-hover" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
}