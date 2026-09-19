using System;
using UnityEngine;
using UnityEngine.Events;

namespace DiceTale
{
    /// <summary>
    /// 回调动作：触发时依次执行 Inspector 配置的「回调列表」，并把触发组件作为参数传给每个回调——
    /// 每个条目可绑定任意 GameObject 上组件的公有函数（无参，或一个 <see cref="BackendComponent"/> 参数）。
    /// 带组件参数的函数在 Inspector 里选「动态」（Dynamic）入参，收到的即本次触发的组件，
    /// 可强转具体值组件（BoolValue/IntValue/OptionValue…）读最新值（与 <see cref="BackendComponent.Changed"/>
    /// 事件同一模式）；也可绑定无参函数，或在 Inspector 里填静态值（此时触发组件被忽略）。
    /// 挂到某 <see cref="BackendComponent"/> 的「变更动作列表」（actions）后，组件数据改变即触发；
    /// 也可由点击区域 ClickRegion 等经 <see cref="BackendChangeAction.Execute"/> 直接触发
    /// （context 为触发来源组件，没有则传 null）。
    /// 无条件包装（不继承条件基类）：触发即执行全部回调；只触发一次等控制由基类 triggerOnce 提供。
    /// </summary>
    public class CallbackAction : BackendChangeAction
    {
        /// <summary>带 <see cref="BackendComponent"/> 参数的回调列表（UnityEvent 泛型子类才可序列化到 Inspector）。</summary>
        [Serializable]
        public class BackendComponentCallback : UnityEvent<BackendComponent>
        {
        }

        [SerializeField, Tooltip("回调列表：触发时依次执行并把触发组件传给每个回调（每条可指向任意 GameObject 组件的公有函数）")]
        private BackendComponentCallback callbacks;

        /// <summary>组件数据改变（或其它触发源经 Execute 调用）：依次执行回调列表，传入触发组件。</summary>
        public override void OnComponentChanged(BackendComponent component)
        {
            callbacks?.Invoke(component);
        }
    }
}
