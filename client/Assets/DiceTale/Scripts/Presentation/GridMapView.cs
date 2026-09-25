using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// **`GridMap` 协议组件在表现层的座位**：地图对象 GameObject 上那个收 <see cref="MirrorMap"/>
    /// 数据的组件（表现层与协议组件 1:1 对应的「组件袋」的一员，见 <see cref="SceneObjectView"/>）。
    ///
    /// 它现在**故意很薄**：只有一份数据引用 + 一个收下它的方法。但这份薄是有意的——
    /// 表现层对每个实体协议组件**有且只有一个**对应 C# 组件，格子数据的展示层入口**只有这一处**：
    /// <see cref="FogOfWar"/> 从这里取格子算雾区，以后要画的**网格线**也落在这里，
    /// 不会出现「第三处又抓了一份 map 数据」的第二真相。
    ///
    /// 数据本身仍归镜像（<see cref="MirrorObject.map"/>）：这里不拷格子、不解析，
    /// 只是把「这份数据是**现在生效的**」这个事实挂在对象自己身上——组件在，数据在；
    /// 组件被摘（对象不再是地图），数据自然也没了。
    /// </summary>
    [DisallowMultipleComponent]
    public class GridMapView : MonoBehaviour
    {
        /// <summary>当前生效的地图数据（每次对象推送都会 <see cref="Adopt"/> 刷成最新一份）。</summary>
        public MirrorMap Map { get; private set; }

        /// <summary>
        /// 收下这份地图数据（每次对象推送都调；**幂等**，同一份再收一遍没有副作用）。
        ///
        /// 对象没挂 `GridMap` 组件时 <see cref="SceneObjectView"/> 根本不会建这个组件，
        /// 所以这里收到的要么是合法数据、要么是「组件刚被摘掉」的 `null`（后者让
        /// <see cref="FogOfWar"/> 知道格子没了，把雾层拆掉）。
        /// </summary>
        public void Adopt(MirrorMap map)
        {
            Map = map;
        }
    }
}
