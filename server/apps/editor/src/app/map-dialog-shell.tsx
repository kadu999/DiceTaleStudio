import * as Dialog from "@radix-ui/react-dialog";
import type { GameObjectDoc } from "@dts/document";
import { useEditorStore } from "../state/editor-store";
import { useDialogSize } from "./dialog-size";

/**
 * 「地图类编辑窗口」的公共外壳：战争雾 Mask（`FogMaskDialog`）、网格编辑（`GridEditDialog`）、
 * 视频混合 Mask（`VideoBlendMaskDialog`）与放大镜（`MagnifierDialog`）共用。
 *
 * 几扇窗的结构完全同构：Root / Portal / Overlay / Content + 标题 +
 * 「找不到这个对象」兜底（`missing` 可换成各自的说法）+ 底栏（关闭按钮固定，左侧是**插槽**——
 * 网格编辑塞「全部清除」、战争雾塞运行态提示、放大镜塞「在画面上打开 / 关闭画面」）。
 * 画布内部并不同构（像素擦除 vs 格子渲染 vs 一张图），那是各窗口自己的 children。
 *
 * `data-testid` 一律由 `prefix` 派生：`<prefix>-dialog` / `<prefix>-missing` /
 * `<prefix>-close`，测试钉的就是这三枚。
 */

/** 按 id 现查当前场景里的对象（窗口兜底用：它可能已经被删了，删了窗口该关，这里只是不崩）。 */
export function useSceneObject(objectId: string | null): GameObjectDoc | undefined {
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  return objectId === null
    ? undefined
    : scenes
        .find((scene) => scene.name === activeSceneName)
        ?.objects.find((item) => item.id === objectId);
}

interface MapDialogShellProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** testid 前缀：三枚 id 由它派生（见文件头）。 */
  readonly prefix: string;
  readonly title: string;
  /** 目标对象还在不在：false 时主体不渲染，换成「找不到」占位。 */
  readonly found: boolean;
  /** 「找不到」占位里写什么（缺省是地图类窗口的那句话；放大镜这类自己给一句）。 */
  readonly missing?: React.ReactNode;
  /** 底栏左侧的差异化内容（关闭按钮由外壳统一给）。 */
  readonly footer?: React.ReactNode;
  /** 主体：左侧画布区 + 右侧工具栏。 */
  readonly children: React.ReactNode;
}

export function MapDialogShell({
  open,
  onClose,
  prefix,
  title,
  found,
  missing,
  footer,
  children,
}: MapDialogShellProps): React.JSX.Element {
  const dialogSize = useDialogSize();

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid={`${prefix}-dialog`}
          // 尺寸按主窗口比例算（见 `dialog-size.ts`）：写死像素在宽屏上太小，白瞎画布
          style={dialogSize}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">{title}</Dialog.Title>

          {found ? (
            <>
              {children}

              <div className="mt-2 flex flex-none items-center gap-2 text-[10px] text-[var(--color-editor-text-dim)]">
                <div className="flex min-w-0 flex-1 items-center gap-2">{footer}</div>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    data-testid={`${prefix}-close`}
                    className="toolbar-button flex-none hover:toolbar-button-hover"
                  >
                    关闭
                  </button>
                </Dialog.Close>
              </div>
            </>
          ) : (
            <div
              data-testid={`${prefix}-missing`}
              className="flex min-h-0 flex-1 items-center justify-center rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]"
            >
              {missing ?? "找不到这张地图（可能已经被删掉了）"}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
