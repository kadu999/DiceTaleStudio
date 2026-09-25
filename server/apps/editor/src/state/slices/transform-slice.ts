/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 变换：工具切换与手柄拖拽（开始 / 应用 / 结束 / 取消）。
 */
import {
  effectiveScaleX,
  effectiveScaleY,
  setObjectPosition as setGameObjectPosition,
  setObjectScaleAxes as setGameObjectScaleAxes,
  setObjectRotation as setGameObjectRotation,
} from "@dts/document";
import { worldRectOf } from "@dts/grid";
import { isCornerScaleHandle, scaleAnchorFor, scaleAxisOf } from "@dts/renderer";
import { writeEditorPrefs } from "../../services/editor-prefs";
import { resolveTransform, type TransformStart } from "../../panels/scene/transform";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { sceneHistory, TRANSFORM_LABELS } from "../store-core";
import { type StoreContext } from "../store-context";

export function createTransformSlice(
  set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "setTool"
  | "setBgmPaths"
  | "beginObjectTransform"
  | "applyObjectTransform"
  | "endObjectTransform"
  | "cancelObjectTransform"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const { findObjectById, applyActiveScene } = ctx;

  return {
    setTool(tool) {
      set((state) => ({ ui: { ...state.ui, tool } }));
      // 写偏好要**整份**写（存储里是一整个对象）：漏掉别的字段 = 把它悄悄还原成默认值
      writeEditorPrefs({ tool, bgmPaths: get().ui.bgmPaths });
    },

    setBgmPaths(show) {
      set((state) => ({ ui: { ...state.ui, bgmPaths: show } }));
      writeEditorPrefs({ tool: get().ui.tool, bgmPaths: show });
    },

    beginObjectTransform(id, handle, pointer, halfWidth, halfHeight) {
      // 「拖动」模式既没有手柄、也不吃对象本体的拖动：护栏放在这里，任何调用方都进不来
      const tool = get().ui.tool;
      if (tool === "none") {
        return undefined;
      }

      const object = findObjectById(id);
      // 锁定的对象**不进入变换**：锁的语义就是「不能被移动」，而旋转与缩放同样是在动它。
      // 画布那边还会先判一次（免得白进一次拖拽状态），这里的护栏是给其它调用方兜底的。
      if (object === undefined || object.position === null || object.locked) {
        return undefined;
      }

      const center = { x: object.position.x, y: object.position.y };
      // **锚点矩形要用整宽整高**：`halfWidth` / `halfHeight` 是半尺寸，而 `worldRectOf`
      // 收的是整尺寸。传半尺寸会把固定点放到「中心与对角的中点」上——按下缩放的一瞬间
      // 对象就跳到 1.5 倍。命中测试那边同一件事写的就是 `half.width * 2`。
      const rect = worldRectOf(center, { width: halfWidth * 2, height: halfHeight * 2 });
      // 拖对象本体（`handle === null`）没有手柄：既没有轴约束，也没有缩放锚点 / 角边之分
      const scaleHandle = tool === "scale" && handle !== null ? handle : null;
      // 边手柄管哪一轴：拖它是「只改这一轴」，`resolveTransform` 靠它把另一轴按住不动
      const scaleAxis = scaleHandle === null ? undefined : scaleAxisOf(scaleHandle);

      const start: TransformStart = {
        id,
        mode: tool,
        base: center,
        rotation: object.rotation,
        scaleX: effectiveScaleX(object),
        scaleY: effectiveScaleY(object),
        // 移动按「指针位移」、旋转按「指针方位角增量」、缩放按「指针相对锚点的偏移比例」——
        // 三者都要**按下这一刻的真实指针位置**当基准（见 transform.ts 顶部说明）
        pointer,
        center,
        // 移动与旋转用不到锚点；缩放拖拽的固定点是对角 / 对边中点（与 Unity 一致）
        anchor:
          scaleHandle === null
            ? center
            : (scaleAnchorFor(scaleHandle, rect, object.rotation) ?? center),
        corner: scaleHandle !== null && isCornerScaleHandle(scaleHandle),
        ...(scaleAxis === undefined ? {} : { axis: scaleAxis }),
      };

      set({ transformStart: start });
      return start;
    },

    applyObjectTransform(pointer, options) {
      const start = get().transformStart;
      if (start === null) {
        return;
      }

      // 拖拽途中对象可能已经被删掉（撤销 / 别人删了）：直接收手，别写一个不存在的 id
      if (findObjectById(start.id) === undefined) {
        return;
      }

      const result = resolveTransform({
        start,
        pointer,
        ...(options?.axis === undefined ? {} : { axis: options.axis }),
        ...(options?.snapAngle === undefined ? {} : { snapAngle: options.snapAngle }),
        ...(options?.uniform === undefined ? {} : { uniform: options.uniform }),
      });

      // 位置 / 角度 / 缩放**一次写完**：三次独立调用会产生三条撤销记录，
      // 而用户眼里这明明是一次拖拽（对比 `moveObject` 只改一个属性，所以它单独一条）
      applyActiveScene(
        TRANSFORM_LABELS[start.mode],
        (scene) => {
          setGameObjectPosition(scene, start.id, result.position);
          setGameObjectRotation(scene, start.id, result.rotation);
          setGameObjectScaleAxes(scene, start.id, { x: result.scaleX, y: result.scaleY });
        },
        { coalesceKey: `transform:${start.id}` },
      );
    },

    endObjectTransform() {
      set({ transformStart: null });
      sceneHistory.endCoalescing();
    },

    cancelObjectTransform() {
      const start = get().transformStart;
      const sceneName = get().activeSceneName;
      set({ transformStart: null });

      if (start === null || sceneName === null) {
        sceneHistory.endCoalescing();
        return;
      }

      // 用快照写回按下前的样子。快照里的 scaleX / scaleY 是**有效值**，
      // 而"按下前是不是等比的写法"已经无从考证——所以统一按当前工具的形状写回：
      // 等比就折叠回 `scale`（`collapseScale` 会做），非等比就写两轴。
      applyActiveScene(
        "取消变换",
        (scene) => {
          setGameObjectPosition(scene, start.id, start.base);
          setGameObjectRotation(scene, start.id, start.rotation);
          setGameObjectScaleAxes(scene, start.id, { x: start.scaleX, y: start.scaleY });
        },
        { coalesceKey: `transform:${start.id}` },
      );

      sceneHistory.endCoalescing();
    },
  };
}
