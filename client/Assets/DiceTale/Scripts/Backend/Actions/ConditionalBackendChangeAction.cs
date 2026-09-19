using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 条件变更动作基类：持有唯一的 <see cref="ComponentCondition"/>（组件条件），
    /// 所有「带条件的效果动作」（ShowHide / Teleport / TeleportZone / PlayAudio / PlayDialogue）
    /// 统一继承本类——条件字段只有这一处引用，需要给条件加 Inspector 编辑器（CustomEditor）时
    /// 只需针对本类编写一次（[CustomEditor(typeof(ConditionalBackendChangeAction), true)]），
    /// 所有子类自动生效。
    /// 条件在所属组件数据改变（OnComponentChanged）时重新评估；condition 留空视为恒满足。
    /// 点击区域（<see cref="ClickRegion"/>）等触发源**不评估条件**：经
    /// <see cref="ExecuteIgnoringCondition"/> 强制直接执行效果（条件评估仅用于组件数据变化触发链）。
    /// </summary>
    public abstract class ConditionalBackendChangeAction : BackendChangeAction
    {
        [SerializeField, Tooltip("Trigger condition: effect runs when the owning component satisfies it; empty = always")]
        private ComponentCondition condition;

        /// <summary>强制忽略条件：置真期间 ConditionMet 恒真（点击区域等触发源用，一次性包裹在
        /// <see cref="ExecuteIgnoringCondition"/> 内，调用前后复位）。</summary>
        [System.NonSerialized]
        private bool ignoreCondition;

        /// <summary>强制执行：忽略条件直接执行效果（<see cref="ClickRegion"/> 触发用）；调用结束后自动复位，
        /// 不影响后续组件数据变化触发时的正常条件评估。</summary>
        public void ExecuteIgnoringCondition()
        {
            ignoreCondition = true;
            try
            {
                Execute();
            }
            finally
            {
                ignoreCondition = false;
            }
        }

        /// <summary>条件是否满足：强制执行期间恒真；否则 condition 为空视为恒满足（恒执行效果），
        /// component 为触发来源。</summary>
        protected bool ConditionMet(BackendComponent component)
        {
            if (ignoreCondition)
            {
                return true;
            }

            // 条件为空恒满足；component 为空（如 Awake 初始评估阶段拿不到所属组件）时无法求值，
            // 视为不满足（保守）+ 防御性日志，避免对 null 调实例方法 NRE（条件化传送区域启动即崩的根因）
            if (component == null)
            {
                if (condition != null)
                {
                    Debug.LogWarning($"[{GetType().Name}] 条件未满足：所属组件尚不可用（初始评估在组件就绪前执行）");
                }

                return condition == null;
            }

            return condition == null || component.Satisfies(condition);
        }
    }
}
