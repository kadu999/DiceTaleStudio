using System.Collections;
using UnityEngine;
using UnityEngine.Video;

namespace DiceTale
{
    /// <summary>
    /// 智能视频播放器：运行时直接创建 VideoPlayer，支持多 clip 按索引播放。
    /// PlayWithFade：切换时先把当前帧冻结到 RenderTexture，把目标 quad 换成
    /// DiceTale/VideoFade 交叉淡化材质（_FromTex=冻结帧, _MainTex=播放器实时纹理），
    /// _Alpha 0→1 平滑过渡。Play 保持原行为；淡化只在 PlayWithFade 中生效。
    /// 声音由 _audioEnabled 开关控制（默认关闭=静音），可运行时用 SetAudioEnabled 切换。
    /// </summary>
    public class SmartVideoPlayer : MonoBehaviour
    {
        [SerializeField]
        private Texture _placeholderTexture; // 静态占位图

        [SerializeField]
        private Renderer _target;

        [SerializeField]
        private bool _playOnAwake;

        [SerializeField]
        private bool _isLooping;

        [SerializeField, Tooltip("播放结束(循环关闭时)隐藏本显示对象；默认不启用")]
        private bool hideWhenFinished;

        [SerializeField, Tooltip("是否开启视频声音；默认关闭（音频输出模式为 None，静音播放）")]
        private bool _audioEnabled = false;

        /// <summary>播放自然结束（循环关闭时到达终点）触发，与隐藏开关无关，供外部感知播完。</summary>
        public event System.Action<SmartVideoPlayer> PlaybackFinished;

        [SerializeField]
        private VideoClip[] _videoClips; // 多个视频剪辑

        [SerializeField]
        private int _startIndex; // 默认从第几个 clip 开始播放

        [SerializeField, Tooltip("PlayWithFade 交叉淡化时长（秒）")]
        private float _fadeDuration = 0.5f;

        private VideoPlayer _videoPlayer;

        private int _currentIndex;

        private float _playbackSpeed = 1f;

        // 目标原本的材质（淡化结束要换回来）
        private Material _targetMaterial;

        // ---- 交叉淡化 ----
        private Material _fadeMaterial;   // DiceTale/VideoFade（_FromTex/_MainTex/_Alpha）
        private RenderTexture _frozenRT;  // 上一视频最后一帧
        private bool _fading;             // 淡化进行中
        private Coroutine _fadeRoutine;

        // 准备中
        private bool _isPrepared = false;

        // 期望播放态：prepare 完成回调据此决策（防止 Stop/换 clip 后迟到的 prepare 回调复活旧视频）
        private bool _wantsPlay;


        void Awake()
        {
            // 直接创建 VideoPlayer，不再引用场景中已有的组件
            _videoPlayer = gameObject.AddComponent<VideoPlayer>();

            if (_target == null)
            {
                _target = GetComponent<Renderer>();
            }

            if (_target == null)
            {
                return;
            }

            // 播放前先显示占位图（缓存目标材质实例，淡化结束要恢复它）
            _targetMaterial = _target.material;
            _targetMaterial.SetTexture("_MainTex", _placeholderTexture);

            _isPrepared = false;
            _videoPlayer.playOnAwake = false;
            ApplyAudioMode();
            _videoPlayer.renderMode = VideoRenderMode.MaterialOverride;
            _videoPlayer.targetMaterialRenderer = _target;
            _videoPlayer.targetMaterialProperty = "_MainTex";
            _videoPlayer.waitForFirstFrame = true;
            _videoPlayer.prepareCompleted += OnVideoPrepared;
            _videoPlayer.loopPointReached += OnVideoLoopPointReached;

            // 交叉淡化材质
            Shader shader = Shader.Find("DiceTale/VideoFade");
            if (shader == null)
            {
                shader = Resources.Load<Shader>("Shaders/VideoFade");
            }

            if (shader != null)
            {
                _fadeMaterial = new Material(shader);
            }

            if (_videoClips != null && _videoClips.Length > 0)
            {
                _currentIndex = Mathf.Clamp(_startIndex, 0, _videoClips.Length - 1);
                ApplyClip(_currentIndex);
            }
        }

        private void OnEnable()
        {
            if (_playOnAwake && _videoPlayer != null)
            {
                _wantsPlay = true; // playOnAwake 语义：prepare 完成后自动开播
                _videoPlayer.Prepare();
            }
        }

        private void OnDestroy()
        {
            if (_fadeRoutine != null)
            {
                StopCoroutine(_fadeRoutine);
            }

            RestoreAfterFade();

            if (_frozenRT != null)
            {
                _frozenRT.Release();
            }

            if (_fadeMaterial != null)
            {
                Destroy(_fadeMaterial);
            }
        }

        void OnVideoPrepared(VideoPlayer vp)
        {
            _isPrepared = true;
            if (_wantsPlay)
            {
                _videoPlayer.Play();
            }
        }

        /// <summary>播放到达终点(循环关闭时才会触发 loopPointReached)：按 hideWhenFinished 开关隐藏显示对象。</summary>
        private void OnVideoLoopPointReached(VideoPlayer vp)
        {
            // 循环播放时 loopPointReached 每圈都触发：只在「非循环自然结束」时广播播完事件
            //（与 PlaybackFinished 注释语义一致，避免「按播完计数」的流程被提前/重复推进）
            if (_isLooping)
            {
                return;
            }

            PlaybackFinished?.Invoke(this);

            if (hideWhenFinished)
            {
                if (_target != null)
                {
                    _target.enabled = false;
                }
            }
        }

        /// <summary>
        /// 根据 _audioEnabled 应用视频音频输出模式：true=Direct（有声音），false=None（静音）。
        /// Awake 与每次 ApplyClip 播放前都会调用，保证开关在 Inspector/运行时都生效。
        /// </summary>
        private void ApplyAudioMode()
        {
            if (_videoPlayer == null)
            {
                return;
            }

            _videoPlayer.audioOutputMode = _audioEnabled ? VideoAudioOutputMode.Direct : VideoAudioOutputMode.None;
        }

        /// <summary>
        /// 运行时开关视频声音（即时生效）：true=开声，false=静音。也同步 Inspector 中的 _audioEnabled。
        /// </summary>
        public void SetAudioEnabled(bool enabled)
        {
            _audioEnabled = enabled;
            ApplyAudioMode();
        }

        /// <summary>当前是否开启视频声音。</summary>
        public bool IsAudioEnabled => _audioEnabled;

        /// <summary>
        /// 播放当前 clip
        /// </summary>
        public void Play()
        {
            Play(_currentIndex);
        }

        /// <summary>
        /// 按索引播放指定的 clip
        /// </summary>
        public void Play(int index, bool loop = true, float speed = 1f)
        {
            if (_videoPlayer == null || _videoClips == null || index < 0 || index >= _videoClips.Length)
            {
                return;
            }

            if (_videoClips[index] == null)
            {
                return;
            }

            if (_target != null)
            {
                _target.enabled = true;
            }

            _isLooping = loop;
            _playbackSpeed = speed;
            _currentIndex = index;
            _wantsPlay = true;
            ApplyClip(_currentIndex);

            if (_videoPlayer.isPrepared)
            {
                _videoPlayer.Play();
            }
            else
            {
                _videoPlayer.Prepare();
            }
        }

        /// <summary>
        /// 带交叉淡化地播放指定 clip：冻结当前帧，切换新视频后 _Alpha 0→1 平滑过渡。
        /// duration &lt;= 0 时使用 Inspector 中的 _fadeDuration。
        /// </summary>
        public void PlayWithFade(int index, bool loop = true, float speed = 1f, float duration = -1f)
        {
            if (_videoPlayer == null || _videoClips == null || index < 0 || index >= _videoClips.Length)
            {
                return;
            }

            if (_videoClips[index] == null)
            {
                return;
            }

            if (_target != null)
            {
                _target.enabled = true;
            }

            _isLooping = loop;
            _playbackSpeed = speed;
            _currentIndex = index;
            _wantsPlay = true;

            // 打断上一次未完成的过渡，并还原目标材质
            if (_fadeRoutine != null)
            {
                StopCoroutine(_fadeRoutine);
                _fadeRoutine = null;
                RestoreAfterFade();
            }

            float d = duration > 0f ? duration : _fadeDuration;

            // 只有当前正在播放时才冻结得到"上一帧"；否则与 Play 行为一致，直接切换
            if (d > 0f && _videoPlayer.isPlaying && _videoPlayer.isPrepared)
            {
                _fadeRoutine = StartCoroutine(CrossFadeCoroutine(d));
            }
            else
            {
                ApplyClip(_currentIndex);
                if (_videoPlayer.isPrepared)
                {
                    _videoPlayer.Play();
                }
                else
                {
                    _videoPlayer.Prepare();
                }
            }
        }

        /// <summary>
        /// 停止播放（同时取消进行中的交叉淡化并还原状态）
        /// </summary>
        public void Stop()
        {
            _wantsPlay = false; // 清除期望态：迟到的 prepare 完成回调不再复活本视频
            if (_fadeRoutine != null)
            {
                StopCoroutine(_fadeRoutine);
                _fadeRoutine = null;
            }

            RestoreAfterFade();

            if (_videoPlayer != null)
            {
                _videoPlayer.Stop();
            }
        }

        /// <summary>
        /// 暂停：停在当前帧（不复位）；之后 <see cref="Resume"/> 或 <see cref="Play()"/> 续播。
        /// </summary>
        public void Pause()
        {
            if (_videoPlayer != null && _videoPlayer.isPlaying)
            {
                _videoPlayer.Pause();
            }
        }

        /// <summary>
        /// 继续：从暂停处恢复播放（Unity VideoPlayer.Play 对已暂停的播放器续播而非重启）；
        /// 未就绪时走 prepare，完成后按 <see cref="_wantsPlay"/> 自动开播。
        /// </summary>
        public void Resume()
        {
            if (_videoPlayer == null)
            {
                return;
            }

            _wantsPlay = true;
            if (_videoPlayer.isPrepared)
            {
                _videoPlayer.Play();
            }
            else
            {
                _videoPlayer.Prepare();
            }
        }

        // ---------------- 交叉淡化实现 ----------------

        private IEnumerator CrossFadeCoroutine(float duration)
        {
            // 1) 取当前帧（播放器实时纹理），冻结 + 换淡化材质
            Texture source = _videoPlayer.texture;
            if (source == null || _fadeMaterial == null || _target == null)
            {
                // 拿不到当前帧/材质：退化为普通切换，避免静默不切
                ApplyClip(_currentIndex);
                if (_videoPlayer.isPrepared)
                {
                    _videoPlayer.Play();
                }
                else
                {
                    _videoPlayer.Prepare();
                }

                _fadeRoutine = null;
                yield break;
            }

            EnsureRTs(source);

            // 冻结帧（Blit 瞬时采样，捕获的就是停止前那一帧）
            Graphics.Blit(source, _frozenRT);

            _fadeMaterial.SetTexture("_FromTex", _frozenRT);
            _fadeMaterial.SetTexture("_MainTex", source);
            _fadeMaterial.SetFloat("_Alpha", 0f);
            _target.material = _fadeMaterial;
            _fading = true;

            yield return null; // 等一帧，确保 GPU 拷贝完成

            // 2) 切换：先定住画面再立刻换 clip（Pause 与 ApplyClip 之间无 yield，
            //    协程被中断也不会把视频留在暂停态）。新视频通过 MaterialOverride
            //    持续写入淡化材质的 _MainTex，_Alpha 从 0 开始只显示冻结帧
            ApplyClip(_currentIndex);

            if (_videoPlayer.isPrepared)
            {
                _isPrepared = true;
                _videoPlayer.Play();
            }
            else
            {
                _isPrepared = false;
                _videoPlayer.Prepare();
            }

            // 3) 等新视频真正解码出第一帧（isPlaying 会提前置真，帧数据可能还没出来）
            float wait = 0f;
            while (wait < 5f && !_isPrepared)
            {
                wait += Time.unscaledDeltaTime;
                yield return null;
            }

            yield return null; // 再让一帧，确保第一帧已写入材质的 _MainTex

            // 4) 交叉淡化：_Alpha 0 -> 1
            float t = 0f;
            while (t < duration)
            {
                t += Time.unscaledDeltaTime;
                _fadeMaterial.SetFloat("_Alpha", Mathf.Clamp01(t / duration));
                yield return null;
            }

            _fadeMaterial.SetFloat("_Alpha", 1f);

            // 5) 还原
            RestoreAfterFade();
            _fadeRoutine = null;
        }

        /// <summary>
        /// 保证冻结 RT 存在且与当前视频同尺寸（跨淡化复用，不反复分配）
        /// </summary>
        private void EnsureRTs(Texture source)
        {
            if (_frozenRT != null && _frozenRT.width == source.width && _frozenRT.height == source.height)
            {
                return;
            }

            if (_frozenRT != null)
            {
                _frozenRT.Release();
            }

            _frozenRT = new RenderTexture(source.width, source.height, 0, RenderTextureFormat.ARGB32);
        }

        /// <summary>
        /// 淡化结束/被中断时：目标换回原材质
        /// </summary>
        private void RestoreAfterFade()
        {
            if (_fading && _target != null && _targetMaterial != null)
            {
                // 先让目标显示新视频的最后一帧，避免换回原材质时闪一下旧帧
                if (_videoPlayer != null && _videoPlayer.texture)
                {
                    _targetMaterial.SetTexture("_MainTex", _videoPlayer.texture);
                }
                _target.material = _targetMaterial;
                _fading = false;
            }
        }

        private void ApplyClip(int index)
        {
            _videoPlayer.Stop();
            _videoPlayer.clip = _videoClips[index];
            _videoPlayer.isLooping = _isLooping;
            _videoPlayer.playbackSpeed = _playbackSpeed;
            ApplyAudioMode();
        }
    }
}
