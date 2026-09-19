using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 浮点参数组件：存一个 float 值（纯参数存储，数据变化经基类 <see cref="BackendComponent.Changed"/> 通知）。
    /// 初始化时经枢纽上报（value/min/max 字段），GM 页面用数字输入框 + 滑动条修改（set_float 命令）。
    /// </summary>
    public class FloatValue : BackendComponent
    {
        [SerializeField, Tooltip("浮点参数值（GM 页面可修改）")]
        private float value;

        [SerializeField, Tooltip("是否启用数值范围：启用后 GM 面板显示滑动条且 min/max 生效；关闭只显示数字输入框")]
        private bool enableRange;

        [SerializeField, Tooltip("最小允许值（启用范围后 GM 滑动条下界）")]
        private float minValue = 0f;

        [SerializeField, Tooltip("最大允许值（启用范围后 GM 滑动条上界）")]
        private float maxValue = 1f;

        /// <summary>组件 ID（与客户端组件类同名，GM 面板据此渲染数字输入框 / 滑动条）。</summary>
        public override string ComponentId => "FloatValue";

        /// <summary>当前值。</summary>
        public float Value => value;

        /// <summary>是否启用数值范围（GM 面板据此决定显示滑动条还是仅数字输入框）。</summary>
        public bool EnableRange => enableRange;

        /// <summary>最小允许值（启用范围后 GM 滑动条下界）。</summary>
        public float MinValue => minValue;

        /// <summary>最大允许值（启用范围后 GM 滑动条上界）。</summary>
        public float MaxValue => maxValue;

        // ---------- 条件比较（值类型：Number，供动作触发条件判定） ----------

        public override bool Satisfies(ComponentCondition condition)
            => condition.ValueType == BackendValueKind.Number &&
               condition.Compare(condition.ValueType, condition.Operator, value);

        /// <summary>本地设置值（客户端本地修改，不回执上报）；值变化时触发 <see cref="BackendComponent.Changed"/>。</summary>
        public void SetValue(float newValue)
        {
            if (value == newValue)
            {
                return;
            }

            value = newValue;
            NotifyChanged();
        }

        /// <summary>组件数据上报：浮点参数值与范围（GM 属性面板的数字输入框 + 滑动条）。</summary>
        public override void AppendToInfo(Server.ServerObjectInfo info)
        {
            AppendData(info, new ValueData { value = value, enableRange = enableRange, min = minValue, max = maxValue });
        }

        [System.Serializable]
        private class ValueData
        {
            public float value;
            public bool enableRange;
            public float min;
            public float max;
        }

        /// <summary>命令处理：set_float（GM 数字输入框修改，本组件自己解析并执行；走 SetValue 统一触发变更通知）。</summary>
        public override bool CanHandle(string commandType) => commandType == "set_float";

        public override bool HandleCommand(Dictionary<string, object> msg)
        {
            SetValue((float)Server.JsonParser.GetNumber(msg, "value"));
            return true;
        }
    }
}
