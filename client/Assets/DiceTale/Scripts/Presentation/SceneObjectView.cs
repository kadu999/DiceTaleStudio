using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 一个镜像对象的视图：**一块贴在地面上的面片**（地图与精灵都走它）。
    ///
    /// 属性怎么来（全部来自后台推下来的对象数据）：
    /// - 位置 = `position`（文档世界坐标 x/y 向上 → 客户端 x/z + 离地抬升）；
    /// - 大小 = 声明尺寸（`image` / `map.image`）× `scale`；
    /// - `active` = 是否显示（编辑器那个勾选框一改，这里就出现 / 消失）；
    /// - `sortingOrder` = 遮挡顺序（大的盖在上面）；
    /// - 有图就去取图贴上；没图（或还没取回来）先用按 `kind` 区分的底色占位，**保证每个对象都看得见**。
    ///
    /// 声音对象（`PlaySound`）不建可见物——编辑器里那枚音频图标只是**编辑器**的画法，
    /// 前端按自己的表现来；它的数据留在镜像里（`sound.picked` 就是该播的那条）。
    /// </summary>
    public class SceneObjectView : MonoBehaviour
    {
        /// <summary>没声明尺寸时的兜底边长（与编辑器画布上那块兜底矩形同口径）。</summary>
        private const float FallbackSize = 64f;

        private GroundSpriteRenderer quad;
        private ResourceImageLoader imageLoader;

        private string currentImageId = "";
        private string currentTextureId = "";
        private Texture2D currentTexture;
        private float currentWidth = FallbackSize;
        private float currentHeight = FallbackSize;

        /// <summary>按对象建视图（地图 / 精灵 / 任意实体都先建一块面片；声音对象除外）。</summary>
        public static SceneObjectView Create(MirrorObject obj, Transform parent, ResourceImageLoader loader)
        {
            var go = new GameObject(obj.id);
            go.transform.SetParent(parent, false);
            var view = go.AddComponent<SceneObjectView>();
            view.imageLoader = loader;
            view.quad = go.AddComponent<GroundSpriteRenderer>();
            return view;
        }

        /// <summary>把最新的对象数据应用到视图上（每次推送都会调）。</summary>
        public void Apply(MirrorObject obj)
        {
            gameObject.name = string.IsNullOrEmpty(obj.name) ? obj.id : $"{obj.name}（{obj.id}）";

            // 声音对象不建可见物：编辑器里那枚音频图标只是编辑器的画法，它的数据留在镜像里就够了
            if (obj.kind == "PlaySound")
            {
                gameObject.SetActive(false);
                return;
            }

            // 没落位的对象不画（与编辑器画布同一口径：画布上也不画、点不到）
            if (!obj.hasPosition)
            {
                gameObject.SetActive(false);
                return;
            }

            gameObject.SetActive(obj.active);

            // 文档 y 向上 → 客户端 +Z（与 GridMap.WorldToGrid 同口径）；y 只用来避免共面闪烁
            transform.position = new Vector3(obj.x, 0f, obj.y);
            transform.rotation = Quaternion.Euler(0f, -obj.rotation, 0f);

            var image = obj.DisplayImage;
            currentWidth = (image != null && image.width > 0 ? image.width : FallbackSize) * obj.scale;
            currentHeight = (image != null && image.height > 0 ? image.height : FallbackSize) * obj.scale;
            currentImageId = image != null ? image.id : "";
            var hasTexture = currentTexture != null && currentImageId.Length > 0 && currentTextureId == currentImageId;

            // 面片网格的宽 = 宽高比、高 = 1，所以整体按「高」缩放就得到声明尺寸（宽 = 高 × 宽高比）
            transform.localScale = new Vector3(currentHeight, 1f, currentHeight);

            // 面片：宽高比 + 染色（有图时白色 = 原图；没图时按 kind 上色，至少看得见）
            quad.SetRuntimeVisual(
                hasTexture ? currentTexture : null,
                currentHeight <= 0f ? 1f : currentWidth / currentHeight,
                hasTexture ? Color.white : KindColor(obj.kind),
                obj.sortingOrder,
                LiftFor(obj.sortingOrder));

            if (image != null && imageLoader != null && !hasTexture && currentTexture == null)
            {
                var id = image.id;
                imageLoader.Load(id, texture =>
                {
                    // 取回来时对象可能已经被删 / 换图了：只认当前还在等的这一张
                    if (this == null || id != currentImageId)
                    {
                        return;
                    }

                    currentTexture = texture;
                    currentTextureId = id;
                });
            }
        }

        /// <summary>按显示顺序错开离地高度：大的略高一点，避免同平面共面闪烁（真正的遮挡靠 sortingOrder）。</summary>
        private static float LiftFor(int sortingOrder)
        {
            return 0.01f + Mathf.Clamp(sortingOrder, -100, 100) * 0.0005f;
        }

        /// <summary>没有图时的占位色（按对象种类区分，一眼看出「这儿有个对象」）。</summary>
        private static Color KindColor(string kind)
        {
            switch (kind)
            {
                case "Map":
                    return new Color(0.25f, 0.35f, 0.30f, 0.85f);
                case "Player":
                    return new Color(0.30f, 0.55f, 0.90f, 0.85f);
                case "Item":
                    return new Color(0.95f, 0.80f, 0.20f, 0.85f);
                case "Event":
                    return new Color(0.80f, 0.45f, 0.85f, 0.85f);
                case "PlaySound":
                    return new Color(0.95f, 0.55f, 0.25f, 0.85f);
                default:
                    return new Color(0.85f, 0.85f, 0.85f, 0.85f);
            }
        }
    }
}
