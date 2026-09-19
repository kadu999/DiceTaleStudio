using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 变更动作基类：所有「组件变更动作」的统一基类（抽象类，不可直接挂到物体上）。
    /// 不继承 <see cref="BackendObject"/>，可挂在任意物体上；挂到某 <see cref="BackendComponent"/> 的
    /// 「变更动作列表」（actions）后，该组件数据改变（NotifyChanged，后台命令或本地修改都会触发）时
    /// 被调用，component 即触发它的组件；是否执行效果由条件基类 <see cref="ConditionalBackendChangeAction"/>
    /// 的 <see cref="ComponentCondition"/> 决定（对任意覆写 Satisfies 的值组件通用）。
    /// 触发次数由 <see cref="triggerOnce"/> 控制：默认 false 可多次触发；true 首次执行后本动作不再触发
    /// （物体随场景卸载销毁即复位，重新加载场景后可再触发；点击区域 ClickRegion 等触发源同样受控）。
    /// </summary>
    public abstract class BackendChangeAction : MonoBehaviour
    {
        [SerializeField, Tooltip("是否只触发一次：true=首次执行后本动作不再触发（重新加载场景后复位）；false=可多次触发（默认）")]
        private bool triggerOnce;

        private bool triggered;

        /// <summary>指定函数：组件数据改变时调用（component 即触发它的组件，可强转具体组件读最新值）。</summary>
        public abstract void OnComponentChanged(BackendComponent component);

        /// <summary>公开执行入口：供非「组件数据改变」的触发源调用（如点击区域 ClickRegion）。
        /// context 为触发来源的组件，没有则传 null（条件基类对空上下文保守求值：无条件恒执行、
        /// 有条件视为未满足而跳过）。<see cref="triggerOnce"/> 开启时首次执行后忽略后续调用。</summary>
        public void Execute(BackendComponent context = null)
        {
            if (triggerOnce)
            {
                if (triggered)
                {
                    return;
                }

                triggered = true;
            }

            OnComponentChanged(context);
        }
    }
}