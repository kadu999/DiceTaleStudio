using UnityEngine;
using UnityEngine.Rendering.Universal;
using UnityEngine.UI;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// 实物层（2026-09-08）：给桌上的实体棋子上色，地图与 UI 保持正交俯视。
    ///
    /// 三张图、一次合成：
    ///   ① 平面相机（游戏主相机，正交俯视）照常渲进 GameRenderTexture：地图、UI、特效，**不含实物层的物件**；
    ///   ② 本组件的**颜色相机**站在镜头位置 C、投影矩阵 NDC ≡ 板 UV（<see cref="ProjectorFrustum"/>），
    ///      渲**整个场景**（地图 + 实物 + 特效，不含 UI）—— 实物在这张图里与场景共用深度与光照：
    ///      挡在它前面的东西照样挡着、打在它身上的特效照样打在身上；
    ///   ③ **遮罩相机**与②同位同矩阵，只渲实物层的物件，alpha = 实物的覆盖（不透明材质写 alpha 1）。
    /// 合成走 <c>PhysicalPropComposite.shader</c>，叠在预畸变那张 RawImage 之上：对投影仪每个像素 P，
    /// B = H(P)，颜色取②在 B 的值、alpha 取③在 B 的值 —— 光线打在实物上的地方用②，其余地方露出①。
    ///
    /// 遮罩是「光线穿过实物模型」而不是「②里可见的第一个表面是实物」：桌上真正挡光的只有实物本身，
    /// 虚拟遮挡物没有实体，它的像该落在实物表面上 —— ②里它已经画在实物前面了，遮罩只需说明「这里有实物」。
    /// 与旧射线层（<see cref="ProjectorCameraRig"/>，只渲实物层自己、整块盖在平面画面上）的区别就在②渲的是整个场景。
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class PhysicalPropLayer : MonoBehaviour
    {
        /// <summary>实物层专用层的名字（TagManager 第 9 槽）。挪到这一层的物件才算实物。</summary>
        public const string LayerName = "PhysicalProp";

        /// <summary>合成 shader，运行时 Shader.Find 取；打包靠 DMProjectionSceneBuilder 的保活材质。</summary>
        public const string CompositeShaderName = "NuLight/ProjectionAlignment/PhysicalPropComposite";

        static readonly int ProjectorToBoardId = Shader.PropertyToID("_ProjectorToBoard");
        static readonly int PropTexId = Shader.PropertyToID("_PropTex");
        static readonly int MaskTexId = Shader.PropertyToID("_MaskTex");

        Camera _flat;
        Camera _color;
        Camera _mask;
        RenderTexture _colorRt;
        RenderTexture _maskRt;
        Material _material;
        RawImage _output;
        ProjectionAlignmentController _alignment;
        bool _identityMapping;
        int _propLayer = -1;
        Matrix4x4 _frame;
        float _matWidthCm;
        float _matHeightCm;

        public bool Configured { get; private set; }
        public string LastMessage { get; private set; } = string.Empty;
        public Camera ColorCamera => _color;
        public Camera MaskCamera => _mask;
        public RenderTexture MaskTexture => _maskRt;
        public RenderTexture ColorTexture => _colorRt;

        /// <summary>
        /// 架起实物层。<paramref name="boardFrame"/> 是板 UV 框架（列定义见 <see cref="ProjectorFrustum.BuildBoardFrame"/>），
        /// 与主相机的取景、上色装置共用同一个。合成件插在 <paramref name="outputParent"/> 的第 <paramref name="outputSiblingIndex"/> 位、
        /// 矩形照抄 <paramref name="outputRectTemplate"/>（预畸变那张 RawImage）；两者为空则自建一块全屏 Overlay 画布做预览。
        /// <paramref name="identityMapping"/>：单机预览时画面没经过预畸变，合成也不过单应。
        /// </summary>
        public bool Setup(Camera flatCamera, ProjectionAlignmentController alignment, int propLayer,
                          Matrix4x4 boardFrame, float matWidthCm, float matHeightCm,
                          RectTransform outputParent, int outputSiblingIndex, RectTransform outputRectTemplate,
                          bool identityMapping)
        {
            if (flatCamera == null) { LastMessage = "没有平面相机，实物层没架。"; return false; }
            if (propLayer < 0 || propLayer > 31) { LastMessage = $"没有 {LayerName} 层，实物层没架。"; return false; }
            if (matWidthCm < 1f || matHeightCm < 1f) { LastMessage = "垫子尺寸无效，实物层没架。"; return false; }

            var shader = Shader.Find(CompositeShaderName);
            if (shader == null)
            {
                LastMessage = $"找不到 {CompositeShaderName} —— 打包版要靠 ProjectionShaderKeepAlive 里的保活材质。";
                return false;
            }

            _flat = flatCamera;
            _alignment = alignment;
            _propLayer = propLayer;
            _frame = boardFrame;
            _matWidthCm = matWidthCm;
            _matHeightCm = matHeightCm;
            _identityMapping = identityMapping;

            _material = new Material(shader) { name = "PhysicalPropComposite (runtime)" };
            EnsureCameras();
            EnsureTargets(Mathf.Max(16, _flat.pixelWidth), Mathf.Max(16, _flat.pixelHeight));
            EnsureOutput(outputParent, outputSiblingIndex, outputRectTemplate);

            Configured = true;
            LastMessage = "实物层已架好：地图/UI 正交，实物由站在镜头位置的相机连同整个场景一起渲、只在光线打到实物处合成。";
            return true;
        }

        /// <summary>
        /// 每帧：两台相机摆到 C、矩阵写成 NDC ≡ 板 UV，叠上和平面相机同样的震屏位移；
        /// <paramref name="hidden"/> 为真时整层停渲（校正层盖着游戏的时候）。
        /// </summary>
        public bool Tick(Vector3 lensCm, Vector2 shakeNdc, bool hidden)
        {
            if (!Configured || _flat == null || _color == null || _mask == null) return false;

            EnsureTargets(Mathf.Max(16, _flat.pixelWidth), Mathf.Max(16, _flat.pixelHeight));

            if (!ProjectorFrustum.Apply(_color, _frame, lensCm, _matWidthCm, _matHeightCm, out string message))
            {
                LastMessage = message;
                SetVisible(false);
                return false;
            }
            ProjectorFrustum.ApplyImageShake(_color, shakeNdc);

            _mask.transform.SetPositionAndRotation(_color.transform.position, _color.transform.rotation);
            _mask.nearClipPlane = _color.nearClipPlane;
            _mask.farClipPlane = _color.farClipPlane;
            _mask.projectionMatrix = _color.projectionMatrix;

            _material.SetMatrix(ProjectorToBoardId,
                _identityMapping || _alignment == null ? Matrix4x4.identity : _alignment.ProjectorToBoardMatrix);

            SetVisible(!hidden);
            return true;
        }

        /// <summary>
        /// 整层拆掉。合成件挂在**装置画布**上、不在本物件子树里，必须在这里一起收
        /// （留下的话画布上是一张贴着已释放 RT 的 RawImage，按纯色画 = 投影帧上糊一整块白）。
        /// </summary>
        public void Teardown()
        {
            if (_output != null)
            {
                DestroyImmediate(_output.gameObject);
                _output = null;
            }
            Configured = false;
            DestroyImmediate(gameObject);
        }

        void SetVisible(bool visible)
        {
            if (_color != null) _color.enabled = visible;
            if (_mask != null) _mask.enabled = visible;
            if (_output != null) _output.enabled = visible;
        }

        void EnsureCameras()
        {
            if (_color != null) return;
            int uiLayer = LayerMask.NameToLayer("UI");
            int uiBit = uiLayer >= 0 ? 1 << uiLayer : 0;

            var colorGo = new GameObject("PhysicalPropColorCamera");
            colorGo.transform.SetParent(transform, false);
            _color = colorGo.AddComponent<Camera>();
            _color.CopyFrom(_flat);
            _color.targetTexture = null;
            _color.rect = new Rect(0f, 0f, 1f, 1f);
            _color.cullingMask = (_flat.cullingMask | (1 << _propLayer)) & ~uiBit;
            _color.depth = _flat.depth - 2f;
            _color.tag = "Untagged";

            var src = _flat.GetUniversalAdditionalCameraData();
            var dst = _color.GetUniversalAdditionalCameraData();
            dst.renderType = CameraRenderType.Base;
            dst.renderPostProcessing = src.renderPostProcessing;
            dst.antialiasing = src.antialiasing;
            dst.antialiasingQuality = src.antialiasingQuality;
            dst.volumeLayerMask = src.volumeLayerMask;
            dst.volumeTrigger = src.volumeTrigger;
            dst.renderShadows = src.renderShadows;
            dst.requiresDepthOption = src.requiresDepthOption;
            dst.requiresColorOption = src.requiresColorOption;
            dst.dithering = src.dithering;
            dst.stopNaN = src.stopNaN;
            dst.allowXRRendering = false;

            var maskGo = new GameObject("PhysicalPropMaskCamera");
            maskGo.transform.SetParent(transform, false);
            _mask = maskGo.AddComponent<Camera>();
            _mask.CopyFrom(_color);
            _mask.clearFlags = CameraClearFlags.SolidColor;
            _mask.backgroundColor = new Color(0f, 0f, 0f, 0f);   // 空处 alpha 0；不透明材质写 alpha 1 = 实物覆盖
            _mask.cullingMask = 1 << _propLayer;
            _mask.depth = _flat.depth - 1f;
            _mask.allowHDR = false;
            _mask.allowMSAA = true;
            _mask.tag = "Untagged";
            var maskData = _mask.GetUniversalAdditionalCameraData();
            maskData.renderType = CameraRenderType.Base;
            maskData.renderPostProcessing = false;
            maskData.antialiasing = AntialiasingMode.None;
            maskData.renderShadows = false;
            maskData.requiresDepthOption = CameraOverrideOption.Off;
            maskData.requiresColorOption = CameraOverrideOption.Off;
            maskData.volumeLayerMask = 0;
            maskData.allowXRRendering = false;
        }

        void EnsureTargets(int width, int height)
        {
            if (_colorRt != null && _colorRt.width == width && _colorRt.height == height) return;
            ReleaseTargets();

            // ARGBHalf：托管链整条是 HDR 的，LDR 中间纹理会把 URP 管线压成 8bit（GameRenderTexture 踩过）。
            _colorRt = new RenderTexture(width, height, 24, RenderTextureFormat.ARGBHalf)
            {
                name = "PhysicalPropLayer Color",
                antiAliasing = 1,
                filterMode = FilterMode.Bilinear,
                wrapMode = TextureWrapMode.Clamp
            };
            // 遮罩只读 alpha；4x MSAA 让实物轮廓的合成边缘是软的。
            _maskRt = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.Linear)
            {
                name = "PhysicalPropLayer Mask",
                antiAliasing = 4,
                filterMode = FilterMode.Bilinear,
                wrapMode = TextureWrapMode.Clamp
            };
            _color.targetTexture = _colorRt;
            _mask.targetTexture = _maskRt;
            _material.SetTexture(PropTexId, _colorRt);
            _material.SetTexture(MaskTexId, _maskRt);
            if (_output != null) _output.texture = _colorRt;
        }

        void ReleaseTargets()
        {
            if (_color != null) _color.targetTexture = null;
            if (_mask != null) _mask.targetTexture = null;
            if (_colorRt != null) { _colorRt.Release(); Destroy(_colorRt); _colorRt = null; }
            if (_maskRt != null) { _maskRt.Release(); Destroy(_maskRt); _maskRt = null; }
        }

        void EnsureOutput(RectTransform parent, int siblingIndex, RectTransform template)
        {
            if (parent == null)
            {
                // 单机预览：场景里没有装置画布，自建一块全屏 Overlay。
                var canvasGo = new GameObject("PhysicalPropOverlayCanvas (preview)", typeof(RectTransform), typeof(Canvas));
                canvasGo.transform.SetParent(transform, false);
                var canvas = canvasGo.GetComponent<Canvas>();
                canvas.renderMode = RenderMode.ScreenSpaceOverlay;
                canvas.sortingOrder = -950;
                parent = (RectTransform)canvasGo.transform;
                siblingIndex = 0;
                template = null;
            }

            var go = new GameObject("PhysicalPropComposite", typeof(RectTransform), typeof(RawImage));
            var rt = (RectTransform)go.transform;
            rt.SetParent(parent, false);
            if (template != null)
            {
                rt.anchorMin = template.anchorMin;
                rt.anchorMax = template.anchorMax;
                rt.offsetMin = template.offsetMin;
                rt.offsetMax = template.offsetMax;
                rt.pivot = template.pivot;
                rt.localScale = template.localScale;
            }
            else
            {
                rt.anchorMin = Vector2.zero;
                rt.anchorMax = Vector2.one;
                rt.offsetMin = Vector2.zero;
                rt.offsetMax = Vector2.zero;
            }
            rt.SetSiblingIndex(Mathf.Clamp(siblingIndex, 0, parent.childCount - 1));

            _output = go.GetComponent<RawImage>();
            _output.texture = _colorRt;
            _output.material = _material;
            _output.raycastTarget = false;
        }

        void OnDestroy()
        {
            ReleaseTargets();
            if (_material != null) Destroy(_material);
            if (_output != null) Destroy(_output.gameObject);
        }
    }
}
