using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 多点同时触发区域：区域内按人数摆放若干触发点标记（场景物体，拖到 points 列表，位置在场景里摆）。
    /// **需要的点数 = 当前玩家数**：取配置列表前 N 个标记（玩家 1 ↔ 第 1 点、玩家 2 ↔ 第 2 点…），
    /// 这些点**同时被按住**（多指/多点触摸，鼠标兜底单点）即触发动作列表；
    /// 超出玩家数的配置点不参与（列表按最大人数配即可，2 人时只要前 2 个点）。
    /// 触发语义：
    ///   - 边缘触发：全部所需点从「未齐」变「齐」的瞬间触发一次；保持全按不重复触发；
    ///   - 任一点松开即复位，需重新按满；
    ///   - 同 <see cref="ClickRegion"/>：触发不评估条件，动作直接执行
    ///     （条件动作经 ConditionalBackendChangeAction.ExecuteIgnoringCondition）。
    /// **生效包围盒**：本组件所在物体需挂 <see cref="BoxCollider"/>，**只有落在包围盒内的触点
    /// 才参与判定**（包围盒外按压不计数、不会把触发点按满）。
    /// 尊重 InputManager.PointerSuspended（投影校正期）与 Game.CanInteract（交互锁）。
    /// **输入统一从 <see cref="InputManager.PressedWorldPositions"/> 查询**（世界坐标快照，
    /// 屏幕→世界换算由 InputManager 统一完成），本组件只做「触点 ⇄ 触发点」匹配。
    /// 挂在区域物体上即可。
    /// </summary>
    public class MultiPointRegion : MonoBehaviour
    {
        [SerializeField, Tooltip("触发点标记（场景物体，拖进来；位置以物体世界坐标为准，场景里直接摆放编辑）。"
            + "需要的点数 = 当前玩家数：取列表前 N 个（玩家 1↔第 1 点…），N 点同时被按下即触发动作列表；"
            + "列表为空或所需范围内含空引用则永不触发（缺失时告警）")]
        private List<Transform> points = new List<Transform>();

        [SerializeField, Tooltip("触发半径（世界单位）：指针与该点的距离 ≤ 半径视为按下该点")]
        private float triggerRadius = 0.6f;

        [SerializeField, Tooltip("是否允许重复触发；关闭后本区域只触发一次（场景重新加载后复位）")]
        private bool repeatable = true;

        [SerializeField, Tooltip("全点按下时依次执行的动作（BackendChangeAction：显隐/传送/音频/视频等）")]
        private List<BackendChangeAction> actions = new List<BackendChangeAction>();

        private BoxCollider regionCollider;
        private bool warnedNoCollider;
        private bool warnedMissingPoint;
        private bool allCovered;
        private bool triggeredOnce;
        private int lastShownCount = -1; // 最近一次按人数同步标记显隐的人数；-1 强制首次同步

        private void Awake()
        {
            regionCollider = GetComponent<BoxCollider>();

            // 标记点初始全部显示（上一局隐藏的点恢复；人数驱动的新显隐在 Update 里按当前玩家数同步）
            foreach (var point in points)
            {
                if (point != null)
                {
                    point.gameObject.SetActive(true);
                }
            }
        }

        private void Update()
        {
            if (InputManager.PointerSuspended)
            {
                return;
            }

            var game = Game.Instance;
            if (game == null || !game.CanInteract || points.Count == 0)
            {
                return;
            }

            var characterManager = game.CharacterManager;
            if (characterManager == null || characterManager.Players.Count == 0)
            {
                return; // 无玩家：点数无从谈起
            }

            // 生效包围盒：必须挂 BoxCollider，缺省时区域不生效（含告警，避免静默失效）
            if (regionCollider == null)
            {
                if (!warnedNoCollider)
                {
                    warnedNoCollider = true;
                    Debug.LogWarning($"[MultiPointRegion] {name} 缺少 BoxCollider：请挂一个 BoxCollider 定义生效包围盒（当前区域不生效）");
                }

                return;
            }

            // 需要的点数 = 当前玩家数（前 N 个按配置顺序，玩家 1 ↔ 第 1 点，玩家 2 ↔ 第 2 点…），
            // 超出的配置点不参与（列表按最大人数配 4 个即可）
            int requiredCount = Mathf.Clamp(characterManager.Players.Count, 1, points.Count);

            // 标记点显隐跟随人数：只显示前 N 个点，超出玩家数的点位隐藏（人数变化时同步一次）
            if (lastShownCount != requiredCount)
            {
                lastShownCount = requiredCount;
                for (int i = 0; i < points.Count; i++)
                {
                    if (points[i] != null)
                    {
                        points[i].gameObject.SetActive(i < requiredCount);
                    }
                }
            }

            var pressedWorld = InputManager.PressedWorldPositions;
            bool covered = true;
            for (int i = 0; i < requiredCount; i++)
            {
                // 空引用/缺失标记：永不触发（一次性告警提示补全）
                if (points[i] == null)
                {
                    covered = false;
                    if (!warnedMissingPoint)
                    {
                        warnedMissingPoint = true;
                        Debug.LogWarning($"[MultiPointRegion] {name} 触发点列表含空引用（第 {i} 项），区域永不触发：请补齐触发点标记");
                    }

                    break;
                }

                if (!IsCovered(points[i].position, pressedWorld))
                {
                    covered = false;
                    break;
                }
            }

            if (covered && !allCovered)
            {
                allCovered = true;
                Trigger();
            }
            else if (!covered)
            {
                allCovered = false;
            }
        }

        /// <summary>任意一个**落在包围盒内**的被按住指针是否覆盖该点（XZ 平面距离 ≤ 触发半径）。</summary>
        private bool IsCovered(Vector3 point, IReadOnlyList<Vector3> pressedWorld)
        {
            float radiusSqr = triggerRadius * triggerRadius;
            for (int i = 0; i < pressedWorld.Count; i++)
            {
                if (!regionCollider.bounds.Contains(pressedWorld[i]))
                {
                    continue; // 包围盒外触点不参与判定
                }

                float dx = pressedWorld[i].x - point.x;
                float dz = pressedWorld[i].z - point.z;
                if (dx * dx + dz * dz <= radiusSqr)
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>全点按下：一次性区域已触发则忽略；否则依次执行动作（不评估条件，直接执行）。</summary>
        private void Trigger()
        {
            if (!repeatable)
            {
                if (triggeredOnce)
                {
                    return;
                }

                triggeredOnce = true;
            }

            int requiredCount = Mathf.Clamp(
                Game.Instance != null && Game.Instance.CharacterManager != null ? Game.Instance.CharacterManager.Players.Count : 0,
                1,
                points.Count);
            Debug.Log($"[MultiPointRegion] {name} 玩家数 {requiredCount} 对应的 {requiredCount} 个触发点同时按下，执行动作列表（{actions.Count} 个）");

            foreach (var point in points)
            {
                point.gameObject.SetActive(false);
            }

            foreach (var action in actions)
            {
                if (action == null)
                {
                    continue;
                }

                if (action is ConditionalBackendChangeAction conditional)
                {
                    conditional.ExecuteIgnoringCondition();
                }
                else
                {
                    action.Execute();
                }
            }
        }

        private void OnDrawGizmos()
        {
            Gizmos.color = new Color(0f, 0.9f, 1f, 0.9f);
            for (int i = 0; i < points.Count; i++)
            {
                if (points[i] != null)
                {
                    Gizmos.DrawWireSphere(points[i].position, triggerRadius);
                }
            }

            // 生效包围盒预览
            var box = GetComponent<BoxCollider>();
            if (box != null)
            {
                Gizmos.color = new Color(0f, 0.7f, 1f, 0.35f);
                Gizmos.DrawWireCube(box.bounds.center, box.bounds.size);
            }
        }
    }
}