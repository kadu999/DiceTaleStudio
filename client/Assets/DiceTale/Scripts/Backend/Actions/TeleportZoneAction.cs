using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 传送区域动作：继承 <see cref="ConditionalBackendChangeAction"/>。
    /// 后台操作组件值开启/关闭传送：组件数据改变（OnComponentChanged）时用基类条件评估所属组件的当前值，
    /// 条件满足则激活传送区域，激活后玩家进入圆形范围（CircleCollider2D，自动设为 Trigger）即被传送到
    /// **下一场景**（目标场景与标记由当前场景脚本 <see cref="GameScene.NextTarget"/> 声明，见 <see cref="GameSceneManager.TryGetNextTarget"/>）；
    /// 条件不满足时关闭传送（进入不传送）。条件支持任意覆写 Satisfies 的值组件；留空则始终开启。
    /// 挂到组件的「变更动作列表」（actions）即可。
    /// 若要后台切状态时直接传送圆内玩家（不等进入），用 <see cref="TeleportAction"/>。
    /// </summary>
    [RequireComponent(typeof(CircleCollider2D))]
    public class TeleportZoneAction : ConditionalBackendChangeAction
    {
        private bool zoneEnabled;
        private CircleCollider2D circleCollider;

        private void OnValidate()
        {
            SetTrigger();
        }

        private void Awake()
        {
            SetTrigger();
            // 未配置条件时默认始终开启；配置了则先关闭，等条件满足再激活
            zoneEnabled = ConditionMet(null);
        }

        public override void OnComponentChanged(BackendComponent component)
        {
            zoneEnabled = ConditionMet(component);
        }

        private void OnTriggerEnter2D(Collider2D other)
        {
            if (!zoneEnabled)
            {
                return;
            }

            var player = other.GetComponent<BackendObject>();
            if (player == null || player.ObjectKind != "Player")
            {
                return;
            }

            var sceneManager = Game.Instance != null ? Game.Instance.GameSceneManager : null;
            // 目标场景/标记由当前场景脚本（GameScene.NextTarget）声明，不再使用 prefab 写死字段
            if (sceneManager == null || !sceneManager.TryGetNextTarget(sceneManager.CurrentSceneName, out var targetScene, out var targetMarker))
            {
                return;
            }

            sceneManager.TeleportPlayer(player, targetScene, targetMarker);
        }

        private void SetTrigger()
        {
            if (circleCollider == null)
            {
                circleCollider = GetComponent<CircleCollider2D>();
            }

            if (circleCollider != null)
            {
                circleCollider.isTrigger = true;
            }
        }
    }
}
