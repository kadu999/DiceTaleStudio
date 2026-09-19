using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 玩家移动管理器（由 Game 初始化持有）：负责「把目标棋子（玩家）瞬移到指定位置」。
    /// **只管移动，不碰点击/区域**：区域触发已抽离到 <see cref="ClickRegion.HandleClick"/>（InputManager
    /// 在指针按下时独立调用，与玩家无关）。本类只做归属解析、可达性判定与瞬移：
    /// 不可达则不移动；点击当前位置（同格）不移动、不重复上报。
    /// playerIndex 归属解析统一在此：索引有效（0..玩家数-1）取该玩家，无效回退当前玩家。
    /// 触发源是 InputManager（移动），也可被其他逻辑直接调用移动指定棋子。
    /// </summary>
    public class PlayerMoveManager : MonoBehaviour
    {
        /// <summary>把目标棋子瞬移到 targetPosition。playerIndex：本次移动归属的玩家索引
        /// （棋子序号，0 起）。
        /// allowCurrentFallback：true（默认，单点点击）= 索引无效（-1/越界）时回退当前玩家；
        /// false（多点移动）= 索引越界直接忽略该触点（不挪当前玩家，多余的触点不产生移动）。
        /// 同格点击不移动；不可达不移动。（点击触发的区域事件走 <see cref="ClickRegion.HandleClick"/>，与本方法解耦。）</summary>
        public void MovePlayerTo(Vector3 targetPosition, int playerIndex, bool allowCurrentFallback = true)
        {
            var player = ResolvePlayer(playerIndex, allowCurrentFallback);
            if (player == null)
            {
                return;
            }

            // A* 判断是否可达（不可达则不移动）；点击当前位置（同格）也不移动、不重复上报
            var gridMap = Object.FindFirstObjectByType<GridMap>();
            if (gridMap != null)
            {
                var startGrid = gridMap.WorldToGrid(player.transform.position);
                var endGrid = gridMap.WorldToGrid(targetPosition);
                if (startGrid == endGrid)
                {
                    return; // 玩家已在该位置：不移动
                }

                if (gridMap.FindPath(startGrid, endGrid) == null)
                {
                    Debug.Log($"无法移动到目标位置：{endGrid} 被阻挡或不可达");
                    return;
                }
            }
            else if ((player.transform.position - targetPosition).sqrMagnitude < 0.0001f)
            {
                return; // 无网格退化：与当前位置几乎重合
            }

            // 可达：直接瞬移过去（不播放移动过程）
            player.transform.position = targetPosition;
            player.ReportPosition();
        }

        /// <summary>按索引解析目标棋子：索引有效（0..玩家数-1）取该玩家；allowCurrentFallback 为 true
        /// 时索引无效回退当前玩家（单点点击语义），为 false 时索引无效返回 null（多点移动：忽略该触点）。</summary>
        private static BackendObject ResolvePlayer(int playerIndex, bool allowCurrentFallback)
        {
            var manager = Game.Instance != null ? Game.Instance.CharacterManager : null;
            if (manager == null)
            {
                return null;
            }

            if (playerIndex >= 0)
            {
                var indexed = manager.GetPlayer(playerIndex);
                if (indexed != null)
                {
                    return indexed;
                }
            }

            return allowCurrentFallback ? manager.CurrentPlayer : null;
        }
    }
}