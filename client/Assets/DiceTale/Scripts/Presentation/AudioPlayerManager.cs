using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 声音播放管理器（由 <see cref="Game"/> 初始化持有）：**三条通道**，与后台的三档声音一一对应。
    ///
    /// - **背景音乐（`bgm`）**：全局一条（曲目清单在编辑器顶栏「音乐」弹框里），**恒循环**、音量单独一档；
    /// - **音效（`sfx`）**：一次性，播完就停；
    /// - **旁白（`voice`）**：一次性，可选同步显示字幕（<see cref="SubtitleWindow"/>）。
    ///
    /// 三条通道的口径完全一致（与协议里「同层同时只响一条」对齐）：**同一通道里播新的会顶掉旧的**，
    /// 各自有独立的 <see cref="AudioSource"/>，所以三条可以同时响（背景音乐 + 一句旁白 + 一个音效）。
    ///
    /// 音量来自**项目级全局设置**（<see cref="ApplySettings"/>，服务端随 `project_settings` 下发）：
    /// 收到即生效，不需要命令——「数据是数据，动作是动作」。
    ///
    /// 管理器**自己不起播**：放哪一首、什么时候放全由编辑器的命令决定（见
    /// `CommandRouter`）——单一真源，不会出现「前端自播 + 编辑器补发」双播。
    /// </summary>
    public class AudioPlayerManager : MonoBehaviour
    {
        [SerializeField, Tooltip("旁白播放时是否显示字幕文字（功能已实现，这里控制是否打开）")]
        private bool enableText = true;

        private AudioSource bgmSource;
        private AudioSource sfxSource;
        private AudioSource voiceSource;

        /// <summary>当前那份全局设置（三档音量）；收到新的就换掉并立即生效。</summary>
        private MirrorSettings settings;

        /// <summary>旁白字幕开着没有（播完 / 停止时关掉）。</summary>
        private bool subtitleShown;

        /// <summary>三条通道的声源（按需创建；音量按当前设置给，背景音乐那条恒循环）。</summary>
        private AudioSource BgmSource => bgmSource != null
            ? bgmSource
            : bgmSource = CreateSource("bgm");

        private AudioSource SfxSource => sfxSource != null
            ? sfxSource
            : sfxSource = CreateSource("sfx");

        private AudioSource VoiceSource => voiceSource != null
            ? voiceSource
            : voiceSource = CreateSource("voice");

        private AudioSource CreateSource(string channel)
        {
            var source = gameObject.AddComponent<AudioSource>();
            source.playOnAwake = false;
            source.loop = false;
            source.volume = VolumeOf(channel);
            return source;
        }

        private void Update()
        {
            // 字幕随播放结束自动关闭（循环播放中持续显示，直到 Stop）
            if (subtitleShown && (voiceSource == null || !voiceSource.isPlaying))
            {
                HideSubtitle();
            }
        }

        // ---------------------------------------------------------------- 设置（三档音量）

        /// <summary>
        /// 换一份全局设置（`project_settings` 到了就调）：三档音量立刻生效。
        ///
        /// `null`（服务端没有设置）按**一份缺省设置**处理：音量回到缺省。
        /// </summary>
        public void ApplySettings(MirrorSettings next)
        {
            settings = next ?? new MirrorSettings();
            settings.ClampVolumes();

            if (bgmSource != null)
            {
                bgmSource.volume = settings.audio.bgm.volume;
            }

            if (sfxSource != null)
            {
                sfxSource.volume = settings.audio.sfxVolume;
            }

            if (voiceSource != null)
            {
                voiceSource.volume = settings.audio.voiceVolume;
            }
        }

        /// <summary>当前设置里的某条通道音量（还没收到设置时用缺省值）。</summary>
        private float VolumeOf(string channel)
        {
            var audio = settings?.audio;
            if (audio == null)
            {
                return channel == "bgm" ? 0.6f : channel == "voice" ? 1f : 0.8f;
            }

            return channel == "bgm"
                ? audio.bgm.volume
                : channel == "voice"
                    ? audio.voiceVolume
                    : audio.sfxVolume;
        }

        // ---------------------------------------------------------------- 三条通道的公共动作

        /// <summary>某条通道现在在响没有（`layer` = `bgm` / `sfx` / `voice`）。</summary>
        public bool IsPlaying(string layer)
        {
            var source = SourceOf(layer);
            return source != null && source.isPlaying;
        }

        /// <summary>某条通道放的是不是这一条（判定「重复点同一首」用）。</summary>
        public bool IsPlayingClip(string layer, AudioClip clip)
        {
            var source = SourceOf(layer);
            return source != null && clip != null && source.clip == clip && source.isPlaying;
        }

        /// <summary>播一条（**顶掉这条通道上原来那条**）；`bgm` 通道恒循环。</summary>
        public void Play(string layer, AudioClip clip, string subtitle = null)
        {
            if (clip == null)
            {
                Stop(layer);
                return;
            }

            var source = SourceOf(layer);
            if (source == null)
            {
                return;
            }

            // 背景音乐恒循环（v16 起循环不是设置项：响到被换掉 / 停掉为止）；其余通道一次性
            var loop = layer == "bgm";
            if (source.isPlaying)
            {
                source.Stop();
            }

            source.clip = clip;
            source.loop = loop;
            source.volume = VolumeOf(layer);
            source.Play();

            // 只有旁白这一条有字幕（音效 / 背景音乐没有文本可显示）
            if (layer == "voice" && enableText && !string.IsNullOrEmpty(subtitle))
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

            if (layer == "voice")
            {
                HideSubtitle();
            }
        }

        /// <summary>暂停某条通道（没在响就什么都不做，返回 false）。</summary>
        public bool Pause(string layer)
        {
            var source = SourceOf(layer);
            if (source == null || !source.isPlaying)
            {
                return false;
            }

            source.Pause();
            return true;
        }

        /// <summary>从暂停处继续（没暂停就什么都不做，返回 false）。</summary>
        public bool Resume(string layer)
        {
            var source = SourceOf(layer);
            if (source == null || source.clip == null || source.isPlaying)
            {
                return false;
            }

            source.UnPause();
            return true;
        }

        /// <summary>停掉某条通道（字幕一起收掉）。</summary>
        public void Stop(string layer)
        {
            var source = SourceOf(layer);
            if (source != null)
            {
                source.Stop();
            }

            if (layer == "voice")
            {
                HideSubtitle();
            }
        }

        /// <summary>
        /// 停掉三条通道。
        ///
        /// 两个场合用它：编辑器关闸（前端被踢下线，不该继续响），以及换项目 / 换资源包版本
        /// （手里的片段已经作废）。
        /// </summary>
        public void StopAll()
        {
            Stop("bgm");
            Stop("sfx");
            Stop("voice");
        }

        private AudioSource SourceOf(string layer)
        {
            switch (layer)
            {
                case "bgm":
                    return BgmSource;

                case "voice":
                    return VoiceSource;

                case "sfx":
                    return SfxSource;

                default:
                    return null;
            }
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
