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
    ///   尺寸由 <see cref="TextureRenderer"/> 烘进网格顶点，本组件**不碰 `localScale`**
    ///   （保持 1，这样根节点的缩放才是唯一影响整体大小的因素）；
    /// - `active` = 是否显示（编辑器那个勾选框一改，这里就出现 / 消失）；
    /// - `sortingOrder` = 遮挡顺序（大的盖在上面）；
    /// - 有图就去取图贴上（本地资源包优先）；没图（或还没取回来）先用按 `kind` 区分的底色占位，
    ///   **保证每个对象都看得见**。
    ///
    /// 面片本身由 <see cref="TextureRenderer"/> 画——它只认运行时纹理，
    /// 因为镜像的图来自后台推下来的资源 ID，不是 Inspector 里拖的 Sprite。
    ///
    /// **动作对象不建视图**：`PlaySound` / `Teleport` 只是「一条给前端的指令」（要播哪条声音、
    /// 要换到哪张图），编辑器画布上那两枚徽标是**编辑器**的画法，前端按自己的表现来。
    /// 它们的数据留在镜像里就够了，所以 <see cref="SceneMirror"/> 根本不会为它们调
    /// <see cref="Create"/>（见 <see cref="NeedsView"/>）——这里的每一行都假定「自己是个实体」。
    ///
    /// **绑了雾区的地图多一个同级的 `FogOverlay`**（<see cref="FogOfWar"/>）：它挂在**场景根节点**下
    /// （与地图并列，不是地图的子物体）、尺寸与地图面片同大、位置与角度按地图同一份数值各摆一遍，
    /// 显示顺序取<a cref="FogSortingOrder">最前面</a>——未探索的地方连对象一起盖住。
    /// 没绑雾区的地图不会有它（见 <see cref="ApplyFog"/>）。
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

        /// <summary>雾层子物体的名字（一眼看出层级里多出来的这一块是什么）。</summary>
        private const string FogOverlayName = "FogOverlay";

        /// <summary>
        /// 雾层的显示顺序：**盖在所有东西前面**（未探索 = 连上面的令牌一起看不见）。
        ///
        /// 文档里的 `sortingOrder` 是给对象自己排前后用的（默认范围很小），雾不该跟它们比大小；
        /// 取 `short.MaxValue`（Unity 的 `sortingOrder` 是 16 位有符号），实际就是「最前面」。
        /// 已经揭示的地方雾是透明的，所以不会挡住该看见的东西。
        /// </summary>
        private const int FogSortingOrder = short.MaxValue;

        /// <summary>
        /// 雾层比自己那张地图高多少（**世界单位**）：只求比地图抬升高一档、别跟地图共面。
        ///
        /// 地图自己的抬升按 `sortingOrder` 每档差 `0.0005`（见 <see cref="LiftFor"/>），
        /// 所以这里给 `0.002` 就够——高了会在斜视角下看起来「浮起来」。
        /// </summary>
        private const float FogLift = 0.002f;

        private TextureRenderer quad;
        private ResourceImageLoader imageLoader;

        /// <summary>这张对象的地图数据（仅 `Map`；`map.fog.regions` 非空时才会建雾层）。</summary>
        private MirrorMap currentMap;

        /// <summary>雾层（仅绑了雾区的地图有；**与地图同级**，命令路由经 <see cref="Fog"/> 找到它）。</summary>
        private FogOfWar fog;

        /// <summary>对象在文档里的位置 / 角度（雾层与地图同级，要各自摆一遍，所以留一份）。</summary>
        private float currentX;
        private float currentY;
        private float currentRotation;

        private string currentImageId = "";
        private string currentTextureId = "";
        private Texture2D currentTexture;
        private float currentWidth = FallbackSize;
        private float currentHeight = FallbackSize;

        /// <summary>
        /// 这种对象在前端**要不要建视图**（连 GameObject 都不该建的那种返回 `false`）。
        ///
        /// **实体要、动作不要**：地图 / 精灵 / 玩家 / 道具 / 事件都在世界里看得见摸得着；
        /// `PlaySound` / `Teleport` 只是「一条给前端的指令」——声音靠命令来播，传送靠编辑器
        /// 换场景（整份 `scene_push`）——它们的**数据留在镜像里**（命令要用它取数据）就够了。
        ///
        /// 判据放在**一处**（<see cref="SceneMirror"/> 建视图前问这里）：新加一种动作对象时，
        /// 只改这一个地方，不会出现「镜像建了、却忘了在别处跳过」的半套状态。
        /// </summary>
        public static bool NeedsView(string kind)
        {
            return kind != "PlaySound" && kind != "Teleport";
        }

        /// <summary>最近一次对象数据里的染色与显示顺序（<see cref="ApplyVisual"/> 要用，含异步取图回来那次）。</summary>
        private Color currentKindColor = new Color(0.85f, 0.85f, 0.85f, 0.85f);
        private int currentSortingOrder;

        /// <summary>按对象建视图（地图 / 精灵 / 任意实体都先建一块面片；动作对象**根本不建**，见 <see cref="NeedsView"/>）。</summary>
        public static SceneObjectView Create(MirrorObject obj, Transform parent, ResourceImageLoader loader)
        {
            var go = new GameObject(obj.id);
            go.transform.SetParent(parent, false);
            var view = go.AddComponent<SceneObjectView>();
            view.imageLoader = loader;
            view.quad = go.AddComponent<TextureRenderer>();
            return view;
        }

        /// <summary>把最新的对象数据应用到视图上（每次推送都会调；**只对实体**，见 <see cref="NeedsView"/>）。</summary>
        public void Apply(MirrorObject obj)
        {
            gameObject.name = string.IsNullOrEmpty(obj.name) ? obj.id : $"{obj.name}（{obj.id}）";

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
            currentX = obj.x;
            currentY = obj.y;
            currentRotation = obj.rotation;
            Place(transform);

            var image = obj.DisplayImage;
            currentWidth = (image != null && image.width > 0 ? image.width : FallbackSize) * obj.scale;
            currentHeight = (image != null && image.height > 0 ? image.height : FallbackSize) * obj.scale;
            currentImageId = image != null ? image.id : "";
            currentKindColor = KindColor(obj.kind);
            currentSortingOrder = obj.sortingOrder;
            currentMap = obj.map;

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
            var lift = LiftFor(currentSortingOrder);
            quad.Apply(
                hasTexture ? currentTexture : null,
                currentWidth * scale,
                currentHeight * scale,
                hasTexture ? Color.white : currentKindColor,
                currentSortingOrder,
                lift);

            ApplyFog(lift);
        }

        /// <summary>
        /// 雾层：**这张地图绑了雾区就建 / 刷，没绑就把旧的拆掉**（每次重画都会走这里）。
        ///
        /// 雾层与地图**同级**（都挂在场景根节点下，见 <see cref="FogOverlayName"/>）：
        /// 它不是地图的一部分，而是盖在整个场景之上的一层——所以位置 / 角度要**自己摆一遍**
        /// （<see cref="Place"/> 与地图同一份算法），显示顺序取最前面（<see cref="FogSortingOrder"/>），
        /// 未探索的地方连对象一起盖住。
        ///
        /// **谁算雾、怎么揭示**由 <see cref="FogOfWar"/> 自己管（后台命令驱动），这里只负责摆放。
        /// </summary>
        private void ApplyFog(float mapLift)
        {
            var map = currentMap;
            var hasFog = map != null && map.fogRegions != null && map.fogRegions.Length > 0;

            if (!hasFog)
            {
                if (fog != null)
                {
                    // 绑定被解开了（或本来就不是地图）：把雾层拆掉，别留一块盖着旧遮罩的面片
                    Destroy(fog.gameObject);
                    fog = null;
                }

                return;
            }

            if (fog == null)
            {
                var go = new GameObject(FogOverlayName);
                // **与地图同级**：挂在场景根节点下（视图的父节点），不是地图的子物体
                go.transform.SetParent(transform.parent != null ? transform.parent : transform, false);
                fog = go.AddComponent<FogOfWar>();
            }

            Place(fog.transform);

            var scale = GlobalScale;
            fog.Apply(
                map,
                currentWidth * scale,
                currentHeight * scale,
                FogSortingOrder,
                mapLift + FogLift);
        }

        /// <summary>
        /// 把一个面片摆到「这个对象在世界里的位置与角度」（**局部坐标**：相对所在场景的根节点）。
        ///
        /// 地图视图与它的雾层是**两个同级物体**，位置 / 角度必须各自摆——摆的是同一份数值
        /// （<see cref="currentX"/> / <see cref="currentY"/> / <see cref="currentRotation"/>），
        /// 所以两者永远重合。y（离地抬升）不在这里设：它由渲染器按自己的显示顺序给。
        /// </summary>
        private void Place(Transform target)
        {
            var scale = GlobalScale;
            target.localPosition = new Vector3(currentX * scale, target.localPosition.y, currentY * scale);

            // 角度：文档里存的是**弧度**（编辑器的 `SceneObject.rotation` 与参考实现同一套），
            // 而 `Quaternion.Euler` 收的是**度**——必须 `Rad2Deg` 换算，
            // 否则 30° 会被当成 0.52°（弧度值直接当度用）。
            // 符号与 Unity 一致（文档正角 = Unity 里正的 Y 轴旋转），所以不取反。
            target.localRotation = Quaternion.Euler(0f, currentRotation * Mathf.Rad2Deg, 0f);
        }

        /// <summary>这一层的雾（没绑雾区的地图返回 null）；命令路由用它执行 `erase_mask` / `reveal_fog_region`。</summary>
        public FogOfWar Fog => fog;

        /// <summary>
        /// 视图被销毁（对象被删 / 换场景）时，把雾层一起带走。
        ///
        /// 雾层是**同级**物体、不是子物体，Unity 不会跟着销毁——不在这里收，它会留在地图上
        /// 盖着一块谁也点不到、也擦不掉的旧雾。
        /// </summary>
        private void OnDestroy()
        {
            if (fog != null)
            {
                Destroy(fog.gameObject);
                fog = null;
            }
        }

        /// <summary>按显示顺序错开离地高度：大的略高一点，避免同平面共面闪烁（真正的遮挡靠 sortingOrder）。</summary>
        private static float LiftFor(int sortingOrder)
        {
            return 0.01f + Mathf.Clamp(sortingOrder, -100, 100) * 0.0005f;
        }

        /// <summary>
        /// 没有图时的占位色（按对象种类区分，一眼看出「这儿有个对象」）。
        ///
        /// 没有 `PlaySound` / `Teleport` 分支：动作对象**根本不建视图**（见 <see cref="NeedsView"/>），
        /// 永远走不到这里——写了也是死代码。
        /// </summary>
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
                default:
                    return new Color(0.85f, 0.85f, 0.85f, 0.85f);
            }
        }
    }
}
