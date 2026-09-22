import { useShallow } from "zustand/react/shallow";
import { teleportDataOf, type SceneObjectDoc } from "@dts/document";
import { useEditorStore } from "../../state/editor-store";
import { FieldRow } from "./fields";

/**
 * 传送阵（动作对象）的字段：**候选目标**（一排小方块 + 末尾的 `＋`）+ **「传送」**。
 *
 * 分工与「播放声音」同一套，但**面板上只放两行、几个可点的东西**：
 * 小方块 = 「传送到哪一个」（选中的那个点着），`＋` = 开「传送目标」窗口勾清单，
 * 「传送」= 按一下换台。
 *
 * 「传送」按钮**不写传到哪**——选中哪个小方块已经说明了，按钮只写动作本身（写成一句话反而
 * 不像能点）。传不了时才在按钮上写为什么（还没加目标 / 还没选 / 目标已失效 / 已经在这个场景），
 * 免得平板上没有 hover、点不动却不知道为什么。
 *
 * 触发 = **切换当前场景**（对 DM 就是「换台」）：走 `teleport()` → `switchScene` →
 * 写回改动、记住视口、换场景、**立刻 `scene_push`**；画布上**双击徽标**是同一件事。
 * **不改文档、不进撤销栈**：按一下换台不是编辑（与「播放声音」同一条规矩）。
 */
export function TeleportFields({ object }: { readonly object: SceneObjectDoc }): React.JSX.Element {
  // 只要场景名（拖手柄时文档每帧都在变，但场景名不变 → 这个面板不会因此重渲染）
  const sceneNames = useEditorStore(useShallow((state) => state.scenes.map((scene) => scene.name)));
  const activeSceneName = useEditorStore((state) => state.activeSceneName);
  const setTeleportPicked = useEditorStore((state) => state.setTeleportPicked);
  const openTeleportEditor = useEditorStore((state) => state.openTeleportEditor);
  const teleportNow = useEditorStore((state) => state.teleport);

  const teleport = teleportDataOf(object);
  // 手写文件里可能整个 teleport 都没有（`validateScene` 会报错）：这里按「还没加目标」显示
  const targets = teleport?.targets ?? [];
  const picked = teleport?.picked;
  const known = new Set(sceneNames);

  // 按钮上的字：能传 = 传到哪；不能传 = 为什么（四句短话，与 `teleport()` 的护栏同一套判断）
  const blocked =
    targets.length === 0
      ? "先加目标"
      : picked === undefined || !targets.includes(picked)
        ? "先选一个目标"
        : !known.has(picked)
          ? "目标已失效"
          : picked === activeSceneName
            ? "已经在这个场景"
            : undefined;

  return (
    <>
      <FieldRow label="目标">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" data-testid="teleport-targets">
          {targets.map((name) => {
            const selected = name === picked;
            const alive = known.has(name);
            return (
              <button
                key={name}
                type="button"
                data-testid="teleport-target-chip"
                data-target={name}
                data-selected={selected}
                data-missing={!alive}
                aria-pressed={selected}
                title={alive ? name : `${name}（已不在项目里）`}
                className={`max-w-[8rem] truncate rounded border px-1.5 py-0.5 text-[10px] ${
                  selected
                    ? "border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] text-white"
                    : "border-[var(--color-editor-border)] hover:bg-[var(--color-editor-panel-alt)]"
                } ${alive ? "" : "text-[var(--color-editor-warn)]"}`}
                onClick={() => setTeleportPicked(object.id, selected ? null : name)}
              >
                {name}
              </button>
            );
          })}

          {/* 勾清单的入口：贴在小方块末尾（虚线框 = 「加」），点它开「传送目标」窗口 */}
          <button
            type="button"
            data-testid="teleport-edit"
            title="选择目标场景"
            className="flex-none rounded border border-dashed border-[var(--color-editor-border)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-editor-panel-alt)]"
            onClick={() => openTeleportEditor(object.id)}
          >
            ＋
          </button>
        </div>
      </FieldRow>

      <FieldRow label="传送">
        <button
          type="button"
          data-testid="teleport-go"
          data-blocked={blocked !== undefined}
          disabled={blocked !== undefined}
          title={blocked ?? `切到「${picked}」（画布上双击徽标也一样）`}
          className="flex-none rounded border border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] px-3 py-0.5 text-[11px] text-white hover:brightness-125 disabled:border-[var(--color-editor-border)] disabled:bg-transparent disabled:text-[var(--color-editor-text-dim)] disabled:hover:brightness-100"
          onClick={() => teleportNow(object.id)}
        >
          {/* 传到哪由上面选中的那个小方块说了算，按钮只管「按」——所以只写动作 */}
          {blocked === undefined ? "⇢ 传送" : blocked}
        </button>
      </FieldRow>
    </>
  );
}
