import { useState } from "react";
import { DEFAULT_SOUND_LAYER, SOUND_LAYER_LABELS, type SceneObjectDoc } from "@dts/document";
import { useEditorStore } from "../../state/editor-store";
import { EmptyState } from "../EmptyState";
import { KIND_LABELS, OBJECT_CATEGORIES, categoryOfKind } from "../object-kinds";

/** 种类过滤：默认「全部」。 */
const ALL_CATEGORIES = "all";

/**
 * 场景对象：当前场景里的对象，可改名 / 删除 / 复制。
 *
 * **不分组**：顶上是一排**种类按钮**（`全部` + 实体 / 动作 / 事件，与「新建对象」弹框同一套归类），
 * 点一下就只看那个种类；默认「全部」，列表按场景文件里的顺序平铺。名字太多时还有关键字过滤。
 *
 * **创建不在这里**：对象由「新建对象」弹框创建（画布标题栏的按钮、`Ctrl/⌘+Shift+N`、
 * 编辑菜单），生成在场景正中，之后在画布上拖动定位。
 * 编辑只作用于**当前场景**；改动经 store 的 `applyScenes` 进撤销栈，并自动落盘。
 */
export function HierarchyPanel(): React.JSX.Element {
  const scenes = useEditorStore((state) => state.scenes);
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const selection = useEditorStore((state) => state.selectedObjectIds);
  const setSelection = useEditorStore((state) => state.setSelection);
  const renameObject = useEditorStore((state) => state.renameObject);
  const deleteObjects = useEditorStore((state) => state.deleteObjects);
  const duplicateObjects = useEditorStore((state) => state.duplicateObjects);
  const toggleObjectActive = useEditorStore((state) => state.toggleObjectActive);
  const toggleObjectLocked = useEditorStore((state) => state.toggleObjectLocked);
  const saveSceneNow = useEditorStore((state) => state.saveSceneNow);
  const saveState = useEditorStore((state) => state.sceneSaveState);
  const saveError = useEditorStore((state) => state.sceneSaveError);

  const [categoryFilter, setCategoryFilter] = useState<string>(ALL_CATEGORIES);
  const [filter, setFilter] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const activeScene = scenes.find((scene) => scene.name === activeSceneName);
  const objects = activeScene?.objects ?? [];

  const categoryObjects = objects.filter(
    (object) =>
      categoryFilter === ALL_CATEGORIES || categoryOfKind(object.kind)?.id === categoryFilter,
  );
  const keyword = filter.trim().toLowerCase();
  const visible = categoryObjects.filter(
    (object) =>
      keyword.length === 0 ||
      object.name.toLowerCase().includes(keyword) ||
      KIND_LABELS[object.kind].includes(keyword),
  );

  const toggleSelection = (id: string, additive: boolean): void => {
    if (!additive) {
      setSelection([id]);
      return;
    }

    setSelection(
      selection.includes(id) ? selection.filter((item) => item !== id) : [...selection, id],
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col panel border-r">
      <div className="panel-header">
        <span>场景对象</span>
        <span className="truncate text-[10px]" title={activeScene?.name}>
          {activeScene?.name ?? "无场景"}
        </span>
        {activeScene === undefined ? null : (
          <button
            type="button"
            data-testid="save-scene"
            disabled={saveState === "saved" || saveState === "saving"}
            className="toolbar-button ml-auto hover:toolbar-button-hover disabled:opacity-40"
            onClick={() => void saveSceneNow()}
          >
            {saveState === "saving" ? "保存中…" : "保存"}
          </button>
        )}
      </div>

      {activeScene === undefined ? null : (
        <>
          <div className="flex flex-none items-center gap-1 border-b border-[var(--color-editor-border)] px-1 py-1">
            <button
              type="button"
              data-testid="duplicate-object"
              disabled={selection.length === 0}
              className="toolbar-button hover:toolbar-button-hover disabled:opacity-40"
              onClick={() => duplicateObjects()}
            >
              复制
            </button>
            <button
              type="button"
              data-testid="delete-object"
              disabled={selection.length === 0}
              className="toolbar-button hover:toolbar-button-hover disabled:opacity-40"
              onClick={() => deleteObjects()}
            >
              删除
            </button>
            <input
              value={filter}
              data-testid="object-filter"
              placeholder="过滤"
              className="ml-auto min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1.5 py-0.5 text-[11px] outline-none"
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>

          {/* 种类按钮：三个种类一直都在（哪怕现在还没有对象），跟弹框的归类对齐 */}
          <div
            data-testid="category-filter"
            className="flex flex-none flex-wrap gap-1 border-b border-[var(--color-editor-border)] px-1 py-1"
          >
            <CategoryButton
              testId="category-filter-all"
              label="全部"
              selected={categoryFilter === ALL_CATEGORIES}
              onClick={() => setCategoryFilter(ALL_CATEGORIES)}
            />
            {OBJECT_CATEGORIES.map((category) => (
              <CategoryButton
                key={category.id}
                testId={`category-filter-${category.id}`}
                label={category.label}
                selected={categoryFilter === category.id}
                onClick={() => setCategoryFilter(category.id)}
              />
            ))}
          </div>

          {saveError.length > 0 ? (
            <div
              data-testid="scene-save-error"
              className="flex-none border-b border-[var(--color-editor-border)] px-2 py-1 text-[11px] text-[var(--color-editor-danger)]"
            >
              保存失败：{saveError}
            </div>
          ) : null}
        </>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-1 text-[12px]" data-testid="object-tree">
        {activeScene === undefined ? (
          <EmptyState />
        ) : visible.length === 0 ? (
          // 一个对象都没有就什么都不写（一眼能看出来）；有对象但被筛掉了才提示
          objects.length === 0 ? null : (
            <div className="px-2 py-3 text-[11px] text-[var(--color-editor-text-dim)]">
              {categoryObjects.length === 0
                ? `「${OBJECT_CATEGORIES.find((item) => item.id === categoryFilter)?.label ?? ""}」下还没有对象`
                : "没有匹配的对象"}
            </div>
          )
        ) : (
          visible.map((object) => (
            <ObjectRow
              key={object.id}
              object={object}
              selected={selection.includes(object.id)}
              renaming={renamingId === object.id}
              renameDraft={renameDraft}
              onSelect={(additive) => toggleSelection(object.id, additive)}
              onStartRename={() => {
                setRenamingId(object.id);
                setRenameDraft(object.name);
              }}
              onRenameChange={setRenameDraft}
              onCommitRename={() => {
                renameObject(object.id, renameDraft);
                setRenamingId(null);
              }}
              onCancelRename={() => setRenamingId(null)}
              onToggleActive={() => toggleObjectActive(object.id)}
              onToggleLocked={() => toggleObjectLocked(object.id)}
              onDelete={() => deleteObjects([object.id])}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** 种类过滤按钮（一排里的小胶囊）。 */
function CategoryButton({
  testId,
  label,
  selected,
  onClick,
}: {
  readonly testId: string;
  readonly label: string;
  readonly selected: boolean;
  readonly onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      data-selected={selected}
      aria-pressed={selected}
      className={`rounded border px-1.5 py-0.5 text-[11px] ${
        selected
          ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
          : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel-alt)]"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

interface ObjectRowProps {
  readonly object: SceneObjectDoc;
  readonly selected: boolean;
  readonly renaming: boolean;
  readonly renameDraft: string;
  readonly onSelect: (additive: boolean) => void;
  readonly onStartRename: () => void;
  readonly onRenameChange: (value: string) => void;
  readonly onCommitRename: () => void;
  readonly onCancelRename: () => void;
  /** 切换「显示 / 隐藏」（对齐 Unity 行首那只眼睛）。 */
  readonly onToggleActive: () => void;
  /** 切换「锁定 / 解锁」（锁上就拖不动）。 */
  readonly onToggleLocked: () => void;
  readonly onDelete: () => void;
}

function ObjectRow({
  object,
  selected,
  renaming,
  renameDraft,
  onSelect,
  onStartRename,
  onRenameChange,
  onCommitRename,
  onCancelRename,
  onToggleActive,
  onToggleLocked,
  onDelete,
}: ObjectRowProps): React.JSX.Element {
  // 只有地图有值得写在列表里的额外信息（网格尺寸）；其它对象不再显示「0 组件」这类噪声。
  // 声音对象（动作对象）和实体一样摆在世界里，行尾显示它落在**哪一层**——那是这条声音
  // 除了名字之外最该一眼看到的东西。
  // 「未放置」是额外的一枚标记（位置为 null，只可能来自手写文件），所以不能顶掉这些信息
  const hint =
    object.kind === "Map"
      ? `${object.map?.grid.width ?? 0}×${object.map?.grid.height ?? 0}`
      : object.kind === "PlaySound"
        ? SOUND_LAYER_LABELS[object.sound?.layer ?? DEFAULT_SOUND_LAYER]
        : object.kind === "Teleport"
          ? // 传送阵：行尾写它当前会把人送到哪张图（没加 / 没选就明说，别留白）
            (object.teleport?.picked ??
              (object.teleport?.targets.length === 0 ? "未加目标" : "未选目标"))
          : null;

  return (
    <div
      data-testid="object-row"
      data-name={object.name}
      data-kind={object.kind}
      data-selected={selected}
      data-active={object.active}
      className={`group flex items-center gap-1 rounded px-1.5 py-1 ${
        selected
          ? "bg-[var(--color-editor-accent-dim)] text-white"
          : "hover:bg-[var(--color-editor-panel-alt)]"
      }`}
    >
      {/* 激活按钮：每一个对象都有。不激活的行整体变淡——一眼看出画布上为什么不画它 */}
      <button
        type="button"
        data-testid="object-active-toggle"
        data-active={object.active}
        aria-pressed={object.active}
        title={object.active ? `隐藏 ${object.name}` : `显示 ${object.name}`}
        aria-label={object.active ? `隐藏 ${object.name}` : `显示 ${object.name}`}
        className={`flex h-5 w-5 flex-none items-center justify-center rounded text-[11px] leading-none hover:bg-[var(--color-editor-panel-alt)] ${
          object.active ? "" : "opacity-50"
        }`}
        onClick={onToggleActive}
      >
        {object.active ? "👁" : "🚫"}
      </button>

      {/* 锁定按钮：锁上就拖不动了（摆场景时最容易被误拖的正是底图） */}
      <button
        type="button"
        data-testid="object-lock-toggle"
        data-locked={object.locked}
        aria-pressed={object.locked}
        title={object.locked ? `解锁 ${object.name}（现在拖不动）` : `锁定 ${object.name}（不再能被拖动）`}
        aria-label={object.locked ? `解锁 ${object.name}` : `锁定 ${object.name}`}
        className={`flex h-5 w-5 flex-none items-center justify-center rounded text-[11px] leading-none hover:bg-[var(--color-editor-panel-alt)] ${
          object.locked ? "" : "opacity-50"
        }`}
        onClick={onToggleLocked}
      >
        {object.locked ? "🔒" : "🔓"}
      </button>
      {renaming ? (
        <input
          autoFocus
          value={renameDraft}
          data-testid="object-rename-input"
          className="min-w-0 flex-1 rounded border border-[var(--color-editor-border)] bg-black/30 px-1 py-0.5 text-[11px] outline-none"
          onChange={(event) => onRenameChange(event.target.value)}
          onBlur={onCommitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onCommitRename();
            } else if (event.key === "Escape") {
              onCancelRename();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={`flex min-w-0 flex-1 items-center justify-between gap-2 text-left ${
            object.active ? "" : "opacity-50"
          }`}
          onClick={(event) => onSelect(event.ctrlKey || event.metaKey || event.shiftKey)}
          onDoubleClick={onStartRename}
        >
          <span className="truncate">{object.name}</span>
          <span className="flex flex-none items-center gap-1 text-[10px] text-[var(--color-editor-text-dim)]">
            {object.position === null ? <span>未放置</span> : null}
            {hint === null ? null : <span>{hint}</span>}
          </span>
        </button>
      )}

      <button
        type="button"
        title={`删除 ${object.name}`}
        aria-label={`删除 ${object.name}`}
        className="toolbar-button flex-none opacity-0 hover:toolbar-button-hover group-hover:opacity-100"
        onClick={onDelete}
      >
        删除
      </button>
    </div>
  );
}
