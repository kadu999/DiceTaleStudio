import { mapDataOf, type SceneObjectDoc } from "@dts/document";
import { useEditorStore } from "../../state/editor-store";
import { FieldRow } from "./fields";

/**
 * 网格标注的入口：放进属性面板的「区域」分组里（分组标题由外面给，这里只出行）。
 *
 * 画布上**没有标注模式**了：涂格子只在「编辑窗口」（`GridEditDialog`）里做——
 * 贴图铺满窗口、落笔就是格子，不用在地图上对准格子，也不用先切模式。
 * 所以这一行只留一个入口按钮；画笔 / 颜色 / 大小 / 每类显示那些控件都在窗口右侧面板里。
 */
export function GridAnnotationFields({
  object,
}: {
  readonly object: SceneObjectDoc;
}): React.JSX.Element {
  const openGridEditor = useEditorStore((state) => state.openGridEditor);

  if (mapDataOf(object) === undefined) {
    return <></>;
  }

  return (
    <FieldRow label="网格标注">
      <button
        type="button"
        data-testid="grid-editor-open"
        title="在贴图窗口里按区域涂 / 擦：不用在地图上对准格子，地图没激活 / 没落位也能改"
        className="flex-none rounded bg-[var(--color-editor-accent)] px-2 py-0.5 text-[11px] text-black hover:opacity-90"
        onClick={() => openGridEditor(object.id)}
      >
        编辑
      </button>
    </FieldRow>
  );
}
