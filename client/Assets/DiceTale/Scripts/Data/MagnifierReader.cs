using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>放大镜列表里的一条：一张图 + 可选的**一格**（`sprite` 为空 = 整张）。</summary>
    public sealed class MagnifierImage
    {
        /// <summary>资源逻辑 ID（交给取图加载器）。</summary>
        public string Id;

        /// <summary>要取的那一格；`null` = 整张图。</summary>
        public MirrorSprite Sprite;
    }

    /// <summary>
    /// 放大镜（协议 v21）在镜像里的**读取口径**：一条图片列表 + 「当前展示第几张」（下标）。
    ///
    /// 为什么单独一个类，而不是继续用泛型读取器（`ComponentData` + `JsonParser` 就地读、
    /// 像 `VideoBlend` 的两路那样）：那里读的是**一个对象的两项**，这里是**数组里的第 N 项**
    /// ——「N 落在不在范围内」是一条真实口径，而 `MirrorObject` 上的泛型读取器读不了这一层。
    /// 往 `MirrorObject` 加强类型字段 + 往 `SceneParser` 加解析行又会把「加新字段」的镜像税
    /// 带回来（见那里的「加新字段的规矩」）。所以这一小段单独收在一处：
    /// **`MirrorObject` 不动、`SceneParser` 不动**，命令路由（弹窗）与单元测试都从这里拿结果。
    ///
    /// 与编辑器那边 `magnifierTargetOf` / `magnifierImageOf` **同一口径**：
    /// 没挂组件 / 列表空 / `picked` 缺失或越界 → 没有可展示的图（前端据此明确拒掉 `open_magnifier`）。
    /// </summary>
    public static class MagnifierReader
    {
        /// <summary>
        /// 取「现在该展示的那一张」；没有可展示的图时返回 `false`（`image` 为 null）。
        /// </summary>
        public static bool TryPickImage(MirrorObject obj, out MagnifierImage image)
        {
            image = null;

            var data = obj != null ? obj.ComponentData(Protocol.ComponentType.Magnifier) : null;
            if (data == null)
            {
                return false;
            }

            var images = JsonParser.GetArray(data, "images");
            if (images == null || images.Count == 0)
            {
                return false;
            }

            // `picked` 是**下标**（缺省用 -1 兜底：缺失与越界同一条处理 = 「还没选」）
            var picked = (int)JsonParser.GetNumber(data, "picked", -1);
            if (picked < 0 || picked >= images.Count)
            {
                return false;
            }

            if (!(images[picked] is Dictionary<string, object> entry))
            {
                return false;
            }

            var id = JsonParser.GetString(entry, "id");
            if (string.IsNullOrEmpty(id))
            {
                return false;
            }

            image = new MagnifierImage { Id = id, Sprite = ReadSprite(entry) };
            return true;
        }

        /// <summary>
        /// 列表项里的那一格（`sprite` + `spriteGrid`）：与 `SceneParser.ParseSprite` 同一条口径
        /// （缺 `spriteGrid` 按 1×1 算、越界的格子夹到最后一格）。返回 `null` = 整张图。
        /// </summary>
        private static MirrorSprite ReadSprite(Dictionary<string, object> entry)
        {
            var cell = JsonParser.GetObject(entry, "sprite");
            if (cell == null)
            {
                return null;
            }

            var grid = JsonParser.GetObject(entry, "spriteGrid");
            var columns = Mathf.Max(1, grid == null ? 1 : (int)JsonParser.GetNumber(grid, "columns"));
            var rows = Mathf.Max(1, grid == null ? 1 : (int)JsonParser.GetNumber(grid, "rows"));

            return new MirrorSprite
            {
                columns = columns,
                rows = rows,
                column = Mathf.Clamp((int)JsonParser.GetNumber(cell, "column"), 0, columns - 1),
                row = Mathf.Clamp((int)JsonParser.GetNumber(cell, "row"), 0, rows - 1),
            };
        }
    }
}
