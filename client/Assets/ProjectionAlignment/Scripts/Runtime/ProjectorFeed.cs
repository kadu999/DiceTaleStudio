using UnityEngine;
using UnityEngine.UI;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// Presents Game Camera A's render texture to the projector, warped by the
    /// calibration homography.
    ///
    /// There is no output quad and no second camera. The warped image is a
    /// full-screen RawImage on an overlay canvas that sits behind the operator UI,
    /// drawn by the UI pipeline.
    ///
    /// It deliberately does NOT blit to the backbuffer from a render-pipeline
    /// callback: `Graphics.Blit(src, null, mat)` writes to whatever render target
    /// happens to be active, which in the editor is the window currently being
    /// repainted — the picture then flickers across Scene view, Inspector previews
    /// and any panel the user clicks.
    ///
    /// CaptureFeed() runs the same material into an explicit texture, so the PNG on
    /// disk and the light on the table come from one material and one source.
    /// </summary>
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(100)]
    public sealed class ProjectorFeed : MonoBehaviour
    {
        [SerializeField] private ProjectionAlignmentController alignment;
        [SerializeField] private RawImage outputImage;
        [SerializeField] private Vector2Int captureResolution = new Vector2Int(1920, 1080);

        public Vector2Int CaptureResolution => captureResolution;
        public RawImage OutputImage => outputImage;

        public void Configure(ProjectionAlignmentController configuredAlignment, RawImage configuredOutputImage)
        {
            alignment = configuredAlignment;
            outputImage = configuredOutputImage;
        }

        private void Start()
        {
            ApplyOutputMaterial();
        }

        /// <summary>
        /// The controller clones the warp material at Awake so it can drive shader
        /// properties per instance; the RawImage has to draw with that same clone.
        /// </summary>
        public void ApplyOutputMaterial()
        {
            if (outputImage == null || alignment == null)
            {
                return;
            }

            RenderTexture source = alignment.GameTexture;
            Material material = alignment.WarpMaterial;
            if (source != null)
            {
                outputImage.texture = source;
            }

            if (material != null)
            {
                outputImage.material = material;
            }
        }

        /// <summary>Writes exactly what the projector is being fed to a PNG.</summary>
        public bool CaptureFeed(string filePath, out string error)
        {
            if (alignment == null || alignment.GameTexture == null || alignment.WarpMaterial == null)
            {
                error = "缺少 Game Texture 或 Warp 材质。";
                return false;
            }

            int width = Mathf.Max(16, captureResolution.x);
            int height = Mathf.Max(16, captureResolution.y);
            RenderTexture target = RenderTexture.GetTemporary(width, height, 24, RenderTextureFormat.ARGB32);
            RenderTexture previous = RenderTexture.active;

            // Explicit destination — never null. See the class comment.
            Graphics.Blit(alignment.GameTexture, target, alignment.WarpMaterial);

            RenderTexture.active = target;
            var readback = new Texture2D(width, height, TextureFormat.RGB24, false);
            readback.ReadPixels(new Rect(0f, 0f, width, height), 0, 0);
            readback.Apply();
            RenderTexture.active = previous;
            RenderTexture.ReleaseTemporary(target);

            try
            {
                System.IO.File.WriteAllBytes(filePath, ImageConversion.EncodeToPNG(readback));
                error = string.Empty;
                return true;
            }
            catch (System.Exception exception)
            {
                error = exception.Message;
                return false;
            }
            finally
            {
                Destroy(readback);
            }
        }
    }
}
