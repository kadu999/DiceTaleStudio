using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 整数参数组件：存一个 int 值（纯参数存储，数据变化经基类 <see cref="BackendComponent.Changed"/> 通知）。
    /// 初始化时经枢纽上报（value/min/max 字段），GM 页面用整数输入框 + 滑动条修改（set_int 命令）。
    /// </summary>
    public class IntValue : BackendComponent
    {
        [SerializeField, Tooltip("整数参数值（GM 页面可修改）")]
        private int value;

        [SerializeField, Tooltip("是否启用数值范围：启用后 GM 面板显示滑动条且 min/max 生效；关闭只显示数字输入框")]
        private bool enableRange;

        [SerializeField, Tooltip("最小允许值（启用范围后 GM 滑动条下界）")]
        private int minValue = 0;

        [SerializeField, Tooltip("最大允许值（启用范围后 GM 滑动条上界）")]
        private int maxValue = 100;

        /// <summary>组件 ID（与客户端组件类同名，GM 面板据此渲染整数输入框 / 滑动条）。</summary>
        public override string ComponentId => "IntValue";

        /// <summary>当前值。</summary>
        public int Value => value;

        /// <summary>是否启用数值范围（GM 面板据此决定显示滑动条还是仅数字输入框）。</summary>
        public bool EnableRange => enableRange;

        /// <summary>最小允许值（启用范围后 GM 滑动条下界）。</summary>
        public int MinValue => minValue;

        /// <summary>最大允许值（启用范围后 GM 滑动条上界）。</summary>
        public int MaxValue => maxValue;

        // ---------- 条件比较（值类型：Integer，供动作触发条件判定） ----------

        public override bool Satisfies(ComponentCondition condition)
            => condition.ValueType == BackendValueKind.Integer &&
               condition.Compare(condition.ValueType, condition.Operator, value);

        /// <summary>本地设置值（客户端本地修改，不回执上报）；值变化时触发 <see cref="BackendComponent.Changed"/>。</summary>
        public void SetValue(int newValue)
        {
            if (value == newValue)
            {
                return;
            }

            value = newValue;
            NotifyChanged();
        }

        /// <summary>组件数据上报：整数参数值与范围（GM 属性面板的数字输入框 + 滑动条）。</summary>
        public override void AppendToInfo(Server.ServerObjectInfo info)
        {
            AppendData(info, new ValueData { value = value, enableRange = enableRange, min = minValue, max = maxValue });
        }

        [System.Serializable]
        private class ValueData
        {
            public int value;
            public bool enableRange;
            public int min;
            public int max;
        }

        /// <summary>命令处理：set_int（GM 整数输入框修改，本组件自己解析并执行；走 SetValue 统一触发变更通知）。</summary>
        public override bool CanHandle(string commandType) => commandType == "set_int";

        public override bool HandleCommand(Dictionary<string, object> msg)
        {
            // 带 key 的 set_int 是给同物体上的 AttributeList（属性表）用的：
            // 本组件让渡（返回 false），由分派器继续尝试下一个可处理组件，避免把属性值错写进 IntValue
            if (Server.JsonParser.GetString(msg, "key") != null)
            {
                return false;
            }

            SetValue((int)Server.JsonParser.GetNumber(msg, "value"));
            return true;
        }
    }
}
