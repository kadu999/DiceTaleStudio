using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 声音播放管理器（由 Game 初始化持有，RequireComponent 自带 AudioSource）：
    /// 负责旁白/对话音频，并可选同步显示字幕（<see cref="SubtitleWindow"/>）；
    /// 另提供**分层背景音乐**（<see cref="PlayBackground(int, AudioClip)"/>）：
    /// 共 <see cref="backgroundLayerCount"/> 层（默认 4），**每层同一时刻只播一首**——
    /// 向某层换曲会顶掉该层旧曲，层与层之间可同时响（如环境层 + 氛围层 + 主题层）；
    /// 各层共享 <see cref="BackgroundVolume"/>，与对白音量互不干扰（对白播放/停止不影响 BGM，反之亦然）。
    /// 「播放时显示文字」功能始终实现，用 <see cref="enableText"/> 开关控制是否启用；
    /// 字幕在播放结束 / <see cref="Stop"/> 时自动关闭（循环播放时持续显示）。
    /// 调用：<c>Game.Instance.AudioPlayerManager.Play(clip, "字幕内容");</c> /
    /// <c>Game.Instance.AudioPlayerManager.PlayBackground(0, ambientClip);</c>（layer 为层号）
    /// </summary>
    [RequireComponent(typeof(AudioSource))]
    public class AudioPlayerManager : MonoBehaviour
    {
        [SerializeField, Tooltip("播放时是否显示字幕文字（功能已实现，这里控制是否打开）")]
        private bool enableText = true;

        [SerializeField, Tooltip("背景音乐层数（每层同一时刻只播一首，层间可同时响）")]
        [Min(1)]
        private int backgroundLayerCount = 4;

        [SerializeField, Tooltip("开场按层播的背景音乐（列表索引 = 层号：第 i 项播到第 i 层；留空 = 不自动播）")]
        private List<AudioClip> backgroundMusic = new List<AudioClip>();

        [SerializeField, Tooltip("背景音乐音量（0..1，所有层共享；运行时可经 BackgroundVolume 修改）")]
        [Range(0f, 1f)]
        private float backgroundVolume = 0.5f;

        private AudioSource audioSource;
        private readonly List<AudioSource> bgmLayers = new List<AudioSource>();
        private float currentBackgroundVolume;
        private bool subtitleShown;

        private void Awake()
        {
            audioSource = GetComponent<AudioSource>();
            if (audioSource != null)
            {
                audioSource.playOnAwake = false;
            }

            currentBackgroundVolume = Mathf.Clamp01(backgroundVolume);

            // 层槽位占位：播放时再补 AudioSource（RequireComponent 只保证一个 AudioSource）
            int layerCount = Mathf.Max(1, backgroundLayerCount);
            for (int i = 0; i < layerCount; i++)
            {
                bgmLayers.Add(null);
            }

            // 开场按层自动播：列表第 i 项播到第 i 层（每层一首，可多层同时响）
            for (int i = 0; i < backgroundMusic.Count; i++)
            {
                if (backgroundMusic[i] != null)
                {
                    PlayBackground(i, backgroundMusic[i]);
                }
            }
        }

        private void Update()
        {
            // 字幕随播放结束自动关闭（循环播放中持续显示，直到 Stop）
            if (subtitleShown && (audioSource == null || !audioSource.isPlaying))
            {
                HideSubtitle();
            }
        }

        /// <summary>是否正在播放（对白/旁白通道）。</summary>
        public bool IsPlaying => audioSource != null && audioSource.isPlaying;

        /// <summary>对白/旁白通道是否正在播该片段（重复触发不重启的判定用）。</summary>
        public bool IsPlayingClip(AudioClip clip)
        {
            return audioSource != null && audioSource.clip == clip && audioSource.isPlaying;
        }

        /// <summary>是否有任一背景音乐层在播放。</summary>
        public bool AnyBackgroundPlaying
        {
            get
            {
                for (int i = 0; i < bgmLayers.Count; i++)
                {
                    if (bgmLayers[i] != null && bgmLayers[i].isPlaying)
                    {
                        return true;
                    }
                }

                return false;
            }
        }

        /// <summary>指定层是否在播放（越界返回 false）。</summary>
        public bool IsBackgroundPlaying(int layer)
        {
            return layer >= 0 && layer < bgmLayers.Count
                && bgmLayers[layer] != null && bgmLayers[layer].isPlaying;
        }

        /// <summary>指定层是否**正在播该片段**（同曲续播判定：正在播同曲时换场景不要重启，免突兀）。</summary>
        public bool IsBackgroundClipPlaying(int layer, AudioClip clip)
        {
            return layer >= 0 && layer < bgmLayers.Count
                && bgmLayers[layer] != null
                && bgmLayers[layer].clip == clip
                && bgmLayers[layer].isPlaying;
        }

        /// <summary>背景音乐音量（0..1，所有层共享；运行时可改，立即生效）。</summary>
        public float BackgroundVolume
        {
            get => currentBackgroundVolume;
            set
            {
                currentBackgroundVolume = Mathf.Clamp01(value);
                for (int i = 0; i < bgmLayers.Count; i++)
                {
                    if (bgmLayers[i] != null)
                    {
                        bgmLayers[i].volume = currentBackgroundVolume;
                    }
                }
            }
        }

        /// <summary>播放音频并可选显示字幕。subtitle 为空或 <see cref="enableText"/> 关闭时不显示文字；
        /// loop 为 true 时循环播放（字幕持续显示到 <see cref="Stop"/>）。</summary>
        public void Play(AudioClip clip, string subtitle = null, bool loop = false)
        {
            if (clip == null)
            {
                Stop();
                return;
            }

            audioSource.clip = clip;
            audioSource.loop = loop;
            audioSource.Play();

            if (enableText && !string.IsNullOrEmpty(subtitle))
            {
                var window = Game.Instance != null && Game.Instance.UIManager != null
                    ? Game.Instance.UIManager.OpenWindow<SubtitleWindow>()
                    : null;
                if (window != null)
                {
                    window.SetText(subtitle);
                    subtitleShown = true;
                    return;
                }
            }

            HideSubtitle();
        }

        /// <summary>在某层播放背景音乐（循环）：**每层同一时刻只播一首**——换曲会顶掉该层旧曲；
        /// 同层同曲已在播则不动作。返回层号（-1 = clip 为空或层号非法）；
        /// 用 <see cref="StopBackground(int)"/> 停指定层。</summary>
        public int PlayBackground(int layer, AudioClip clip)
        {
            if (clip == null)
            {
                return -1;
            }

            var source = EnsureLayer(layer);
            if (source == null)
            {
                return -1;
            }

            if (source.clip == clip && source.isPlaying)
            {
                return layer; // 该层同一曲已在播：不动
            }

            if (source.isPlaying)
            {
                source.Stop();
            }

            source.clip = clip;
            source.loop = true;
            source.volume = currentBackgroundVolume;
            source.Play();
            return layer;
        }

        /// <summary>停止指定背景音乐层（越界忽略；该层 AudioSource 保留，可再次 PlayBackground 续播）。</summary>
        public void StopBackground(int layer)
        {
            if (layer < 0 || layer >= bgmLayers.Count)
            {
                return;
            }

            var source = bgmLayers[layer];
            if (source != null)
            {
                source.Stop();
            }
        }

        /// <summary>停止全部背景音乐层。</summary>
        public void StopAllBackground()
        {
            for (int i = 0; i < bgmLayers.Count; i++)
            {
                if (bgmLayers[i] != null)
                {
                    bgmLayers[i].Stop();
                }
            }
        }

        /// <summary>停止对白/旁白播放并关闭字幕（不影响背景音乐）。</summary>
        public void Stop()
        {
            if (audioSource != null)
            {
                audioSource.Stop();
            }

            HideSubtitle();
        }

        /// <summary>取/建指定层的 AudioSource（越界返回 null）。</summary>
        private AudioSource EnsureLayer(int layer)
        {
            if (layer < 0 || layer >= bgmLayers.Count)
            {
                return null;
            }

            var source = bgmLayers[layer];
            if (source == null)
            {
                source = gameObject.AddComponent<AudioSource>();
                source.playOnAwake = false;
                source.loop = true;
                source.volume = currentBackgroundVolume;
                bgmLayers[layer] = source;
            }

            return source;
        }

        private void HideSubtitle()
        {
            subtitleShown = false;
            if (Game.Instance != null && Game.Instance.UIManager != null)
            {
                Game.Instance.UIManager.CloseWindow<SubtitleWindow>();
            }
        }
    }
}