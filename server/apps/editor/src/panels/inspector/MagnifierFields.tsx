import { magnifierDataOf, magnifierStateIsEmpty, type GameObjectDoc } from "@dts/document";
import { useEditorStore } from "../../state/editor-store";
import { FieldRow } from "./fields";

/**
 * 放大镜（动作对象，v30；v31 起数据是**状态列表**）的字段：**只剩「窗口」这一行**。
 *
 * 「状态列表」**整行搬进那扇窗口里**了（加状态 / 挑图 / 写标题与文字都在窗口里做，
 * 窗口下排就是状态槽）——属性面板这边不再留一套，免得两处各改一半、互相不一致。
 *
 * 留下的这一行是**动作**：打开窗口（编辑器那扇，预览 + 编辑；运行态下同时投到前端）、
 * 以及「关闭画面」——前端那扇窗只能由后端开、由后端关（它自己没有按钮）。
 * 换状态 / 换图 / 改标题文字都不是命令：那是**文档数据**，运行态下整份 `scene_push` 带过去。
 */
export function MagnifierFields({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
  const magnifier = magnifierDataOf(object);
  const states = magnifier?.states ?? [];
  const picked = magnifier?.picked;
  const state = picked === undefined ? undefined : states[picked];
  /** 选中的那个状态**有东西可展示**（标题 / 图 / 文字至少一项）——没有图也行（纯文字线索卡）。 */
  const shown = !magnifierStateIsEmpty(state);

  const showMagnifier = useEditorStore((store) => store.showMagnifier);
  const closeMagnifierWindow = useEditorStore((store) => store.closeMagnifierWindow);
  const mode = useEditorStore((store) => store.mode);
  const windowShown = useEditorStore((store) => store.magnifierShown);

  const running = mode === "run";
  const showingHere = windowShown === object.id;

  return (
    <FieldRow label="窗口">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" data-testid="magnifier-window">
        <button
          type="button"
          data-testid="magnifier-open"
          title={
            running
              ? "打开窗口，并让前端也弹一扇（画布上双击徽标也一样）"
              : "打开窗口（预览 + 加状态 / 挑图 / 写字）；进运行态后点它会同时投到前端"
          }
          className="flex-none rounded border border-[var(--color-editor-accent)] bg-[var(--color-editor-accent-dim)] px-3 py-0.5 text-[11px] text-white hover:brightness-125"
          onClick={() => showMagnifier(object.id)}
        >
          打开窗口
        </button>

        {showingHere ? (
          <button
            type="button"
            data-testid="magnifier-close-window"
            title="让前端把那扇窗收起来（它自己没有关闭按钮）"
            className="flex-none rounded border border-[var(--color-editor-border)] px-2 py-0.5 text-[11px] hover:border-[var(--color-editor-danger)] hover:text-[var(--color-editor-danger)]"
            onClick={() => closeMagnifierWindow()}
          >
            关闭画面
          </button>
        ) : null}

        <span
          data-testid="magnifier-window-state"
          className="text-[10px] text-[var(--color-editor-text-dim)]"
        >
          {!running
            ? `编辑态只有窗口预览（进运行态才投到前端）· ${states.length} 个状态`
            : showingHere
              ? shown
                ? "画面上开着这一个状态"
                : "画面上开着（但选中的状态是空的）"
              : `画面上没开 · ${states.length} 个状态`}
        </span>
      </div>
    </FieldRow>
  );
}
