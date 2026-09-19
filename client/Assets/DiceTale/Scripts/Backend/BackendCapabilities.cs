using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 后台能力接口集合（组件模型）：
    /// <see cref="IBackendComponentData"/>（数据上报）与 <see cref="IBackendCommandHandler"/>（命令处理）
    /// 由 <see cref="BackendComponent"/> 基类实现，子类覆写；
    /// 条件比较由 <see cref="BackendComponent.Satisfies"/> 虚方法承载（值组件子类覆写），
    /// 配合 <see cref="ComponentCondition"/> 的单一 Compare 方法。
    /// </summary>

    /// <summary>
    /// 组件数据上报能力：组件把自己的参数（数据）填充到 GM 上报信息 <see cref="Server.ServerObjectInfo"/>。
    /// 由 <see cref="BackendComponent"/> 基类实现（默认空实现），有数据要上报的子类覆写，
    /// 只填自己负责的字段（OptionValue 填选项、Backpack 填道具、ItemExchange 填货源、MaskImage 填遮罩）。
    /// </summary>
    public interface IBackendComponentData
    {
        /// <summary>把本组件的参数填充到上报信息（只填自己负责的字段，其余保持默认）。</summary>
        void AppendToInfo(Server.ServerObjectInfo info);
    }

    /// <summary>
    /// 命令处理能力：组件自己处理对应后台命令（解析参数并执行），枢纽只做通用路由、分派器只做定位。
    /// 由 <see cref="BackendComponent"/> 基类实现（默认不处理任何命令），子类覆写声明并执行自己的命令：
    /// <see cref="OptionValue"/>（set_option）、<see cref="Backpack"/>（set_object_items）、
    /// <see cref="MaskImage"/>（set_mask_image / erase_mask）。
    /// </summary>
    public interface IBackendCommandHandler
    {
        /// <summary>是否处理该命令类型（后台消息 type，如 "set_option"）。</summary>
        bool CanHandle(string commandType);

        /// <summary>执行命令（msg 为后台消息字典，组件自己解析参数）；返回是否成功处理。</summary>
        bool HandleCommand(Dictionary<string, object> msg);
    }
}
