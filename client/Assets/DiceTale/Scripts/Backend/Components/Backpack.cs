using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 背包组件：存储道具（道具名列表，同名重复表示数量）。
    /// 供玩家等持有道具的物体使用（容器也可挂）。
    /// 继承 <see cref="BackendComponent"/>，与 <see cref="BackendObject"/> 枢纽挂同一物体：
    /// 初始化时由枢纽统一上报（IBackendComponentData），之后道具数据由后台 set_object_items 命令修改，前端不回执。
    /// </summary>
    public class Backpack : BackendComponent
    {
        /// <summary>组件 ID（与客户端组件类同名，GM 面板据此渲染物品编辑区）。</summary>
        public override string ComponentId => "Backpack";

        private readonly List<string> items = new List<string>();

        /// <summary>道具列表（只读视图；由后台命令修改）。</summary>
        public IReadOnlyList<string> Items => items;

        /// <summary>组件数据上报（初始化）：道具列表（GM 属性面板的物品编辑区）。</summary>
        public override void AppendToInfo(Server.ServerObjectInfo info)
        {
            AppendData(info, new BackpackData { items = new List<string>(items) });
        }

        [System.Serializable]
        private class BackpackData
        {
            public List<string> items;
        }

        /// <summary>命令处理：set_object_items（道具列表由本组件自己解析并执行）。</summary>
        public override bool CanHandle(string commandType) => commandType == "set_object_items";

        public override bool HandleCommand(Dictionary<string, object> msg)
        {
            // 缺 items 字段 = 拒绝执行（避免协议漏发/字段改名把背包误清空；
            // 「空数组 = 清空」仅限显式下发，两者语义分开）
            var rawItems = Server.JsonParser.GetArray(msg, "items");
            if (rawItems == null)
            {
                Debug.LogWarning("[Backpack] set_object_items 缺少 items 字段，已拒绝执行（避免背包被误清空）");
                return false;
            }

            var newItems = new List<string>();
            foreach (var raw in rawItems)
            {
                if (raw is string s)
                {
                    newItems.Add(s);
                }
                else
                {
                    Debug.LogWarning($"[Backpack] set_object_items 含非字符串项，已跳过: {raw}");
                }
            }

            SetItems(newItems);
            return true;
        }

        /// <summary>添加道具（重复添加忽略；本地修改，不回执）；实际添加时触发 <see cref="BackendComponent.Changed"/>。</summary>
        public void AddItem(string item)
        {
            if (string.IsNullOrEmpty(item) || items.Contains(item))
            {
                return;
            }

            items.Add(item);
            NotifyChanged();
            ItemExchange.RefreshAllQuantities(); // 玩家持有变化：刷新场景道具货源的「剩余」并重报（GM 页同步）
        }

        /// <summary>移除道具（不存在时无操作；本地修改，不回执）；实际移除时触发 <see cref="BackendComponent.Changed"/>。</summary>
        public void RemoveItem(string item)
        {
            if (items.Remove(item))
            {
                NotifyChanged();
                ItemExchange.RefreshAllQuantities(); // 玩家持有变化：刷新场景道具货源的「剩余」并重报（GM 页同步）
            }
        }

        /// <summary>整体设置道具列表（后台 set_object_items 命令经枢纽路由调用；本地修改，不回执）；
        /// 列表实际变化时触发 <see cref="BackendComponent.Changed"/>。</summary>
        public void SetItems(IEnumerable<string> newItems)
        {
            var next = new List<string>();
            if (newItems != null)
            {
                next.AddRange(newItems);
            }

            if (ItemsEqual(items, next))
            {
                return;
            }

            items.Clear();
            items.AddRange(next);
            NotifyChanged();
            ItemExchange.RefreshAllQuantities(); // 玩家持有变化：刷新场景道具货源的「剩余」并重报（GM 页同步）
        }

        /// <summary>两个道具列表是否完全一致（顺序敏感；一致时不触发变更通知）。</summary>
        private static bool ItemsEqual(List<string> a, List<string> b)
        {
            if (a.Count != b.Count)
            {
                return false;
            }

            for (int i = 0; i < a.Count; i++)
            {
                if (a[i] != b[i])
                {
                    return false;
                }
            }

            return true;
        }
    }
}
