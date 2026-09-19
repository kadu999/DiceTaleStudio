using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 视频播放动作：条件满足时对 SmartVideoPlayer 执行指定命令（播放 / 暂停 / 继续 / 停止）。
    /// 命令由 <see cref="_command"/> 选择，Inspector 配好即用：如场景状态 A 配 Play、
    /// 状态 B 配 Pause / Resume / Stop——条件切换即触发对应视频控制
    /// （挂到组件的「变更动作列表」actions，经 ConditionalBackendChangeAction 在组件数据
    /// 改变时重新评估条件；条件不满足时不执行任何命令）。
    /// </summary>
    public class PlayVideoAction : ConditionalBackendChangeAction
    {
        /// <summary>条件满足时对目标视频执行的控制命令。</summary>
        public enum VideoCommand
        {
            /// <summary>播放（切换/从头播，带交叉淡化）。</summary>
            Play,

            /// <summary>暂停（停在当前帧，可 <see cref="SmartVideoPlayer.Resume"/> 续播）。</summary>
            Pause,

            /// <summary>继续（从暂停处恢复播放）。</summary>
            Resume,

            /// <summary>停止（复位到片头）。</summary>
            Stop,
        }

        [SerializeField]
        private SmartVideoPlayer _videoPlayer;

        [SerializeField]
        private List<SmartVideoPlayer> _videoPlayers = new List<SmartVideoPlayer>();

        [SerializeField]
        private int _index;

        [SerializeField]
        private bool _isLooping;

        [SerializeField]
        private float _speed = 1.0f;

        [SerializeField, Tooltip("条件满足时执行的命令：Play / Pause / Resume / Stop")]
        private VideoCommand _command = VideoCommand.Play;

        public override void OnComponentChanged(BackendComponent component)
        {
            if (!ConditionMet(component))
            {
                return;
            }

            if (_videoPlayer != null)
            {
                Execute(_command, _videoPlayer);
            }

            for (int i = 0; i < _videoPlayers.Count; i++)
            {
                if (_videoPlayers[i] != null)
                {
                    Execute(_command, _videoPlayers[i]);
                }
            }
        }

        private void Execute(VideoCommand command, SmartVideoPlayer player)
        {
            switch (command)
            {
                case VideoCommand.Play:
                    player.PlayWithFade(_index, _isLooping, _speed);
                    break;
                case VideoCommand.Pause:
                    player.Pause();
                    break;
                case VideoCommand.Resume:
                    player.Resume();
                    break;
                case VideoCommand.Stop:
                    player.Stop();
                    break;
            }
        }
    }
}