import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { nextObjectName, type SceneObjectDoc } from "@dts/document";
import { kindMarkerColor } from "@dts/renderer";
import { useEditorStore } from "../state/editor-store";
import {
  DEFAULT_CATEGORY,
  OBJECT_CATEGORIES,
  creatableObjects,
  type ObjectCategoryDef,
  type ObjectTypeDef,
} from "../panels/object-kinds";

/**
 * 「新建对象」弹框：**先选种类（实体 / 动作 / 事件），再选该种类下的对象**，然后创建。
 *
 * 对象生成在场景正中，之后在画布上拖动定位。类型色点与画布上标记点的颜色同源，
 * 选了哪种一眼能对上。
 */

interface ObjectDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function ObjectDialog({ open, onClose }: ObjectDialogProps): React.JSX.Element {
  const createObject = useEditorStore((state) => state.createObject);

  const [category, setCategory] = useState<ObjectCategoryDef>(DEFAULT_CATEGORY);
  // **按类型（`ObjectTypeDef`）选，不按 kind**：实体下「精灵」与「贴图」是两个类型，
  // 用 kind 当选中态会让两个瓦片一起亮
  const [selected, setSelected] = useState<ObjectTypeDef | null>(
    creatableObjects(DEFAULT_CATEGORY)[0] ?? null,
  );
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  /** 该种类下现在能创建的对象类型。 */
  const options = creatableObjects(category);

  /** 当前场景里的对象（名字预填要拿它避开重名）。 */
  const sceneObjects = (): readonly SceneObjectDoc[] => {
    const state = useEditorStore.getState();
    return state.scenes.find((scene) => scene.name === state.activeSceneName)?.objects ?? [];
  };

  /** 选中某个类型：预填名按**它自己的展示名**（精灵 → 「精灵 2」、贴图 → 「贴图 2」）。 */
  const chooseObject = (type: ObjectTypeDef): void => {
    setSelected(type);
    setName(nextObjectName(sceneObjects(), type.label));
    setError("");
  };

  // 每次打开都重置回默认种类
  useEffect(() => {
    if (!open) {
      return;
    }

    const first = creatableObjects(DEFAULT_CATEGORY)[0];
    setCategory(DEFAULT_CATEGORY);
    setSelected(first ?? null);
    setName(first === undefined ? "" : nextObjectName(sceneObjects(), first.label));
    setError("");
  }, [open]);

  const chooseCategory = (next: ObjectCategoryDef): void => {
    const first = creatableObjects(next)[0];
    setCategory(next);
    setSelected(first ?? null);
    setName(first === undefined ? "" : nextObjectName(sceneObjects(), first.label));
    setError("");
  };

  const submit = async (): Promise<void> => {
    if (selected === null) {
      return;
    }

    const reason = await createObject(selected.kind, name);
    if (reason === undefined) {
      onClose();
    } else {
      setError(reason);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid="object-dialog"
          // 固定大小：切换种类时弹框不跳动（内容区自己滚动）。
          // 瓦片尺寸**跟着弹框宽度走**：内容区分 5 列 + `aspect-square`，所以瓦片 ≈ 弹框宽度的
          // 1/5（正方形），不用手写像素——改弹框宽度，瓦片等比缩放。
          className="fixed left-1/2 top-1/2 z-50 flex h-[560px] w-[680px] max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-[var(--color-editor-border)] bg-[var(--color-editor-panel)] p-3 shadow-2xl"
        >
          <Dialog.Title className="mb-2 flex-none text-[13px] font-semibold">新建对象</Dialog.Title>

          {/* 一级：种类 */}
          <div className="flex flex-none items-center gap-1" data-testid="object-category-list">
            {OBJECT_CATEGORIES.map((item) => (
              <button
                key={item.id}
                type="button"
                data-testid={`object-category-${item.id}`}
                data-selected={item.id === category.id}
                aria-pressed={item.id === category.id}
                className={`flex-1 rounded border px-2 py-1 text-[12px] ${
                  item.id === category.id
                    ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                    : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel-alt)]"
                }`}
                onClick={() => chooseCategory(item)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* 二级：该种类下**能创建**的对象类型，**固定大小的正方形瓦片**，多了就在这块区域里滚 */}
          <div className="mt-2 min-h-0 flex-1 overflow-auto" data-testid="object-type-list">
            {options.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded border border-dashed border-[var(--color-editor-border)] text-[11px] text-[var(--color-editor-text-dim)]">
                「{category.label}」下还没有可创建的对象
              </div>
            ) : (
              <div className="grid grid-cols-5 gap-2">
                {options.map((type) => (
                  <button
                    key={type.id}
                    type="button"
                    data-testid={`object-type-${type.id}`}
                    data-selected={type.id === selected?.id}
                    aria-pressed={type.id === selected?.id}
                    className={`flex aspect-square flex-col items-center justify-center gap-1.5 rounded border px-1 text-[11px] ${
                      type.id === selected?.id
                        ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                        : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel-alt)]"
                    }`}
                    onClick={() => chooseObject(type)}
                  >
                    <span
                      className="h-7 w-7 flex-none rounded-full"
                      style={{ background: kindMarkerColor(type.kind) }}
                    />
                    <span className="text-center leading-tight">{type.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <label
            className="mt-3 block flex-none text-[11px] text-[var(--color-editor-text-dim)]"
            htmlFor="object-name"
          >
            名称
          </label>
          <input
            id="object-name"
            data-testid="object-name-input"
            autoFocus
            value={name}
            disabled={selected === null}
            className="mt-1 w-full flex-none rounded border border-[var(--color-editor-border)] bg-black/30 px-2 py-1 text-[12px] outline-none disabled:opacity-40"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void submit();
              }
            }}
          />

          {error.length > 0 ? (
            <div className="mt-2 flex-none text-[11px] text-[var(--color-editor-danger)]">
              {error}
            </div>
          ) : null}

          <div className="mt-3 flex flex-none items-center justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="object-dialog-cancel"
                className="toolbar-button hover:toolbar-button-hover"
              >
                取消
              </button>
            </Dialog.Close>
            <button
              type="button"
              data-testid="confirm-object"
              disabled={selected === null}
              className="rounded bg-[var(--color-editor-accent)] px-3 py-1 text-[12px] text-black disabled:opacity-40"
              onClick={() => void submit()}
            >
              创建
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
