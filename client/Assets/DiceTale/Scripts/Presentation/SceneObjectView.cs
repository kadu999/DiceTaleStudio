using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 一个镜像对象的视图：**一块贴在地面上的面片**（地图与精灵都走它）。
    ///
    /// 属性怎么来（全部来自后台推下来的对象数据）：
    /// - 位置 = `position`（文档世界坐标 x/y 向上 → 客户端 x/z + 离地抬升）；
    ///   写的是 **`localPosition` / `localRotation`**——相对所在**场景的根节点**，
    ///   所以根节点可以自由平移 / 旋转 / **缩放**，整棵场景一起变，不用逐个改世界坐标；
    /// - 大小 = 声明尺寸（`image` / `map.image`）× `scale` × **<see cref="GlobalScale"/>**
    ///   ——后者是「文档像素 → 世界单位」的全局换算，位置也乘它；
    ///   尺寸由 <see cref="GroundTextureRenderer"/> 烘进网格顶点，本组件**不碰 `localScale`**
    ///   （保持 1，这样根节点的缩放才是唯一影响整体大小的因素）；
    /// - `active` = 是否显示（编辑器那个勾选框一改，这里就出现 / 消失）；
    /// - `sortingOrder` = 遮挡顺序（大的盖在上面）；
    /// - 有图就去取图贴上（本地资源包优先）；没图（或还没取回来）先用按 `kind` 区分的底色占位，
    ///   **保证每个对象都看得见**。
    ///
    /// 面片本身由 <see cref="GroundTextureRenderer"/> 画——它只认运行时纹理，
    /// 因为镜像的图来自后台推下来的资源 ID，不是 Inspector 里拖的 Sprite。
    ///
    /// 声音对象（`PlaySound`）不建可见物——编辑器里那枚音频图标只是**编辑器**的画法，
    /// 前端按自己的表现来；它的数据留在镜像里（`sound.picked` 就是该播的那条）。
    /// </summary>
    public class SceneObjectView : MonoBehaviour
    {
        /// <summary>
        /// **全局缩放**：文档像素 → 世界单位的唯一那根指针。想改整体大小就改它。
        ///
        /// 文档里的尺寸与坐标都是**像素**（那张地图 1920×1080、精灵 256×256、
        /// 位置像 `(-108.74, -56.60)`），直接当世界单位用会大得离谱，所以统一乘这个系数：
        /// **尺寸**（声明尺寸 × 对象 scale）与**位置**都乘它——两者必须同一个系数，
        /// 否则对象会被摆到远超自身尺寸的地方。
        ///
        /// 默认 `0.01`：1920×1080 的地图 → 19.2×10.8 个单位，256×256 的精灵 → 2.56×2.56 个单位。
        /// 运行时也能改（下一帧推送或下一次 `ApplyVisual` 生效）。
        ///
        /// 想**整场景**一起缩放（连格子、连雾一起）请改场景根节点的 Transform——
        /// 那是另一层，`localPosition` 会跟着根节点走。
        /// </summary>
        public static float GlobalScale = 0.01f;

        /// <summary>没声明尺寸时的兜底边长（**文档像素**，与编辑器画布上那块兜底矩形同口径）。</summary>
        private const float FallbackSize = 64f;

        private GroundTextureRenderer quad;
        private ResourceImageLoader imageLoader;

        private string currentImageId = "";
        private string currentTextureId = "";
        private Texture2D currentTexture;
        private float currentWidth = FallbackSize;
        private float currentHeight = FallbackSize;

        /// <summary>最近一次对象数据里的染色与显示顺序（<see cref="ApplyVisual"/> 要用，含异步取图回来那次）。</summary>
        private Color currentKindColor = new Color(0.85f, 0.85f, 0.85f, 0.85f);
        private int currentSortingOrder;

        /// <summary>按对象建视图（地图 / 精灵 / 任意实体都先建一块面片；声音对象除外）。</summary>
        public static SceneObjectView Create(MirrorObject obj, Transform parent, ResourceImageLoader loader)
        {
            var go = new GameObject(obj.id);
            go.transform.SetParent(parent, false);
            var view = go.AddComponent<SceneObjectView>();
            view.imageLoader = loader;
            view.quad = go.AddComponent<GroundTextureRenderer>();
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

            // **用局部坐标**：位置/旋转都相对所在场景的根节点。
            // 这样整棵场景可以被根节点平移、旋转、**缩放**（比如把场景缩到 0.5 倍看全局），
            // 里面的对象跟着一起变，而不用逐个改世界坐标。
            // 文档 y 向上 → 客户端 +Z（与 GridMap.WorldToGrid 同口径）；y 只用来避免共面闪烁。
            //
            // 位置是**文档像素**，乘同一个 GlobalScale（与尺寸同系数，否则会被摆到离谱的地方）；
            // y（离地抬升）是**世界单位**，不参与缩放。
            var scale = GlobalScale;
            transform.localPosition = new Vector3(obj.x * scale, 0f, obj.y * scale);
            transform.localRotation = Quaternion.Euler(0f, -obj.rotation, 0f);

            var image = obj.DisplayImage;
            currentWidth = (image != null && image.width > 0 ? image.width : FallbackSize) * obj.scale;
            currentHeight = (image != null && image.height > 0 ? image.height : FallbackSize) * obj.scale;
            currentImageId = image != null ? image.id : "";
            currentKindColor = KindColor(obj.kind);
            currentSortingOrder = obj.sortingOrder;

            ApplyVisual();

            if (image != null && imageLoader != null && currentTextureId != currentImageId)
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

                    // **关键**：取图是异步的，首帧必然是占位色；拿到图（或确知取不到）之后
                    // 这里必须自己重画一次——否则要到下一次推送才更新，而命中缓存时那次推送
                    // 根本不会调回来（表现为「图在缓存里，画面上却一直是占位色」）。
                    ApplyVisual();
                });
            }
        }

        /// <summary>
        /// 把当前的尺寸 / 染色 / 纹理应用到面片上（**每次都调，含异步取图回来之后**）。
        ///
        /// 拆出来是因为「对象数据变了」和「图取回来了」是两个独立时机：只按前者画，
        /// 首帧永远只有占位色，而命中缓存的那次推送不会回调这里。
        /// </summary>
        private void ApplyVisual()
        {
            var hasTexture = currentTexture != null && currentImageId.Length > 0 && currentTextureId == currentImageId;

            // 声明尺寸（× 对象 scale）先乘全局缩放折成世界单位，再交给渲染器**烘进网格顶点**——
            // 这里不碰 transform.localScale（尺寸只有一个来源，网格自己）。
            var scale = GlobalScale;
            quad.Apply(
                hasTexture ? currentTexture : null,
                currentWidth * scale,
                currentHeight * scale,
                hasTexture ? Color.white : currentKindColor,
                currentSortingOrder,
                LiftFor(currentSortingOrder));
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
