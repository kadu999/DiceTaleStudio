using UnityEngine;

namespace DiceTale
{
    /// <summary>值形态：条件的 valueType 与组件 Satisfies 覆写用它声明"比较哪种值"。
    /// 注意：追加新值必须放在末尾（序列化按整数存储，已有预置物数据不能移位）。</summary>
    public enum BackendValueKind
    {
        Bool,
        String,
        Number,
        Integer
    }

    /// <summary>
    /// 组件条件：用户选择「要比较的值类型」（<see cref="valueType"/>）与目标值，
    /// 由值组件的 <see cref="BackendComponent.Satisfies"/> 调用单一的
    /// <see cref="Compare(BackendValueKind, Op, object)"/> 完成比较——
    /// 条件只提供操作符与目标值，组件自己决定怎么提供实际值。
    /// 动作用它决定是否触发/显隐等效果（经 <see cref="ConditionalBackendChangeAction"/> 持有）。
    /// </summary>
    [System.Serializable]
    public class ComponentCondition
    {
        /// <summary>比较操作符（Bool/String 只用 Equal/NotEqual；Number 支持全部）。</summary>
        public enum Op
        {
            Equal = 0,
            NotEqual = 1,
            AtLeast = 2,
            AtMost = 3
        }

        [SerializeField, Tooltip("Value type to compare: Bool (BoolValue) / String (OptionValue option name) / Number (FloatValue) / Integer (IntValue)")]
        private BackendValueKind valueType = BackendValueKind.Bool;

        [SerializeField, Tooltip("Comparison operator (Bool/String only support Equal/NotEqual; Number/Integer support all)")]
        private Op op;

        [SerializeField, Tooltip("Target bool (compared when valueType = Bool)")]
        private bool targetBool;

        [SerializeField, Tooltip("Target string (compared when valueType = String, e.g. OptionValue option name)")]
        private string targetString;

        [SerializeField, Tooltip("Target number (compared when valueType = Number)")]
        private float targetNumber;

        [SerializeField, Tooltip("Target integer (compared when valueType = Integer)")]
        private int targetInteger;

        /// <summary>用户选择的值类型（编辑器据此显示对应的目标字段）。</summary>
        public BackendValueKind ValueType => valueType;

        /// <summary>比较操作符。</summary>
        public Op Operator => op;

        /// <summary>
        /// 单一比较入口：按 valueType 分派，把实际值 actualValue（bool / string / number / integer）
        /// 与对应目标值比较。实际值类型与 valueType 不符（配错）时返回 false。
        /// </summary>
        public bool Compare(BackendValueKind valueType, Op op, object actualValue)
        {
            switch (valueType)
            {
                case BackendValueKind.Bool:
                    return actualValue is bool b && CompareBool(op, b);

                case BackendValueKind.String:
                    return actualValue is string s && CompareString(op, s);

                case BackendValueKind.Number:
                    return actualValue is float f && CompareNumber(op, f);

                case BackendValueKind.Integer:
                    return actualValue is int i && CompareInteger(op, i);

                default:
                    return false;
            }
        }

        private bool CompareBool(Op op, bool actual)
        {
            switch (op)
            {
                case Op.Equal:
                    return actual == targetBool;

                case Op.NotEqual:
                    return actual != targetBool;

                default:
                    return false; // Bool 只支持等于/不等于
            }
        }

        private bool CompareString(Op op, string actual)
        {
            switch (op)
            {
                case Op.Equal:
                    return string.Equals(actual, targetString, System.StringComparison.OrdinalIgnoreCase);

                case Op.NotEqual:
                    return !string.Equals(actual, targetString, System.StringComparison.OrdinalIgnoreCase);

                default:
                    return false; // String 只支持等于/不等于
            }
        }

        private bool CompareNumber(Op op, float actual)
        {
            switch (op)
            {
                case Op.Equal:
                    return actual == targetNumber;

                case Op.NotEqual:
                    return actual != targetNumber;

                case Op.AtLeast:
                    return actual >= targetNumber;

                case Op.AtMost:
                    return actual <= targetNumber;

                default:
                    return false;
            }
        }

        private bool CompareInteger(Op op, int actual)
        {
            switch (op)
            {
                case Op.Equal:
                    return actual == targetInteger;

                case Op.NotEqual:
                    return actual != targetInteger;

                case Op.AtLeast:
                    return actual >= targetInteger;

                case Op.AtMost:
                    return actual <= targetInteger;

                default:
                    return false;
            }
        }
    }
}
