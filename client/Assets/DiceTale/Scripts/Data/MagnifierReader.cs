using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 放大镜里**一个状态**（协议 v22 起）：一屏画面 = 标题（上面）+ 图（左）+ 文字（右）。
    /// 三项都可以没有——**只要有一项就有东西可展示**（纯文字 / 只有标题的线索卡是常见用法）。
    /// </summary>
    public sealed class MagnifierStateView
    {
        /// <summary>上面那行标题；空 = 没有标题（那一行不显示）。</summary>
        public string Title = "";

        /// <summary>右边那段文字描述（多行纯文本，换行照原样）；空 = 没有文字。</summary>
        public string Text = "";

        /// <summary>左边那张图的资源逻辑 ID（交给取图加载器）；**空 = 这一屏没有图**。</summary>
        public string Id;

        /// <summary>要取的那一格；`null` = 整张图。</summary>
        public MirrorSprite Sprite;
    }

    /// <summary>
    /// 放大镜（协议 v21 起；v22 起数据是**状态列表**）在镜像里的**读取口径**：
    /// 一条状态列表 + 「当前展示第几个」（下标）。
    ///
    /// 为什么单独一个类，而不是继续用泛型读取器（`ComponentData` + `JsonParser` 就地读、
    /// 像 `VideoBlend` 的两路那样）：那里读的是**一个对象的两项**，这里是**数组里的第 N 项**
    /// ——「N 落在不在范围内」是一条真实口径，而 `MirrorObject` 上的泛型读取器读不了这一层。
    /// 往 `MirrorObject` 加强类型字段 + 往 `SceneParser` 加解析行又会把「加新字段」的镜像税
    /// 带回来（见那里的「加新字段的规矩」）。所以这一小段单独收在一处：
    /// **`MirrorObject` 不动、`SceneParser` 不动**，命令路由（弹窗）与单元测试都从这里拿结果。
    ///
    /// 与编辑器那边 `magnifierStateOf` / `magnifierStateIsEmpty` **同一口径**：
    /// 没挂组件 / 列表空 / `picked` 缺失或越界 / **选中的那个状态三项全空** → 展示不出来
    /// （前端据此明确拒掉 `open_magnifier`）。**没有图不算**——纯文字 / 只有标题的线索卡照放。
    /// </summary>
    public static class MagnifierReader
    {
        /// <summary>
        /// 取「现在该展示的那一个状态」；没有可展示的东西时返回 `false`（`state` 为 null）。
        ///
        /// 「三项全空才展示不出来」这条与编辑器逐字对齐（`magnifierStateIsEmpty`）：
        /// 有图、有标题、有文字，任意一项就够了。`Id` 为空表示这一屏**没有图**
        /// （窗口那边会把图那一格收掉、让文字铺满整行）。
        /// </summary>
        public static bool TryPickState(MirrorObject obj, out MagnifierStateView state)
        {
            state = null;

            var data = obj != null ? obj.ComponentData(Protocol.ComponentType.Magnifier) : null;
            if (data == null)
            {
                return false;
            }

            var states = JsonParser.GetArray(data, "states");
            if (states == null || states.Count == 0)
            {
                return false;
            }

            // `picked` 是**下标**（缺省用 -1 兜底：缺失与越界同一条处理 = 「还没选」）
            var picked = (int)JsonParser.GetNumber(data, "picked", -1);
            if (picked < 0 || picked >= states.Count)
            {
                return false;
            }

            if (!(states[picked] is Dictionary<string, object> entry))
            {
                return false;
            }

            // 图住在 `image` 里（空状态槽 / 只有文字的状态没有它）
            var image = JsonParser.GetObject(entry, "image");
            var id = image == null ? null : JsonParser.GetString(image, "id");
            var title = JsonParser.GetString(entry, "title") ?? "";
            var text = JsonParser.GetString(entry, "text") ?? "";

            // 三项全空 = 一张空卡：投上去什么也看不见，明确拒掉
            if (string.IsNullOrEmpty(id) && string.IsNullOrEmpty(title) && string.IsNullOrEmpty(text))
            {
                return false;
            }

            state = new MagnifierStateView
            {
                Title = title,
                Text = text,
                Id = id ?? "",
                Sprite = image == null ? null : ReadSprite(image),
            };
            return true;
        }

        /// <summary>
        /// 那条图引用里的那一格（`sprite` + `spriteGrid`）：与 `SceneParser.ParseSprite` 同一条口径
        /// （缺 `spriteGrid` 按 1×1 算、越界的格子夹到最后一格）。返回 `null` = 整张图。
        /// </summary>
        private static MirrorSprite ReadSprite(Dictionary<string, object> image)
        {
            var cell = JsonParser.GetObject(image, "sprite");
            if (cell == null)
            {
                return null;
            }

            var grid = JsonParser.GetObject(image, "spriteGrid");
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
