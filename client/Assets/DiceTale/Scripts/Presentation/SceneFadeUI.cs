using System.Collections;
using UnityEngine;
using UnityEngine.UI;

namespace DiceTale
{
    /// <summary>
    /// 全屏淡入淡出遮罩窗口（继承 <see cref="UIWindow"/>，由 UIManager 统一管理）。
    /// 全屏黑色遮罩盖住整个 Canvas，alpha 0→1（淡出/变黑）或 1→0（淡入/显像），
    /// 用于切场景时盖住旧内容卸载、新内容载入的瞬间。
    ///
    /// **无 prefab 的代码构建窗口**：结构只一个全屏 Image（Mask），Awake 时自动生成并撑满 Canvas，
    /// 经 <see cref="UIManager.OpenWindow{T}"/>（不传 Resources 路径）打开即可，无需在 Resources 建预设。
    ///
    /// 用法：
    ///   FadeToBlack(duration)     —— 淡出到全黑（切换在黑屏间隙做）
    ///   FadeFromBlack(duration)   —— 从全黑淡入（新内容显像）
    ///   IsFading                  —— 是否正在播放淡入淡出（外部协程用轮询等待）
    /// 遮罩 alpha &gt; 0 时开启 raycastTarget 拦截点击，避免黑屏期间误触场景/UI；完全透明时关闭不挡交互。
    ///
    /// **调用方是 <see cref="SceneMirror"/>**：真的换了一个场景时，它按
    /// 「淡出到全黑 → 黑屏里建 / 显新场景 → 淡入还原」的次序用这个窗口
    /// （参照参考实现 `LLMNPC_NEWLIGHT_EX` 的 `GameSceneManager.LoadScene`；
    /// 本工程没有「按 Resources 预置体切场景」那回事——场景内容由后台推送、由镜像搭出来）。
    /// 遮罩本身仍然是个独立工具：开关与时长在 `SceneMirror` 的 Inspector 字段上。
    /// </summary>
    public class SceneFadeUI : UIWindow
    {
        [SerializeField, Tooltip("遮罩颜色（默认黑）")]
        private Color maskColor = new Color(0f, 0f, 0f, 1f);

        /// <summary>全屏遮罩（代码构建的 Image，alpha 由淡入淡出控制）。</summary>
        private Image mask;

        /// <summary>遮罩用纯白 sprite（内置白纹理生成的 1×1，拉伸撑满即实心色块）。
        /// 注意：uGUI 的 Image 在 sprite == null 时不渲染（无纹理），不赋 sprite 会完全看不见遮罩。</summary>
        private static Sprite maskSprite;

        /// <summary>当前播放中的淡入淡出协程（null = 空闲）。</summary>
        private Coroutine fadeRoutine;

        /// <summary>是否正在播放淡入淡出。</summary>
        public bool IsFading => fadeRoutine != null;

        protected override void Awake()
        {
            base.Awake(); // UIWindow：向 UIManager 注册
            EnsureMask();
        }

        protected override void OnOpen()
        {
            // 每次淡出前把遮罩提到 Canvas 最上层，防止被之后创建的 UI 盖住
            transform.SetAsLastSibling();
        }

        /// <summary>确保全屏遮罩存在：代码构建（不依赖 prefab），根与遮罩都撑满 Canvas。
        /// 只有**新创建**的遮罩才初始化 alpha 0（透明、常驻不可见）；
        /// 已存在的遮罩**不动 color**——否则 FadeCoroutine 每次调用都会把当前透明度归零，
        /// 导致淡入从 0 开始渐变到 0（遮罩全程透明、新场景瞬间出现）。</summary>
        private void EnsureMask()
        {
            var root = transform as RectTransform;
            if (root != null)
            {
                root.anchorMin = Vector2.zero;
                root.anchorMax = Vector2.one;
                root.offsetMin = Vector2.zero;
                root.offsetMax = Vector2.zero;
            }

            var maskT = transform.Find("Mask");
            var isNew = false;
            if (maskT != null)
            {
                mask = maskT.GetComponent<Image>();
                if (mask == null)
                {
                    mask = maskT.gameObject.AddComponent<Image>();
                    isNew = true;
                }
            }

            if (mask == null)
            {
                var go = new GameObject("Mask", typeof(RectTransform));
                go.transform.SetParent(transform, false);
                mask = go.AddComponent<Image>();
                isNew = true;
            }

            var rt = mask.rectTransform;
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.offsetMin = Vector2.zero;
            rt.offsetMax = Vector2.zero;

            // 关键：给 Image 赋纯白 sprite，否则 uGUI 不渲染、遮罩不可见
            if (mask.sprite == null)
            {
                mask.sprite = GetOrCreateMaskSprite();
            }

            mask.type = Image.Type.Simple;

            // 仅新建时初始化透明，不重置已有遮罩的当前 alpha
            if (isNew)
            {
                mask.color = new Color(maskColor.r, maskColor.g, maskColor.b, 0f);
                mask.raycastTarget = false; // 透明时不挡交互
            }
        }

        /// <summary>内置白纹理（1×1）生成的纯白 sprite；静态缓存一份复用。</summary>
        private static Sprite GetOrCreateMaskSprite()
        {
            if (maskSprite == null)
            {
                var tex = Texture2D.whiteTexture;
                maskSprite = Sprite.Create(tex, new Rect(0f, 0f, tex.width, tex.height), new Vector2(0.5f, 0.5f), 100f);
                maskSprite.name = "SceneFadeMask";
            }

            return maskSprite;
        }

        /// <summary>淡出到全黑（alpha → 1）；完成后回调（可在此切换场景）。</summary>
        public void FadeToBlack(float duration, System.Action onDone = null)
        {
            RunFade(1f, duration, onDone);
        }

        /// <summary>从全黑淡入（alpha → 0）；完成后回调。</summary>
        public void FadeFromBlack(float duration, System.Action onDone = null)
        {
            RunFade(0f, duration, onDone);
        }

        /// <summary>直接设遮罩透明度（0..1；供外部强制清零/置黑，如场景异常中断时复位）。</summary>
        public void SetAlpha(float alpha)
        {
            EnsureMask();
            var c = mask.color;
            mask.color = new Color(c.r, c.g, c.b, Mathf.Clamp01(alpha));
            mask.raycastTarget = mask.color.a > 0.01f; // 全透明不挡点击
        }

        private void RunFade(float targetAlpha, float duration, System.Action onDone)
        {
            if (fadeRoutine != null)
            {
                StopCoroutine(fadeRoutine);
                fadeRoutine = null;
            }

            fadeRoutine = StartCoroutine(FadeCoroutine(targetAlpha, duration, onDone));
        }

        private IEnumerator FadeCoroutine(float targetAlpha, float duration, System.Action onDone)
        {
            EnsureMask();
            var from = mask.color.a;
            var t = 0f;
            while (t < 1f)
            {
                t += Time.deltaTime / Mathf.Max(duration, 0.001f);
                SetAlpha(Mathf.Lerp(from, targetAlpha, Mathf.Clamp01(t)));
                yield return null;
            }

            SetAlpha(targetAlpha);
            fadeRoutine = null;
            onDone?.Invoke();
        }
    }
}