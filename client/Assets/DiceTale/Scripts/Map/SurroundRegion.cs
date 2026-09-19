using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 包围触发区域：区域内一个目标物体（由目标自身组件控制移动，如 <see cref="BirdWanderer"/>），玩家按玩家人数同时按下
    /// **形成 ≥3 个触点组成的封闭连线把目标围在内部** 时触发动作列表（3 点即三角形、4 点即四边形；多点时任一 3 点三角形或 4 点四边形围住即算）。
    /// 触发语义：**按玩家人数同时按下**——连线成形需要盒内同时按下的触点数 = 玩家人数
    /// （N 人局需 N 人同时按下，至少 3 人；可用 <see cref="requiredPressCount"/> 手动配置），
    /// 人数不足不出现连线、不做包围检测；
    /// 人数满足后**持续判定围住**：由「未围住 → 围住」边缘触发成功回调一次
    /// （动作列表 + <see cref="OnSurroundSuccess"/>；连线成形瞬间已在包围内、成形后拖动调整、
    /// 或目标游荡进形内都会即时判定）；人数不足即复位；可配一次性；
    /// 触发不评估条件，动作直接执行。
    /// **目标移动由目标自身组件负责**（如 BirdWanderer），本组件只读 <see cref="target"/> 的位置做包围判定，不驱动目标。
    /// **生效包围盒**：本组件所在物体需挂 <see cref="BoxCollider"/>，**只有落在包围盒内的触点
    /// 才参与三角形围住判定**（包围盒外按压不计数）。
    /// 输入统一从 <see cref="InputManager.PressedWorldPositions"/> 查询（世界坐标快照，不直接采样输入设备）。
    /// 挂在区域物体上即可。
    /// </summary>
    public class SurroundRegion : MonoBehaviour
    {
        [SerializeField, Tooltip("被围住的目标物体（其移动由目标自身组件控制，如 BirdWanderer；本组件只读目标位置，不驱动目标）")]
        private Transform target;

        [SerializeField, Tooltip("是否允许重复触发；关闭后本区域只触发一次（场景重新加载后复位）")]
        private bool repeatable = true;

        [SerializeField, Tooltip("连线成形需要同时按下的触点数：0=自动按玩家人数（至少 3，N 人局需 N 人同时按下才出现连线）；手动配置后以配置值为准")]
        private int requiredPressCount;

        [SerializeField, Tooltip("目标被包围时依次执行的动作（BackendChangeAction：显隐/传送/音频/视频等）")]
        private List<BackendChangeAction> actions = new List<BackendChangeAction>();

        [SerializeField, Tooltip("是否显示触点连线（玩家实时看到自己围出的形）")]
        private bool showLines = true;

        [SerializeField, Tooltip("连线宽度（世界单位）")]
        private float lineWidth = 0.08f;

        [SerializeField, Tooltip("连线离地高度（防与地面 z-fighting）")]
        private float lineLift = 0.05f;

        [SerializeField, Tooltip("连线颜色（未围住时）")]
        private Color lineColor = new Color(0f, 0.85f, 1f, 0.9f);

        [SerializeField, Tooltip("围住成功时的连线颜色")]
        private Color enclosedColor = new Color(0.3f, 1f, 0.4f, 0.95f);

        private bool surrounded;
        private bool checkActive;
        private bool triggeredOnce;
        private bool warnedNoTarget;
        private bool warnedNoCollider;
        private BoxCollider regionCollider;
        private LineRenderer lineRenderer;

        private void Awake()
        {
            regionCollider = GetComponent<BoxCollider>();
            BuildLines();
        }

        private void Update()
        {
            if (InputManager.PointerSuspended)
            {
                return;
            }

            var game = Game.Instance;
            if (game == null || !game.CanInteract)
            {
                return;
            }

            // 生效包围盒：必须挂 BoxCollider，缺省时区域不生效（含告警，避免静默失效）
            if (regionCollider == null)
            {
                if (!warnedNoCollider)
                {
                    warnedNoCollider = true;
                    Debug.LogWarning($"[SurroundRegion] {name} 缺少 BoxCollider：请挂一个 BoxCollider 定义生效包围盒（当前区域不生效）");
                }

                return;
            }

            // 目标未指定：包围判定停用（提示一次；目标移动由目标自身组件负责）
            if (target == null)
            {
                if (!warnedNoTarget)
                {
                    warnedNoTarget = true;
                    Debug.LogWarning($"[SurroundRegion] {name} 未指定 target：包围判定停用");
                }

                return;
            }

            // 盒内触点（只取生效包围盒内的）；触点按质心角序排列（连线不自相交），
            // 绘制与主判定共用同一顺序
            var inBoxPressed = CollectInBoxPressed();
            var ordered = OrderAroundCentroid(inBoxPressed);
            int required = RequiredPressCount;
            UpdateLines(ordered, required);
            CheckSurround(ordered, required);
        }

        // ---------------------------------------------------------------- 触点连线

        /// <summary>创建触点连线（LineRenderer：封闭折线，随触点实时更新；<see cref="showLines"/> 关闭时不创建）。</summary>
        private void BuildLines()
        {
            if (!showLines)
            {
                return;
            }

            var lineGo = new GameObject("SurroundLines");
            lineGo.transform.SetParent(transform, false);

            lineRenderer = lineGo.AddComponent<LineRenderer>();
            lineRenderer.useWorldSpace = true;
            lineRenderer.loop = true;
            lineRenderer.positionCount = 0;
            lineRenderer.enabled = false;
            lineRenderer.startWidth = lineRenderer.endWidth = lineWidth;
            lineRenderer.material = CreateLineMaterial();
            lineRenderer.sortingOrder = 1;
        }

        /// <summary>URP 半透明无光照材质（画连线；透明混合写死在材质设置里）。</summary>
        private Material CreateLineMaterial()
        {
            var shader = Shader.Find("Universal Render Pipeline/Unlit");
            var material = new Material(shader != null ? shader : Shader.Find("Unlit/Color"));
            material.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
            material.SetFloat("_Surface", 1f);
            material.SetFloat("_Blend", 0f);
            material.SetColor("_BaseColor", lineColor);
            material.SetOverrideTag("RenderType", "Transparent");
            material.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent;
            return material;
        }

        /// <summary>当前被按住的触点中，落在生效包围盒（BoxCollider）内的（世界坐标，原 y 保留）。</summary>
        private List<Vector3> CollectInBoxPressed()
        {
            var pressedWorld = InputManager.PressedWorldPositions;
            var result = new List<Vector3>(pressedWorld.Count);
            for (int i = 0; i < pressedWorld.Count; i++)
            {
                if (regionCollider.bounds.Contains(pressedWorld[i]))
                {
                    result.Add(pressedWorld[i]);
                }
            }

            return result;
        }

        /// <summary>把触点按质心角序排列（atan2 绕质心绕转），使连线成为不自相交的星形多边形
        /// （4 点不再交叉成"蝴蝶结"；绘制与主判定共用此顺序）。</summary>
        private static List<Vector2> OrderAroundCentroid(List<Vector3> points)
        {
            var result = new List<Vector2>(points.Count);
            for (int i = 0; i < points.Count; i++)
            {
                result.Add(new Vector2(points[i].x, points[i].z));
            }

            if (points.Count < 3)
            {
                return result;
            }

            Vector2 centroid = Vector2.zero;
            for (int i = 0; i < result.Count; i++)
            {
                centroid += result[i];
            }
            centroid /= result.Count;

            result.Sort((a, b) =>
            {
                float angleA = Mathf.Atan2(a.y - centroid.y, a.x - centroid.x);
                float angleB = Mathf.Atan2(b.y - centroid.y, b.x - centroid.x);
                return angleA.CompareTo(angleB);
            });
            return result;
        }

        /// <summary>按盒内触点更新连线（触点已质心角序、不自相交）：达到所需人数（≥<paramref name="required"/>）
        /// 才画封闭折线（放在 <see cref="lineLift"/> 高度），围住时变绿。</summary>
        private void UpdateLines(List<Vector2> ordered, int required)
        {
            if (lineRenderer == null)
            {
                return;
            }

            if (ordered.Count < required)
            {
                lineRenderer.enabled = false;
                return;
            }

            lineRenderer.enabled = true;
            lineRenderer.positionCount = ordered.Count;
            for (int i = 0; i < ordered.Count; i++)
            {
                lineRenderer.SetPosition(i, new Vector3(ordered[i].x, lineLift, ordered[i].y));
            }

            Color color = surrounded ? enclosedColor : lineColor;
            lineRenderer.startColor = lineRenderer.endColor = color;
        }

        // ---------------------------------------------------------------- 包围判定

        /// <summary>连线成形所需同时按下的触点数：手动配置值 >0 以配置为准；否则自动 = max(3, 玩家人数)
        /// （N 人局需 N 人同时按下，至少 3 人）。</summary>
        private int RequiredPressCount
        {
            get
            {
                if (requiredPressCount > 0)
                {
                    return requiredPressCount;
                }

                var manager = Game.Instance != null ? Game.Instance.CharacterManager : null;
                int playerCount = manager != null ? manager.Players.Count : 0;
                return Mathf.Max(3, playerCount);
            }
        }

        /// <summary>包围检测：盒内点数达所需人数（<paramref name="required"/>）后**持续判定**——
        /// 由「未围住 → 围住」边缘触发成功回调一次（覆盖连线成形瞬间；成形后拖动调整、
        /// 或目标游荡进形内同样立即判定）。人数不足不出线、不检测、状态复位。
        /// 出线瞬间打印一次诊断（触点/门槛/目标位置/判定结果），围住成立时也打印，便于排查。</summary>
        private void CheckSurround(List<Vector2> ordered, int required)
        {
            bool active = ordered.Count >= required;
            if (!active)
            {
                checkActive = false;
                surrounded = false; // 人数不足：连线不出现、包围状态复位
                return;
            }

            // 包围判定先算一次（target 为空时短路为 false，供诊断复用）
            bool enclosed = target != null && IsTargetEnclosed(ordered);

            // 出线瞬间打印一次诊断（触点/门槛/目标位置/判定结果）
            if (!checkActive)
            {
                checkActive = true;
                string points = string.Empty;
                for (int i = 0; i < ordered.Count; i++)
                {
                    points += $" ({ordered[i].x:F1},{ordered[i].y:F1})";
                }

                string targetInfo = target != null
                    ? $"({target.position.x:F1},{target.position.z:F1})"
                    : "(null)";
                Debug.Log($"[SurroundRegion] {name} 出线开始检测：触点 {ordered.Count}/{required}，目标 XZ={targetInfo}，触点：{points}，围住判定={enclosed}");
            }

            if (enclosed && !surrounded)
            {
                surrounded = true;
                Debug.Log($"[SurroundRegion] {name} 包围判定成立（触点 {ordered.Count}/{required}），触发成功回调");
                Trigger();
            }
            else if (!enclosed)
            {
                surrounded = false;
            }
        }

        /// <summary>目标是否被围住（XZ 平面；points 已按质心角序排列 = 连线画出顺序）：
        /// 优先按**连线画出的多边形**判定；角序异常/凹形时回退到"任一 3 点三角形"或"任一 4 点四边形"围住。</summary>
        private bool IsTargetEnclosed(List<Vector2> points)
        {
            if (points.Count < 3)
            {
                return false;
            }

            Vector2 targetXZ = new Vector2(target.position.x, target.position.z);

            // 主判定：连线画出的多边形内部（与玩家看到的画面一致）
            if (PointInPolygon(targetXZ, points))
            {
                return true;
            }

            // 兼容回退 1：任一 3 点三角形围住也算（触点顺序异常/凹形时仍可命中）
            for (int i = 0; i < points.Count; i++)
            {
                for (int j = i + 1; j < points.Count; j++)
                {
                    for (int k = j + 1; k < points.Count; k++)
                    {
                        if (PointInTriangle(targetXZ, points[i], points[j], points[k]))
                        {
                            return true;
                        }
                    }
                }
            }

            // 兼容回退 2：任一 4 点组成四边形围住也算（支持 4 边形围捕；按触点列表顺序取角点）
            for (int i = 0; i < points.Count; i++)
            {
                for (int j = i + 1; j < points.Count; j++)
                {
                    for (int k = j + 1; k < points.Count; k++)
                    {
                        for (int l = k + 1; l < points.Count; l++)
                        {
                            var quad = new List<Vector2>(4)
                            {
                                points[i], points[j], points[k], points[l],
                            };
                            if (PointInPolygon(targetXZ, quad))
                            {
                                return true;
                            }
                        }
                    }
                }
            }

            return false;
        }

        /// <summary>点 p 是否在多边形内部（射线法，含边；polygon 按顺序闭合，至少 3 点）。</summary>
        private static bool PointInPolygon(Vector2 p, List<Vector2> polygon)
        {
            int count = polygon.Count;
            if (count < 3)
            {
                return false;
            }

            bool inside = false;
            for (int i = 0, j = count - 1; i < count; j = i++)
            {
                Vector2 a = polygon[i];
                Vector2 b = polygon[j];
                if (((a.y > p.y) != (b.y > p.y))
                    && (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x))
                {
                    inside = !inside;
                }
            }

            return inside;
        }

        /// <summary>点 p 是否在三角形 (a,b,c) 内（含边；跨立符号法）。</summary>
        private static bool PointInTriangle(Vector2 p, Vector2 a, Vector2 b, Vector2 c)
        {
            bool hasNegative = Sign(p, a, b) < 0f || Sign(p, b, c) < 0f || Sign(p, c, a) < 0f;
            bool hasPositive = Sign(p, a, b) > 0f || Sign(p, b, c) > 0f || Sign(p, c, a) > 0f;
            return !(hasNegative && hasPositive);
        }

        private static float Sign(Vector2 p1, Vector2 p2, Vector2 p3)
        {
            return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
        }

        // ---------------------------------------------------------------- 触发

        /// <summary>包围成功回调：连线成形瞬间目标在包围内时触发（动作列表执行完之后），
        /// 供外部逻辑挂接（隐藏目标/特效/计分/流程推进等）。</summary>
        public event System.Action OnSurroundSuccess;

        /// <summary>目标被包围（连线成形瞬间命中）：一次性区域已触发则忽略；否则依次执行动作
        /// （不评估条件，直接执行），随后广播 <see cref="OnSurroundSuccess"/> 成功回调。</summary>
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

            Debug.Log($"[SurroundRegion] {name} 目标被包围（需 {RequiredPressCount} 人同时按下），执行动作列表（{actions.Count} 个）并广播成功回调");

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

            OnSurroundSuccess?.Invoke();
        }

        private void OnDrawGizmos()
        {
            // 生效包围盒（BoxCollider）预览
            var box = GetComponent<BoxCollider>();
            if (box != null)
            {
                Gizmos.color = new Color(0f, 0.9f, 1f, 0.4f);
                Gizmos.DrawWireCube(box.bounds.center, box.bounds.size);
            }

            if (target != null)
            {
                Gizmos.color = Color.yellow;
                Gizmos.DrawWireSphere(target.position, 0.25f);
            }
        }
    }
}