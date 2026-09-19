using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

namespace NuLight.ProjectionAlignment
{
    [DisallowMultipleComponent]
    public sealed class ProjectionTouchVisualizer : MonoBehaviour
    {
        [SerializeField] private PressureInputRouter pressureInput;
        [SerializeField] private RectTransform interactionFrame;
        [SerializeField, Min(1)] private int maxMarkers = 20;
        [SerializeField] private Color markerColor = new Color(1f, 0.18f, 0.05f, 0.9f);

        [Tooltip("Shared with the rest of the alignment overlay so the dots draw above game "
            + "content whatever render queue it uses.")]
        [SerializeField] private Material markerMaterial;

        private readonly List<RectTransform> markers = new List<RectTransform>();
        private readonly List<Image> markerImages = new List<Image>();
        private static Sprite circleSprite;

        public void Configure(PressureInputRouter input, RectTransform frame, Material overlayMaterial = null)
        {
            pressureInput = input;
            interactionFrame = frame;
            markerMaterial = overlayMaterial;
        }

        private void Awake()
        {
            EnsureMarkers();
        }

        private void LateUpdate()
        {
            if (pressureInput == null || interactionFrame == null)
            {
                HideAll();
                return;
            }

            EnsureMarkers();
            IReadOnlyList<BoardContact> contacts = pressureInput.Contacts;
            Rect rect = interactionFrame.rect;
            for (int index = 0; index < markers.Count; index++)
            {
                if (index >= contacts.Count)
                {
                    markers[index].gameObject.SetActive(false);
                    continue;
                }

                BoardContact contact = contacts[index];
                RectTransform marker = markers[index];
                marker.anchoredPosition = new Vector2(
                    contact.boardUv.x * rect.width,
                    (1f - contact.boardUv.y) * rect.height);

                float diameter = Mathf.Max(
                    12f,
                    contact.radius * 2f / Mathf.Max(1, pressureInput.SensorResolution.y) * rect.height);
                marker.sizeDelta = Vector2.one * diameter;
                float alpha = contact.normalizedPressure;
                markerImages[index].color = new Color(markerColor.r, markerColor.g, markerColor.b, Mathf.Max(0.35f, alpha));
                marker.gameObject.SetActive(true);
            }
        }

        private void EnsureMarkers()
        {
            if (interactionFrame == null)
            {
                return;
            }

            while (markers.Count < maxMarkers)
            {
                var markerObject = new GameObject(
                    $"Pressure Marker {markers.Count + 1:00}",
                    typeof(RectTransform),
                    typeof(Image));
                markerObject.transform.SetParent(interactionFrame, false);
                var marker = markerObject.GetComponent<RectTransform>();
                marker.anchorMin = Vector2.zero;
                marker.anchorMax = Vector2.zero;
                marker.pivot = new Vector2(0.5f, 0.5f);
                var image = markerObject.GetComponent<Image>();
                image.sprite = CircleSprite;
                image.raycastTarget = false;
                if (markerMaterial != null)
                {
                    image.material = markerMaterial;
                }
                markerObject.SetActive(false);
                markers.Add(marker);
                markerImages.Add(image);
            }
        }

        private void HideAll()
        {
            for (int index = 0; index < markers.Count; index++)
            {
                markers[index].gameObject.SetActive(false);
            }
        }

        private static Sprite CircleSprite
        {
            get
            {
                if (circleSprite != null)
                {
                    return circleSprite;
                }

                const int size = 64;
                var texture = new Texture2D(size, size, TextureFormat.RGBA32, false)
                {
                    name = "Projection Pressure Marker"
                };
                var pixels = new Color32[size * size];
                float center = (size - 1) * 0.5f;
                float outer = center * center;
                float inner = (center - 5f) * (center - 5f);
                for (int y = 0; y < size; y++)
                {
                    for (int x = 0; x < size; x++)
                    {
                        float dx = x - center;
                        float dy = y - center;
                        float distance = dx * dx + dy * dy;
                        pixels[y * size + x] = distance <= outer && distance >= inner
                            ? new Color32(255, 255, 255, 255)
                            : new Color32(255, 255, 255, 0);
                    }
                }

                texture.SetPixels32(pixels);
                texture.Apply(false, true);
                circleSprite = Sprite.Create(
                    texture,
                    new Rect(0, 0, size, size),
                    new Vector2(0.5f, 0.5f),
                    100f);
                return circleSprite;
            }
        }
    }
}
