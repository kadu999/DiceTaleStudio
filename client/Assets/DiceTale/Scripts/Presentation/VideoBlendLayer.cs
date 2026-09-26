using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 视频混合那一层的渲染器：与 <see cref="ImageLayer"/> 同源（同一个 <see cref="GroundLayer"/>
    /// 的网格 / 尺寸 / 离地 / 生命周期），只把 shader 换成 `DiceTale/VideoBlend`——
    /// 两张视频（A 盖住 / B 擦开露出）+ 一张 Mask 逐像素混合。
    ///
    /// 它自己不认识视频：两张 `RenderTexture` 与 Mask 纹理都由 <see cref="VideoBlend"/> 塞进材质。
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class VideoBlendLayer : GroundLayer
    {
        protected override string ShaderName => "DiceTale/VideoBlend";
    }
}
