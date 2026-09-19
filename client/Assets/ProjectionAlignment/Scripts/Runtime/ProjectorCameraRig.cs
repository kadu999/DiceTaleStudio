using UnityEngine;
using UnityEngine.UI;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// 实物上色装置：把颜色投到立在垫子上的实体（Shader Lamps）。
    ///
    /// **2026-08-31 起走「单应锚定的射线层」，不再从单应反解投影仪位姿。** 原因：
    /// 反解要求单应里有透视成分（斜投），而吊装到垫子正上方、近垂直投影的机器给出的
    /// 单应接近仿射，位姿在数学上不存在；而且反解必须假设针孔内参，新投影仪的内参拿不到。
    /// 旧求解器 <see cref="ProjectorPoseSolver"/> 保留作参考实现，运行时不再引用。
    ///
    /// 新链路对每个投影像素 P：
    ///   ① B = H(P) —— 标定单应说这个像素落在垫面哪一点（与预畸变链同一张矩阵）；
    ///   ② 把垫面点 B 投进「站在镜头位置 C 的本相机」取色（<c>PlaneAnchoredParallax.shader</c>）。
    /// 经过 P 的真实光线必然穿过 C 与 B，所以本相机沿这条方向看到的第一个表面，
    /// 就是这条光在现实里照到的表面。**整条链不需要投影仪内参** —— 焦距、lens shift、
    /// 机内数字形变全被 H 吸收；唯一的未知量是镜头位置 C（三个厘米数，卷尺可量、9/0 可拧）。
    /// 桌面上（h=0）的内容按构造精确等于单应，与 C 无关，和预畸变链不可能漂。
    ///
    /// **它是加一层，不是换一层。** 预畸变链照旧管「屏幕空间内容准确落在桌面平面上」；
    /// 本装置只管「世界空间内容的光准确落在实物表面上」。合成走同一块 Overlay 画布上的
    /// 第二张 RawImage（Overlay 画布在所有相机之后绘制，相机盖不上去，必须走 RT + RawImage）。
    ///
    /// 坐标：一切以「板 UV 框架」<see cref="ApplyPlaneAnchored"/> 传入的 4×4 矩阵为准 ——
    /// 列 0 = 板 U 方向 × 垫宽、列 1 = 板 V 方向 × 垫深、列 2 = 高度方向 × 每厘米单位数、
    /// 列 3 = 板 (0,0) 角的世界位置。调用方怎么定义（隐藏角落 / 从游戏相机推导），本装置照用，
    /// 于是「C 的厘米」「验证靶的厘米」「shader 里的 B」天然是同一套，没有极性可猜。
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class ProjectorCameraRig : MonoBehaviour
    {
        [Header("接线")]
        [SerializeField] private ProjectionAlignmentController alignment;
        [Tooltip("叠在预畸变那张 RawImage 之上的输出件。留空则运行时在同一画布上建一张")]
        [SerializeField] private RawImage outputImage;

        [Header("渲染")]
        [Tooltip("只渲染这些层。留空时自动用 ProjectionMapped 层（本装置专用，slot 8）。\n"
               + "绝不能含 Default —— 那会把整个游戏又画一遍、还是从投影仪视角画的")]
        [SerializeField] private LayerMask mappedLayers;

        /// <summary>本装置专用层的名字。放这一层的物件才会被投到实物上。</summary>
        public const string MappedLayerName = "ProjectionMapped";

        /// <summary>合成 shader 的名字。打包要靠保活材质，见 ProjectionShaderKeepAlive。</summary>
        public const string ParallaxShaderName = "NuLight/ProjectionAlignment/PlaneAnchoredParallax";

        [SerializeField] private Vector2Int textureSize = new Vector2Int(1920, 1080);
        [Tooltip("视锥比「刚好罩住垫子」再放大的倍数，给标定误差和垫外内容留余量")]
        [SerializeField] private float frustumMargin = 1.2f;

        // ---- 镜头位置 C 的持久化 ----
        // 三个数都是**物理厘米**，跟画面分辨率无关。编辑器和打包版各存各的
        // （macOS 上是 company.product 与 bundle identifier 两份 plist），互不影响；
        // 没拧过的一边落到默认值 = 垫子正中。要在编辑器里复现打包版的取景，先把这三个键临时填成打包版的值。
        public const string PrefLensXKey = "ProjectionAlignment.LensXCm";
        public const string PrefLensYKey = "ProjectionAlignment.LensYCm";
        public const string PrefLensHKey = "ProjectionAlignment.LensHeightCm";
        public const float DefaultLensHeightCm = 50f;

        /// <summary>没存过的分量给 NaN，由 <see cref="ResolveLensCm"/> 落到垫子正中/默认高。</summary>
        public static Vector3 LoadLensCm()
        {
            return new Vector3(
                PlayerPrefs.GetFloat(PrefLensXKey, float.NaN),
                PlayerPrefs.GetFloat(PrefLensYKey, float.NaN),
                PlayerPrefs.GetFloat(PrefLensHKey, DefaultLensHeightCm));
        }

        public static void SaveLensCm(Vector3 lensCm)
        {
            if (!float.IsNaN(lensCm.x)) PlayerPrefs.SetFloat(PrefLensXKey, lensCm.x);
            if (!float.IsNaN(lensCm.y)) PlayerPrefs.SetFloat(PrefLensYKey, lensCm.y);
            if (!float.IsNaN(lensCm.z)) PlayerPrefs.SetFloat(PrefLensHKey, lensCm.z);
            PlayerPrefs.Save();
        }

        /// <summary>把没拧过的分量落到默认值：水平 = 垫子正中，高度 = 默认高。</summary>
        public static Vector3 ResolveLensCm(Vector3 lensCm, float matWidthCm, float matHeightCm)
        {
            if (float.IsNaN(lensCm.x)) lensCm.x = matWidthCm * 0.5f;
            if (float.IsNaN(lensCm.y)) lensCm.y = matHeightCm * 0.5f;
            if (float.IsNaN(lensCm.z) || lensCm.z < 5f) lensCm.z = DefaultLensHeightCm;
            return lensCm;
        }

        Camera _cam;
        RenderTexture _rt;
        Material _material;
        bool _configured;
        // 运行时自建的那张合成件。它挂在**装置画布**上（预畸变那张的兄弟），不在 rig 子树里 ——
        // 拆层时得自己收，见 Teardown。
        GameObject _spawnedOutput;

        Matrix4x4 _boardUvToWorld;      // 见类注释的列定义
        Matrix4x4 _worldToBoardCm;      // 逆映射：世界 → (垫面厘米 x, y, 高 cm)
        float _unitsPerCm = 1f;
        float _matWidthCm = 100f;
        float _matHeightCm = 50f;
        Vector3 _lensCm;

        static readonly int ProjectorToBoardId = Shader.PropertyToID("_ProjectorToBoard");
        static readonly int BoardToRigClipId = Shader.PropertyToID("_BoardToRigClip");

        public Camera Camera => _cam;
        /// <summary>合成用的那张 RawImage（运行时自建或场景里手接的）。实物层的合成件要排在它下面。</summary>
        public RawImage OutputImage => outputImage;
        public bool Configured => _configured;
        public string LastMessage { get; private set; } = string.Empty;

        /// <summary>当前镜头位置（垫面厘米 x、y，高 z）。</summary>
        public Vector3 LensCm => _lensCm;

        public float UnitsPerCentimetre => _unitsPerCm;
        public float MatWidthCm => _matWidthCm;
        public float MatHeightCm => _matHeightCm;

        /// <summary>运行时建时用：接上对齐组件（合成 shader 要拿它的单应）。</summary>
        public void Configure(ProjectionAlignmentController configuredAlignment)
        {
            alignment = configuredAlignment;
        }

        /// <summary>
        /// 架起上色层。<paramref name="boardUvToWorld"/> 定义板 UV 框架（列定义见类注释）；
        /// <paramref name="lensCm"/> 是镜头位置（垫面厘米，NaN 分量自动落默认）。
        /// 重复调用 = 重架（幂等）。
        /// </summary>
        public bool ApplyPlaneAnchored(
            Matrix4x4 boardUvToWorld, float unitsPerCm,
            float matWidthCm, float matHeightCm, Vector3 lensCm)
        {
            if (matWidthCm < 1f || matHeightCm < 1f || unitsPerCm < 1e-6f)
            {
                LastMessage = "垫子尺寸或尺度无效，上色层没架。";
                _configured = false;
                return false;
            }

            _boardUvToWorld = boardUvToWorld;
            _unitsPerCm = unitsPerCm;
            _matWidthCm = matWidthCm;
            _matHeightCm = matHeightCm;
            _worldToBoardCm = BuildWorldToBoardCm(boardUvToWorld, matWidthCm, matHeightCm);
            _lensCm = ResolveLensCm(lensCm, matWidthCm, matHeightCm);

            EnsureCamera();
            if (_cam == null)
            {
                LastMessage = "建不出 rig 相机，上色层没架。";
                _configured = false;
                return false;
            }

            PlaceCamera();
            _configured = SelfCheck();
            return _configured;
        }

        /// <summary>只挪镜头位置（9/0 的落点）。写进 PlayerPrefs —— 它是这套吊装的物理常数。</summary>
        public void SetLensCm(Vector3 lensCm)
        {
            if (!_configured && _cam == null) { _lensCm = lensCm; return; }
            _lensCm = ResolveLensCm(lensCm, _matWidthCm, _matHeightCm);
            SaveLensCm(_lensCm);
            PlaceCamera();
            SelfCheck();
        }

        /// <summary>垫面厘米 (x, y, 高 cm) → 世界。三层（C、验证靶、shader）共用的唯一换算。</summary>
        public Vector3 MatCmToWorld(Vector3 matCm)
        {
            Vector3 o = _boardUvToWorld.GetColumn(3);
            Vector3 ex = _boardUvToWorld.GetColumn(0);
            Vector3 ey = _boardUvToWorld.GetColumn(1);
            Vector3 eh = _boardUvToWorld.GetColumn(2);
            return o + ex * (matCm.x / _matWidthCm) + ey * (matCm.y / _matHeightCm) + eh * matCm.z;
        }

        /// <summary>世界 → 垫面厘米 (x, y, 高 cm)。</summary>
        public Vector3 WorldToMatCm(Vector3 world)
        {
            Vector4 v = _worldToBoardCm * new Vector4(world.x, world.y, world.z, 1f);
            return new Vector3(v.x, v.y, v.z);
        }

        /// <summary>板框架的高度方向（世界，单位向量）。验证靶把圆柱轴摆到它上。</summary>
        public Vector3 HeightDirWorld
        {
            get
            {
                Vector3 eh = _boardUvToWorld.GetColumn(2);
                return eh.sqrMagnitude > 1e-12f ? eh.normalized : Vector3.up;
            }
        }

        /// <summary>
        /// 板框架的朝向（右 = U 方向、上 = 高度方向）。给验证靶摆轮廓线用；
        /// 框架若是镜像的，旋转吸收不了那一位镜像 —— 靶件全是对称体，看不出来，无妨。
        /// </summary>
        public Quaternion FrameRotation
        {
            get
            {
                Vector3 ey = _boardUvToWorld.GetColumn(1);
                Vector3 fwd = ey.sqrMagnitude > 1e-12f ? ey.normalized : Vector3.forward;
                return Quaternion.LookRotation(fwd, HeightDirWorld);
            }
        }

        static Matrix4x4 BuildWorldToBoardCm(Matrix4x4 frame, float matWidthCm, float matHeightCm)
        {
            // 每厘米基向量：世界 = origin + ex·x + ey·y + eh·h
            Vector3 o = frame.GetColumn(3);
            Vector3 ex = (Vector3)frame.GetColumn(0) / matWidthCm;
            Vector3 ey = (Vector3)frame.GetColumn(1) / matHeightCm;
            Vector3 eh = frame.GetColumn(2);
            var m = new Matrix4x4(
                new Vector4(ex.x, ex.y, ex.z, 0f),
                new Vector4(ey.x, ey.y, ey.z, 0f),
                new Vector4(eh.x, eh.y, eh.z, 0f),
                new Vector4(o.x, o.y, o.z, 1f));
            return m.inverse;
        }

        void PlaceCamera()
        {
            Vector3 pos = MatCmToWorld(new Vector3(_lensCm.x, _lensCm.y, _lensCm.z));
            Vector3 centre = MatCmToWorld(new Vector3(_matWidthCm * 0.5f, _matHeightCm * 0.5f, 0f));
            Vector3 fwd = centre - pos;
            if (fwd.sqrMagnitude < 1e-10f) fwd = -HeightDirWorld;

            // up 提示用板 V 方向；镜头几乎在正上方时它和视线接近垂直，永不退化。
            Vector3 upHint = _boardUvToWorld.GetColumn(1);
            if (Vector3.Cross(fwd, upHint).sqrMagnitude < 1e-10f) upHint = _boardUvToWorld.GetColumn(0);

            var t = _cam.transform;
            t.SetPositionAndRotation(pos, Quaternion.LookRotation(fwd.normalized, upHint.normalized));

            // 内参自选（这台相机不是投影仪的复刻，H 才是）：视锥罩住垫子四角再放余量。
            _cam.ResetProjectionMatrix();
            _cam.usePhysicalProperties = false;
            float aspect = textureSize.y > 0 ? (float)textureSize.x / textureSize.y : 16f / 9f;
            float needHalfTan = 0.05f;
            float minZ = float.MaxValue, maxZ = 0f;
            for (int i = 0; i < 4; i++)
            {
                Vector3 cornerCm = new Vector3((i & 1) * _matWidthCm, ((i >> 1) & 1) * _matHeightCm, 0f);
                Vector3 local = t.InverseTransformPoint(MatCmToWorld(cornerCm));
                if (local.z < 1e-4f) continue;   // 角落在相机背后：自检会把它揪出来
                needHalfTan = Mathf.Max(needHalfTan, Mathf.Abs(local.y) / local.z);
                needHalfTan = Mathf.Max(needHalfTan, Mathf.Abs(local.x) / local.z / aspect);
                minZ = Mathf.Min(minZ, local.z);
                maxZ = Mathf.Max(maxZ, local.z);
            }
            _cam.fieldOfView = 2f * Mathf.Rad2Deg * Mathf.Atan(needHalfTan * Mathf.Max(1.01f, frustumMargin));
            if (minZ < float.MaxValue)
            {
                _cam.nearClipPlane = Mathf.Max(0.001f, minZ * 0.05f);
                _cam.farClipPlane = maxZ * 4f;
            }
        }

        /// <summary>
        /// 垫面上撒 5×5 个点，全部要求落在相机**前方**且在视锥内。
        /// 平面上的对齐由单应保证、与 C 无关，所以这里查的只是「框架和镜头位置没写反」。
        /// </summary>
        bool SelfCheck()
        {
            int behind = 0, outside = 0;
            Matrix4x4 vp = _cam.projectionMatrix * _cam.worldToCameraMatrix;
            for (int i = 0; i <= 4; i++)
            {
                for (int j = 0; j <= 4; j++)
                {
                    Vector3 w = MatCmToWorld(new Vector3(i / 4f * _matWidthCm, j / 4f * _matHeightCm, 0f));
                    Vector4 clip = vp * new Vector4(w.x, w.y, w.z, 1f);
                    if (clip.w <= 0f) { behind++; continue; }
                    Vector2 ndc = new Vector2(clip.x / clip.w, clip.y / clip.w);
                    if (Mathf.Abs(ndc.x) > 1f || Mathf.Abs(ndc.y) > 1f) outside++;
                }
            }

            if (behind > 0)
            {
                LastMessage = $"✗ 垫面上有 {behind} 个采样点在 rig 相机背后 —— 镜头高度是不是拧成了负数？";
                return false;
            }
            if (outside > 0)
            {
                LastMessage = $"✗ 垫面上有 {outside} 个采样点出了 rig 相机视锥 —— 视锥余量不够，检查镜头位置。";
                return false;
            }
            LastMessage = $"上色层已架好：镜头在垫面 ({_lensCm.x:F0}, {_lensCm.y:F0}) cm、高 {_lensCm.z:F0} cm。"
                        + "桌面内容由单应钉死；立面颜色只随这三个数走。";
            return true;
        }

        void LateUpdate()
        {
            if (!_configured || _material == null || _cam == null) return;
            // 单应可能被重标定换掉、框架的世界端可能被宿主挪动 —— 每帧同步，量级是两次矩阵乘。
            if (alignment != null) _material.SetMatrix(ProjectorToBoardId, alignment.ProjectorToBoardMatrix);
            Matrix4x4 boardToClip = _cam.projectionMatrix * _cam.worldToCameraMatrix * _boardUvToWorld;
            _material.SetMatrix(BoardToRigClipId, boardToClip);
        }

        void EnsureCamera()
        {
            if (_cam != null) return;
            var go = new GameObject("ProjectorCamera");
            go.transform.SetParent(transform, false);
            _cam = go.AddComponent<Camera>();
            _cam.clearFlags = CameraClearFlags.SolidColor;
            _cam.backgroundColor = new Color(0f, 0f, 0f, 0f);   // 空处透明，底下的预畸变画面照旧露出来
            int mapped = LayerMask.NameToLayer(MappedLayerName);
            _cam.cullingMask = mappedLayers.value != 0
                ? mappedLayers.value
                : (mapped >= 0 ? 1 << mapped : 0);   // 拿不到专用层就什么都不画，绝不回落到 Default
            _cam.depth = -50f;                       // 早于游戏相机，免得抢 backbuffer
            _cam.allowMSAA = false;

            // ARGBHalf：托管链整条是 HDR 的（LDR 中间纹理会把 URP 管线压成 8bit，
            // GameRenderTexture 踩过同一个坑），上色层不做第二个 8bit 瓶颈。
            _rt = new RenderTexture(textureSize.x, textureSize.y, 24, RenderTextureFormat.ARGBHalf)
            { name = "ProjectorCameraRig RT" };
            _cam.targetTexture = _rt;

            var shader = Shader.Find(ParallaxShaderName);
            if (shader == null)
            {
                Debug.LogError($"[ProjectorCameraRig] 找不到 {ParallaxShaderName} —— "
                             + "打包版要靠 ProjectionShaderKeepAlive 里的保活材质。", this);
                return;
            }
            _material = new Material(shader) { name = "PlaneAnchoredParallax (runtime)" };

            if (outputImage == null)
            {
                outputImage = CreateOutputImage();
                _spawnedOutput = outputImage != null ? outputImage.gameObject : null;
            }
            if (outputImage != null)
            {
                outputImage.texture = _rt;
                outputImage.material = _material;
                // 叠在预畸变那张之上：同一画布里排到最后一个兄弟
                outputImage.transform.SetAsLastSibling();
                outputImage.raycastTarget = false;
            }
        }

        /// <summary>
        /// 自动接线：找到预畸变那张 RawImage（<see cref="ProjectorFeed"/> 持有它），在它**同一个父节点下**
        /// 建一张同尺寸的兄弟 —— 预畸变画布是 Screen Space - Overlay，在所有相机之后绘制，
        /// 相机没法直接盖上去。**单机预览**（场景里没有装置）时自建一块全屏 Overlay 画布，
        /// 让编辑器里也能看到上色层会投出什么。
        /// </summary>
        RawImage CreateOutputImage()
        {
            var feed = FindFirstObjectByType<ProjectorFeed>();
            RawImage warped = feed != null ? feed.OutputImage : null;

            RectTransform parent;
            if (warped != null)
            {
                parent = (RectTransform)warped.transform.parent;
            }
            else
            {
                var canvasGo = new GameObject("ProjectionMappedOverlayCanvas (preview)",
                    typeof(RectTransform), typeof(Canvas));
                canvasGo.transform.SetParent(transform, false);
                var canvas = canvasGo.GetComponent<Canvas>();
                canvas.renderMode = RenderMode.ScreenSpaceOverlay;
                canvas.sortingOrder = -900;   // 在游戏 UI 之下没有意义（Overlay 恒在最上），压低只为不盖操作面板
                parent = (RectTransform)canvasGo.transform;
            }

            var go = new GameObject("ProjectionMappedOverlay", typeof(RectTransform), typeof(RawImage));
            var rt = (RectTransform)go.transform;
            rt.SetParent(parent, false);
            if (warped != null)
            {
                var src = (RectTransform)warped.transform;
                rt.anchorMin = src.anchorMin;
                rt.anchorMax = src.anchorMax;
                rt.offsetMin = src.offsetMin;
                rt.offsetMax = src.offsetMax;
                rt.pivot = src.pivot;
                rt.localScale = src.localScale;
            }
            else
            {
                rt.anchorMin = Vector2.zero;
                rt.anchorMax = Vector2.one;
                rt.offsetMin = Vector2.zero;
                rt.offsetMax = Vector2.zero;
            }
            return go.GetComponent<RawImage>();
        }

        /// <summary>
        /// 整层拆掉：本组件连同 GameObject 一起没（相机、RT、材质走 <see cref="OnDestroy"/>）。
        ///
        /// ⚠ **不能只销毁 GameObject**：合成用的那张 RawImage 是运行时挂到装置画布上的
        /// **兄弟节点**，不在 rig 的子树里。只销毁 rig 的话画布上会留下一张贴着已释放 RT 的
        /// RawImage —— 而 RawImage 没有贴图就按纯色画，等于在投影帧上糊一整块白。
        /// </summary>
        public void Teardown()
        {
            if (_spawnedOutput != null)
            {
                DestroyImmediate(_spawnedOutput);
                _spawnedOutput = null;
            }
            else if (outputImage != null)
            {
                // 场景里手接的那张不归本装置销毁，但也不能让它继续画一张已死的 RT
                outputImage.texture = null;
                outputImage.material = null;
                outputImage.enabled = false;
            }
            outputImage = null;
            _configured = false;
            DestroyImmediate(gameObject);
        }

        void OnDestroy()
        {
            if (_rt != null)
            {
                if (_cam != null && _cam.targetTexture == _rt) _cam.targetTexture = null;
                _rt.Release();
                Destroy(_rt);
            }
            if (_material != null) Destroy(_material);
        }
    }
}
