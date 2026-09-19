namespace DiceTale
{
    /// <summary>
    /// 后台对象类型（GM 页面展示与分类用，序列化在 BackendObject 枢纽上）。
    /// 新增类型时在末尾追加新值（不要插入中间），避免打乱已保存 prefab 中的序列化索引。
    /// </summary>
    public enum BackendObjectKind
    {
        /// <summary>场景物体（门、宝箱、拉杆等）；枢纽未配置类型时的默认值。</summary>
        SceneObject = 0,

        /// <summary>玩家（枢纽 kind=Player，实体 = BackendObject + Backpack）。</summary>
        Player = 1,

        /// <summary>道具（ItemExchange 道具交换组件）。</summary>
        Item = 2,

        /// <summary>事件（机关触发、遮罩等事件类对象；原 Mask 类别已并入）。</summary>
        Event = 3,
    }
}
