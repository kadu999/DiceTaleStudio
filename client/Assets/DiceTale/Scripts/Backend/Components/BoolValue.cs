using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 布尔参数组件：存一个 bool 值（纯参数存储，数据变化经基类 <see cref="BackendComponent.Changed"/> 通知）。
    /// 初始化时经枢纽上报（boolValue 字段），GM 页面用开关修改（set_bool 命令）。
    /// </summary>
    public class BoolValue : BackendComponent
    {
        [SerializeField, Tooltip("布尔参数值（GM 页面可修改）")]
        private bool value;

        /// <summary>组件 ID（与客户端组件类同名，GM 面板据此渲染开关）。</summary>
        public override string ComponentId => "BoolValue";

        /// <summary>当前值。</summary>
        public bool Value => value;

        // ---------- 条件比较（值类型：Bool，供动作触发条件判定） ----------

        public override bool Satisfies(ComponentCondition condition)
            => condition.ValueType == BackendValueKind.Bool &&
               condition.Compare(condition.ValueType, condition.Operator, value);

        /// <summary>本地设置值（客户端本地修改，不回执上报）；值变化时触发 <see cref="BackendComponent.Changed"/>。</summary>
        public void SetValue(bool newValue)
        {
            if (value == newValue)
            {
                return;
            }

            value = newValue;
            NotifyChanged();
        }

        /// <summary>组件数据上报：布尔参数值。</summary>
        public override void AppendToInfo(Server.ServerObjectInfo info)
        {
            AppendData(info, new ValueData { value = value });
        }

        [System.Serializable]
        private class ValueData
        {
            public bool value;
        }

        /// <summary>命令处理：set_bool（GM 开关修改，本组件自己解析并执行；走 SetValue 统一触发变更通知）。</summary>
        public override bool CanHandle(string commandType) => commandType == "set_bool";

        public override bool HandleCommand(Dictionary<string, object> msg)
        {
            SetValue(Server.JsonParser.GetBool(msg, "value"));
            return true;
        }
    }
}
