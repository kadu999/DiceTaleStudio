namespace NuLight.ProjectionAlignment
{
    /// <summary>一个游戏在投影装置上怎么给桌上的实物上色。由游戏定义 SO 配置，游戏自己的接管逻辑照它办。</summary>
    public enum PropColoringMode
    {
        /// <summary>不上色：主相机正交俯视、按物理尺寸取景，实物位置上照常画平面画面。</summary>
        None,

        /// <summary>接管相机（相机 = 投影仪）：主相机站在镜头位置 C，整个画面带透视；相机空间 UI 另由一台正交 Overlay 相机渲。</summary>
        TakeoverCamera,

        /// <summary>分层：主相机正交俯视渲地图与 UI；实物由 <see cref="PhysicalPropLayer"/> 连同整个场景一起渲、只在光线打到实物处合成。</summary>
        Layered,
    }
}
