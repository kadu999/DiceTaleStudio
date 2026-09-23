import { componentSpecOf, setComponentField as setSceneComponentField } from "@dts/document";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { type StoreContext } from "../store-context";

/**
 * **泛型组件字段写入**的切片。
 *
 * 这个切片只有一条 action，而且**不需要随字段增长**：字段的标签（撤销记录的说明）与
 * 「要不要合并成一条撤销记录」都从组件规格里读。于是「给某个组件加一个布尔」在 store 这一层
 * 是**零改动**——过去的做法是在 `store-types.ts` 加声明、在 `slices/<功能>-slice.ts` 加实现。
 *
 * 仍然走 `applyActiveScene`：撤销栈、落盘时机、日志口径与其它编辑完全同一条路。
 */
export function createComponentSlice(
  _set: StoreSet,
  _get: StoreGet,
  ctx: StoreContext,
): Pick<EditorStoreState, "setComponentField"> {
  const { applyActiveScene } = ctx;

  return {
    setComponentField(objectId, type, key, value) {
      const field = componentSpecOf(type)?.fields.find((item) => item.key === key);

      return applyActiveScene(
        // 规格里没有这个字段时也给一个能看懂的说明：这条 action 是别的调用方（而不只是面板）在用
        field === undefined ? "修改组件" : `修改${field.label}`,
        (scene) => {
          // **不要 `return` 这条命令的布尔值**：immer 的 recipe 返回值非 undefined 会被当成
          // 「返回了新状态」，与「改了 draft」冲突并直接抛错。「有没有变更」由补丁数决定
          // （`DocumentHistory.apply`），与其它切片里的写法一致。
          setSceneComponentField(scene, objectId, type, key, value);
        },
        // 数值 / 文本输入框连续敲字合并成一条撤销记录（与 `setObjectScale` 同一套做法）
        field?.coalesce === true ? { coalesceKey: `${type}:${key}:${objectId}` } : undefined,
      );
    },
  };
}
