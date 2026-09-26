using UnityEngine;
using UnityEngine.UI;

namespace DiceTale
{
    /// <summary>
    /// 放大镜窗口（代码构建，无 prefab）：**全屏半透明底 + 居中一张等比放大的图**。
    ///
    /// 它由 <see cref="CommandRouter"/> 按 `open_magnifier` / `close_magnifier` 两条命令开关——
    /// **自己没有任何按钮**（没有选择、也没有关闭），因为这就是需求：「只能后端来关闭」。
    /// 也**不吃点击**（从头到尾 `raycastTarget = false`）：窗口盖着的时候别的交互照常穿过去。
    ///
    /// **换图不经过这里**：展示哪一张是**文档数据**（`Magnifier.picked`）——编辑器一改就整份
    /// `scene_sync` 推下来，命令路由在镜像落地时把新那张塞进来（见
    /// <see cref="CommandRouter.OnSceneApplied"/>）。所以这里只有「显示这一张 / 关掉」两件事。
    ///
    /// 与编辑器那扇窗（`apps/editor/src/app/MagnifierDialog.tsx`）长得一样，差别正是用户说的那两点：
    /// 编辑器那扇**多一排可以选的小图、多两个按钮**，这扇只有中间那张。
    /// </summary>
    [DisallowMultipleComponent]
    public class MagnifierWindow : UIWindow
    {
        /// <summary>遮底的颜色：压暗后面的场景，让图本身更清楚（与编辑器窗口的 `bg-black/40` 同一档）。</summary>
        private static readonly Color BackdropColor = new Color(0f, 0f, 0f, 0.72f);

        /// <summary>中间那张图占画布的多少（两侧各留一点边，看得出这是浮层）——见 <see cref="Build"/>。</summary>
        private const float StageMargin = 0.06f;

        private Image image;

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

        /// <summary>这一张是不是已经在窗里了（同一个 id + 同一格，**而且纹理还是那一个**）。</summary>
        public bool IsShowing(string imageId, Texture2D texture, MirrorSprite sprite)
        {
            return image != null
                && image.sprite != null
                && currentId == imageId
                && SameSprite(currentSprite, sprite)
                && ReferenceEquals(currentTexture, texture);
        }

        /// <summary>
        /// 换上要显示的那一张；`sprite` 非空时只取图集里的那一格。
        ///
        /// 同一张、同一格、同一个纹理时**直接返回**（省掉一次重建）：镜像每次落地都会叫一声
        /// （`OnSceneApplied`），而绝大多数推送与这张图无关。
        /// </summary>
        public void Show(string imageId, Texture2D texture, MirrorSprite sprite)
        {
            if (image == null || texture == null || IsShowing(imageId, texture, sprite))
            {
                return;
            }

            var next = SpriteOf(texture, sprite);
            DestroySprite();
            current = next;
            currentId = imageId ?? "";
            currentSprite = sprite;
            currentTexture = texture;

            image.sprite = next;
            image.color = Color.white;
            image.enabled = true;
        }

        /// <summary>窗口的显隐由基类管；图形本身没有别的状态要收拾（Sprite 在换成下一张 / 销毁时才清）。</summary>
        protected override void OnClose()
        {
            // 关掉时**留着**当前这张：再开一次（比如前端重连后补发）就是同一张，`IsShowing` 直接命中。
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
            var backdrop = new GameObject("Backdrop", typeof(Image));
            backdrop.transform.SetParent(transform, false);
            var backdropRect = backdrop.GetComponent<RectTransform>();
            backdropRect.anchorMin = Vector2.zero;
            backdropRect.anchorMax = Vector2.one;
            backdropRect.offsetMin = Vector2.zero;
            backdropRect.offsetMax = Vector2.zero;
            var backdropImage = backdrop.GetComponent<Image>();
            backdropImage.color = BackdropColor;
            backdropImage.raycastTarget = false;

            /*
              中间那张图：占画布的 88%，**等比缩放**（`preserveAspect`）。
              为什么不用「量出可视区再算像素」（编辑器那扇窗的 `fitBox` 那样）：uGUI 的
              `preserveAspect` 就是「在这个矩形里等比装下」，宽高比交给它，一行都不用算——
              编辑器那边要算是因为 canvas 还要按同一块矩形做像素级擦除，这里没有那件事。
            */
            var imageGo = new GameObject("Image", typeof(Image));
            imageGo.transform.SetParent(transform, false);
            image = imageGo.GetComponent<Image>();
            var rect = image.rectTransform;
            rect.anchorMin = new Vector2(StageMargin, StageMargin);
            rect.anchorMax = new Vector2(1f - StageMargin, 1f - StageMargin);
            rect.offsetMin = Vector2.zero;
            rect.offsetMax = Vector2.zero;
            image.preserveAspect = true;
            image.raycastTarget = false;
            image.enabled = false;
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
