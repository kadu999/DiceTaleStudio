/**
 * 精灵（子图）：对象引用哪一格（场景那条轨道）+ 一张图怎么切（工程文件那条轨道）。
 *
 * 两个 action 看着像一对，其实落在**两条不同的撤销轨道**上（文件都不同）：
 *
 * - `setObjectSprite` 改的是**场景文件**（对象身上那一格引用）；
 * - `setSpriteSheet` 改的是**工程文件**（`图片逻辑 ID → 列×行`，切分只有这一份）。
 *
 * 分开是有意的：切分是「这张图整体怎么切」，与某一个对象无关；改它时**不去动**已放好的对象
 * （越界的格子由渲染与推送统一夹到最后一格，见 `sprites.ts`）——一次操作落在两条轨道上，
 * 撤销就会说不清「退回去的是哪一半」。
 */
import {
  setObjectImage as setSceneObjectImage,
  setObjectSprite as setSceneObjectSprite,
  setSpriteSheet as setProjectSpriteSheet,
  setSpriteImportSettings as setProjectSpriteImportSettings,
  type ImageRef,
  type ImageSpriteRef,
  type SceneListDraft,
  type SpriteImportSettingsDoc,
  type SpriteSheetDoc,
} from "@dts/document";
import { findAssetById } from "../../panels/asset-picker";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { type StoreContext } from "../store-context";

export function createSpriteSlice(
  _set: StoreSet,
  get: StoreGet,
  _ctx: StoreContext,
): Pick<EditorStoreState, "setObjectImageSprite" | "setObjectSprite" | "setSpriteSheet" | "setSpriteImportSettings"> {
  /** 当前场景的 draft（没打开场景 / 找不到就是 `undefined`）。 */
  const sceneOf = (draft: SceneListDraft): SceneListDraft[number] | undefined => {
    const name = get().activeSceneName;
    return name === null ? undefined : draft.find((scene) => scene.name === name);
  };

  return {
    /**
     * 「选择贴图 / 精灵」窗口确定时的一条命令：**图 + 格子一次写进去**。
     *
     * 合成一个 action 而不是外面连着调两次，为的是**一条撤销记录**：在用户眼里
     * 「换一张图并取它的第 3 格」就是一次操作，撤销一次应该整件事退回去。
     * （两条命令各自落在**场景**这条轨道上，所以合成没有跨轨道的问题。）
     */
    setObjectImageSprite(objectId, image: ImageRef, sprite: ImageSpriteRef | null) {
      const label =
        sprite === null ? "更换贴图" : `换图并取子图 第${sprite.row + 1}行第${sprite.column + 1}列`;
      return get().applyScenes(label, (draft) => {
        const scene = sceneOf(draft);
        if (scene === undefined) {
          return;
        }

        // 整图时**显式不带 `sprite`**（换回整图就是这一条）；带格子时由 `setObjectImage`
        // 原样写进去（它「给什么用什么」，见文档命令）
        const next: ImageRef =
          sprite === null
            ? { id: image.id, width: image.width, height: image.height }
            : { id: image.id, width: image.width, height: image.height, sprite };
        setSceneObjectImage(scene, objectId, next);
      });
    },

    /**
     * 选这个对象要显示的**哪一格**（传 `null` = 改回整图）。
     *
     * 标签里带上「第几行第几列」，撤销菜单里一眼看得出退回的是哪一次选格。
     */
    setObjectSprite(objectId, sprite: ImageSpriteRef | null) {
      const label =
        sprite === null ? "改回整图" : `设为子图 第${sprite.row + 1}行第${sprite.column + 1}列`;
      const changed = get().applyScenes(label, (draft) => {
        const scene = sceneOf(draft);
        if (scene !== undefined) {
          setSceneObjectSprite(scene, objectId, sprite);
        }
      });

      return changed;
    },

    /**
     * 改一张图的**切分**（列 × 行）；`null` = 恢复整图（等于删掉这一项）。
     *
     * 落在工程文件那条轨道上（`applyProject`）：切分是项目级数据，与场景文件无关。
     * 路径名只用于日志与撤销标签。**不动任何对象**——口径是「改切分，所有引用它的对象一起变」，
     * 那个「变」发生在渲染与推送解析里（同一份引用算出来的矩形换了）。
     */
    setSpriteSheet(imageId, sheet: SpriteSheetDoc | null) {
      const name = findAssetById(get().project.tree, imageId)?.path ?? imageId;
      const label =
        sheet === null ? `恢复整图：${name}` : `切分 ${name} 为 ${sheet.columns}×${sheet.rows}`;

      return get().applyProject(
        label,
        (draft) => {
          setProjectSpriteSheet(draft, imageId, sheet);
        },
        // 在输入框里连着改行 / 列（4 → 4×…）合成一条撤销记录
        { coalesceKey: `sprite-sheet:${imageId}` },
      );
    },

    setSpriteImportSettings(imageId, settings: SpriteImportSettingsDoc | null) {
      const name = findAssetById(get().project.tree, imageId)?.path ?? imageId;
      const label = settings?.type === "Sprite" ? `启用精灵 ${name}` : `关闭精灵 ${name}`;
      return get().applyProject(label, (draft) => {
        setProjectSpriteImportSettings(draft, imageId, settings);
      });
    },
  };
}
