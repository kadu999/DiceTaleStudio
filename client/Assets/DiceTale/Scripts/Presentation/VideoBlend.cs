using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Video;

namespace DiceTale
{
    /// <summary>
    /// 贴图上的**视频混合层**：**两路素材**（A 盖住 / B 擦开露出）叠在宿主对象自己的矩形上，
    /// 用一个**纯运行态**的 Mask 决定哪里显示哪一路。
    ///
    /// 每路可以是**视频**（`VideoPlayer` → `RenderTexture`）或**图片**（取一张贴图），
    /// 由数据里的 `kind` 说了算（见 <see cref="Source"/>）——图片那一路走
    /// <see cref="ResourceImageLoader"/>（与对象自己的贴图同一条取图路，缓存复用、不归这里释放）。
    ///
    /// 与 <see cref="VideoOverlay"/>（一条视频、`MaterialOverride` 零拷贝）/
    /// <see cref="FogOfWar"/>（按格子填遮罩 + 模糊链）的分工：
    /// - 由 <see cref="SceneObjectView"/> 在对象带 `VideoBlend` 协议组件时挂上（像 `FogOfWar`）；
    /// - 自建一个子物体 `VideoBlendOverlay`（挂 <see cref="VideoBlendLayer"/>），位置 / 旋转 / 缩放
    ///   自动跟着宿主；尺寸 = 对象矩形 × scale（调用方乘好）；
    /// - 视频那一路一个 `VideoPlayer` → 一张 `RenderTexture`（**这是与 VideoOverlay 不同的渲染
    ///   路径**：零拷贝换不来「两路同时上屏」，只能各出一张再混合）；
    /// - 混合面片用自建 shader `DiceTale/VideoBlend`（`lerp(B, A, mask.a)`）。
    ///
    /// **遮罩只在前端**（不写文档、也不随场景推送回来）：与 `FogOfWar` 同一套——组件里留一份
    /// CPU 遮罩 + 一份**有序的擦除记录**，素材尺寸变了就「重填初始态 + 按顺序重放」。
    /// 初始态是**整张不透明**（A 全盖住、B 完全看不见）。
    ///
    /// 遮罩尺寸按**素材像素尺寸**推（<see cref="MaskSizeFor"/>，与编辑器 `mask-math.ts` 的
    /// `previewMaskSizeFor` 同式：960 宽、高按比例、长边封顶 2048）——维度要等视频
    /// `prepareCompleted` / 图片加载完才知道，所以遮罩那时才建；命令先到也没有关系（擦除记录会重放上去）。
    /// </summary>
    [DisallowMultipleComponent]
    public class VideoBlend : MonoBehaviour
    {
        private const string OverlayName = "VideoBlendOverlay";
        private const string BlendShaderName = "DiceTale/VideoBlend";
        private const float OverlayLift = 0.001f;
        private const int MaskPreviewWidth = 960;
        private const int MaxPreviewEdge = 2048;
        private const int FallbackHeight = 540;
        private const float PrepareTimeoutSeconds = 15f;

        private static readonly Color32 Opaque = new Color32(255, 255, 255, 255);
        private static readonly Color32 Cleared = new Color32(255, 255, 255, 0);
        private static readonly string[] ChannelTextureProps = { "_TexA", "_TexB" };

        /// <summary>
        /// 一路素材：**视频**给已经解析好的 URL、**图片**给资源逻辑 ID（用 <see cref="SetImageLoader"/>
        /// 那份加载器取）。`Reference` 空 = 这一路空着（黑场）。
        /// </summary>
        public readonly struct Source
        {
            public readonly bool IsVideo;
            public readonly string Reference;

            public Source(bool isVideo, string reference)
            {
                IsVideo = isVideo;
                Reference = reference ?? "";
            }

            public bool IsEmpty => string.IsNullOrEmpty(Reference);
        }

        private VideoPlayer playerA;
        private VideoPlayer playerB;
        private RenderTexture targetA;
        private RenderTexture targetB;
        private VideoBlendLayer layer;
        private Material blendMaterial;
        private ResourceImageLoader imageLoader;
        private Coroutine watchdog;

        private float worldWidth = 1f;
        private float worldHeight = 1f;
        private int sortingOrder;
        private bool loop;
        private string audio = "none";

        /// <summary>这一轮两路放什么（`Play` 时定下；`BindTextures` / 暂停继续都按它走）。</summary>
        private Source sourceA;
        private Source sourceB;
        private string urlA = "";
        private string urlB = "";

        /// <summary>已经就绪的路数（视频 prepare 完 / 图片加载完）。第一路就绪就把面片显出来。</summary>
        private int readyCount;

        private Color32[] pixels = new Color32[0];
        private Texture2D maskTexture;
        private int maskWidth;
        private int maskHeight;

        /// <summary>有序的擦除记录：素材尺寸一变就「重填初始态 + 重放」（与 `FogOfWar` 同一套）。</summary>
        private readonly List<Stroke> ops = new List<Stroke>();

        private bool warnedNoShader;
        private bool warnedNoPrepare;

        /// <summary>正在放 / 暂停中（给命令路由与日志用）。两路都是图片时恒为 false。</summary>
        public bool IsPlaying =>
            (playerA != null && playerA.isPlaying) || (playerB != null && playerB.isPlaying);

        public bool IsPaused { get; private set; }

        private struct Stroke
        {
            public float radius;
            public float softness;
            public List<Vector2> points;
        }

        private void OnDestroy()
        {
            if (watchdog != null)
            {
                StopCoroutine(watchdog);
                watchdog = null;
            }

            ReleaseTargets();
            if (blendMaterial != null)
            {
                Release(blendMaterial);
                blendMaterial = null;
            }

            if (maskTexture != null)
            {
                Release(maskTexture);
                maskTexture = null;
            }
        }

        // ---------------------------------------------------------------- 取图加载器（图片那一路用）

        /// <summary>
        /// 接上取图加载器（<see cref="SceneObjectView.Create"/> 挂组件时调）。
        ///
        /// **图片那一路**靠它取图；没接上时图片那一路会被跳过并报一条错（视频那一路不受影响）。
        /// </summary>
        public void SetImageLoader(ResourceImageLoader loader)
        {
            imageLoader = loader;
        }

        // ---------------------------------------------------------------- 场景推送（尺寸 / 开关）

        /// <summary>收下这份数据（每次场景推送都会调）：尺寸 / 显示顺序 / 循环 / 声音来源。幂等。</summary>
        public void Apply(float width, float height, int order, bool shouldLoop, string audioChannel)
        {
            worldWidth = width <= 0f ? 1f : width;
            worldHeight = height <= 0f ? 1f : height;
            sortingOrder = order;
            loop = shouldLoop;
            audio = string.IsNullOrEmpty(audioChannel) ? "none" : audioChannel;

            ApplyLoopAudio();

            if (layer != null)
            {
                layer.Apply(null, worldWidth, worldHeight, Color.white, sortingOrder, OverlayLift);
                BindTextures();
            }
        }

        // ---------------------------------------------------------------- 命令

        /// <summary>
        /// 放两路素材（URL / 资源逻辑 ID 由命令路由按 `kind` 解析好）。
        ///
        /// **至少一路非空**（路由那边拦过了）：空的那一路按黑场；两路都是图片时面片照样建、
        /// 只是没有 `VideoPlayer` 在跑（`IsPlaying` 为 false）。
        /// </summary>
        public void Play(Source a, Source b)
        {
            sourceA = a;
            sourceB = b;
            urlA = a.IsVideo ? a.Reference : "";
            urlB = b.IsVideo ? b.Reference : "";

            EnsureOverlay();
            EnsurePlayers();
            ApplyLoopAudio();

            IsPaused = false;
            readyCount = 0;
            SetRendererEnabled(false);

            // 先把两路都指到各自的空 RT（黑的）：图片那一路加载完再换成贴图，
            // 视频那一路本来就渲在这张 RT 上
            if (blendMaterial != null)
            {
                blendMaterial.SetTexture(ChannelTextureProps[0], targetA);
                blendMaterial.SetTexture(ChannelTextureProps[1], targetB);
                if (maskTexture != null)
                {
                    blendMaterial.SetTexture("_Mask", maskTexture);
                }
            }

            StartChannel(0, a);
            StartChannel(1, b);

            if (watchdog != null)
            {
                StopCoroutine(watchdog);
                watchdog = null;
            }

            if ((a.IsVideo || b.IsVideo) && isActiveAndEnabled)
            {
                watchdog = StartCoroutine(WatchPrepare());
            }

            Debug.Log(
                $"[视频混合] 准备播放：A={Describe(a)}，B={Describe(b)}（循环={loop}，声音={audio}）");
        }

        public void Pause()
        {
            var any = false;
            if (playerA != null && playerA.isPlaying)
            {
                playerA.Pause();
                any = true;
            }

            if (playerB != null && playerB.isPlaying)
            {
                playerB.Pause();
                any = true;
            }

            if (any)
            {
                IsPaused = true;
            }
        }

        public void Resume()
        {
            IsPaused = false;

            var resumed = false;
            if (playerA != null && playerA.isPrepared)
            {
                playerA.Play();
                resumed = true;
            }

            if (playerB != null && playerB.isPrepared)
            {
                playerB.Play();
                resumed = true;
            }

            if (resumed)
            {
                return;
            }

            // 一个都没准备好：把视频那两路重新 Prepare（图片那一路不用管）
            SetRendererEnabled(false);
            if (sourceA.IsVideo)
            {
                playerA.Prepare();
            }

            if (sourceB.IsVideo)
            {
                playerB.Prepare();
            }
        }

        /// <summary>停掉播放（视频层由调用方销毁；这里只停解码 / 隐藏那一层）。</summary>
        public void StopPlayback()
        {
            if (watchdog != null)
            {
                StopCoroutine(watchdog);
                watchdog = null;
            }

            if (playerA != null)
            {
                playerA.Stop();
            }

            if (playerB != null)
            {
                playerB.Stop();
            }

            SetRendererEnabled(false);
            IsPaused = false;
        }

        /// <summary>
        /// 擦一笔（`erase_video_mask`）：沿轨迹打软边擦除圆（与编辑器 Mask 窗口 / 战争雾同一套公式）。
        /// `softness` 由编辑器给：视频混合是 `0.5`（**要实心核**，擦到的地方才真的到 0、完全露出 B）——
        /// 雾那档 `1` 没有平顶核，擦得再密也到不了 0，擦完的区域会永远糊着一层 A。
        /// 遮罩还没建好（素材还没就绪）时也收下——记录会重放上去。
        /// </summary>
        public bool EraseStroke(IReadOnlyList<Vector2> points, float radius, float softness)
        {
            if (points == null || points.Count == 0)
            {
                return false;
            }

            var op = new Stroke
            {
                radius = Mathf.Max(0f, radius),
                softness = Mathf.Clamp01(softness),
                points = new List<Vector2>(points),
            };

            ops.Add(op);

            if (maskTexture != null)
            {
                ApplyStroke(op);
                Upload();
            }

            return true;
        }

        // ---------------------------------------------------------------- 渲染子物体 / 播放器

        private void EnsureOverlay()
        {
            if (layer != null)
            {
                return;
            }

            var go = new GameObject(OverlayName);
            go.transform.SetParent(transform, false);
            layer = go.AddComponent<VideoBlendLayer>();
            layer.Apply(null, worldWidth, worldHeight, Color.white, sortingOrder, OverlayLift);
            blendMaterial = layer.OwnedMaterial;

            if (blendMaterial != null && blendMaterial.shader != null && blendMaterial.shader.name != BlendShaderName && !warnedNoShader)
            {
                warnedNoShader = true;
                Debug.LogError($"[视频混合] 找不到 Shader「{BlendShaderName}」：混合层会显示成占位色");
            }
        }

        private void EnsurePlayers()
        {
            if (playerA != null)
            {
                return;
            }

            var goA = new GameObject("VideoBlendA");
            goA.transform.SetParent(transform, false);
            playerA = goA.AddComponent<VideoPlayer>();
            ConfigurePlayer(playerA);
            playerA.prepareCompleted += OnPrepared;
            playerA.errorReceived += OnError;
            targetA = NewTarget();

            var goB = new GameObject("VideoBlendB");
            goB.transform.SetParent(transform, false);
            playerB = goB.AddComponent<VideoPlayer>();
            ConfigurePlayer(playerB);
            playerB.prepareCompleted += OnPrepared;
            playerB.errorReceived += OnError;
            targetB = NewTarget();

            playerA.targetTexture = targetA;
            playerB.targetTexture = targetB;
        }

        private void ConfigurePlayer(VideoPlayer player)
        {
            player.playOnAwake = false;
            player.waitForFirstFrame = true;
            player.isLooping = false;
            player.renderMode = VideoRenderMode.RenderTexture;
        }

        private RenderTexture NewTarget()
        {
            return new RenderTexture(MaskPreviewWidth, FallbackHeight, 0, RenderTextureFormat.ARGB32)
            {
                name = "VideoBlendTarget",
                filterMode = FilterMode.Bilinear,
                wrapMode = TextureWrapMode.Clamp,
                hideFlags = HideFlags.DontSave,
            };
        }

        /// <summary>按一路素材把这一路起起来：视频 → `Prepare`；图片 → 用加载器取图。</summary>
        private void StartChannel(int index, Source source)
        {
            if (source.IsEmpty)
            {
                return;
            }

            if (!source.IsVideo)
            {
                LoadChannelImage(index, source.Reference);
                return;
            }

            var player = index == 0 ? playerA : playerB;
            player.url = source.Reference;
            player.Stop();
            player.Prepare();
        }

        /// <summary>图片那一路：取图（缓存复用）→ 绑上材质 → 就绪。</summary>
        private void LoadChannelImage(int index, string logicalId)
        {
            var prop = ChannelTextureProps[index];
            if (imageLoader == null)
            {
                Debug.LogError($"[视频混合] 图片那一路需要取图加载器，但没接上：{logicalId}");
                return;
            }

            imageLoader.Load(logicalId, (texture) =>
            {
                if (texture == null || blendMaterial == null)
                {
                    return;
                }

                blendMaterial.SetTexture(prop, texture);
                if (texture.width > 0 && texture.height > 0)
                {
                    EnsureMask(texture.width, texture.height);
                }

                MarkReady();
            });
        }

        /// <summary>
        /// 只绑**视频那两路**的 RT（图片那一路的贴图由 <see cref="LoadChannelImage"/> 自己绑，
        /// 不能被这里的空 RT 盖掉）+ 遮罩。`Upload` / `Apply` / 每次就绪都走它。
        /// </summary>
        private void BindTextures()
        {
            if (blendMaterial == null)
            {
                return;
            }

            if (sourceA.IsVideo && targetA != null)
            {
                blendMaterial.SetTexture(ChannelTextureProps[0], targetA);
            }

            if (sourceB.IsVideo && targetB != null)
            {
                blendMaterial.SetTexture(ChannelTextureProps[1], targetB);
            }

            if (maskTexture != null)
            {
                blendMaterial.SetTexture("_Mask", maskTexture);
            }
        }

        private void ApplyLoopAudio()
        {
            if (playerA == null)
            {
                return;
            }

            playerA.isLooping = loop;
            playerB.isLooping = loop;
            // 两条同时放，声音至多出一路（与面板上的「声音来源」同一口径）
            playerA.audioOutputMode = audio == "a" ? VideoAudioOutputMode.Direct : VideoAudioOutputMode.None;
            playerB.audioOutputMode = audio == "b" ? VideoAudioOutputMode.Direct : VideoAudioOutputMode.None;
        }

        private void OnPrepared(VideoPlayer source)
        {
            // 视频尺寸只有 prepare 之后才知道：用第一路报上来的宽高建遮罩
            var index = source == playerB ? 1 : 0;
            var width = (int)source.width;
            var height = (int)source.height;
            if (width > 0 && height > 0)
            {
                EnsureMask(width, height);
                ResizeTarget(index == 0 ? targetA : targetB, width, height);
            }

            source.Play();
            MarkReady();
        }

        /// <summary>一路就绪：绑材质 + 显出面片（第一路就绪就显示，另一路随后上来）。</summary>
        private void MarkReady()
        {
            readyCount += 1;
            BindTextures();
            SetRendererEnabled(true);
        }

        private void OnError(VideoPlayer source, string message)
        {
            // 两路都没起来才藏那一层：图片那一路 + 视频那一路，坏了一路不该把好的也藏掉
            if (readyCount == 0)
            {
                SetRendererEnabled(false);
            }

            Debug.LogError(
                $"[视频混合] 播放失败：{message}（A={urlA}，B={urlB}；Windows 上建议 H.264 的 .mp4）");
        }

        private IEnumerator WatchPrepare()
        {
            var deadline = Time.realtimeSinceStartup + PrepareTimeoutSeconds;
            while (Time.realtimeSinceStartup < deadline)
            {
                if (VideoChannelsPrepared())
                {
                    yield break;
                }

                yield return null;
            }

            if (!warnedNoPrepare && !VideoChannelsPrepared())
            {
                warnedNoPrepare = true;
                Debug.LogError(
                    $"[视频混合] 等首帧超时（{PrepareTimeoutSeconds} 秒）：A={urlA}，B={urlB}（多半是这台机器解不了这个编码）");
            }
        }

        /// <summary>视频那几路都 prepare 好了吗（没有视频路 = 直接算好）。</summary>
        private bool VideoChannelsPrepared()
        {
            if (sourceA.IsVideo && (playerA == null || !playerA.isPrepared))
            {
                return false;
            }

            if (sourceB.IsVideo && (playerB == null || !playerB.isPrepared))
            {
                return false;
            }

            return true;
        }

        private void SetRendererEnabled(bool enabled)
        {
            if (layer == null)
            {
                return;
            }

            var renderer = layer.GetComponent<Renderer>();
            if (renderer != null)
            {
                renderer.enabled = enabled;
            }
        }

        private void ResizeTarget(RenderTexture target, int width, int height)
        {
            if (target == null || (target.width == width && target.height == height))
            {
                return;
            }

            target.Release();
            target.width = width;
            target.height = height;
            target.Create();
        }

        private static string Describe(Source source)
        {
            if (source.IsEmpty)
            {
                return "-";
            }

            return source.IsVideo ? $"{source.Reference}（视频）" : $"{source.Reference}（图片）";
        }

        // ---------------------------------------------------------------- 遮罩

        /// <summary>与编辑器 `mask-math.ts` 的 `previewMaskSizeFor` 同式（两端遮罩必须是同一张尺寸）。</summary>
        private static Vector2Int MaskSizeFor(int videoWidth, int videoHeight)
        {
            var aspect = Mathf.Max(1, videoHeight) / (float)Mathf.Max(1, videoWidth);
            var width = MaskPreviewWidth;
            var height = Mathf.Max(1, Mathf.RoundToInt(width * aspect));

            var longest = Mathf.Max(width, height);
            if (longest > MaxPreviewEdge)
            {
                var scale = MaxPreviewEdge / (float)longest;
                width = Mathf.Max(1, Mathf.RoundToInt(width * scale));
                height = Mathf.Max(1, Mathf.RoundToInt(height * scale));
            }

            return new Vector2Int(width, height);
        }

        private void EnsureMask(int videoWidth, int videoHeight)
        {
            var size = MaskSizeFor(videoWidth, videoHeight);
            if (maskTexture != null && maskWidth == size.x && maskHeight == size.y)
            {
                return;
            }

            maskWidth = size.x;
            maskHeight = size.y;
            pixels = new Color32[Mathf.Max(1, maskWidth * maskHeight)];

            if (maskTexture != null)
            {
                Release(maskTexture);
            }

            maskTexture = new Texture2D(maskWidth, maskHeight, TextureFormat.RGBA32, false)
            {
                name = "VideoBlendMask",
                filterMode = FilterMode.Bilinear,
                wrapMode = TextureWrapMode.Clamp,
                hideFlags = HideFlags.DontSave,
            };

            // 尺寸变了：旧记录是按旧尺寸算的，重放没有意义（与 FogOfWar 同一条口径）
            ops.Clear();
            Rebuild();
        }

        private void Rebuild()
        {
            if (maskTexture == null)
            {
                return;
            }

            FillInitial();
            for (var i = 0; i < ops.Count; i++)
            {
                ApplyStroke(ops[i]);
            }

            Upload();
        }

        private void FillInitial()
        {
            for (var i = 0; i < pixels.Length; i++)
            {
                pixels[i] = Opaque;
            }
        }

        private void ApplyStroke(Stroke op)
        {
            var points = op.points;
            if (points == null || points.Count == 0)
            {
                return;
            }

            var radiusTex = Mathf.Max(1f, op.radius * maskWidth);
            if (points.Count == 1)
            {
                Stamp(ToTexel(points[0]), radiusTex, op.softness);
                return;
            }

            var step = Mathf.Max(1f, radiusTex * 0.5f);
            for (var i = 0; i < points.Count - 1; i++)
            {
                var from = ToTexel(points[i]);
                var to = ToTexel(points[i + 1]);
                var distance = (to - from).magnitude;
                var samples = Mathf.Max(1, Mathf.CeilToInt(distance / step));
                for (var s = 0; s <= samples; s++)
                {
                    Stamp(Vector2.Lerp(from, to, s / (float)samples), radiusTex, op.softness);
                }
            }
        }

        /// <summary>与编辑器 `applyEraseToPixels` / `FogOfWar.Stamp` 逐字同式（只改 alpha，min 幂等）。</summary>
        private void Stamp(Vector2 center, float radius, float softness)
        {
            var core = radius * (1f - Mathf.Clamp01(softness));
            var band = Mathf.Max(radius - core, 1e-5f);

            var x0 = Mathf.Max(0, Mathf.FloorToInt(center.x - radius));
            var x1 = Mathf.Min(maskWidth - 1, Mathf.CeilToInt(center.x + radius));
            var y0 = Mathf.Max(0, Mathf.FloorToInt(center.y - radius));
            var y1 = Mathf.Min(maskHeight - 1, Mathf.CeilToInt(center.y + radius));

            for (var y = y0; y <= y1; y++)
            {
                for (var x = x0; x <= x1; x++)
                {
                    var dx = x + 0.5f - center.x;
                    var dy = y + 0.5f - center.y;
                    var distance = Mathf.Sqrt(dx * dx + dy * dy);
                    if (distance > radius)
                    {
                        continue;
                    }

                    var erased = (byte)Mathf.RoundToInt(Mathf.Clamp01((distance - core) / band) * 255f);
                    var index = y * maskWidth + x;
                    var current = pixels[index];
                    if (erased < current.a)
                    {
                        pixels[index] = new Color32(Cleared.r, Cleared.g, Cleared.b, erased);
                    }
                }
            }
        }

        private Vector2 ToTexel(Vector2 point)
        {
            return new Vector2(
                Mathf.Clamp01(point.x) * maskWidth,
                (1f - Mathf.Clamp01(point.y)) * maskHeight
            );
        }

        private void Upload()
        {
            if (maskTexture == null)
            {
                return;
            }

            maskTexture.SetPixels32(pixels);
            maskTexture.Apply(false);
            BindTextures();
        }

        // ---------------------------------------------------------------- 释放

        private void ReleaseTargets()
        {
            if (targetA != null)
            {
                targetA.Release();
                Release(targetA);
                targetA = null;
            }

            if (targetB != null)
            {
                targetB.Release();
                Release(targetB);
                targetB = null;
            }
        }

        /// <summary>
        /// 释放自建的 Unity 对象：运行时用 `Destroy`，编辑器用 `DestroyImmediate`
        /// （与 <see cref="FogOfWar.Release"/> 同一份取舍）。**不释放取图加载器给的贴图**——
        /// 那是它缓存并复用的（见 `ResourceImageLoader`）。
        /// </summary>
        internal static void Release(UnityEngine.Object owned)
        {
            if (Application.isPlaying)
            {
                Destroy(owned);
            }
            else
            {
                DestroyImmediate(owned);
            }
        }
    }
}
