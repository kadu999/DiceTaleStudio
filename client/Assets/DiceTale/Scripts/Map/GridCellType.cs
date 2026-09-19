namespace DiceTale
{
    /// <summary>
    /// 格子类型（位掩码，可组合）。0=空 1=障碍 2=困难 4=水 8~128=雾1~雾5（浓度递增）。
    /// 一个格子可以同时拥有多个位，例如 Obstacle | Fog1 表示既是阻挡点又是雾点。
    /// 枚举值即掩码值，可直接 (int) 转换，无需再映射。
    /// </summary>
    [System.Flags]
    public enum GridCellType
    {
        Empty = 0,
        Obstacle = 1,
        Difficult = 2,
        Water = 4,
        Fog1 = 8,
        Fog2 = 16,
        Fog3 = 32,
        Fog4 = 64,
        Fog5 = 128,
    }
}
