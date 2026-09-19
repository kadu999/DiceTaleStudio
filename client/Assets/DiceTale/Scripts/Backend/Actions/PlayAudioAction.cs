using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 音频播放动作：条件满足时经 <see cref="AudioPlayerManager"/> 播放音频（对白通道或背景音乐层，
    /// 由 <see cref="_target"/> 选择），条件不再满足时停止。
    /// - <see cref="PlayTarget.Dialogue"/>：对白/旁白通道（共享通道，同片段在播不重启，循环可选）；
    /// - <see cref="PlayTarget.BackgroundMusic"/>：背景音乐层（每层一首、换曲顶替，恒循环；层号
    ///   <see cref="_layer"/> 仅此模式生效）。
    /// 挂到组件的「变更动作列表」（actions），经 ConditionalBackendChangeAction 在组件数据改变时
    /// 重新评估条件。参数显隐由 PlayAudioActionEditor 按目标区分。
    /// </summary>
    public class PlayAudioAction : ConditionalBackendChangeAction
    {
        /// <summary>播放目标：对白通道还是背景音乐层（Editor 按此显示参数）。</summary>
        public enum PlayTarget
        {
            /// <summary>对白/旁白通道（共享，后播顶先播；支持循环）。</summary>
            Dialogue,

            /// <summary>背景音乐层（每层一首、换曲顶替、恒循环；需指定层号）。</summary>
            BackgroundMusic,
        }

        [SerializeField, Tooltip("播放目标：对白通道 / 背景音乐层（Editor 按此显示对应参数）")]
        private PlayTarget _target = PlayTarget.Dialogue;

        [SerializeField, Tooltip("要播放的音频片段（为空时不播放/停止）")]
        private AudioClip clip;

        [SerializeField, Tooltip("循环播放（仅对白通道；背景音乐恒循环）")]
        private bool loop;

        [SerializeField, Tooltip("背景音乐层号（仅 BackgroundMusic 模式生效；第 0 层起）")]
        [Min(0)]
        private int _layer;

        /// <summary>当前管理器（无 Game / AudioPlayerManager 时返回 null）。</summary>
        private static AudioPlayerManager Audio =>
            Game.Instance != null ? Game.Instance.AudioPlayerManager : null;

        public override void OnComponentChanged(BackendComponent component)
        {
            var audio = Audio;
            if (audio == null)
            {
                return;
            }

            if (ConditionMet(component))
            {
                Play(audio);
            }
            else
            {
                Stop(audio);
            }
        }

        /// <summary>条件满足：按目标播放（同片段已在播则保持，避免重复触发时重启打断）。</summary>
        private void Play(AudioPlayerManager audio)
        {
            switch (_target)
            {
                case PlayTarget.BackgroundMusic:
                    if (clip != null)
                    {
                        if (!audio.IsBackgroundClipPlaying(_layer, clip))
                        {
                            audio.PlayBackground(_layer, clip);
                        }
                    }
                    else
                    {
                        audio.StopBackground(_layer);
                    }

                    break;

                default:
                    if (clip != null)
                    {
                        if (!audio.IsPlayingClip(clip))
                        {
                            audio.Play(clip, null, loop);
                        }
                    }
                    else
                    {
                        audio.Stop();
                    }

                    break;
            }
        }

        /// <summary>条件不满足：按目标停止（对白通道整体停；背景音乐只停指定层）。</summary>
        private void Stop(AudioPlayerManager audio)
        {
            switch (_target)
            {
                case PlayTarget.BackgroundMusic:
                    audio.StopBackground(_layer);
                    break;

                default:
                    audio.Stop();
                    break;
            }
        }
    }
}