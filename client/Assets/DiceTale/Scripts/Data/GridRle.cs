using System.Collections.Generic;

namespace DiceTale
{
    /// <summary>
    /// 网格数据的 RLE 解码。
    ///
    /// 服务端（`@dts/grid` 的 `rle.ts`）把一片格子压成 `[[掩码, 连续格数], …]`，
    /// 掩码值与客户端的 <see cref="GridCellType"/> **完全一致**（0/1/2/4/8/16/32/64/128，可叠加），
    /// 所以解出来直接就能当 `GridCellType` 用。行序固定 `bottom-up`（第 0 行 = 世界 y 最小那行）。
    /// </summary>
    public static class GridRle
    {
        /// <summary>
        /// 解码 RLE。`expectedCount` &gt; 0 时结果会补齐 / 截断到该长度（服务端声明了格子总数，
        /// 数据比它短就补空格子、比它长就丢掉多余的），这样后面按行列取值永远不会越界。
        /// </summary>
        public static int[] Decode(List<object> runs, int expectedCount = 0)
        {
            var cells = new List<int>(expectedCount > 0 ? expectedCount : 0);
            if (runs != null)
            {
                foreach (var raw in runs)
                {
                    if (!(raw is List<object> pair) || pair.Count < 2)
                    {
                        continue;
                    }

                    var mask = (int)ToNumber(pair[0]);
                    var count = (int)ToNumber(pair[1]);
                    if (count <= 0)
                    {
                        continue;
                    }

                    // 掩码只保留 8 位（位掩码协议上限），脏数据不至于画出奇怪的东西
                    mask &= 0xFF;
                    for (var i = 0; i < count; i++)
                    {
                        cells.Add(mask);
                    }
                }
            }

            if (expectedCount > 0)
            {
                while (cells.Count < expectedCount)
                {
                    cells.Add(0);
                }

                if (cells.Count > expectedCount)
                {
                    cells.RemoveRange(expectedCount, cells.Count - expectedCount);
                }
            }

            return cells.ToArray();
        }

        /// <summary>把 JSON 数字数组摊平成 int[]（战争雾的 `regions` 用）。</summary>
        public static int[] FlattenInts(List<object> values)
        {
            if (values == null || values.Count == 0)
            {
                return new int[0];
            }

            var result = new int[values.Count];
            for (var i = 0; i < values.Count; i++)
            {
                result[i] = (int)ToNumber(values[i]);
            }

            return result;
        }

        private static double ToNumber(object value)
        {
            if (value is double d)
            {
                return d;
            }

            if (value is int i)
            {
                return i;
            }

            if (value is long l)
            {
                return l;
            }

            return 0d;
        }
    }
}
