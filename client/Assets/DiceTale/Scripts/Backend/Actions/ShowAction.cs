using UnityEngine;

namespace DiceTale
{
    public class ShowAction : BackendChangeAction
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

            go.SetActive(true);
        }
    }
}