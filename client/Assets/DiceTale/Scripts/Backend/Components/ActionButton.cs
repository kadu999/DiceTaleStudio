using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 后台按钮组件：GM 页面渲染一个「触发」按钮，点击后经后台转发
    /// <c>trigger_button</c> 命令到本组件，直接触发挂在「变更动作列表」上的动作——
    /// **不评估条件、直接执行**（同 ClickRegion 语义：条件动作经
    /// <see cref="ConditionalBackendChangeAction.ExecuteIgnoringCondition"/> 强制生效）。
    ///
    /// 参考 <see cref="OptionValue"/> 的组件模式（ComponentId 与类名一致，后台/GM 按此渲染控件）。
    /// 按钮无状态：不参与数据上报（AppendToInfo 保持基类空实现），后台快照无需维护。
    /// 也可被本地逻辑直接调用 <see cref="Trigger"/> 触发。
    /// </summary>
    public class ActionButton : BackendComponent
    {
        /// <summary>组件 ID：ActionButton（后台 gm_trigger_button 转发与本组件识别一致）。</summary>
        public override string ComponentId => "ActionButton";

        /// <summary>只处理 trigger_button 命令（后台转发 GM 按钮点击）。</summary>
        public override bool CanHandle(string commandType) => commandType == "trigger_button";

        public override bool HandleCommand(Dictionary<string, object> msg)
        {
            Trigger();
            return true;
        }

        /// <summary>触发动作列表：不评估条件直接执行（GM 按钮点击或本地逻辑都走这里）。</summary>
        public void Trigger()
        {
            ExecuteActionsIgnoringCondition();
        }
    }
}