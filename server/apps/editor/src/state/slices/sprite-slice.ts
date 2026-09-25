/**
 * 精灵（子图）：对象引用哪一格（场景那条轨道）+ 一张图怎么切 / 怎么导入（素材 meta 那条轨道）。
 *
 * 两个动作看着像一对，其实落在**两条不同的撤销轨道**上（文件都不同）：
 *
 * - 对象身上那一格引用是**场景文件**数据——由 `setObjectImageSprite` 一条命令
 *   （图 + 格子一次写入，一条撤销记录）维护；
 * - `setSpriteSheet` / `setSpriteImportSettings` 改的是**素材自己的 `.meta`**
 *   （v23 起：`<素材>.meta` 里的 `sprite` 节点，见 `@dts/document` 的 `asset-meta.ts`）。
 *
 * 分开是有意的：切分是「这张图整体怎么切」，与某一个对象无关；改它时**不去动**已放好的对象
 * （越界的格子由渲染与推送统一夹到最后一格，见 `sprites.ts`）——一次操作落在两条轨道上，
 * 撤销就会说不清「退回去的是哪一半」。
 *
 * meta 的写入**一律走文档层那两个纯函数**（`withMetaSpriteSheet` / `withMetaSpriteSettings`）：
 * 「1×1 不留空壳」「Default 摘掉整个 sprite 节点」「Single 顺手清切分」这些口径只有那一份，
 * 这里只负责选轨道、起撤销标签、给去抖落盘一个键。
 */
import {
  createAssetMeta,
  canRepairObjectComponent,
  componentForSlot,
  DEFAULT_SLOT_COMPONENT,
  repairImageObjectComponent as repairSceneImageObjectComponent,
  repairMapObjectComponent as repairSceneMapObjectComponent,
  objectImageSlot,
  setObjectImage as setGameObjectImage,
  withMetaSpriteSheet,
  withMetaSpriteSettings,
  type ImageRef,
  type ImageSpriteRef,
  type SpriteImportSettingsDoc,
  type SpriteSheetDoc,
} from "@dts/document";
import { findAssetById } from "../../panels/asset-picker";
import { type StoreSet, type StoreGet, type EditorStoreState } from "../store-types";
import { type StoreContext } from "../store-context";

export function createSpriteSlice(
  _set: StoreSet,
  get: StoreGet,
  ctx: StoreContext,
): Pick<
  EditorStoreState,
  | "setObjectImageSprite"
  | "setSpriteSheet"
  | "setSpriteImportSettings"
  | "ensureAssetMeta"
> {
  // 共享的闭包状态与局部工具都在 ctx 里：这里解构一次，方法体与拆分前逐字一致
  const { applyActiveScene } = ctx;

  /** 这个素材在资源树里的相对路径（只用于日志与撤销标签；找不到就退回逻辑 ID）。 */
  const assetName = (imageId: string): string =>
    findAssetById(get().project.tree, imageId)?.path ?? imageId;

  return {
    /**
     * 「选择贴图 / 精灵」窗口确定时的一条命令：**图 + 格子一次写进去**。
     *
     * 合成一个 action 而不是外面连着调两次，为的是**一条撤销记录**：在用户眼里
     * 「换一张图并取它的第 3 格」就是一次操作，撤销一次应该整件事退回去。
     * （两条命令各自落在**场景**这条轨道上，所以合成没有跨轨道的问题。）
     *
     * `guid` 原样带过去：它是这个引用的**身份**（v23 起有 guid 就以它为准），
     * 漏掉它这次换图就退回到「只认路径」——素材一改名，这次挑的图就断链。
     * 没有 guid 的引用也不在这里补（补 = 改 meta = 另一条轨道，那会让「一次操作一条记录」不成立）；
     * 补身份是挑图那一刻的事，见 `ensureAssetMeta` 与 `ResourcePickerDialog`。
     */
    setObjectImageSprite(objectId, image: ImageRef, sprite: ImageSpriteRef | null) {
      const state = get();
      const object = state.scenes
        .find((scene) => scene.name === state.activeSceneName)
        ?.objects.find((item) => item.id === objectId);
      const repairingMap = object !== undefined &&
        canRepairObjectComponent(object, DEFAULT_SLOT_COMPONENT.map);
      const imageComponent = object === undefined ? undefined : componentForSlot("image", object.kind);
      const repairingImage = !repairingMap && object !== undefined && imageComponent !== undefined &&
        objectImageSlot(object) !== "map" &&
        canRepairObjectComponent(object, imageComponent);
      const label =
        repairingMap
          ? "修复地图贴图"
          : repairingImage
            ? "添加图片组件"
            : sprite === null ? "更换贴图" : `换图并取子图 第${sprite.row + 1}行第${sprite.column + 1}列`;
      return applyActiveScene(label, (scene) => {
        const ref: ImageRef = {
          id: image.id,
          width: image.width,
          height: image.height,
          ...(image.guid === undefined ? {} : { guid: image.guid }),
        };

        if (repairingMap) {
          repairSceneMapObjectComponent(scene, objectId, ref);
        } else if (repairingImage) {
          repairSceneImageObjectComponent(scene, objectId, sprite === null ? ref : { ...ref, sprite });
        } else {
          // 整图时显式不带 sprite；带格子时由 setObjectImage 原样写入。
          setGameObjectImage(scene, objectId, sprite === null ? ref : { ...ref, sprite });
        }
      });
    },

    /**
     * 改一张图的**切分**（列 × 行）；`null` = 恢复整图（等于把这一项摘掉）。
     *
     * 落在**素材 meta** 那条轨道上（`applyMetas`）：切分是「这张图自己的属性」，
     * 跟着素材走（v23 起），与场景文件、工程文件都无关。路径名只用于日志与撤销标签。
     * **不动任何对象**——口径是「改切分，所有引用它的对象一起变」，那个「变」发生在渲染与推送
     * 解析里（同一份引用按新的切分算出来的矩形换了）。
     *
     * 素材**还没有 meta** 时按需现建一份（新 GUID）：切分总得有个地方住。
     * 反过来，「恢复整图」而它本来就没有 meta 时**不建**——没有可写的东西，
     * 凭空造一份只有 GUID 的 meta 正是这次要消掉的噪声。
     */
    setSpriteSheet(imageId, sheet: SpriteSheetDoc | null) {
      const name = assetName(imageId);
      const label =
        sheet === null ? `恢复整图：${name}` : `切分 ${name} 为 ${sheet.columns}×${sheet.rows}`;

      return get().applyMetas(
        label,
        (draft) => {
          const existing = draft[imageId];
          if (existing === undefined) {
            const created = createAssetMeta("texture");
            const next = withMetaSpriteSheet(created, sheet);
            if (next !== created) {
              draft[imageId] = next;
            }

            return;
          }

          const next = withMetaSpriteSheet(existing, sheet);
          // 值没变时纯函数返回原对象：**别写回**，否则会在撤销栈里留一条「什么都没改」的记录
          if (next !== existing) {
            draft[imageId] = next;
          }
        },
        // 在输入框里连着改行 / 列（4 → 4×…）合成一条撤销记录
        { coalesceKey: `sprite-sheet:${imageId}` },
      );
    },

    /**
     * 改一张图的**导入设置**（`null` / `Default` = 普通图片）。
     *
     * 与切分同一条轨道、同一套「没有 meta 就现建 / 没有可写的就不建」的规矩
     * （口径在 `withMetaSpriteSettings`：`Default` 摘掉整个 `sprite` 节点、
     * `Single` 顺手把网格切分摘掉）。
     */
    setSpriteImportSettings(imageId, settings: SpriteImportSettingsDoc | null) {
      const name = assetName(imageId);
      const label = settings?.type === "Sprite" ? `启用精灵 ${name}` : `关闭精灵 ${name}`;
      return get().applyMetas(label, (draft) => {
        const existing = draft[imageId];
        if (existing === undefined) {
          const created = createAssetMeta("texture");
          const next = withMetaSpriteSettings(created, settings);
          if (next !== created) {
            draft[imageId] = next;
          }

          return;
        }

        const next = withMetaSpriteSettings(existing, settings);
        if (next !== existing) {
          draft[imageId] = next;
        }
      });
    },

    /**
     * 拿到这个素材的 meta，没有就现建一份（新 GUID）——**挑图 / 引用图片时用它拿身份**。
     *
     * 为什么要在这里建：`ImageRef.guid` 是身份，「第一次引用」就得写上；等到改名之后再补，
     * 那时路径已经对不上了（这正是 `.meta` 要解决的问题）。新建走第三条轨道，
     * 所以它会进撤销栈，也随订阅去抖落盘（`store-context.ts` 只写内容变了的那些）。
     */
    ensureAssetMeta(imageId) {
      const existing = get().assetMetaTable[imageId];
      if (existing !== undefined) {
        return existing;
      }

      const meta = createAssetMeta("texture");
      get().applyMetas(`新建素材 meta：${assetName(imageId)}`, (draft) => {
        draft[imageId] = meta;
      });

      // 订阅是同步的：这里取回来的就是刚写进去的那一份（取不到就退回本地这一份）
      return get().assetMetaTable[imageId] ?? meta;
    },
  };
}
