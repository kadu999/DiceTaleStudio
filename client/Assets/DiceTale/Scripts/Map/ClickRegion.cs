using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 点击区域：地图上的 Box 触发区，**与玩家移动解耦**。每次指针按下时，InputManager 调用
    /// <see cref="HandleClick"/>——查询落点命中的区域（<see cref="FindAt"/>）、按指针 Id 匹配
    /// （<see cref="Matches"/>）后调用 <see cref="Trigger"/>，依次执行挂载的
    /// <see cref="BackendChangeAction"/> 动作（显隐 / 传送 / 音频 / 视频…，复用项目动作体系，
    /// 动作挂在任意物体上拖进 actions 即可）。任何指针（玩家/拍照等）均可触发，不要求玩家在场。
    ///
    /// 范围是世界 AABB：默认取 Collider bounds，没有 Collider 时退化用 Renderer 包围盒。
    /// 一次性语义用 <see cref="repeatable"/> 控制（场景物体销毁即复位，重新加载场景后可再触发）。
    /// <see cref="Id"/> 限定允许触发本区域的指针（<see cref="PointerId"/>）：
    /// 指针 Id 与区域 Id 一致才执行动作；Unassigned = 任意指针可触发。
    /// </summary>
    public class ClickRegion : MonoBehaviour
    {
        [SerializeField, Tooltip("允许触发本区域的指针/玩家 Id：Player1..5 限定对应玩家；Photo=拍照指针；Unassigned(默认)=任意指针可触发")]
        private PointerId regionId = PointerId.Unassigned;

        [SerializeField, Tooltip("是否允许重复触发；关闭后本区域只触发一次（场景重新加载后复位）")]
        private bool repeatable = true;

        [SerializeField, Tooltip("落地区域内时依次执行的动作（BackendChangeAction：显隐/传送/音频/视频等）")]
        private List<BackendChangeAction> actions = new List<BackendChangeAction>();

        private Collider regionCollider;
        private Renderer regionRenderer;
        private bool triggeredOnce;

        /// <summary>允许触发本区域的指针/玩家 Id（<see cref="PointerId"/>）；Unassigned = 不限任意指针。</summary>
        public PointerId Id
        {
            get => regionId;
            set => regionId = value;
        }

        /// <summary>指定指针 Id 是否允许触发本区域（Unassigned 恒为允许）。</summary>
        public bool Matches(PointerId pointerId)
        {
            return regionId == PointerId.Unassigned || regionId == pointerId;
        }

        /// <summary>处理一次指针点击（与玩家移动解耦）：查询落点命中的区域并按指针 Id 匹配后触发。
        /// 命中且触发了某区域返回 true，否则 false。UI 点击豁免由调用方（InputManager）在调用前处理。</summary>
        public static bool HandleClick(Vector3 worldPoint, PointerId pointerId)
        {
            var region = FindAt(worldPoint);
            if (region == null || !region.Matches(pointerId))
            {
                return false;
            }

            region.Trigger();
            return true;
        }

        /// <summary>查询包含 worldPoint 的最小体积区域；无命中返回 null。
        /// 只统计挂接物体激活（activeInHierarchy，含父级）的区域——区域物体 SetActive(false) 隐藏后
        /// 即不再可触发（FindObjectsByType 本身只取活动物体，此检查为显式语义与防御）。
        /// 多个区域重叠时返回包围盒最小者。</summary>
        public static ClickRegion FindAt(Vector3 worldPoint)
        {
            ClickRegion best = null;
            float bestVolume = float.MaxValue;

            foreach (var region in Object.FindObjectsByType<ClickRegion>(FindObjectsSortMode.None))
            {
                if (region == null || !region.gameObject.activeInHierarchy || !region.Contains(worldPoint))
                {
                    continue;
                }

                float volume = region.Bounds.size.sqrMagnitude;
                if (volume < bestVolume)
                {
                    best = region;
                    bestVolume = volume;
                }
            }

            return best;
        }

        private void Awake()
        {
            regionCollider = GetComponent<Collider>();
            regionRenderer = GetComponent<Renderer>();
        }

        /// <summary>区域世界包围盒（Collider 优先，退化为 Renderer bounds；都没有时退化为自身一点）。</summary>
        public Bounds Bounds
        {
            get
            {
                if (regionCollider != null)
                {
                    return regionCollider.bounds;
                }

                if (regionRenderer != null)
                {
                    return regionRenderer.bounds;
                }

                return new Bounds(transform.position, Vector3.zero);
            }
        }

        /// <summary>世界点是否落在本区域内（世界 AABB 判定）。</summary>
        public bool Contains(Vector3 worldPoint)
        {
            return Bounds.Contains(worldPoint);
        }

        /// <summary>被移动管理器命中调用：一次性区域已触发则忽略；否则**不评估条件、直接执行**全部动作
        /// （条件动作经 <see cref="ConditionalBackendChangeAction.ExecuteIgnoringCondition"/> 强制生效，
        /// 无条件的动作直接 Execute；点击触发不做任何条件/上下文检测）。</summary>
        public void Trigger()
        {
            if (!repeatable)
            {
                if (triggeredOnce)
                {
                    return;
                }

                triggeredOnce = true;
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
    }
}