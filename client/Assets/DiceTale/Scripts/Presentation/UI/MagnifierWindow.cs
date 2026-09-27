using UnityEngine;
using UnityEngine.UI;

namespace DiceTale
{
    /// <summary>
    /// 放大镜窗口（代码构建，无 prefab）：**全屏半透明底 + 居中一张「线索卡」**。
    ///
    /// 它是**跑团时给玩家看重要信息**的那块画面（DM 从编辑器推上来），所以**层次与可读性优先**：
    /// - **三层明暗**：遮底最暗 → 面板较亮 → 里面「图」那一格更暗（像嵌进相框）、
    ///   「标题 / 文字」那两块更亮（像浮起来）——一眼分得清哪边是图、哪边是字；
    /// - **一圈 1px 描边 + 圆角**：圆角白图自己造一张 9-slice（见 <see cref="RoundedRectSprite"/>），
    ///   颜色由各块自己的 `Image.color` 上；
    /// - **标题带左边一条暖黄强调条**，与画布上那枚放大镜徽标同色（`#e8c840`）——这张卡属于它；
    /// - **字号按 1080p 参考分辨率给**（标题 40 / 正文 27 / 行距 1.35），文字太长时自动缩到装下
    ///   （最小 15）——跑团时隔着桌子也要读得清，宁可小一点也不要被截断。
    ///
    /// 它由 <see cref="CommandRouter"/> 按 `open_magnifier` / `close_magnifier` 两条命令开关——
    /// **自己没有任何按钮**（没有状态槽、也没有关闭），因为这就是需求：「只能后端来关闭」。
    /// 也**不吃点击**（从头到尾 `raycastTarget = false`）：窗口盖着的时候别的交互照常穿过去。
    ///
    /// **换状态 / 换图 / 改标题文字都不经过这里**：那是**文档数据**（`Magnifier.picked` 与
    /// `Magnifier.states`）——编辑器一改就整份 `scene_sync` 推下来，命令路由在镜像落地时把新
    /// 那一屏塞进来（见 <see cref="CommandRouter.OnSceneApplied"/>）。所以这里只有
    /// 「显示这一屏 / 关掉」两件事。
    ///
    /// 与编辑器那扇窗（`apps/editor/src/app/MagnifierDialog.tsx`）版式一致：上面标题、下面左图右文字；
    /// 差别是编辑器那扇**多一排状态槽与「添加状态」、多底栏那两个按钮**，这扇只有这一屏。
    /// </summary>
    [DisallowMultipleComponent]
    public class MagnifierWindow : UIWindow
    {
        // ---------------------------------------------------------------- 版式
        // 都是**1080p 参考分辨率下的像素**（CanvasScaler 会整体缩放，见 UIManager.EnsureCanvas）。

        /// <summary>面板占画布的多少（两侧各留一点边，看得出这是浮层）。</summary>
        private const float PanelMargin = 0.055f;

        /// <summary>面板内边距：内容离面板边这么远。</summary>
        private const float Padding = 28f;

        /// <summary>标题带的高度。</summary>
        private const float TitleHeight = 88f;

        /// <summary>两块卡片之间的间距（也是标题带与内容区之间的间距）。</summary>
        private const float Gap = 18f;

        /// <summary>图那一块占内容区宽度的多少，剩下的给右边文字。</summary>
        private const float ImageWidthRatio = 0.58f;

        /// <summary>图与它的相框之间的留白。</summary>
        private const float ImageInset = 12f;

        /// <summary>文字与它那块卡片之间的留白。</summary>
        private const float TextInset = 26f;

        /// <summary>描边粗细（也是圆角贴图 9-slice 的边宽）。</summary>
        private const float BorderWidth = 1.5f;

        /// <summary>正文自动缩放的下限：再长也不缩到这个字号以下（宁可截断也不要小到读不清）。</summary>
        private const int BodyMinFontSize = 16;

        /// <summary>正文字号（跑团时是投给玩家看的，按 1080p 参考分辨率给大一号）。</summary>
        private const int BodyFontSize = 30;

        /// <summary>标题字号。</summary>
        private const int TitleFontSize = 44;

        // ---------------------------------------------------------------- 颜色
        // 一层比一层亮：遮底 → 面板 → 卡片（图那格更暗、文字那格更亮）。

        private static readonly Color BackdropColor = new Color32(0x03, 0x05, 0x0A, 0xD6);
        private static readonly Color PanelFill = new Color32(0x14, 0x1A, 0x22, 0xFF);
        private static readonly Color PanelEdge = new Color32(0x2B, 0x35, 0x43, 0xFF);
        private static readonly Color BarFill = new Color32(0x1D, 0x25, 0x31, 0xFF);
        private static readonly Color BarEdge = new Color32(0x38, 0x45, 0x5A, 0xFF);
        private static readonly Color FrameFill = new Color32(0x0A, 0x0E, 0x14, 0xFF);
        private static readonly Color FrameEdge = new Color32(0x2B, 0x35, 0x43, 0xFF);
        private static readonly Color AccentColor = new Color32(0xE8, 0xC8, 0x40, 0xFF);
        private static readonly Color TitleColor = new Color32(0xF4, 0xF7, 0xFA, 0xFF);
        private static readonly Color BodyColor = new Color32(0xDD, 0xE4, 0xEC, 0xFF);

        /// <summary>圆角贴图（全窗共用一张白的，颜色由各块自己的 `Image.color` 上）。</summary>
        private static Sprite rounded;

        private Image image;
        private RectTransform titleBar;
        private Text titleText;
        private RectTransform frame;
        private RectTransform bodyCard;
        private RectTransform content;
        private Text bodyText;

        /// <summary>当前显示的那张资源逻辑 ID 与那一格（用来判断「同一张就别重建」）。</summary>
        private string currentId = "";
        private MirrorSprite currentSprite;
        private Texture2D currentTexture;

        /// <summary>运行时造出来的 Sprite：换一张时销毁旧的（纹理是取图器缓存的，**不能**跟着销毁）。</summary>
        private Sprite current;

        protected override void Awake()
        {
            base.Awake();
            Build();
        }

        protected override void OnDestroy()
        {
            DestroySprite();
            base.OnDestroy();
        }

        /// <summary>这张图是不是已经在窗里了（同一个 id + 同一格，**而且纹理还是那一个**）。</summary>
        public bool IsShowing(string imageId, Texture2D texture, MirrorSprite sprite)
        {
            return image != null
                && image.sprite != null
                && currentId == imageId
                && SameSprite(currentSprite, sprite)
                && ReferenceEquals(currentTexture, texture);
        }

        /// <summary>
        /// 换上要显示的那一屏；`sprite` 非空时只取图集里的那一格。
        ///
        /// 标题与文字**每次都直接覆盖**（它们是纯文本，改起来不要钱）；图是同一张、同一格、
        /// 同一个纹理时跳过重建——镜像每次落地都会叫一声（`OnSceneApplied`），而绝大多数
        /// 推送与这一屏无关。
        ///
        /// **这一屏没有图**（`state.Id` 为空，纯文字 / 只有标题的线索卡）时：把上一屏的图清掉，
        /// 图那一格整块收起来（版式见 <see cref="ApplyContent"/>）。
        /// </summary>
        public void Show(MagnifierStateView state, Texture2D texture)
        {
            if (state == null)
            {
                return;
            }

            var hasImage = !string.IsNullOrEmpty(state.Id);
            ApplyContent(state.Title, state.Text, hasImage);

            if (!hasImage)
            {
                DestroySprite();
                return;
            }

            if (image == null || texture == null || IsShowing(state.Id, texture, state.Sprite))
            {
                return;
            }

            var next = SpriteOf(texture, state.Sprite);
            DestroySprite();
            current = next;
            currentId = state.Id ?? "";
            currentSprite = state.Sprite;
            currentTexture = texture;

            image.sprite = next;
            image.color = Color.white;
            image.enabled = true;
        }

        /// <summary>窗口的显隐由基类管；图形本身没有别的状态要收拾（Sprite 在换成下一张 / 销毁时才清）。</summary>
        protected override void OnClose()
        {
            // 关掉时**留着**当前这一屏：再开一次（比如前端重连后补发）就是同一屏，`IsShowing` 直接命中。
        }

        /// <summary>
        /// 把标题与文字铺上去，并按「这一屏有什么」重排：
        /// - **没有标题** → 标题带整条不占位，内容区顶上去；
        /// - **没有图** → 图那一格整块收起来（纯文字 / 只有标题的线索卡），文字铺满整行；
        /// - **没有文字** → 文字那块不占位，图铺满整行。
        /// </summary>
        private void ApplyContent(string title, string body, bool hasImage)
        {
            var hasTitle = !string.IsNullOrEmpty(title);
            titleBar.gameObject.SetActive(hasTitle);
            titleText.text = hasTitle ? title : "";

            var hasBody = !string.IsNullOrEmpty(body);
            bodyCard.gameObject.SetActive(hasBody);
            bodyText.text = hasBody ? body : "";

            frame.gameObject.SetActive(hasImage);

            content.offsetMax = new Vector2(0f, hasTitle ? -(TitleHeight + Gap) : 0f);

            // 图与文字各占一边；只有一边时它铺满整行（另一边不占位）
            var split = hasImage && hasBody;
            frame.anchorMax = new Vector2(split ? ImageWidthRatio : 1f, 1f);
            frame.offsetMax = new Vector2(split ? -Gap : 0f, 0f);
            bodyCard.anchorMin = new Vector2(split ? ImageWidthRatio : 0f, 0f);
        }

        // ---------------------------------------------------------------- 搭界面

        private void Build()
        {
            // 根铺满画布：窗口一显示就盖住整屏（与字幕条那种「贴边」的不一样）
            Stretch(GetComponent<RectTransform>());

            // 遮底：最暗的一层（不吃点击）
            Stretch(CreateImage("Backdrop", transform, BackdropColor, null).rectTransform);

            // 面板：居中一块圆角卡片 + 一点投影（有投影才像浮在场景上）
            var panel = CreateImage("Panel", transform, PanelEdge, RoundedRectSprite());
            var panelRect = panel.rectTransform;
            panelRect.anchorMin = new Vector2(PanelMargin, PanelMargin);
            panelRect.anchorMax = new Vector2(1f - PanelMargin, 1f - PanelMargin);
            panelRect.offsetMin = Vector2.zero;
            panelRect.offsetMax = Vector2.zero;

            var shadow = panel.gameObject.AddComponent<Shadow>();
            shadow.effectColor = new Color(0f, 0f, 0f, 0.45f);
            shadow.effectDistance = new Vector2(0f, -8f);

            var panelFill = CreateImage("PanelFill", panelRect, PanelFill, RoundedRectSprite());
            Stretch(panelFill.rectTransform, BorderWidth);

            // 内边距：内容都挂它下面（于是内容离面板边正好 Padding）
            var padding = new GameObject("Padding", typeof(RectTransform));
            padding.transform.SetParent(panelFill.transform, false);
            var paddingRect = padding.GetComponent<RectTransform>();
            Stretch(paddingRect, Padding);

            // 标题带：上面一条（没有标题时整条不占位，见 ApplyContent）
            titleBar = CreateCard("TitleBar", paddingRect, BarFill, BarEdge, out var titleContent);
            titleBar.anchorMin = new Vector2(0f, 1f);
            titleBar.anchorMax = new Vector2(1f, 1f);
            titleBar.pivot = new Vector2(0.5f, 1f);
            titleBar.offsetMin = new Vector2(0f, -TitleHeight);
            titleBar.offsetMax = Vector2.zero;

            // 强调条：标题带左边一小截暖黄（与画布上那枚放大镜徽标同色）
            var accent = CreateImage("Accent", titleContent, AccentColor, RoundedRectSprite());
            var accentRect = accent.rectTransform;
            accentRect.anchorMin = new Vector2(0f, 0f);
            accentRect.anchorMax = new Vector2(0f, 1f);
            accentRect.pivot = new Vector2(0f, 0.5f);
            accentRect.offsetMin = new Vector2(22f, 22f);
            accentRect.offsetMax = new Vector2(30f, -22f);

            // 标题**居中**（左右留一样的边，免得长标题压到左边那条强调条上）
            titleText = CreateText("Title", titleContent, TitleFontSize, TextAnchor.MiddleCenter, FontStyle.Bold);
            titleText.color = TitleColor;
            titleText.rectTransform.anchorMin = Vector2.zero;
            titleText.rectTransform.anchorMax = Vector2.one;
            titleText.rectTransform.offsetMin = new Vector2(48f, 0f);
            titleText.rectTransform.offsetMax = new Vector2(-48f, 0f);

            // 内容区：标题带下面那一行（左边图、右边文字）
            var contentGo = new GameObject("Content", typeof(RectTransform));
            contentGo.transform.SetParent(paddingRect, false);
            content = contentGo.GetComponent<RectTransform>();
            content.anchorMin = Vector2.zero;
            content.anchorMax = Vector2.one;
            content.offsetMin = Vector2.zero;
            content.offsetMax = new Vector2(0f, -(TitleHeight + Gap));

            /*
              图那一块：**更暗**（像嵌进相框），里面那张等比装下。
              为什么不用「量出可视区再算像素」（编辑器那扇窗的 `fitBox` 那样）：uGUI 的
              `preserveAspect` 就是「在这个矩形里等比装下」，宽高比交给它，一行都不用算——
              编辑器那边要算是因为 canvas 还要按同一块矩形做像素级擦除，这里没有那件事。
            */
            frame = CreateCard("Frame", content, FrameFill, FrameEdge, out var frameContent);
            frame.anchorMin = new Vector2(0f, 0f);
            frame.anchorMax = new Vector2(ImageWidthRatio, 1f);
            frame.offsetMin = Vector2.zero;
            frame.offsetMax = new Vector2(-Gap, 0f);

            var imageGo = new GameObject("Image", typeof(Image));
            imageGo.transform.SetParent(frameContent, false);
            image = imageGo.GetComponent<Image>();
            Stretch(image.rectTransform, ImageInset);
            image.preserveAspect = true;
            image.raycastTarget = false;
            image.enabled = false;

            // 文字那一块：与标题带同色（浮起来的一层）
            bodyCard = CreateCard("Body", content, BarFill, FrameEdge, out var bodyContent);
            bodyCard.anchorMin = new Vector2(ImageWidthRatio, 0f);
            bodyCard.anchorMax = Vector2.one;
            bodyCard.offsetMin = Vector2.zero;
            bodyCard.offsetMax = Vector2.zero;

            bodyText = CreateText("Text", bodyContent, BodyFontSize, TextAnchor.UpperLeft, FontStyle.Normal);
            bodyText.color = BodyColor;
            bodyText.lineSpacing = 1.35f;
            // 长文自动缩到装下（下限 BodyMinFontSize）：跑团时信息宁可小一点，也不要被截掉半句
            bodyText.resizeTextForBestFit = true;
            bodyText.resizeTextMinSize = BodyMinFontSize;
            bodyText.resizeTextMaxSize = BodyFontSize;
            Stretch(bodyText.rectTransform, TextInset);
        }

        /// <summary>
        /// 一块**圆角卡片**（外面一圈 1px 边）：返回外层（**布局挂在它上面**），
        /// 内层（子节点挂它上面，不会被那条边压住）从 `content` 出来。
        /// </summary>
        private static RectTransform CreateCard(
            string name,
            Transform parent,
            Color fill,
            Color edge,
            out RectTransform content)
        {
            var card = CreateImage(name, parent, edge, RoundedRectSprite());
            var inner = CreateImage(name + "Fill", card.transform, fill, RoundedRectSprite());
            Stretch(inner.rectTransform, BorderWidth);
            content = inner.rectTransform;
            return card.rectTransform;
        }

        private static Image CreateImage(string name, Transform parent, Color color, Sprite sprite)
        {
            var go = new GameObject(name, typeof(Image));
            go.transform.SetParent(parent, false);
            var created = go.GetComponent<Image>();
            created.color = color;
            created.raycastTarget = false;
            if (sprite != null)
            {
                created.sprite = sprite;
                created.type = Image.Type.Sliced;
            }

            return created;
        }

        /// <summary>造一块白字带黑描边的文本（可读性优先，与字幕条同一套）。</summary>
        private static Text CreateText(
            string name,
            Transform parent,
            int fontSize,
            TextAnchor alignment,
            FontStyle style)
        {
            var go = new GameObject(name, typeof(Text));
            go.transform.SetParent(parent, false);
            var created = go.GetComponent<Text>();
            created.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            created.fontSize = fontSize;
            created.fontStyle = style;
            created.alignment = alignment;
            created.color = Color.white;
            created.horizontalOverflow = HorizontalWrapMode.Wrap;
            created.verticalOverflow = VerticalWrapMode.Truncate;
            created.raycastTarget = false;

            var outline = go.AddComponent<Outline>();
            outline.effectColor = new Color(0f, 0f, 0f, 0.8f);
            outline.effectDistance = new Vector2(1.5f, -1.5f);
            return created;
        }

        /// <summary>铺满父节点（`inset` = 四边各内缩多少）。</summary>
        private static void Stretch(RectTransform rect, float inset = 0f)
        {
            rect.anchorMin = Vector2.zero;
            rect.anchorMax = Vector2.one;
            rect.offsetMin = new Vector2(inset, inset);
            rect.offsetMax = new Vector2(-inset, -inset);
        }

        /// <summary>
        /// **圆角矩形**的 9-slice 白图：**全窗共用一张**，颜色由各块自己的 `Image.color` 上
        /// （边框 = 外面铺满一张、里面再铺一张内缩 `BorderWidth` 的，两层不同色）。
        ///
        /// 为什么要自己造：这扇窗是**代码构建**（仓库里没有 prefab），而 Unity 6 里内置的那几张
        /// `UI/Skin/*.psd`（`Resources.GetBuiltinResource<Sprite>`）**已经拿不到了**（实测返回 null），
        /// 项目里也没有 UI 素材。生成一次就缓存（`HideAndDontSave`：不进场景、不随场景卸载走）。
        /// </summary>
        private static Sprite RoundedRectSprite()
        {
            if (rounded != null)
            {
                return rounded;
            }

            const int size = 64;
            const int radius = 18;
            var texture = new Texture2D(size, size, TextureFormat.RGBA32, false)
            {
                hideFlags = HideFlags.HideAndDontSave,
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Bilinear,
            };

            var half = size * 0.5f;
            for (var y = 0; y < size; y++)
            {
                for (var x = 0; x < size; x++)
                {
                    // 圆角矩形的有符号距离（< 0 在里面）；边缘留 1px 过渡，圆角不锯齿
                    var qx = Mathf.Abs(x + 0.5f - half) - (half - radius);
                    var qy = Mathf.Abs(y + 0.5f - half) - (half - radius);
                    var outside = new Vector2(Mathf.Max(qx, 0f), Mathf.Max(qy, 0f)).magnitude;
                    var distance = outside + Mathf.Min(Mathf.Max(qx, qy), 0f) - radius;
                    texture.SetPixel(x, y, new Color(1f, 1f, 1f, Mathf.Clamp01(0.5f - distance)));
                }
            }

            texture.Apply();
            rounded = Sprite.Create(
                texture,
                new Rect(0f, 0f, size, size),
                new Vector2(0.5f, 0.5f),
                100f,
                0,
                SpriteMeshType.FullRect,
                new Vector4(radius, radius, radius, radius));
            rounded.hideFlags = HideFlags.HideAndDontSave;
            return rounded;
        }

        /// <summary>
        /// 从纹理造一份「整张图或其中一格」的 Sprite：`null` = 整张。
        ///
        /// 矩形由 <see cref="SpriteLayer.UvRectOf"/> 算——那里是**全链路唯一一次 y 翻转**
        /// （格序数从左上数、纹理 UV 自下而上），放大镜不另写一份，于是与对象自己的子图
        /// 画出来的是同一块。
        /// </summary>
        public static Sprite SpriteOf(Texture2D texture, MirrorSprite sprite)
        {
            var uv = SpriteLayer.UvRectOf(sprite);
            return Sprite.Create(
                texture,
                new Rect(
                    uv.x * texture.width,
                    uv.y * texture.height,
                    uv.z * texture.width,
                    uv.w * texture.height),
                new Vector2(0.5f, 0.5f),
                100f);
        }

        private void DestroySprite()
        {
            if (current != null)
            {
                Destroy(current);
                current = null;
            }

            currentId = "";
            currentSprite = null;
            currentTexture = null;
            if (image != null)
            {
                image.sprite = null;
            }
        }

        private static bool SameSprite(MirrorSprite left, MirrorSprite right)
        {
            if (left == null || right == null)
            {
                return left == right;
            }

            return left.columns == right.columns
                && left.rows == right.rows
                && left.column == right.column
                && left.row == right.row;
        }
    }
}
