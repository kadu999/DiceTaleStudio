import {
  addObjectComponent as addSceneObjectComponent,
  componentSpecOf,
  findComponentType,
  removeObjectComponent as removeSceneObjectComponent,
  repairObjectComponent as repairSceneObjectComponent,
  setComponentField as setSceneComponentField,
  type ComponentType,
} from "@dts/document";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { type StoreContext } from "../store-context";

/**
 * **泛型组件写入**的切片：字段、修复，以及**可选组件的添加 / 移除**。
 *
 * 这些 action **不随组件增长**：字段的标签与合并规则从组件规格里读，添加 / 移除按组件类型
 * 分派给 `@dts/document` 的统一入口。于是「给某个组件加一个布尔」「多一种可选组件」在 store
 * 这一层几乎零改动——过去的做法是在 `store-types.ts` 加声明、在 `slices/<功能>-slice.ts` 加实现。
 *
 * 仍然走 `applyActiveScene`：撤销栈、落盘时机、日志口径与其它编辑完全同一条路。
 */
export function createComponentSlice(
  _set: StoreSet,
  _get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  "setComponentField" | "repairObjectComponent" | "addObjectComponent" | "removeObjectComponent"
> {
  const { applyActiveScene } = ctx;

  return {
    repairObjectComponent(objectId, type) {
      return applyActiveScene("修复对象组件", (scene) => {
        repairSceneObjectComponent(scene, objectId, type);
      });
    },

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

    /**
     * 给对象**加上一个可选组件**（属性面板底部的 `Add Component`）。
     *
     * 加哪些、怎么初始化都交给 `@dts/document` 的 `addObjectComponent` 分派；撤销说明取组件的
     * 显示名（`添加视频` / `添加网格地图`），与「修改字段」同一套命名。
     */
    addObjectComponent(objectId: string, type: ComponentType) {
      const label = findComponentType(type)?.displayName ?? type;
      return applyActiveScene(`添加${label}`, (scene) => {
        addSceneObjectComponent(scene, objectId, type);
      });
    },

    /** 把对象上的一个可选组件**整个摘掉**（组件头上的「移除组件」）。 */
    removeObjectComponent(objectId: string, type: ComponentType) {
      const label = findComponentType(type)?.displayName ?? type;
      return applyActiveScene(`移除${label}`, (scene) => {
        removeSceneObjectComponent(scene, objectId, type);
      });
    },
  };
}
