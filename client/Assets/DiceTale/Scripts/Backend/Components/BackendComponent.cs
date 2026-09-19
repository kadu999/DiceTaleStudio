using System;
using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 后台能力组件基类：所有能力组件（OptionValue 选项值 / Backpack 背包 / ItemExchange 道具交换 /
    /// MaskImage 遮罩图）的统一基类。
    ///
    /// 基类已实现组件公共契约，子类只需声明自己的能力接口：
    /// - <see cref="IBackendCommandHandler"/>：命令处理（CanHandle/HandleCommand 默认不处理，子类按需覆写）；
    /// - <see cref="IBackendComponentData"/>：数据上报（AppendToInfo 默认空实现，有数据要上报的子类覆写）。
    ///
    /// 基类另提供：
    /// - <see cref="ComponentId"/>：组件 ID（与客户端组件类同名，上报给 GM 面板用于渲染控件），子类覆写；
    /// - <see cref="GmEditable"/>：GM 属性面板是否渲染该组件的编辑控件
    ///   （角色组件由玩家/出生点名单处理，不进入面板清单，覆写为 false）；
    /// - 激活时自动通知 <see cref="BackendObject"/> 枢纽刷新能力组件缓存（OnEnable 内置）；
    /// - <see cref="SendToBackend"/> / <see cref="NormalizePosition"/>：上报触发，统一转发给主体枢纽，
    ///   组件不直接接触通信层；数据修改由后台命令驱动，前端只在初始化上报；
    /// - 同一物体可挂多个能力组件（BackendObject 枢纽 + 任意个组件组合，如 状态机+背包+数值），
    ///   多个组件各自上报数据段，GM 面板按组件类型分行渲染；
    /// - 要求同物体必须有 BackendObject 枢纽（RequireComponent）。
    ///
    /// 变更通知（数据被修改后的统一出口，所有组件通用）：
    /// - <see cref="actions"/>：变更动作列表——本组件数据改变时依次调用每个动作的 OnComponentChanged
    ///   （动作可挂在任意物体上；顺序确定、不依赖动作启用状态）；
    /// - <see cref="Changed"/>：代码订阅事件——数据真正改变处触发（后台命令或本地修改都会），
    ///   订阅/退订建议放在 OnEnable/OnDisable（退订勿漏，避免悬挂引用）；
    /// - <see cref="NotifyCommandHandled"/>：后台命令成功处理后由枢纽调用（触发子类钩子
    ///   <see cref="OnCommandHandled"/>）；actions/Changed 不在此触发，避免命令路径双触发——
    ///   各组件在自己的公共修改方法里主动调 <see cref="NotifyChanged"/>。
    /// </summary>
    [RequireComponent(typeof(BackendObject))]
    public abstract class BackendComponent : MonoBehaviour, IBackendComponentData, IBackendCommandHandler
    {
        /// <summary>组件 ID（与客户端组件类同名，如 OptionValue / Backpack / MaskImage；后台/GM 按此渲染控件）。</summary>
        public abstract string ComponentId { get; }

        /// <summary>Inspector 自定义组件显示名（GM 属性面板分区标题；留空用组件类名）。</summary>
        [SerializeField, Tooltip("组件显示名（GM 属性面板分区标题）；留空使用组件类名")]
        private string displayName;

        /// <summary>组件显示名（GM 属性面板的分区标题）：Inspector 可覆盖（displayName 字段），留空时用组件类名（ComponentId）。</summary>
        public string DisplayName => string.IsNullOrEmpty(displayName) ? ComponentId : displayName;

        /// <summary>变更动作列表：本组件数据改变时（NotifyChanged）依次调用每个动作的 OnComponentChanged（传入本组件）。
        /// 动作可挂在任意物体上；顺序确定、不依赖动作启用状态。</summary>
        [SerializeField, Tooltip("变更动作列表：本组件数据改变时依次调用每个动作的 OnComponentChanged（可挂在任意物体上）")]
        private List<BackendChangeAction> actions = new List<BackendChangeAction>();

        /// <summary>GM 属性面板是否渲染该组件的编辑控件（默认 true；角色组件覆写为 false）。</summary>
        public virtual bool GmEditable => true;

        /// <summary>主体枢纽（同物体上的 BackendObject）；组件所有上报都经它转发。</summary>
        protected BackendObject Hub => GetComponent<BackendObject>();

        protected virtual void OnEnable()
        {
            // 通知枢纽刷新能力组件缓存（激活/动态挂载后保持同步）
            Hub?.RefreshCapabilityComponents();
        }

        // ---------- IBackendComponentData（默认空实现，有数据要上报的子类覆写） ----------

        /// <summary>把本组件的参数填充到上报信息（默认空实现；各能力组件覆写）。</summary>
        public virtual void AppendToInfo(Server.ServerObjectInfo info)
        {
        }

        /// <summary>
        /// 把组件数据以 JSON 字符串追加到上报信息：
        /// component = 组件类型（ComponentId），displayName = 组件显示名（GM 面板分区标题），data = JsonUtility 序列化。
        /// 谁要用谁解析（GM/后端按组件类型 JSON.parse）。覆写 AppendToInfo 时调用。
        /// </summary>
        protected void AppendData(Server.ServerObjectInfo info, object data)
        {
            info.componentData.Add(new Server.ComponentData
            {
                component = ComponentId,
                displayName = DisplayName,
                data = JsonUtility.ToJson(data)
            });
        }

        // ---------- IBackendCommandHandler（默认不处理命令，有命令要处理的子类覆写） ----------

        /// <summary>是否处理该命令类型（默认 false；OptionValue/Backpack/MaskImage 覆写声明自己处理的命令）。</summary>
        public virtual bool CanHandle(string commandType) => false;

        /// <summary>执行命令（默认不处理；覆写 CanHandle 的组件在此解析参数并执行）。</summary>
        public virtual bool HandleCommand(Dictionary<string, object> msg) => false;

        // ---------- 变更通知（数据被修改后的统一出口） ----------

        /// <summary>
        /// 数据变更事件：组件数据真正改变处触发（后台命令或本地修改都会），订阅者据此做响应。
        /// 载荷为本组件，订阅端可强转具体组件读取最新属性（如 (BoolValue)comp → Value）。
        /// 建议在 OnEnable 订阅、OnDisable 退订（退订勿漏，避免悬挂引用）。
        /// </summary>
        public event Action<BackendComponent> Changed;

        /// <summary>
        /// 后台命令成功处理后的通知入口（由 <see cref="BackendObject.DispatchCommand"/> 在组件
        /// HandleCommand 返回 true 后调用）：触发子类钩子 <see cref="OnCommandHandled"/>。
        /// 注意本方法不触发 <see cref="Changed"/>（避免命令路径双触发）——组件在自己的公共
        /// 修改方法里主动调 <see cref="NotifyChanged"/>，本地修改与后台命令统一走同一出口。
        /// </summary>
        public void NotifyCommandHandled(string commandType, Dictionary<string, object> msg)
        {
            OnCommandHandled(commandType, msg);
        }

        /// <summary>后台命令成功处理后的子类钩子（想感知具体命令类型的组件覆写；默认空实现）。</summary>
        protected virtual void OnCommandHandled(string commandType, Dictionary<string, object> msg)
        {
        }

        /// <summary>触发变更通知（组件在数据真正改变处调用；值未变时不要调用）：
        /// 依次执行变更动作列表（actions）→ 代码订阅事件（Changed）。
        /// 后台命令与本地修改统一走这一出口，不会重复触发。</summary>
        protected void NotifyChanged()
        {
            foreach (var action in actions)
            {
                action?.OnComponentChanged(this);
            }

            Changed?.Invoke(this);
        }

        /// <summary>直接执行变更动作列表（**忽略条件**，与点击区域 ClickRegion 同语义）：条件动作经
        /// <see cref="ConditionalBackendChangeAction.ExecuteIgnoringCondition"/> 强制生效、无条件动作直接 Execute。
        /// 供「按下/点击即触发、不做条件判断」的组件用（如 <see cref="ActionButton"/> 后台按钮组件）；
        /// 组件数据变更触发的常规路径仍是 <see cref="NotifyChanged"/>（带条件评估）。</summary>
        protected void ExecuteActionsIgnoringCondition()
        {
            foreach (var action in actions)
            {
                if (action == null)
                {
                    continue;
                }

                if (action is ConditionalBackendChangeAction conditional)
                {
                    conditional.ExecuteIgnoringCondition();
                }
                else
                {
                    action.Execute();
                }
            }
        }

        // ---------- 条件比较（值组件子类覆写，动作的触发条件统一经此判定） ----------

        /// <summary>组件当前值是否满足条件（默认不满足；BoolValue/IntValue/FloatValue/OptionValue
        /// 覆写，用自己类型的值调用 condition.Compare）。</summary>
        public virtual bool Satisfies(ComponentCondition condition)
        {
            return false;
        }

        // ---------- 上报触发（统一经主体枢纽） ----------

        /// <summary>向后台发送一条消息（JSON 自动序列化；统一经主体枢纽）。</summary>
        protected void SendToBackend(object message)
        {
            Hub?.SendToBackend(message);
        }

        /// <summary>把世界坐标换算为当前地图图片的归一化坐标（y 向下，左上角为原点；无枢纽时回退中心点）。</summary>
        protected Server.Position NormalizePosition(Vector3 worldPosition)
        {
            var hub = Hub;
            return hub != null ? hub.NormalizePosition(worldPosition) : new Server.Position { x = 0.5f, y = 0.5f };
        }
    }
}
