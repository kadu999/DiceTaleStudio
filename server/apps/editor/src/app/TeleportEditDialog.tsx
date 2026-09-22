import * as Dialog from "@radix-ui/react-dialog";
import { teleportDataOf } from "@dts/document";
import { useEditorStore } from "../state/editor-store";

/**
 * 「传送目标」窗口：把项目里的场景**勾进来 / 取消勾**，成为这个传送阵的候选。
 *
 * 为什么要有窗口（与「编辑声音」同一个理由）：面板上只放得下一排小方块，
 * 而「有哪几张图可以传」是**清单**——场景可能有十几张，塞进面板那一列会变成一片滚动的名字。
 *
 * 所以窗口里**没有「选中」这一套**（选哪个是面板上的事，这里改的是清单本身）。内容就三样：
 * 勾选清单、`已勾 N 个`、`完成`。候选里已经不在项目里的场景（被改名 / 删掉）也照常列出来
 * 并在行尾点明，否则「勾过的东西看不见、也取消不掉」。
 */
export function TeleportEditDialog({
  open,
  objectId,
  onClose,
}: {
  readonly open: boolean;
  readonly objectId: string | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  // 全部场景名（顺序就是切换条那套顺序：装载时按自然序排好）
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const setTeleportTargets = useEditorStore((state) => state.setTeleportTargets);

  const names = scenes.map((scene) => scene.name);
  // 对象可能被删 / 切了场景：现查一次（找不到时窗口写明，与「编辑声音」同一条）
  const object =
    objectId === null
      ? undefined
      : scenes.find((scene) => scene.name === activeSceneName)?.objects.find((item) => item.id === objectId);

  const targets = (object === undefined ? undefined : teleportDataOf(object))?.targets ?? [];
  const stale = targets.filter((name) => !names.includes(name));

  const toggle = (name: string, on: boolean): void => {
    if (object === undefined) {
      return;
    }

    // 清单的顺序 = 勾进来的先后（取消勾再勾会排到末尾）；去空去重由文档命令负责
    const next = on ? [...targets, name] : targets.filter((item) => item !== name);
    setTeleportTargets(object.id, next);
  };

  const rowClass =
    "flex cursor-pointer items-center gap-2 border-b border-[var(--color-editor-border)] px-2 py-1 text-[12px] last:border-b-0 hover:bg-[var(--color-editor-panel-alt)]";

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid="teleport-edit-dialog"
          className="fixed left-1/2 top-1/2 z-50 flex h-[520px] w-[420px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">传送目标</Dialog.Title>

          {object === undefined ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-[11px] text-[var(--color-editor-text-dim)]">
              这个传送阵已经不在了
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto rounded border border-[var(--color-editor-border)]">
              {[...names, ...stale].map((name) => {
                const alive = names.includes(name);
                return (
                  <label
                    key={name}
                    data-testid="teleport-scene-row"
                    data-scene={name}
                    data-checked={targets.includes(name)}
                    className={rowClass}
                  >
                    <input
                      type="checkbox"
                      data-testid="teleport-scene-check"
                      checked={targets.includes(name)}
                      onChange={(event) => toggle(name, event.target.checked)}
                      className="flex-none"
                    />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    {!alive ? (
                      <span className="flex-none text-[10px] text-[var(--color-editor-warn)]">已失效</span>
                    ) : name === activeSceneName ? (
                      <span className="flex-none text-[10px] text-[var(--color-editor-text-dim)]">当前</span>
                    ) : null}
                  </label>
                );
              })}

              {names.length === 0 && stale.length === 0 ? (
                <div className="p-3 text-[11px] text-[var(--color-editor-text-dim)]">这个项目还没有场景</div>
              ) : null}
            </div>
          )}

          <div className="mt-2 flex flex-none items-center justify-between gap-2 text-[11px] text-[var(--color-editor-text-dim)]">
            <span>已勾 {targets.length} 个</span>
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="teleport-edit-close"
                className="toolbar-button hover:toolbar-button-hover"
              >
                完成
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
