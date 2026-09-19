using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 传送动作：继承 <see cref="ConditionalBackendChangeAction"/>。
    /// 后台触发传送：组件数据改变（OnComponentChanged）且基类条件满足时，
    /// 把目标玩家传送到**下一场景**（目标场景与标记由当前场景脚本
    /// <see cref="GameScene.NextTarget"/> 声明，见 <see cref="GameSceneManager.TryGetNextTarget"/>）。
    /// 目标玩家默认是 <see cref="range"/> 半径范围内（以自身为中心）的玩家；
    /// 勾选 <see cref="teleportAllPlayers"/> 时忽略半径，传送当前场景上的所有玩家。
    /// 挂到组件的「变更动作列表」（actions）即可；基类条件留空则任意数据改变都触发。
    /// 若要后台开/关传送区域（开启后玩家进入才传送），用 <see cref="TeleportZoneAction"/>。
    /// </summary>
    public class TeleportAction : ConditionalBackendChangeAction
    {
        [SerializeField, Tooltip("传送范围半径（世界单位），以自身为中心")]
        private float range = 1f;

        [SerializeField, Tooltip("是否传送当前场景上的所有玩家（忽略范围半径）；不勾选则只传送半径范围内的玩家")]
        private bool teleportAllPlayers = false;

        public override void OnComponentChanged(BackendComponent component)
        {
            if (!ConditionMet(component))
            {
                return;
            }

            TeleportNearbyPlayers();
        }

        private void OnDrawGizmos()
        {
            // 场景视图画出传送范围圆，方便调试
            Gizmos.color = new Color(0f, 0.8f, 1f, 0.2f);
            Gizmos.DrawSphere(transform.position, range);
            Gizmos.color = new Color(0f, 0.8f, 1f, 0.9f);
            Gizmos.DrawWireSphere(transform.position, range);
        }

        /// <summary>把目标玩家传送到目标地图的目标标记位置。
        /// 先按当前状态收集目标再逐个传送：首名玩家传送可能切换地图，后续玩家的位置已被重定位，
        /// 边遍历边判定距离会得到错误结果。</summary>
        private void TeleportNearbyPlayers()
        {
            var sceneManager = Game.Instance != null ? Game.Instance.GameSceneManager : null;
            // 目标场景/标记由当前场景脚本（GameScene.NextTarget）声明，不再使用 prefab 写死字段
            if (sceneManager == null || !sceneManager.TryGetNextTarget(sceneManager.CurrentSceneName, out var targetScene, out var targetMarker))
            {
                return;
            }

            var characterManager = Game.Instance != null ? Game.Instance.CharacterManager : null;
            if (characterManager == null)
            {
                return;
            }

            // 目标集合：全部玩家（忽略半径）或半径范围内的玩家主体
            var center = transform.position;
            var targets = new List<BackendObject>();
            foreach (var player in characterManager.Players)
            {
                if (player == null)
                {
                    continue;
                }

                if (teleportAllPlayers || Vector3.Distance(player.transform.position, center) <= range)
                {
                    targets.Add(player);
                }
            }

            if (targets.Count == 0)
            {
                return;
            }

            // 逐个传送；多人时按网格格子大小方阵错开站位，避免全部叠在标记点上
            for (int i = 0; i < targets.Count; i++)
            {
                sceneManager.TeleportPlayer(targets[i], targetScene, targetMarker, GameSceneManager.GetSpawnOffset(i, targets.Count));
            }
        }
    }
}
