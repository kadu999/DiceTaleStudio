import { useEffect, useRef } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { objectImage, supportsSpriteSheet } from "@dts/document";
import { useCompactLayout } from "../hooks/useMediaQuery";
import { useEditorStore } from "../state/editor-store";
import { LeftPanel } from "../panels/LeftPanel";
import { InspectorPanel } from "../panels/inspector/InspectorPanel";
import { RuntimePanel } from "../panels/runtime/RuntimePanel";
import { ScenePanel } from "../panels/scene/ScenePanel";
import { FogMaskDialog } from "./FogMaskDialog";
import { GridEditDialog } from "./GridEditDialog";
import { ImagePickerDialog } from "./ImagePickerDialog";
import { SoundEditDialog } from "./SoundEditDialog";
import { TeleportEditDialog } from "./TeleportEditDialog";
import { VideoEditDialog } from "./VideoEditDialog";
import { AudioTagEditorDialog } from "./AudioTagEditorDialog";
import { BgmDialog } from "./BgmDialog";
import { GlobalSettingsDialog } from "./GlobalSettingsDialog";
import { MenuBar } from "./MenuBar";
import { StatusBar } from "./StatusBar";
import { currentImageAssetId } from "../panels/asset-picker";

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
  const imagePicker = useEditorStore((state) => state.imagePicker);
  const imagePickerTarget = useEditorStore((state) => state.imagePickerTarget);
  const assetMetas = useEditorStore((state) => state.assetMetas);
  const openImagePicker = useEditorStore((state) => state.openImagePicker);
  const soundEditor = useEditorStore((state) => state.soundEditor);
  const soundEditorTarget = useEditorStore((state) => state.soundEditorTarget);
  const openSoundEditor = useEditorStore((state) => state.openSoundEditor);
  const teleportEditor = useEditorStore((state) => state.teleportEditor);
  const teleportEditorTarget = useEditorStore((state) => state.teleportEditorTarget);
  const openTeleportEditor = useEditorStore((state) => state.openTeleportEditor);
  const videoEditor = useEditorStore((state) => state.videoEditor);
  const videoEditorTarget = useEditorStore((state) => state.videoEditorTarget);
  const openVideoEditor = useEditorStore((state) => state.openVideoEditor);
  const fogMask = useEditorStore((state) => state.fogMask);
  const fogMaskTarget = useEditorStore((state) => state.fogMaskTarget);
  const openFogMask = useEditorStore((state) => state.openFogMask);
  const gridEditor = useEditorStore((state) => state.gridEditor);
  const gridEditorTarget = useEditorStore((state) => state.gridEditorTarget);
  const openGridEditor = useEditorStore((state) => state.openGridEditor);
  const setObjectImageSprite = useEditorStore((state) => state.setObjectImageSprite);
  const setTool = useEditorStore((state) => state.setTool);
  const cancelObjectTransform = useEditorStore((state) => state.cancelObjectTransform);
  const openSceneByIndex = useEditorStore((state) => state.openSceneByIndex);
  const openAdjacentScene = useEditorStore((state) => state.openAdjacentScene);

  /**
   * 弹框要换图片的那个对象（对象可能已被删掉，所以现查一次）。
   *
   * **只在图片选择器开着时才订阅场景**：拖手柄时文档每帧都在变，若这里订阅了 `scenes`，
   * 每帧都会重渲染整个外壳（菜单栏 + 三栏 + 状态栏）。关着时返回恒定的 `undefined`，
   * `Object.is` 一比就跳过。
   */
  const pickerTarget = useEditorStore((state) =>
    state.imagePicker && state.imagePickerTarget !== null
      ? state.scenes
          .find((scene) => scene.name === state.activeSceneName)
          ?.objects.find((object) => object.id === state.imagePickerTarget)
      : undefined,
  );

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

      // 变换工具：Q / W / E / R（W / E / R 与 Unity 同一套键位；Q 是「拖动」= 默认状态）。
      // 放在 `typing` 之后：输入框里敲 w 不该切工具
      if (event.key === "q" || event.key === "w" || event.key === "e" || event.key === "r") {
        event.preventDefault();
        setTool(
          event.key === "q"
            ? "none"
            : event.key === "w"
              ? "move"
              : event.key === "e"
                ? "rotate"
                : "scale",
        );
        return;
      }

      // 拖手柄拖到一半按 Esc = 放弃这次变换（回到按下前的样子）
      if (event.key === "Escape") {
        cancelObjectTransform();
        return;
      }

      // 切场景：`1`-`9` 直选切换条上的第 N 格，`[` / `]` 上一场 / 下一场。
      // 这是 DM 跑团时最常用的两个动作，值得一个**裸键**（和 Q/W/E/R 同一套约定：
      // 输入框里打字时上面那道 `typing` 已经放行，不会误触）。
      // 不用 Ctrl+数字：那是浏览器留给标签页的，网页拦不住。
      if (event.key >= "1" && event.key <= "9") {
        event.preventDefault();
        openSceneByIndex(Number(event.key) - 1);
        return;
      }

      if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        openAdjacentScene(event.key === "[" ? -1 : 1);
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
  }, [deleteObjects, duplicateObjects, openObjectDialog, redo, saveSceneNow, undo, setTool, cancelObjectTransform, openSceneByIndex, openAdjacentScene]);

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

      {/* 从项目已有图片中选择整张贴图 */}
      <ImagePickerDialog
        open={imagePicker && pickerTarget !== undefined}
        currentId={
          pickerTarget === undefined || objectImage(pickerTarget) === undefined
            ? undefined
            : currentImageAssetId(objectImage(pickerTarget)!, assetMetas)
        }
        currentSprite={pickerTarget === undefined ? undefined : objectImage(pickerTarget)?.sprite}
        allowSprite={pickerTarget !== undefined && supportsSpriteSheet(pickerTarget)}
        onClose={() => openImagePicker(null)}
        onPick={(image, sprite) => {
          if (imagePickerTarget !== null) {
            const meta = useEditorStore.getState().ensureAssetMeta(image.id);
            setObjectImageSprite(imagePickerTarget, { ...image, guid: meta.guid }, sprite);
          }

          openImagePicker(null);
        }}
      />

      {/* 编辑声音：看得到路径、挑一条、给每个音频起名字（属性面板只显示选中的名字） */}
      <SoundEditDialog
        open={soundEditor && soundEditorTarget !== null}
        objectId={soundEditorTarget}
        onClose={() => openSoundEditor(null)}
      />

      {/* 传送目标：把项目里的场景勾成这个传送阵的候选（选哪个在属性面板上点小方块） */}
      <TeleportEditDialog
        open={teleportEditor && teleportEditorTarget !== null}
        objectId={teleportEditorTarget}
        onClose={() => openTeleportEditor(null)}
      />

      {/* 编辑视频：地图 / 贴图的视频列表（放哪条在属性面板上点小方块选） */}
      <VideoEditDialog
        open={videoEditor && videoEditorTarget !== null}
        objectId={videoEditorTarget}
        onClose={() => openVideoEditor(null)}
      />

      {/* 背景音乐（v16 起）：项目音频清单 + 点一首就播 / 暂停 · 继续 / 停止（顶栏「音乐」唤出） */}
      <BgmDialog />

      {/* 标签（v18 起）：标签表本身——tag 是整数，这里给每个值起名字 / 删除 */}
      <AudioTagEditorDialog />

      {/* 全局设置（项目级）：三档音量（背景音乐的清单不在这里） */}
      <GlobalSettingsDialog />

      {/* 战争雾 Mask 窗口：在贴图上按雾区涂 / 擦（目标地图由属性面板指定） */}
      <FogMaskDialog
        open={fogMask && fogMaskTarget !== null}
        objectId={fogMaskTarget}
        onClose={() => openFogMask(null)}
      />

      {/* 网格编辑窗口：同一套窗户，画笔换成 8 个区域 + 橡皮（不用在地图上对准格子） */}
      <GridEditDialog
        open={gridEditor && gridEditorTarget !== null}
        objectId={gridEditorTarget}
        onClose={() => openGridEditor(null)}
      />
    </div>
  );
}

interface DrawerProps {
  readonly side: "left" | "right";
  readonly title: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}

/**
 * 平板下的滑出抽屉（覆盖式，不挤压场景）。
 *
 * 外层这一圈是**绝对定位的整屏层**，但只有面板本身（`w-[min(88vw,340px)]`，靠左/靠右）
 * 看得见、也接指针：`pointer-events-none` + 面板 `pointer-events-auto`。
 * 少了这一对，整屏那层会把画布**全部**吃掉——抽屉开着时点画布没反应、也拖不动地图。
 */
function Drawer({ side, title, onClose, children }: DrawerProps): React.JSX.Element {
  return (
    <div
      className="pointer-events-none absolute inset-y-0 z-20 flex"
      style={side === "left" ? { left: 0 } : { right: 0 }}
    >
      <div
        className="pointer-events-auto flex h-full w-[min(88vw,340px)] flex-col bg-[var(--color-editor-panel)] shadow-2xl"
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
