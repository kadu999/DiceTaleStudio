import type { GameObjectDoc } from "@dts/document";
import { useEditorStore } from "../../state/editor-store";
import { FieldRow } from "./fields";

/**
 * 放大镜（动作对象，v30；v31 起数据是**状态列表**）的字段：**只剩「打开窗口」这一个按钮**。
 *
 * 「状态列表」**整行搬进那扇窗口里**了（加状态 / 挑图 / 写标题与文字都在窗口里做，
 * 窗口下排就是状态槽）——属性面板这边不再留一套，免得两处各改一半、互相不一致。
 * **状态数量、有没有在投影这类说明文字也一并去掉**：这一行只留动作本身
 * （用户原话：「放大镜对象只需要一个打开窗口的按钮，关闭画面和描述状态都不需要」）。
 *
 * 留下的这一个是**动作**：打开窗口（编辑器那扇，预览 + 编辑；运行态下同时投到前端）。
 * **「关闭画面」不在这里**——要去掉前端那扇窗，去编辑器那扇窗（`MagnifierDialog`）底栏点
 * 「关闭画面」（前端那扇窗自己没有按钮，只能由后端开、由后端关）。
 * 换状态 / 换图 / 改标题文字都不是命令：那是**文档数据**，运行态下整份 `scene_push` 带过去。
 */
export function MagnifierFields({ object }: { readonly object: GameObjectDoc }): React.JSX.Element {
  const showMagnifier = useEditorStore((store) => store.showMagnifier);
  const running = useEditorStore((store) => store.mode === "run");

  return (
    <FieldRow label="窗口">
      <div className="flex min-w-0 flex-1 items-center gap-1" data-testid="magnifier-window">
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
      </div>
    </FieldRow>
  );
}
