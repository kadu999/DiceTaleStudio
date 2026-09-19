using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 选项值组件：持有选项列表与当前选项（单选数据组件，GM 面板渲染为单选按钮组）。
    /// 继承 <see cref="BackendComponent"/>，与 <see cref="BackendObject"/> 枢纽挂同一物体：
    /// - 组件 ID 与类名一致（OptionValue），后台/GM 按此渲染单选按钮组；
    /// - 选项列表/当前选项由组件自己上报（IBackendComponentData → GM 单选按钮组）；
    /// - set_option 命令由枢纽路由到本组件（TrySetState），执行后不回执上报（数据由后台维护）；
    /// - 切换选项时调用基类 NotifyChanged()（变更动作列表 actions / 代码事件 Changed；动作类挂在本组件的「变更动作列表」上）；
    /// - 显示名称在枢纽上配置（BackendObject.displayName，后台看名字识别对象）。
    /// </summary>
    public class OptionValue : BackendComponent
    {
        /// <summary>组件 ID：OptionValue（后台 updateComponentParam 与 GM 面板渲染按此字符串识别）。</summary>
        public override string ComponentId => "OptionValue";

        [SerializeField, Tooltip("状态列表（仅状态名称）；后台可用 set_option 按名称切换")]
        private List<SceneObjectState> states = new List<SceneObjectState>();

        [SerializeField, Tooltip("目前选择的索引（对应选项列表中的位置，从 0 开始；越界时回退到第 0 个选项）")]
        private int selectedIndex;

        /// <summary>当前选项名称；未配置选项或尚未启动时为 null。</summary>
        public string CurrentStateName =>
            selectedIndex >= 0 && selectedIndex < states.Count ? states[selectedIndex].Name : null;

        /// <summary>目前选择的索引（对应选项列表中的位置，从 0 开始）。</summary>
        public int SelectedIndex => selectedIndex;

        // ---------- 条件比较（String = 当前选项名；Integer = 当前选项索引，供动作触发条件判定） ----------

        public override bool Satisfies(ComponentCondition condition)
        {
            switch (condition.ValueType)
            {
                case BackendValueKind.String:
                    return condition.Compare(condition.ValueType, condition.Operator, CurrentStateName);

                case BackendValueKind.Integer:
                    return condition.Compare(condition.ValueType, condition.Operator, selectedIndex);

                default:
                    return false;
            }
        }

        /// <summary>全部可选状态名称（上报给 GM 页面展示与切换）。</summary>
        public List<string> StateNames
        {
            get
            {
                var names = new List<string>(states.Count);
                foreach (var state in states)
                {
                    names.Add(state.Name);
                }

                return names;
            }
        }

        /// <summary>组件数据上报：选项列表与当前选项名称（GM 属性面板的单选按钮组；JSON 键 currentOption/options）。</summary>
        public override void AppendToInfo(Server.ServerObjectInfo info)
        {
            AppendData(info, new StateData { currentOption = CurrentStateName, options = StateNames });
        }

        [System.Serializable]
        private class StateData
        {
            public string currentOption;
            public List<string> options;
        }

        /// <summary>命令处理：set_option（选项切换由本组件自己解析并执行，不再经枢纽转发）。</summary>
        public override bool CanHandle(string commandType) => commandType == "set_option";

        public override bool HandleCommand(Dictionary<string, object> msg)
        {
            var stateName = Server.JsonParser.GetString(msg, "option");
            return TrySetState(stateName);
        }

        private void Start()
        {
            // 进入当前选项（按索引对应选项列表；越界时回退到第 0 个），触发基类变更通知
            if (states.Count > 0)
            {
                if (selectedIndex < 0 || selectedIndex >= states.Count)
                {
                    Debug.LogWarning($"[OptionValue] {name}: selected index {selectedIndex} out of range, fallback to first option.");
                    selectedIndex = 0;
                }

                EnterState(selectedIndex);
            }
        }

        /// <summary>
        /// 按名称切换选项（后台服务器 set_option 命令经枢纽转发调用）。
        /// 切换到新选项时触发基类变更通知并同步 selectedIndex；已是同名选项时不重复触发。
        /// </summary>
        /// <returns>选项存在并切换成功（或已在同选项）返回 true；名称不存在返回 false。</returns>
        public bool TrySetState(string stateName)
        {
            if (string.IsNullOrEmpty(stateName))
            {
                return false;
            }

            for (int i = 0; i < states.Count; i++)
            {
                if (!string.Equals(states[i].Name, stateName, System.StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (selectedIndex == i)
                {
                    return true;
                }

                EnterState(i); // 只执行后台命令，不回执上报（数据由后台维护）
                return true;
            }

            return false;
        }

        /// <summary>是否配置了指定名称的状态（不区分大小写）。</summary>
        public bool HasState(string stateName)
        {
            if (string.IsNullOrEmpty(stateName))
            {
                return false;
            }

            for (int i = 0; i < states.Count; i++)
            {
                if (string.Equals(states[i].Name, stateName, System.StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>进入指定选项：同步目前选择的索引并触发基类变更通知（代码事件 Changed；
        /// 后台切换与初始 Start 进入都会触发）。</summary>
        private void EnterState(int index)
        {
            selectedIndex = index;
            NotifyChanged();
        }
    }

    /// <summary>
    /// 场景物体的一个状态：只包含状态名称（供后台 set_option 按名称切换）。
    /// 状态变化经基类变更通知统一分发（变更动作列表 actions / 代码事件 Changed；动作类挂在本组件的「变更动作列表」上），
    /// 动作按 <see cref="OptionValue.CurrentStateName"/> 判断当前状态。
    /// </summary>
    [System.Serializable]
    public class SceneObjectState
    {
        [SerializeField, Tooltip("状态名称（后台服务器切换状态时使用的名称）")]
        private string name;

        public string Name => name;
    }
}
