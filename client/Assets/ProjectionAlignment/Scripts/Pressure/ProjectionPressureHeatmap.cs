using System;
using DeviceViz;
using UnityEngine;
using UnityEngine.UI;

namespace NuLight.ProjectionAlignment
{
    /// <summary>One continuous raw pressure image: a square for one mat, 2:1 for two mats.</summary>
    [DisallowMultipleComponent]
    public sealed class ProjectionPressureHeatmap : MonoBehaviour
    {
        private MatrixHeatmap heatmap;
        private Text label;
        private int[] emptyFrame;
        private int[] combinedFrame;
        private Canvas canvas;
        private float side;
        private Vector2 origin;
        private int boardCount;

        public int BoardCount => boardCount;
        public bool IsVisible => canvas == null || canvas.isActiveAndEnabled;

        public void Configure(MatrixHeatmap first)
        {
            if (first == null || heatmap != null) return;
            heatmap = first;
            canvas = first.GetComponentInParent<Canvas>();
            var rect = (RectTransform)first.transform;
            side = Mathf.Max(100f, rect.rect.width);
            origin = rect.anchoredPosition;
            label = AddLabel(rect);
            var group = first.GetComponent<CanvasGroup>();
            if (group == null) group = first.gameObject.AddComponent<CanvasGroup>();
            group.interactable = false;
            group.blocksRaycasts = false;
            SetBoardCount(1);
        }

        public void SetBoardCount(int count)
        {
            if (heatmap == null) return;
            count = Mathf.Clamp(count, 1, 2);
            if (boardCount == count) return;
            boardCount = count;
            var rect = (RectTransform)heatmap.transform;
            rect.anchorMin = rect.anchorMax = new Vector2(1f, 0f);
            rect.pivot = new Vector2(1f, 0f);
            rect.sizeDelta = new Vector2(side * count, side);
            rect.anchoredPosition = origin;
            // Scale horizontal padding too, so the actual pressure image and touch overlay
            // retain the same aspect ratio as the frame and do not distort individual mats.
            SetLayerBounds(heatmap.colorLayer);
            SetLayerBounds(heatmap.touchMarkerLayer);
        }

        public void UpdateFrames(int[] first, int[] second, int columns, int rows,
            string firstStatus, string secondStatus)
        {
            if (heatmap == null || columns < 1 || rows < 1) return;
            label.text = "1  |  " + firstStatus
                + (boardCount == 2 ? "     2  |  " + secondStatus : string.Empty);
            if (!IsVisible) return;
            int cells = columns * rows;
            if (boardCount == 1)
            {
                if (first == null || first.Length != cells)
                {
                    if (emptyFrame == null || emptyFrame.Length != cells)
                        emptyFrame = new int[cells];
                    first = emptyFrame;
                }
                heatmap.UpdateData(first, columns, rows);
                return;
            }

            if (combinedFrame == null || combinedFrame.Length != cells * 2)
                combinedFrame = new int[cells * 2];
            // Join corresponding rows into one texture. Debugging always shows raw mats
            // left to right, independently of the gameplay tiling axis and physical seam.
            CopyHalf(first, 0, columns, rows);
            CopyHalf(second, columns, columns, rows);
            heatmap.UpdateData(combinedFrame, columns * 2, rows);
        }

        private void CopyHalf(int[] source, int offset, int columns, int rows)
        {
            bool usable = source != null && source.Length == columns * rows;
            for (int row = 0; row < rows; row++)
            {
                int destination = row * columns * 2 + offset;
                if (usable) Array.Copy(source, row * columns, combinedFrame, destination, columns);
                else Array.Clear(combinedFrame, destination, columns);
            }
        }

        private void SetLayerBounds(VizLayer layer)
        {
            if (layer == null) return;
            var rect = (RectTransform)layer.transform;
            rect.anchorMin = Vector2.zero;
            rect.anchorMax = Vector2.one;
            rect.offsetMin = new Vector2(8f * boardCount, 8f);
            rect.offsetMax = -rect.offsetMin;
        }

        private static Text AddLabel(RectTransform parent)
        {
            var go = new GameObject("Serial Port Label", typeof(RectTransform), typeof(Image));
            var rect = (RectTransform)go.transform;
            rect.SetParent(parent, false);
            rect.anchorMin = new Vector2(0f, 1f);
            rect.anchorMax = Vector2.one;
            rect.pivot = new Vector2(0.5f, 0f);
            rect.anchoredPosition = new Vector2(0f, 2f);
            rect.sizeDelta = new Vector2(0f, 26f);
            go.GetComponent<Image>().color = new Color(0f, 0f, 0f, 0.8f);
            go.GetComponent<Image>().raycastTarget = false;
            var textObject = new GameObject("Port", typeof(RectTransform), typeof(Text));
            var textRect = (RectTransform)textObject.transform;
            textRect.SetParent(rect, false);
            textRect.anchorMin = Vector2.zero;
            textRect.anchorMax = Vector2.one;
            textRect.offsetMin = textRect.offsetMax = Vector2.zero;
            var text = textObject.GetComponent<Text>();
            text.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            text.fontSize = 16;
            text.alignment = TextAnchor.MiddleCenter;
            text.color = Color.white;
            text.raycastTarget = false;
            return text;
        }

        private void OnDestroy()
        {
            if (label == null) return;
            if (Application.isPlaying) Destroy(label.transform.parent.gameObject);
            else DestroyImmediate(label.transform.parent.gameObject);
        }
    }
}
