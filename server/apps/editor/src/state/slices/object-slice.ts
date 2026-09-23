/**
 * 本文件从 `editor-store.ts` 拆出（纯搬运，行为不变）。
 *
 * 场景对象：增删改、选中与弹框开关。
 */
import {
  addObject,
  createId,
  nextObjectName,
  removeObject as removeSceneObject,
  renameObject as renameSceneObject,
  setMapGrid as setSceneMapGrid,
  setObjectActive as setSceneObjectActive,
  setObjectImage as setSceneObjectImage,
  setObjectPosition as setSceneObjectPosition,
  setObjectLocked as setSceneObjectLocked,
  setObjectScale as setSceneObjectScale,
  setObjectScaleAxes as setSceneObjectScaleAxes,
  setObjectRotation as setSceneObjectRotation,
  setObjectSortingOrder as setSceneObjectSortingOrder,
  type SceneObjectDoc,
} from "@dts/document";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { createSceneObjectForKind } from "../scene-object-factory";
import {
  sceneHistory,
  makeLog,
  SCENE_CENTER,
  offsetPosition,
  findSceneByName,
} from "../store-core";
import { type StoreContext } from "../store-context";

export function createObjectSlice(
  set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "setSelection"
  | "selectAsset"
  | "openObjectDialog"
  | "createObject"
  | "renameObject"
  | "setObjectActive"
  | "toggleObjectActive"
  | "setObjectLocked"
  | "toggleObjectLocked"
  | "setObjectSortingOrder"
  | "setObjectScale"
  | "setObjectRotation"
  | "deleteObjects"
  | "duplicateObjects"
  | "moveObject"
  | "endObjectDrag"
  | "setObjectScaleAxes"
  | "setMapGrid"
  | "setObjectImage"
  | "openImagePicker"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const { pushLog } = ctx;

  return {
    setSelection(objectIds) {
      const next = [...objectIds];
      // 选中对象就取消资源选中：属性面板一次只显示一样东西
      set({ selectedObjectIds: next, selectedAssetId: null });
    },

    selectAsset(id) {
      set({ selectedAssetId: id, selectedObjectIds: [] });
    },

    openObjectDialog(open) {
      set({ objectDialog: open });
    },

    // ---------------------------------------------------------------- 场景对象

    async createObject(kind, name, position) {
      const project = get().project.current;
      const sceneName = get().activeSceneName;
      const scene = findSceneByName(get().scenes, sceneName);
      if (project === null || sceneName === null || scene === undefined) {
        return "还没有场景";
      }

      const trimmed = name.trim();
      if (trimmed.length === 0) {
        return "请输入对象名";
      }

      // 世界无限大：落点就是给的那个坐标，不夹取
      const at = position === undefined ? { ...SCENE_CENTER } : { x: position.x, y: position.y };
      const object = createSceneObjectForKind(kind, {
        project,
        sceneName,
        name: trimmed,
        position: at,
      });

      const changed = get().applyScenes(`新建对象 ${trimmed}`, (draft) => {
        const target = draft.find((item) => item.name === sceneName);
        if (target !== undefined) {
          addObject(target, object);
        }
      });

      if (!changed) {
        return "新建对象失败";
      }

      set({ selectedObjectIds: [object.id], selectedAssetId: null });
      pushLog(makeLog("info", `已新建对象：${trimmed}（${kind}）`));
      return undefined;
    },

    renameObject(id, name) {
      const sceneName = get().activeSceneName;
      const trimmed = name.trim();
      if (sceneName === null || trimmed.length === 0) {
        return false;
      }

      return get().applyScenes(`重命名对象 ${trimmed}`, (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          renameSceneObject(scene, id, trimmed);
        }
      });
    },

    setObjectActive(id, active) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const scene = findSceneByName(get().scenes, sceneName);
      const object = scene?.objects.find((item) => item.id === id);
      if (object === undefined || object.active === active) {
        return false;
      }

      const changed = get().applyScenes(active ? `激活 ${object.name}` : `停用 ${object.name}`, (draft) => {
        const target = draft.find((item) => item.name === sceneName);
        if (target !== undefined) {
          setSceneObjectActive(target, id, active);
        }
      });

      if (changed) {
        pushLog(makeLog("info", `${active ? "已显示" : "已隐藏"}对象：${object.name}`));
      }

      return changed;
    },

    toggleObjectActive(id) {
      const object = findSceneByName(get().scenes, get().activeSceneName)?.objects.find(
        (item) => item.id === id,
      );
      if (object === undefined) {
        return false;
      }

      return get().setObjectActive(id, !object.active);
    },

    setObjectLocked(id, locked) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const object = findSceneByName(get().scenes, sceneName)?.objects.find((item) => item.id === id);
      if (object === undefined || object.locked === locked) {
        return false;
      }

      const changed = get().applyScenes(
        locked ? `锁定 ${object.name}` : `解锁 ${object.name}`,
        (draft) => {
          const target = draft.find((item) => item.name === sceneName);
          if (target !== undefined) {
            setSceneObjectLocked(target, id, locked);
          }
        },
      );

      if (changed) {
        pushLog(makeLog("info", `${locked ? "已锁定" : "已解锁"}对象：${object.name}`));
      }

      return changed;
    },

    toggleObjectLocked(id) {
      const object = findSceneByName(get().scenes, get().activeSceneName)?.objects.find(
        (item) => item.id === id,
      );
      if (object === undefined) {
        return false;
      }

      return get().setObjectLocked(id, !object.locked);
    },

    setObjectSortingOrder(id, sortingOrder) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes(
        "修改显示顺序",
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene !== undefined) {
            setSceneObjectSortingOrder(scene, id, sortingOrder);
          }
        },
        // 连续敲数字 / 按住微调按钮合并成一条撤销记录
        { coalesceKey: `sorting:${id}` },
      );
    },

    setObjectScale(id, scale) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes(
        "修改缩放",
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene !== undefined) {
            setSceneObjectScale(scene, id, scale);
          }
        },
        // 连续输入合并成一条撤销记录（与显示顺序同一套做法）
        { coalesceKey: `scale:${id}` },
      );
    },

    setObjectRotation(id, rotationRadians) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes(
        "修改角度",
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene !== undefined) {
            setSceneObjectRotation(scene, id, rotationRadians);
          }
        },
        // 连续输入合并成一条撤销记录
        { coalesceKey: `rotation:${id}` },
      );
    },

    deleteObjects(ids) {
      const sceneName = get().activeSceneName;
      const targetIds = ids ?? get().selectedObjectIds;
      if (sceneName === null || targetIds.length === 0) {
        return false;
      }

      const changed = get().applyScenes(
        targetIds.length === 1 ? "删除对象" : `删除 ${targetIds.length} 个对象`,
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene === undefined) {
            return;
          }

          for (const id of targetIds) {
            removeSceneObject(scene, id);
          }
        },
      );

      if (changed) {
        set({ selectedObjectIds: [] });
        // 两个格子编辑窗口同理：它们盯着的那张地图没了就把窗口关掉（否则窗口里是一张画不出来的图）
        const fogTarget = get().fogMaskTarget;
        if (fogTarget !== null && targetIds.includes(fogTarget)) {
          set({ fogMask: false, fogMaskTarget: null });
        }

        const editTarget = get().gridEditorTarget;
        if (editTarget !== null && targetIds.includes(editTarget)) {
          set({ gridEditor: false, gridEditorTarget: null });
        }
      }

      return changed;
    },

    duplicateObjects(ids) {
      const sceneName = get().activeSceneName;
      const targetIds = ids ?? get().selectedObjectIds;
      if (sceneName === null || targetIds.length === 0) {
        return false;
      }

      const copies: string[] = [];
      const changed = get().applyScenes(
        targetIds.length === 1 ? "复制对象" : `复制 ${targetIds.length} 个对象`,
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene === undefined) {
            return;
          }

          let step = 1;
          for (const id of targetIds) {
            const source = scene.objects.find((object) => object.id === id);
            if (source === undefined) {
              continue;
            }

            const copy: SceneObjectDoc = {
              ...source,
              id: createId("obj"),
              // 名字与位置都错开，复制出来的东西不会与原对象完全重叠 / 同名
              name: nextObjectName(scene.objects, `${source.name} 副本`),
              position: offsetPosition(source.position, step),
            };
            step += 1;
            addObject(scene, copy);
            copies.push(copy.id);
          }
        },
        // 连按复制合并成一条撤销记录
        { coalesceKey: "duplicate" },
      );

      if (!changed) {
        return false;
      }

      set({ selectedObjectIds: copies, selectedAssetId: null });
      pushLog(makeLog("info", `已复制 ${copies.length} 个对象`));
      return true;
    },

    moveObject(id, position) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return;
      }

      // **锁定 = 不能移动**：这里是全项目唯一的移动入口（画布拖动、属性面板改坐标都走它），
      // 所以护栏放在这一处就够——画布那边还会先判一次（免得白进一次拖动状态）
      const object = findSceneByName(get().scenes, sceneName)?.objects.find((item) => item.id === id);
      if (object === undefined || object.locked) {
        return;
      }

      get().applyScenes(
        "移动对象",
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene !== undefined) {
            setSceneObjectPosition(scene, id, position);
          }
        },
        { coalesceKey: `move:${id}` },
      );
    },

    endObjectDrag() {
      sceneHistory.endCoalescing();
    },

    setObjectScaleAxes(id, x, y) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes(
        "修改缩放",
        (draft) => {
          const scene = draft.find((item) => item.name === sceneName);
          if (scene !== undefined) {
            setSceneObjectScaleAxes(scene, id, { x, y });
          }
        },
        // 连续输入合并成一条撤销记录（与等比缩放同一套做法）
        { coalesceKey: `scale:${id}` },
      );
    },

    setMapGrid(mapObjectId, grid) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      return get().applyScenes("修改网格尺寸", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneMapGrid(scene, mapObjectId, grid);
        }
      });
    },

    setObjectImage(objectId, image) {
      const sceneName = get().activeSceneName;
      if (sceneName === null) {
        return false;
      }

      const changed = get().applyScenes("更换贴图", (draft) => {
        const scene = draft.find((item) => item.name === sceneName);
        if (scene !== undefined) {
          setSceneObjectImage(scene, objectId, image);
        }
      });

      if (changed) {
        pushLog(makeLog("info", `已更换贴图：${image.id}（${image.width}×${image.height}）`));
      }

      return changed;
    },

    openImagePicker(objectId) {
      set({ imagePicker: objectId !== null, imagePickerTarget: objectId });
      if (objectId !== null) {
        // 打开「选择贴图」时刷新一次目录：素材由外部提交，不刷新的话刚放进去的图选不到。
        void get().refreshTree();
      }
    },
  };
}
