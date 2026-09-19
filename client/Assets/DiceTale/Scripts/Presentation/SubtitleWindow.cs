using UnityEngine;
using UnityEngine.UI;

namespace DiceTale
{
    /// <summary>
    /// 字幕窗口（代码构建，无 prefab）：底部半透明黑条 + 居中白字（带描边）。
    /// 由 <see cref="AudioPlayerManager"/> 在播放旁白/对话时经 UIManager.OpenWindow 打开，
    /// 播放结束/Stop 时自动关闭；重新 Open 可继续显示新字幕。
    /// </summary>
    [DisallowMultipleComponent]
    public class SubtitleWindow : UIWindow
    {
        private Text subtitleText;

        protected override void Awake()
        {
            base.Awake();
            Build();
        }

        /// <summary>更新字幕内容（窗口未打开时也可先设置，Open 后即显示）。</summary>
        public void SetText(string content)
        {
            if (subtitleText == null)
            {
                return;
            }

            subtitleText.text = content ?? string.Empty;
        }

        private void Build()
        {
            // 背景条：底部 140px 半透明黑
            var barGo = new GameObject("SubtitleBar", typeof(Image));
            barGo.transform.SetParent(transform, false);
            var barRect = barGo.GetComponent<RectTransform>();
            barRect.anchorMin = new Vector2(0f, 0f);
            barRect.anchorMax = new Vector2(1f, 0f);
            barRect.pivot = new Vector2(0.5f, 0f);
            barRect.offsetMin = Vector2.zero;
            barRect.offsetMax = new Vector2(0f, 140f);
            barGo.GetComponent<Image>().color = new Color(0f, 0f, 0f, 0.6f);

            // 字幕文字（白字带黑描边，可读性优先）
            var textGo = new GameObject("Text", typeof(Text));
            textGo.transform.SetParent(barGo.transform, false);
            subtitleText = textGo.GetComponent<Text>();
            var textRect = subtitleText.rectTransform;
            textRect.anchorMin = Vector2.zero;
            textRect.anchorMax = Vector2.one;
            textRect.offsetMin = new Vector2(60f, 8f);
            textRect.offsetMax = new Vector2(-60f, -8f);

            subtitleText.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            subtitleText.fontSize = 42;
            subtitleText.alignment = TextAnchor.MiddleCenter;
            subtitleText.color = Color.white;
            subtitleText.horizontalOverflow = HorizontalWrapMode.Wrap;
            subtitleText.verticalOverflow = VerticalWrapMode.Truncate;
            subtitleText.raycastTarget = false;

            var outline = textGo.AddComponent<Outline>();
            outline.effectColor = new Color(0f, 0f, 0f, 0.8f);
            outline.effectDistance = new Vector2(1.5f, -1.5f);
        }
    }
}