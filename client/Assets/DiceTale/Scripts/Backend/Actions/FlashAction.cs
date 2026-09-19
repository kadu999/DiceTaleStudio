using System.Collections;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 闪烁动作：OnComponentChanged 触发时把目标物体激活显示，持续 duration 秒后自动隐藏
    /// （如区域事件触发的提示特效）。目标为空时作用于自身；Awake 时先隐藏目标。
    /// 文件必须以 UTF-8 编码保存（中文 Tooltip 乱码会进编译器）。
    /// </summary>
    public class FlashAction : BackendChangeAction
    {
        [SerializeField, Tooltip("要闪烁的目标物体；为空时使用自身")]
        private GameObject target;

        [SerializeField, Tooltip("闪烁显示时长（秒）")]
        private float duration = 0.5f;

        private void Awake()
        {
            var go = target != null ? target : gameObject;
            if (go != null)
            {
                go.SetActive(false);
            }
        }

        public override void OnComponentChanged(BackendComponent component)
        {
            var go = target != null ? target : gameObject;
            if (go != null)
            {
                StartCoroutine(FlashCoroutine(go));
            }
        }

        private IEnumerator FlashCoroutine(GameObject go)
        {
            go.SetActive(true);
            yield return new WaitForSeconds(duration);
            go.SetActive(false);
        }
    }
}