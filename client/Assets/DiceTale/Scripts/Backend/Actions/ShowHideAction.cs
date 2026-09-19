using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 显示/隐藏动作：继承 <see cref="ConditionalBackendChangeAction"/>。
    /// 组件数据改变时（OnComponentChanged）用基类条件评估所属组件的当前值：
    /// 条件满足显示/激活目标，否则隐藏/停用。条件支持任意覆写 Satisfies 的值组件
    /// （BoolValue 开关、OptionValue 选项名、数值阈值…）；条件留空恒显示。
    /// 目标为空时作用于自身。挂到组件的「变更动作列表」（actions）即可。
    ///
    /// 注意：目标若是**场景状态根**（挂了 <see cref="SceneState"/>），本动作不直接改它的激活状态——
    /// 状态根的显隐由 GameScene 的场景状态切换独占驱动，在此再 SetActive 会与状态切换互相覆盖
    /// （状态激活的物体被显隐条件立刻关掉 / 反之）。需要随条件显隐的应作用于状态根**内部**的子物体。
    /// </summary>
    public class ShowHideAction : ConditionalBackendChangeAction
    {
        [SerializeField, Tooltip("要激活/隐藏的目标物体；为空时使用自身")]
        private GameObject target;

        public override void OnComponentChanged(BackendComponent component)
        {
            var go = target != null ? target : gameObject;
            if (go == null)
            {
                return;
            }

            // 状态根由 GameScene 独占驱动，避免两个控制器互相覆盖（见类注释）
            if (go.GetComponent<SceneState>() != null)
            {
                Debug.LogWarning($"[ShowHideAction] 目标 {go.name} 是场景状态根（SceneState），显隐由场景状态切换控制，" +
                                 "ShowHideAction 已跳过；如需按条件显隐请作用于状态根内部的子物体。");
                return;
            }

            go.SetActive(ConditionMet(component));
        }
    }
}
