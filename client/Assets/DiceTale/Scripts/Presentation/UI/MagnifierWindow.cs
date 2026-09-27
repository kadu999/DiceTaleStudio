using UnityEngine;
using UnityEngine.UI;

namespace DiceTale
{
    /// <summary>
    /// 放大镜窗口（代码构建，无 prefab）：**全屏半透明底 + 居中一屏画面**——
    /// 上面一行标题（有才占位）、下面**左边一张图、右边一段文字**。
    ///
    /// 它由 <see cref="CommandRouter"/> 按 `open_magnifier` / `close_magnifier` 两条命令开关——
    /// **自己没有任何按钮**（没有选择、也没有关闭），因为这就是需求：「只能后端来关闭」。
    /// 也**不吃点击**（从头到尾 `raycastTarget = false`）：窗口盖着的时候别的交互照常穿过去。
    ///
    /// **换状态 / 换图 / 改标题文字都不经过这里**：那是**文档数据**（`Magnifier.picked` 与
    /// `Magnifier.states`）——编辑器一改就整份 `scene_sync` 推下来，命令路由在镜像落地时把新
    /// 那一屏塞进来（见 <see cref="CommandRouter.OnSceneApplied"/>）。所以这里只有
    /// 「显示这一屏 / 关掉」两件事。
    ///
    /// 与编辑器那扇窗（`apps/editor/src/app/MagnifierDialog.tsx`）长得一样，差别正是用户说的那两点：
    /// 编辑器那扇**多下面一排状态槽与「添加状态」、多底栏那两个按钮**，这扇只有上面那块画面。
    /// </summary>
    [DisallowMultipleComponent]
    public class MagnifierWindow : UIWindow
    {
        /// <summary>遮底的颜色：压暗后面的场景，让画面本身更清楚（与编辑器窗口的 `bg-black/40` 同一档）。</summary>
        private static readonly Color BackdropColor = new Color(0f, 0f, 0f, 0.72f);

        /// <summary>面板底色：比遮底再实一点，图与文字都装在里面（与编辑器那块 `bg-black/40` 同义）。</summary>
        private static readonly Color PanelColor = new Color(0.05f, 0.06f, 0.08f, 0.92f);

        /// <summary>面板占画布的多少（两侧各留一点边，看得出这是浮层）——见 <see cref="Build"/>。</summary>
        private const float PanelMargin = 0.06f;

        /// <summary>标题那一行的高度（**没有标题时整行不占位**，内容区顶上去）。</summary>
        private const float TitleHeight = 64f;

        /// <summary>图占内容区宽度的多少，剩下的给右边那段文字。</summary>
        private const float ImageWidthRatio = 0.6f;

        private Image image;
        private Text titleText;
        private Text bodyText;
        private RectTransform content;

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
        /// </summary>
        public void Show(MagnifierStateView state, Texture2D texture)
        {
            if (state == null)
            {
                return;
            }

            ApplyTexts(state.Title, state.Text);

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

        /// <summary>把标题与文字铺上去；**没有标题时那一行整个不占位**（内容区顶上去）。</summary>
        private void ApplyTexts(string title, string body)
        {
            var hasTitle = !string.IsNullOrEmpty(title);
            titleText.text = hasTitle ? title : "";
            titleText.gameObject.SetActive(hasTitle);
            bodyText.text = body ?? "";

            var top = hasTitle ? -(TitleHeight + 8f) : -12f;
            content.offsetMax = new Vector2(-12f, top);
        }

        private void Build()
        {
            // 根铺满画布：窗口一显示就盖住整屏（与字幕条那种「贴边」的不一样）
            var root = GetComponent<RectTransform>();
            root.anchorMin = Vector2.zero;
            root.anchorMax = Vector2.one;
            root.offsetMin = Vector2.zero;
            root.offsetMax = Vector2.zero;

            // 半透明底（不吃点击）
            var backdrop = CreateImage("Backdrop", transform, BackdropColor);
            Stretch(backdrop.rectTransform);

            // 面板：居中一块深色底，标题 / 图 / 文字都装在里面
            var panel = CreateImage("Panel", transform, PanelColor);
            var panelRect = panel.rectTransform;
            panelRect.anchorMin = new Vector2(PanelMargin, PanelMargin);
            panelRect.anchorMax = new Vector2(1f - PanelMargin, 1f - PanelMargin);
            panelRect.offsetMin = Vector2.zero;
            panelRect.offsetMax = Vector2.zero;

            // 标题（上面一行；没有标题时整行不显示，见 ApplyTexts）
            titleText = CreateText("Title", panelRect, 40, TextAnchor.MiddleCenter, FontStyle.Bold);
            var titleRect = titleText.rectTransform;
            titleRect.anchorMin = new Vector2(0f, 1f);
            titleRect.anchorMax = new Vector2(1f, 1f);
            titleRect.pivot = new Vector2(0.5f, 1f);
            titleRect.offsetMin = new Vector2(16f, -TitleHeight - 8f);
            titleRect.offsetMax = new Vector2(-16f, -8f);

            // 内容区：左边图 + 右边文字（顶边由 ApplyTexts 按有没有标题调）
            var contentGo = new GameObject("Content", typeof(RectTransform));
            contentGo.transform.SetParent(panelRect, false);
            content = contentGo.GetComponent<RectTransform>();
            content.anchorMin = Vector2.zero;
            content.anchorMax = Vector2.one;
            content.offsetMin = new Vector2(12f, 12f);
            content.offsetMax = new Vector2(-12f, -12f);

            /*
              左边那张图：占内容区的 60%，**等比缩放**（`preserveAspect`）。
              为什么不用「量出可视区再算像素」（编辑器那扇窗的 `fitBox` 那样）：uGUI 的
              `preserveAspect` 就是「在这个矩形里等比装下」，宽高比交给它，一行都不用算——
              编辑器那边要算是因为 canvas 还要按同一块矩形做像素级擦除，这里没有那件事。
            */
            var imageGo = new GameObject("Image", typeof(Image));
            imageGo.transform.SetParent(content, false);
            image = imageGo.GetComponent<Image>();
            var rect = image.rectTransform;
            rect.anchorMin = new Vector2(0f, 0f);
            rect.anchorMax = new Vector2(ImageWidthRatio, 1f);
            rect.offsetMin = Vector2.zero;
            rect.offsetMax = Vector2.zero;
            image.preserveAspect = true;
            image.raycastTarget = false;
            image.enabled = false;

            // 右边那段文字（多行，左上起排；换行照原样）
            bodyText = CreateText("Text", content, 28, TextAnchor.UpperLeft, FontStyle.Normal);
            var bodyRect = bodyText.rectTransform;
            bodyRect.anchorMin = new Vector2(ImageWidthRatio, 0f);
            bodyRect.anchorMax = new Vector2(1f, 1f);
            bodyRect.offsetMin = new Vector2(16f, 0f);
            bodyRect.offsetMax = Vector2.zero;
        }

        private static Image CreateImage(string name, Transform parent, Color color)
        {
            var go = new GameObject(name, typeof(Image));
            go.transform.SetParent(parent, false);
            var created = go.GetComponent<Image>();
            created.color = color;
            created.raycastTarget = false;
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

        private static void Stretch(RectTransform rect)
        {
            rect.anchorMin = Vector2.zero;
            rect.anchorMax = Vector2.one;
            rect.offsetMin = Vector2.zero;
            rect.offsetMax = Vector2.zero;
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
