using System.Collections;
using UnityEngine;
using UnityEngine.Video;

namespace DiceTale
{
    /// <summary>
    /// 地图 / 精灵上的**视频层**：把一条视频放成**那个对象自己矩形**上的一块面片。
    ///
    /// 它由 <see cref="SceneObjectView"/> 在收到 `play_video` 时**按需建出来**（作为对象视图的
    /// **子物体**：位置 / 旋转跟着对象走，对象被隐藏时一起隐藏），`stop_video` 时整个拆掉——
    /// 拆掉就露出对象自己原来的贴图。与战争雾那层「挂在场景根节点、盖住整个场景」不同：
    /// 视频只盖它自己那个对象，所以子物体是最贴切的结构（不必再摆一遍位置）。
    ///
    /// **按 URL 播，不用 `VideoClip`**：视频是后台推下来的**资源逻辑 ID**，字节在本地资源包里
    /// （或从服务端逐文件取），所以只能走 `VideoPlayer.url`。这条路也绕开了 Unity 的导入限制
    /// （见 Unity 手册「Video file compatibility」）：能不能解码取决于**运行平台**的解码器——
    /// Windows 上稳的是 **H.264 的 .mp4**，`.webm` 多半解不了（编辑器在选素材时就提醒过）。
    ///
    /// **显示顺序与地图相同**。首帧准备完成后隐藏地图 Renderer，由视频面片替代地图画面；
    /// 视频停止或解码失败时恢复地图 Renderer。面片位置固定在宿主原点，不额外移动或抬升。
    ///
    /// **首帧之前不显示**：`ImageLayer` 没有纹理时会画一块纯色占位，如果一建出来就显示，
    /// 视频还没解码就先闪一块白底。所以先把 renderer 关掉，`prepareCompleted` 再打开。
    ///
    /// 视频自带的声音由 `video.audio` 决定（缺省静音）：对应 `VideoPlayer.audioOutputMode`。
    /// </summary>
    [DisallowMultipleComponent]
    [RequireComponent(typeof(ImageLayer))]
    public class VideoOverlay : MonoBehaviour
    {
        /// <summary>子物体名（层级里一眼看出多出来的这一块是什么）。</summary>
        public const string OverlayName = "VideoOverlay";

        /// <summary>等首帧的上限（秒）：prepare 一直不回调时别把画面永远留在「黑着等」的状态。</summary>
        private const float PrepareTimeoutSeconds = 15f;

        private VideoPlayer player;
        private ImageLayer quad;
        private Renderer quadRenderer;
        private Renderer sourceRenderer;
        private bool sourceRendererWasEnabled;

        /// <summary>等首帧的看门狗（见 <see cref="PrepareTimeoutSeconds"/>）。</summary>
        private Coroutine prepareWatchdog;

        private bool loop;
        private bool audioEnabled;

        /// <summary>正在放 / 暂停中（给命令路由与日志用）。</summary>
        public bool IsPlaying => player != null && player.isPlaying;

        public bool IsPaused { get; private set; }

        /// <summary>这条视频的资源逻辑 ID（诊断日志用）。</summary>
        public string LogicalId { get; private set; } = "";

        /// <summary>
        /// 建好那一块面片。位置留在宿主原点，显示顺序与地图一致。
        ///
        /// 一开始 renderer 是**关着**的：视频首帧到了才显示（见类注释）。
        /// </summary>
        public static VideoOverlay Create(
            Transform parent,
            float worldWidth,
            float worldHeight,
            int sortingOrder,
            Renderer sourceRenderer,
            string logicalId)
        {
            var go = new GameObject(OverlayName);
            go.transform.SetParent(parent, false);

            var overlay = go.AddComponent<VideoOverlay>();
            overlay.LogicalId = logicalId ?? "";

            /*
              `VideoOverlay` 声明了 `[RequireComponent(typeof(ImageLayer))]`：上面那一行
              **已经**把 ImageLayer（以及它要求的 MeshFilter / MeshRenderer）挂好了。
              所以这里只能**取**——再 `AddComponent<ImageLayer>()` 一次会被
              `[DisallowMultipleComponent]` 拒掉并返回 null，于是 `quad` 是 null、
              `ApplyGeometry` 直接返回：**网格永远建不出来、尺寸也从来没应用过**（踩过一次，
              Unity 控制台里那句就是「Can't add 'ImageLayer' … already added」）。
            */
            overlay.quad = go.GetComponent<ImageLayer>();
            if (overlay.quad == null)
            {
                // 兜底：万一以后有人把 RequireComponent 去掉
                overlay.quad = go.AddComponent<ImageLayer>();
            }

            overlay.quadRenderer = overlay.quad.GetComponent<Renderer>();
            overlay.sourceRenderer = sourceRenderer;
            overlay.sourceRendererWasEnabled = sourceRenderer != null && sourceRenderer.enabled;
            overlay.ApplyGeometry(worldWidth, worldHeight, sortingOrder);

            // 还没有纹理：先藏着，别让占位色盖住对象
            if (overlay.quadRenderer != null)
            {
                overlay.quadRenderer.enabled = false;
            }

            overlay.player = go.AddComponent<VideoPlayer>();
            overlay.player.playOnAwake = false;
            overlay.player.waitForFirstFrame = true;
            overlay.player.isLooping = false;
            overlay.player.renderMode = VideoRenderMode.MaterialOverride;
            overlay.player.targetMaterialRenderer = overlay.quadRenderer;
            overlay.player.targetMaterialProperty = "_MainTex";
            overlay.player.prepareCompleted += overlay.OnPrepared;
            overlay.player.errorReceived += overlay.OnError;
            overlay.player.loopPointReached += overlay.OnLoopPointReached;

            return overlay;
        }

        /// <summary>对象尺寸或排序变化时跟着更新，位置始终留在宿主原点。</summary>
        public void ApplyGeometry(float worldWidth, float worldHeight, int sortingOrder)
        {
            if (quad == null)
            {
                // 走到这里说明初始化漏了（Create 是唯一入口）：说清楚，别让它表现成「视频层是空的」
                Debug.LogError($"[视频] 视频层没有 ImageLayer，网格建不出来：{LogicalId}");
                return;
            }

            quad.Apply(null, worldWidth, worldHeight, Color.white, sortingOrder, 0f);
        }

        /// <summary>放某一条视频（`url` 是本地包或服务端的地址，见 <see cref="ResourceBundleCache.LocalUrlOf"/>）。</summary>
        public void Play(string url, bool shouldLoop, bool shouldPlayAudio)
        {
            loop = shouldLoop;
            audioEnabled = shouldPlayAudio;
            IsPaused = false;
            ApplyAudioMode();

            player.isLooping = loop;
            player.url = url;

            // 换了 URL 一定要重新 Prepare：先 Stop 把上一份清掉，避免旧帧留在材质里
            player.Stop();
            RestoreSourceRenderer();
            if (quadRenderer != null)
            {
                quadRenderer.enabled = false;
            }

            player.Prepare();

            if (prepareWatchdog != null)
            {
                StopCoroutine(prepareWatchdog);
                prepareWatchdog = null;
            }

            /*
              看门狗只在物体**是激活的**时候起得来：对象被隐藏 / 未落位时，视频层作为它的子物体
              也是 inactive，`StartCoroutine` 会直接抛异常。那种情况下画面本来就看不见，
              所以只提示一句，等对象显示出来再（重新点一次播放）。
            */
            if (isActiveAndEnabled)
            {
                prepareWatchdog = StartCoroutine(WatchPrepare());
            }
            else
            {
                Debug.LogWarning(
                    $"[视频] 「{LogicalId}」所在的对象当前不可见（没激活 / 未落位），先不等等首帧；" +
                    "让它显示出来后再点一次「播放」");
            }

            Debug.Log($"[视频] 准备播放：{LogicalId}（循环={loop}，声音={audioEnabled}）");
        }

        /// <summary>
        /// 等首帧的看门狗：**准备一直不回调**（平台解不了这个编码时就是这样，不一定会走
        /// `errorReceived`）时，至少留一条能照着排查的错误，而不是画面上什么都没有。
        /// </summary>
        private IEnumerator WatchPrepare()
        {
            var deadline = Time.realtimeSinceStartup + PrepareTimeoutSeconds;
            while (Time.realtimeSinceStartup < deadline)
            {
                if (player != null && player.isPrepared)
                {
                    yield break;
                }

                yield return null;
            }

            if (player != null && !player.isPrepared)
            {
                Debug.LogError(
                    $"[视频] 等首帧超时（{PrepareTimeoutSeconds} 秒）：{LogicalId}——" +
                    "多半是这台机器解不了这个编码（Windows 上建议 H.264 的 .mp4，webm 常常不行）");
            }
        }

        /// <summary>循环 / 声音开关变了（文档数据变了，运行中即时生效）。</summary>
        public void SetLoop(bool shouldLoop)
        {
            loop = shouldLoop;
            if (player != null)
            {
                player.isLooping = shouldLoop;
            }
        }

        public void SetAudioEnabled(bool enabled)
        {
            audioEnabled = enabled;
            ApplyAudioMode();
        }

        public void Pause()
        {
            if (player == null || !player.isPlaying)
            {
                return;
            }

            player.Pause();
            IsPaused = true;
        }

        public void Resume()
        {
            if (player == null)
            {
                return;
            }

            IsPaused = false;
            if (player.isPrepared)
            {
                player.Play();
                return;
            }

            if (quadRenderer != null)
            {
                quadRenderer.enabled = false;
            }

            RestoreSourceRenderer();
            player.Prepare();
        }

        /// <summary>停掉播放并恢复地图 Renderer（视频物体由调用方销毁）。</summary>
        public void StopPlayback()
        {
            if (prepareWatchdog != null)
            {
                StopCoroutine(prepareWatchdog);
                prepareWatchdog = null;
            }

            RestoreSourceRenderer();
            if (quadRenderer != null)
            {
                quadRenderer.enabled = false;
            }

            if (player == null)
            {
                return;
            }

            player.prepareCompleted -= OnPrepared;
            player.errorReceived -= OnError;
            player.loopPointReached -= OnLoopPointReached;
            player.Stop();
            IsPaused = false;
        }

        private void OnDestroy()
        {
            StopPlayback();
        }

        private void OnPrepared(VideoPlayer source)
        {
            if (prepareWatchdog != null)
            {
                StopCoroutine(prepareWatchdog);
                prepareWatchdog = null;
            }

            if (quadRenderer != null)
            {
                quadRenderer.enabled = true;
            }

            HideSourceRenderer();
            source.Play();
            IsPaused = false;
            Debug.Log($"[视频] 开始播放：{LogicalId}（循环={loop}）");
        }

        private void OnError(VideoPlayer source, string message)
        {
            if (quadRenderer != null)
            {
                quadRenderer.enabled = false;
            }

            RestoreSourceRenderer();
            // 解码失败最常见的两种原因：编码平台不支持（Windows 上的 webm / VP9）、文件不在本地
            Debug.LogError($"[视频] 播放失败：{LogicalId}（{message}）");
        }

        private void HideSourceRenderer()
        {
            if (sourceRenderer == null || !sourceRenderer.enabled)
            {
                return;
            }

            sourceRendererWasEnabled = sourceRenderer.enabled;
            sourceRenderer.enabled = false;
        }

        private void RestoreSourceRenderer()
        {
            if (sourceRenderer != null)
            {
                sourceRenderer.enabled = sourceRendererWasEnabled;
            }
        }

        private void OnLoopPointReached(VideoPlayer source)
        {
            // 循环时每圈都会触发：只在「放一遍」自然结束时说一句，方便排查「怎么停住了」
            if (!loop)
            {
                Debug.Log($"[视频] 播放结束（停在最后一帧；要露回对象原来的贴图请点「停止」）：{LogicalId}");
            }
        }

        private void ApplyAudioMode()
        {
            if (player == null)
            {
                return;
            }

            player.audioOutputMode = audioEnabled
                ? VideoAudioOutputMode.Direct
                : VideoAudioOutputMode.None;
        }
    }
}
