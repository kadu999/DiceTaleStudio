using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// **精灵对象**的显示层（`kind: "Sprite"`，协议组件 `SpriteLayer`）：只画**图集里的一格**。
    ///
    /// 与 <see cref="ImageLayer"/>（贴图对象，整张铺满）的区别只有一件事：**取样矩形**。
    /// 这里把数据里的「第几行第几列 + 几行几列」（`MirrorSprite`）换算成一块 UV，
    /// 并额外内缩半个纹素躲开邻格渗色；网格 / 材质 / 尺寸口径全部继承自基类。
    ///
    /// 为什么要分成两个组件（而不是一个组件加个开关）：编辑器侧「这个对象的图能不能取一格」
    /// 要有**唯一判据**——现在它就是「组件名是 `SpriteLayer` 还是 `ImageLayer`」
    /// （文档侧的同一条判据是 `@dts/document` 的 `supportsSpriteSheet`），
    /// 于是选择图片弹框给不给切分面板、属性面板显不显示子图那一行，全都跟着同一个事实走。
    ///
    /// **整张图也是合法状态**（`sprite == null` → UV 就是 `(0,0,1,1)`）：精灵还没挑格子时
    /// 显示整张图，与 v9 的行为逐字一样。
    /// </summary>
    [DisallowMultipleComponent]
    public class SpriteLayer : ImageLayer
    {
        /// <summary>
        /// 把「第几格」换算成 **UV 矩形**（全链路唯一一次 y 翻转，就这一处）。
        ///
        /// 服务端 / 文档里的格子是从**左上**数的（`row: 0` = 第一行，对齐 Unity 的 Sprite Editor），
        /// 而纹理的 UV 的 v 从**下**往上（0 = 图的最下面）——所以：
        ///
        /// ```
        /// u0 = column / columns          u1 = (column + 1) / columns
        /// v1 = 1 - row / rows            v0 = 1 - (row + 1) / rows
        /// ```
        ///
        /// 除法是**归一化**的（每格恰好 1/列、1/行），所以图片尺寸不是行列的整数倍时，
        /// 这里与服务端、与编辑器画布算出来的是同一块（谁都不取整像素）。
        /// </summary>
        public static Vector4 UvRectOf(MirrorSprite sprite)
        {
            if (sprite == null)
            {
                return FullUvRect;
            }

            var columns = Mathf.Max(1, sprite.columns);
            var rows = Mathf.Max(1, sprite.rows);
            var column = Mathf.Clamp(sprite.column, 0, columns - 1);
            var row = Mathf.Clamp(sprite.row, 0, rows - 1);

            return new Vector4(
                (float)column / columns,
                1f - (float)(row + 1) / rows,
                1f / columns,
                1f / rows);
        }

        /// <summary>
        /// 子图的 UV 再往里收半个纹素（避免双线性过滤把邻格的边渗进来）。
        ///
        /// 整张图（`(0,0,1,1)`）不动它：它外面没有别的格子。格子不到两个纹素宽 / 高时也不缩
        /// ——那会把 UV 缩成零宽（那种切分本身没有可采样的内容）。
        /// </summary>
        protected override Vector4 InsetUv(Vector4 uv, Texture texture)
        {
            if (texture == null || (uv.x == 0f && uv.y == 0f && uv.z == 1f && uv.w == 1f))
            {
                return uv;
            }

            var insetU = 0.5f / Mathf.Max(1, texture.width);
            var insetV = 0.5f / Mathf.Max(1, texture.height);
            if (uv.z <= insetU * 2f || uv.w <= insetV * 2f)
            {
                return uv;
            }

            return new Vector4(uv.x + insetU, uv.y + insetV, uv.z - insetU * 2f, uv.w - insetV * 2f);
        }
    }
}
