using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 小鸟模拟：让一个物体（<see cref="target"/>）在一个 BoxCollider 区域内做**水平随机移动**
    /// （XZ 平面；**固定飞行高度** <see cref="flyHeight"/>，默认开启 <see cref="lockHeight"/>
    /// 每帧强制锁定 y，不会往下掉；关闭时保持目标自身高度不动）。
    /// 行为与 <see cref="SurroundRegion"/> 的随机游荡一致：匀速直线漂移 + 定时随机换向 + 撞边界反弹，
    /// 因此小鸟永远不会越出区域（世界 AABB）。
    ///
    /// 用法：挂到小鸟物体上（或任意物体 + <see cref="target"/> 指定小鸟），
    /// 把 <see cref="region"/> 拖成场景里的 BoxCollider（或其所在物体）；不拖就自动在本物体/"本物体上方
    /// 祖先链"里找第一个 BoxCollider。
    ///
    /// **不卡墙**（关键修复）：
    /// - 区域 BoxCollider 自动设为 isTrigger：它只定义活动范围，不参与物理阻挡（越界反弹由脚本负责）。
    /// - 移动方式按载体自动选择：无组件用 transform.position；有 CharacterController 用 Move；
    ///   有 Rigidbody 用 MovePosition 并关重力（水平飞行语义），不硬设 position 与物理打架。
    /// - 被挡脱困：每帧若实际位移过小（被真实墙/其他碰撞体挡住，或 CharacterController 撞到 Side），
    ///   立即反向换向，保证不会"焊"在墙上不动。
    /// </summary>
    public class BirdWanderer : MonoBehaviour
    {
        [SerializeField, Tooltip("被模拟的小鸟（要移动的物体）；空 = 本物体")]
        private Transform target;

        [SerializeField, Tooltip("活动区域（BoxCollider）；空 = 自动在本物体/祖先链上找第一个 BoxCollider。"
            + "脚本会自动把它设为 isTrigger（区域只定义范围，不做实体墙）")]
        private BoxCollider region;

        [SerializeField, Tooltip("速度随机范围（世界单位/秒）")]
        private float minSpeed = 1f;

        [SerializeField, Tooltip("速度随机范围（世界单位/秒）")]
        private float maxSpeed = 3f;

        [SerializeField, Tooltip("方向随机换向的平均间隔（秒，实际 ±40% 抖动）")]
        private float directionChangeInterval = 1.5f;

        [SerializeField, Tooltip("是否面朝移动方向（水平转动，只绕 Y；关掉则保持原朝向）")]
        private bool faceMovementDirection = true;

        [SerializeField, Tooltip("被挡判定阈值：单帧实际位移小于该值视为被碰撞体卡住，立即反向换向（防焊在墙上）")]
        private float stuckThreshold = 0.002f;

        [SerializeField, Tooltip("是否锁定固定飞行高度（每帧强制把 y 设为 flyHeight；"
            + "关闭则保持目标自身当前高度不动）")]
        private bool lockHeight = true;

        [SerializeField, Tooltip("固定飞行高度（世界 y；lockHeight 开启时每帧强制应用，"
            + "覆盖重力/物理/动画对 y 的干扰）")]
        private float flyHeight = 1f;

        private Vector3 velocity;
        private float changeTimer;
        private bool warnedNoRegion;
        private Rigidbody cachedRigidbody;
        private CharacterController cachedController;

        private void Awake()
        {
            if (target == null)
            {
                target = transform;
            }

            if (region == null)
            {
                region = GetComponentInParent<BoxCollider>();
            }

            if (region != null)
            {
                region.isTrigger = true; // 区域只做范围定义，不做实体墙（越界反弹由脚本负责）
            }

            cachedController = target.GetComponent<CharacterController>();
            cachedRigidbody = target.GetComponent<Rigidbody>();
            if (cachedRigidbody != null && !cachedRigidbody.isKinematic)
            {
                cachedRigidbody.useGravity = false; // 水平飞行语义：不参与重力，避免被拉离固定高度
            }
        }

        private void Update()
        {
            MoveBird();
        }

        /// <summary>每帧：定时换向 → 区域内水平移动（撞边界反弹）→ 被挡则反向脱困。
        /// 区域缺失时只告警一次并停用。</summary>
        private void MoveBird()
        {
            if (target == null)
            {
                return;
            }

            if (region == null)
            {
                if (!warnedNoRegion)
                {
                    warnedNoRegion = true;
                    Debug.LogWarning($"[BirdWanderer] {name} 找不到 BoxCollider 区域：请挂 BoxCollider 或拖 region（小鸟停用移动）");
                }

                return;
            }

            UpdateDirection();

            var start = target.position;
            Step();
            BounceClamp();
            ApplyFixedHeight();

            // 被挡脱困：单帧实际位移极小（被真实墙/其他碰撞体顶住）→ 反向换向，保证不会焊在墙上
            if (Vector3.Distance(start, target.position) < stuckThreshold)
            {
                velocity = -velocity;
                changeTimer = 0.05f; // 立即重新计时，一小段后自然换向
            }

            if (faceMovementDirection && velocity.sqrMagnitude > 0.0001f)
            {
                target.rotation = Quaternion.LookRotation(velocity, Vector3.up);
            }
        }

        /// <summary>锁定固定飞行高度：lockHeight 开启时每帧强制把目标 y 设为 <see cref="flyHeight"/>。
        /// 放在 Step/BounceClamp 之后执行，覆盖物理/重力/动画对 y 的任何干扰（"往下掉"的根治点）。
        /// 关闭 lockHeight 时保持目标自身 y（Step 里已保证不主动改变 y）。</summary>
        private void ApplyFixedHeight()
        {
            if (target == null || !lockHeight)
            {
                return;
            }

            var position = target.position;
            position.y = flyHeight;

            if (cachedRigidbody != null)
            {
                cachedRigidbody.MovePosition(position);
            }
            else
            {
                target.position = position;
            }
        }

        /// <summary>定时随机换向：重选水平方向角与速度，组装 XZ 速度向量（y=0）。</summary>
        private void UpdateDirection()
        {
            changeTimer -= Time.deltaTime;
            if (changeTimer > 0f)
            {
                return;
            }

            changeTimer = directionChangeInterval * Random.Range(0.6f, 1.4f);
            float angle = Random.Range(0f, Mathf.PI * 2f);
            float speed = Mathf.Max(Random.Range(minSpeed, maxSpeed), 0.0001f); // 防 0 速（0 速会触发"被挡"死循环）
            velocity = new Vector3(Mathf.Cos(angle) * speed, 0f, Mathf.Sin(angle) * speed);
        }

        /// <summary>按目标物体的移动载体前进一步（水平步进，y 保持原值）：
        /// CharacterController.Move（自带碰撞）→ Rigidbody.MovePosition → transform.position。
        /// 绝不直接与物理系统抢 position（那是"卡墙不动"的根因）。</summary>
        private void Step()
        {
            var step = velocity * Time.deltaTime;

            if (cachedController != null)
            {
                cachedController.Move(step);
                return;
            }

            var position = target.position + step;
            position.y = target.position.y; // 水平移动：只动 XZ，y 保持原值（固定飞行高度）
            if (cachedRigidbody != null)
            {
                cachedRigidbody.MovePosition(position);
            }
            else
            {
                target.position = position;
            }
        }

        /// <summary>撞区域边界反弹（世界 AABB，只约束 XZ）：越过边界就夹回边界并把对应速度分量反向。
        /// 所有载体（含 Rigidbody / CharacterController / 纯 transform）都夹回 position——
        /// 区域已设为 isTrigger，物理不会挡越界，夹回必须由脚本完成。</summary>
        private void BounceClamp()
        {
            if (target == null || region == null)
            {
                return;
            }

            var position = target.position;
            Vector3 min = region.bounds.center - region.bounds.extents;
            Vector3 max = region.bounds.center + region.bounds.extents;
            if (position.x < min.x) { position.x = min.x; velocity.x = Mathf.Abs(velocity.x); }
            else if (position.x > max.x) { position.x = max.x; velocity.x = -Mathf.Abs(velocity.x); }
            if (position.z < min.z) { position.z = min.z; velocity.z = Mathf.Abs(velocity.z); }
            else if (position.z > max.z) { position.z = max.z; velocity.z = -Mathf.Abs(velocity.z); }
            position.y = target.position.y;

            if (cachedRigidbody != null)
            {
                cachedRigidbody.MovePosition(position);
            }
            else
            {
                target.position = position;
            }
        }

        private void OnDrawGizmos()
        {
            // 活动区域预览（World AABB）
            var box = region != null ? region : GetComponentInParent<BoxCollider>();
            if (box != null)
            {
                Gizmos.color = new Color(0f, 0.9f, 1f, 0.35f);
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