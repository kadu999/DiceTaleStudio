using UnityEngine;
using UnityEngine.UI;

namespace DiceTale
{
    /// <summary>
    /// 当前输入源的调试圆点层（屏幕圆点）：为 <see cref="InputManager.PressedScreenPositions"/>
    /// 里本帧按住的每个触点画一个屏幕圆点——任意输入源都适用（模拟手指 / 压板触点 / 单点指挥 v2），
    /// 按下显示、抬起隐藏；第 1 个触点亮白、其余半透明青（单点模式下只有第 1 个）；
    /// 圆点上的数字标注该触点的指针 Id（<see cref="InputManager.PressedIds"/>：玩家 1..5 / 拍照 6）。
    /// 带开关控制是否显示（运行时可改，立即生效）。
    ///
    /// 用法：挂到场景任意对象即可。数据只读 <see cref="InputManager.PressedScreenPositions"/> 的
    /// 每帧快照，不依赖具体输入源类型（本组件只管显示、不产输入）。
    /// </summary>
    public class SimulatedTouchDebugUI : MonoBehaviour
    {
        [Tooltip("是否显示调试圆点层（运行时可改，立即生效）")]
        [SerializeField] private bool showDebugUi = true;

        /// <summary>压板虚拟触屏最多 10 触点、模拟源 6 指：圆点按 10 预留。</summary>
        private const int MaxContacts = 10;

        private const float CircleDiameterPx = 64f;

        private static readonly Color ActiveColor = new Color(1f, 1f, 1f, 0.65f); // 第 1 个触点：半透明白
        private static readonly Color IdleColor = new Color(0f, 0.85f, 1f, 0.45f); // 其余触点：半透明青

        /// <summary>编号文字颜色（深色，压在半透明浅色圆点上可读）。</summary>
        private static readonly Color NumberColor = new Color(0.08f, 0.16f, 0.24f, 1f);

        private static Font builtinFont;
        private static bool builtinFontResolved;

        /// <summary>内置动态字体 LegacyRuntime.ttf（Unity 2022.2+ 替代 Arial；Unity 6 仍可用）。</summary>
        private static Font BuiltinFont
        {
            get
            {
                if (!builtinFontResolved)
                {
                    builtinFontResolved = true;
                    builtinFont = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
                }

                return builtinFont;
            }
        }

        private GameObject canvasGo;
        private Image[] fingerCircles = new Image[0];
        private Text[] dotLabels = new Text[0];

        /// <summary>是否显示调试圆点层（运行时可改，立即生效）。</summary>
        public bool ShowDebugUi
        {
            get => showDebugUi;
            set
            {
                showDebugUi = value;
                if (canvasGo != null)
                {
                    canvasGo.SetActive(showDebugUi);
                }
            }
        }

        private void Start()
        {
            RebuildCircles();
            if (canvasGo != null)
            {
                canvasGo.SetActive(showDebugUi);
            }
        }

        private void Update()
        {
            if (!showDebugUi || canvasGo == null || !canvasGo.activeSelf)
            {
                return;
            }

            // 任意输入源的统一触点快照：本帧按住的触点屏幕像素坐标 + 各自 Id（空 = 无人按）
            var positions = InputManager.PressedScreenPositions;
            var ids = InputManager.PressedIds;
            for (int i = 0; i < fingerCircles.Length; i++)
            {
                bool down = i < positions.Count;
                fingerCircles[i].gameObject.SetActive(down);
                if (!down)
                {
                    continue;
                }

                // 屏幕像素坐标（左下原点，与鼠标/InputSystem 口径一致；圆点锚左下角避免依赖 canvas 根锚点）
                fingerCircles[i].rectTransform.anchoredPosition = positions[i];
                fingerCircles[i].color = i == 0 ? ActiveColor : IdleColor;

                // 标数字 = 该触点的指针 Id（玩家编号 1..5 / 拍照 6），不是列表序号
                if (i < dotLabels.Length && dotLabels[i] != null && i < ids.Count)
                {
                    dotLabels[i].text = ((int)ids[i]).ToString();
                }
            }
        }

        /// <summary>重建圆点层（触点上限固定为 <see cref="MaxContacts"/>，一般只建一次）。</summary>
        private void RebuildCircles()
        {
            if (canvasGo != null)
            {
                Destroy(canvasGo);
                canvasGo = null;
            }

            BuildCanvas();
        }

        /// <summary>建屏幕圆点层：Overlay Canvas + 每个触点一个编号圆点（按下显示/抬起隐藏）。</summary>
        private void BuildCanvas()
        {
            canvasGo = new GameObject("PointerDebugCanvas");
            canvasGo.transform.SetParent(transform, false);
            var canvas = canvasGo.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            canvas.sortingOrder = 32767;
            canvasGo.AddComponent<CanvasScaler>();
            canvasGo.AddComponent<GraphicRaycaster>();

            var sprite = DebugCircleSprite; // 运行时生成，不依赖内置资源（UI/Skin/UISprite.psd 在 Unity 6 已不可用）
            fingerCircles = new Image[MaxContacts];
            dotLabels = new Text[MaxContacts];
            for (int i = 0; i < fingerCircles.Length; i++)
            {
                var go = new GameObject(string.Format("Pointer{0}Circle", i + 1));
                go.transform.SetParent(canvasGo.transform, false);
                var image = go.AddComponent<Image>();
                image.sprite = sprite;
                image.raycastTarget = false;
                image.rectTransform.anchorMin = Vector2.zero;
                image.rectTransform.anchorMax = Vector2.zero;
                image.rectTransform.pivot = new Vector2(0.5f, 0.5f);
                image.rectTransform.sizeDelta = new Vector2(CircleDiameterPx, CircleDiameterPx);
                fingerCircles[i] = image;
                go.SetActive(false);

                // 触点 Id 标签（每帧按快照更新为玩家编号/拍照），随圆点一起显示/隐藏；字体内置、无工程资源依赖
                if (BuiltinFont != null)
                {
                    var labelGo = new GameObject(string.Format("Pointer{0}Label", i + 1));
                    labelGo.transform.SetParent(go.transform, false);
                    var label = labelGo.AddComponent<Text>();
                    dotLabels[i] = label;
                    label.text = (i + 1).ToString();
                    label.font = BuiltinFont;
                    label.fontSize = 42;
                    label.fontStyle = FontStyle.Bold;
                    label.alignment = TextAnchor.MiddleCenter;
                    label.color = NumberColor;
                    label.raycastTarget = false;

                    // 标签铺满圆点区域：居中显示
                    var labelRect = labelGo.GetComponent<RectTransform>();
                    labelRect.anchorMin = Vector2.zero;
                    labelRect.anchorMax = Vector2.one;
                    labelRect.offsetMin = Vector2.zero;
                    labelRect.offsetMax = Vector2.zero;
                }
            }
        }

        private void OnDestroy()
        {
            // 组件被摘除时带走圆点层；随对象销毁时子物体已在销毁中，此处为无害空操作
            if (canvasGo != null)
            {
                Destroy(canvasGo);
            }
        }

        /// <summary>调试圆点用白色圆 sprite（多实例共享一份，避免每个实例都生成一遍）。</summary>
        private static Sprite debugCircleSprite;

        private static Sprite DebugCircleSprite
        {
            get
            {
                if (debugCircleSprite == null)
                {
                    debugCircleSprite = CreateCircleSprite();
                }

                return debugCircleSprite;
            }
        }

        /// <summary>程序化生成 64x64 白色圆（边缘 1px 抗锯齿过渡），不依赖任何内置/工程资源。</summary>
        private static Sprite CreateCircleSprite()
        {
            const int size = 64;
            var texture = new Texture2D(size, size, TextureFormat.RGBA32, false);
            float radius = size * 0.5f - 1f;
            float center = size * 0.5f;
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    float dx = x + 0.5f - center;
                    float dy = y + 0.5f - center;
                    float alpha = Mathf.Clamp01(radius + 1f - Mathf.Sqrt(dx * dx + dy * dy));
                    texture.SetPixel(x, y, new Color(1f, 1f, 1f, alpha));
                }
            }

            texture.Apply();
            return Sprite.Create(texture, new Rect(0f, 0f, size, size), new Vector2(0.5f, 0.5f));
        }
    }
}