using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 对话播放动作：继承 <see cref="ConditionalBackendChangeAction"/>。
    /// 组件数据改变（OnComponentChanged）且基类条件满足时，调用 <see cref="AudioPlayerManager"/>
    /// 播放指定音频并可选同步显示字幕（字幕是否启用由音频播放器的 enableText 开关决定）；
    /// 条件不再满足时停止播放并关闭字幕。挂到组件的「变更动作列表」（actions）即可。
    /// </summary>
    public class PlayDialogueAction : ConditionalBackendChangeAction
    {
        [SerializeField, Tooltip("要播放的音频片段；为空时停止播放并关闭字幕")]
        private AudioClip clip;

        [SerializeField, Tooltip("同步显示的字幕文字；留空则不显示文字（即使音频播放器 enableText 已开启）")]
        private string subtitle;

        [SerializeField, Tooltip("循环播放（字幕持续显示到条件不满足/Stop）")]
        private bool loop;

        public override void OnComponentChanged(BackendComponent component)
        {
            var player = Game.Instance != null ? Game.Instance.AudioPlayerManager : null;
            if (player == null)
            {
                return;
            }

            if (ConditionMet(component))
            {
                // clip 为空时 AudioPlayerManager.Play 内部转 Stop（停播+关字幕）
                player.Play(clip, subtitle, loop);
            }
            //else
            //{
            //    player.Stop();
            //}
        }
    }
}