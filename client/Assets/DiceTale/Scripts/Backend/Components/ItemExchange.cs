using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 道具交换组件：场景中的道具货源（道具名 + 固定总数），GM 从这里把道具分配给玩家（也可收回）。
    /// 经 <see cref="BackendObject"/> 枢纽自动上报到 GM 页面：
    /// 上报的「数量」是固定总数，剩余（总数 − 玩家持有数）由 GM 页面即时推导；
    /// 客户端本地也维护剩余（remaining），GM 分配/收回命令（set_object_items）到达时刷新。
    /// 对象 ID 由枢纽统一提供（默认自动生成唯一 ID）。
    /// </summary>
    public class ItemExchange : BackendComponent
    {
        /// <summary>组件 ID（与客户端组件类同名，GM 面板据此渲染道具分配区）。</summary>
        public override string ComponentId => "ItemExchange";

        [SerializeField, Tooltip("道具名（GM 页面显示名，也是分配给玩家的物品名）")]
        private string itemName;

        [SerializeField, Tooltip("道具总数（固定库存；剩余 = 总数 - 所有玩家持有数）")]
        private int quantity = 1;

        [SerializeField, Tooltip("当前剩余（运行时自动计算更新，勿手动修改；GM 页面「剩余」即此值）")]
        private int remaining;

        /// <summary>道具名（不含数量，供 GM 页面分配道具使用）。</summary>
        public string ItemName => itemName;

        /// <summary>道具总数（固定库存），上报给 GM 页面；GM 页面据此推导剩余 = 总数 − 玩家持有数。</summary>
        public int ItemQuantity => quantity;

        /// <summary>组件数据上报：道具名与固定库存（GM 属性面板的道具分配区）。</summary>
        public override void AppendToInfo(Server.ServerObjectInfo info)
        {
            AppendData(info, new ExchangeData { itemName = itemName, quantity = quantity });
        }

        [System.Serializable]
        private class ExchangeData
        {
            public string itemName;
            public int quantity;
        }

        protected override void OnEnable()
        {
            base.OnEnable(); // 通知枢纽刷新能力组件列表（基类内置）

            // 地图重载/激活时按当前玩家持有量重算剩余（首次进入时玩家尚未持有，剩余 = 总数）
            RefreshQuantity();
        }

        /// <summary>重新计算剩余数量：总数 − 所有玩家已持有该道具的数量（客户端本地状态，随 GM 分配命令更新）；
        /// 剩余实际变化时触发基类 <see cref="BackendComponent.Changed"/>。</summary>
        public void RefreshQuantity()
        {
            var held = 0;
            var characterManager = Game.Instance != null ? Game.Instance.CharacterManager : null;
            if (characterManager != null && !string.IsNullOrEmpty(itemName))
            {
                foreach (var player in characterManager.Players)
                {
                    if (player == null)
                    {
                        continue;
                    }

                    var backpack = player.GetComponent<Backpack>();
                    if (backpack == null)
                    {
                        continue;
                    }

                    foreach (var item in backpack.Items)
                    {
                        if (item == itemName)
                        {
                            held++;
                        }
                    }
                }
            }

            var next = Mathf.Max(0, quantity - held);
            if (next == remaining)
            {
                return;
            }

            remaining = next;
            NotifyChanged();
        }

        /// <summary>刷新场景中所有道具交换组件的剩余数量并重新上报（玩家物品列表变化后调用）。</summary>
        public static void RefreshAllQuantities()
        {
            foreach (var item in Object.FindObjectsByType<ItemExchange>(FindObjectsSortMode.None))
            {
                item.RefreshQuantity();
            }

            var registry = Game.Instance != null ? Game.Instance.BackendRegistry : null; // 无宿主/宿主销毁中时经 Game 取不到，必须判空（防 NRE）
            if (registry != null)
            {
                registry.ReportAll(); // 剩余变化后重报，GM 页面同步显示
            }
        }
    }
}
