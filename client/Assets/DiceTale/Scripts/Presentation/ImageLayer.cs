using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// **贴图对象**的显示层（`kind: "Texture"`，协议组件 `ImageLayer`）：显示**整张图**。
    ///
    /// 它自己就是「把一张图铺在对象那块矩形上」这件事的全部——网格 / 材质 / 尺寸 / 离地
    /// 全在基类 <see cref="GroundLayer"/> 里，这里一个字节都不加：
    /// 取样矩形永远是整张（`(0,0,1,1)`），所以也不内缩纹素（没有邻格可渗）。
    ///
    /// 为什么不与 <see cref="SpriteLayer"/> 合成一个组件：编辑器侧「这个对象的图能不能取一格」
    /// 要有唯一判据，而那条判据就是**组件名**（文档侧同名函数是 `supportsSpriteSheet`）。
    /// 合成一个再挂个 `bool` 开关的话，「选择图片弹框给不给切分面板」与「这里到底会不会取一格」
    /// 迟早各说各话。
    ///
    /// **战争雾那一层也挂本组件**（`FogOfWar` 拿它当渲染器，贴一张 `RenderTexture`）——
    /// 所以基类的注释里说「地图与雾永远严丝合缝」。
    /// </summary>
    [DisallowMultipleComponent]
    public class ImageLayer : GroundLayer
    {
    }
}
