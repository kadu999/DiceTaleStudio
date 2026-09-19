using UnityEngine;
using UnityEngine.UI;
using UnityEditor;

namespace DiceTale
{
    /// <summary>
    /// 重建 PlayerPanel.prefab 的卡结构（2026-09-02，参考「玩家小卡 240×270」HTML）。
    ///
    /// 把整张卡的视觉结构写进 prefab（而不是运行时代码 new），prefab 编辑器里直接可见、可调。
    ///
    /// 每个 PlayerSlot_i 下生成：
    ///   BorderTop/Bottom/Left/Right        琥珀描边 2px（默认关闭，当前玩家时运行时启用）
    ///   Accent                             身份区左侧玩家色竖条（颜色运行时填）
    ///   Name / Role / Divider              名字 / 角色行（空占位）/ 分隔线
    ///   Content（容器，从身份区下沿到卡底）
    ///     TabRail                          纸深底分页栏（40px，贴 Content 左缘整高）
    ///     Tab_状态 / Tab_背包 / Tab_记录    分页按钮（Label + AmberBar）
    ///     PageTitle                        页标题
    ///     Page_状态 / Page_背包 / Page_记录 页容器（状态/记录空态；背包=行列表）
    ///     Page_背包/BackpackList           RectMask2D 行容器
    ///     .../ItemRowTemplate              隐藏行模板（运行时克隆）
    ///
    /// 坐标约定（关键，避免 RectTransform 的经典坑）：
    /// 一律直接写 offsetMin/offsetMax 两个序列化字段来定义矩形边缘——
    ///   rect.min = anchorMin*parentSize + offsetMin
    ///   rect.max = anchorMax*parentSize + offsetMax
    /// 不碰 sizeDelta / anchoredPosition / pivot（它们会被 offset 反算）。
    /// 卡内容宽 232 = 240 面板 - 2×4 缝；卡高随画布（4 等分），故纵向用「贴顶固定 px」或「贴底拉伸」。
    ///
    /// 用法：菜单 DiceTale/UI/重建 PlayerPanel 卡片结构（直接改写并保存 prefab 资产）。
    /// 运行时 PlayerSwitcherUI 只绑定 + 填数据 + 切页 + 高亮，不再创建节点。
    /// </summary>
    public static class PlayerPanelStructureBuilder
    {
        private const string PrefabPath = "Assets/DiceTale/Resources/PlayerPanel.prefab";
        private const float CardW = 232f; // 240 面板 - 2×4 缝

        // ---- 参考卡配色 ----
        private static readonly Color Paper = new Color(0.910f, 0.898f, 0.863f, 1f);       // #e8e5dc
        private static readonly Color PaperLight = new Color(0.945f, 0.937f, 0.914f, 1f);   // #f1efe9
        private static readonly Color PaperDeep = new Color(0.843f, 0.831f, 0.792f, 1f);    // #d7d4ca
        private static readonly Color Ink = new Color(0.125f, 0.149f, 0.161f, 1f);          // #202629
        private static readonly Color Muted = new Color(0.361f, 0.416f, 0.439f, 1f);        // #5c6a70
        private static readonly Color TealDark = new Color(0.153f, 0.424f, 0.439f, 1f);     // #276c70
        private static readonly Color Amber = new Color(0.835f, 0.647f, 0.278f, 1f);        // #D5A547
        private static readonly Color Hairline = new Color(0.125f, 0.149f, 0.161f, 0.22f);  // rgba(ink,.22)

        // ---- 布局常量（px，y 从卡顶向下）----
        private const float IdentityH = 62f;     // 身份区高（含分隔线）
        private const float RailW = 40f;         // 分页栏宽
        private const float PageTopInset = 26f;  // 页标题占位：页容器距 Content 顶
        private const float RowH = 26f;          // 背包行距（含 4px 间隔）
        private const float RowInnerH = 22f;     // 单行视觉高

        private static Font font;

        [MenuItem("DiceTale/UI/重建 PlayerPanel 卡片结构")]
        public static void RebuildPlayerPanel()
        {
            if (!AssetDatabase.LoadAssetAtPath<GameObject>(PrefabPath))
            {
                Debug.LogError($"[PlayerPanelStructureBuilder] prefab not found at {PrefabPath}");
                return;
            }

            var root = PrefabUtility.LoadPrefabContents(PrefabPath);
            try
            {
                Build(root.transform);
                PrefabUtility.SaveAsPrefabAsset(root, PrefabPath);
                Debug.Log("[PlayerPanelStructureBuilder] PlayerPanel 卡结构已重建并保存。");
            }
            finally
            {
                PrefabUtility.UnloadPrefabContents(root);
            }
        }

        private static void Build(Transform panelRoot)
        {
            var panelImage = panelRoot.GetComponent<Image>();
            if (panelImage != null)
            {
                panelImage.color = new Color(0.094f, 0.129f, 0.161f, 0.62f);
            }

            font = FindOrCreateFont(panelRoot);
            for (int i = 0; i < 4; i++)
            {
                var slot = panelRoot.Find($"PlayerSlot_{i}");
                if (slot == null)
                {
                    Debug.LogWarning($"[PlayerPanelStructureBuilder] PlayerSlot_{i} not found, skipped.");
                    continue;
                }

                // 槽位内缩出 4px 缝（原运行时做，现在写进 prefab）
                var rt = slot.GetComponent<RectTransform>();
                if (rt != null)
                {
                    rt.offsetMin = new Vector2(4f, 2f);
                    rt.offsetMax = new Vector2(-4f, -2f);
                }

                // 清空旧子结构
                for (int c = slot.childCount - 1; c >= 0; c--)
                {
                    Object.DestroyImmediate(slot.GetChild(c).gameObject);
                }

                BuildCard(slot);
            }
        }

        private static void BuildCard(Transform slot)
        {
            var slotImage = slot.GetComponent<Image>();
            if (slotImage != null)
            {
                slotImage.color = Paper;
                slotImage.raycastTarget = true;
            }

            // ---- 边框 ----
            CreateBorderStrip(slot, "BorderTop", new Vector2(0f, 1f), new Vector2(1f, 1f),
                new Vector2(0f, -2f), new Vector2(0f, 0f));
            CreateBorderStrip(slot, "BorderBottom", new Vector2(0f, 0f), new Vector2(1f, 0f),
                new Vector2(0f, 0f), new Vector2(0f, 2f));
            CreateBorderStrip(slot, "BorderLeft", new Vector2(0f, 0f), new Vector2(0f, 1f),
                new Vector2(0f, 0f), new Vector2(2f, 0f));
            CreateBorderStrip(slot, "BorderRight", new Vector2(1f, 0f), new Vector2(1f, 1f),
                new Vector2(-2f, 0f), new Vector2(0f, 0f));

            // ---- 身份区（贴卡顶，固定高；仿参考卡 identity-card：名字+职业同行 → 细线 → 资源行）----
            var accent = NewImage(slot, "Accent", Color.white); // 颜色运行时填
            TopLeftRect(accent.rectTransform, 0f, 0f, 5f, IdentityH);

            // 名字（大字，占左）——与职业同行（参考卡 identity-top：flex baseline，名字左职业右）
            var name = NewText(slot, "Name", string.Empty, 17, FontStyle.Bold, Ink, TextAnchor.MiddleLeft);
            TopLeftRect(name.rectTransform, 12f, 3f, 96f, 22f);

            // 职业（小字，跟名字同一行右侧；数据 PlayerStats.Role，暂无则空）
            var role = NewText(slot, "Role", string.Empty, 10, FontStyle.Normal, Muted, TextAnchor.MiddleRight);
            TopLeftRect(role.rectTransform, 116f, 3f, CardW - 128f, 22f);

            // 名字行下的细线（参考卡资源行顶的 border-top，与资源行之间）
            var divider = NewImage(slot, "Divider", Hairline);
            TopLeftRect(divider.rectTransform, 0f, 28f, CardW, 1f);

            // 资源行容器（仿参考卡 .resources：放身份区资源行的空容器，格子由运行时按
            // AttributeList group=identity 动态生成、均分排布）
            var resources = NewRect(slot, "Resources");
            TopLeftRect(resources, 2f, 33f, CardW - 4f, 16f);

            // ---- 内容区容器：身份区下沿到卡底 ----
            var content = NewRect(slot, "Content");
            FullStretch(content, 0f, 0f, IdentityH + 2f, 0f);

            // 分页栏（贴 Content 左缘、整高）
            var rail = NewImage(content, "TabRail", PaperDeep);
            LeftStretch(rail.rectTransform, RailW);

            // 分页按钮（3 个，竖排，靠 Content 顶）
            string[] pageNames = { "状态", "背包", "记录" };
            for (int p = 0; p < pageNames.Length; p++)
            {
                BuildTab(content, pageNames[p], p);
            }

            // 页标题
            var title = NewText(content, "PageTitle", "背包 · 0 件", 12, FontStyle.Bold, Ink, TextAnchor.MiddleLeft);
            TopLeftRect(title.rectTransform, RailW + 8f, 2f, CardW - RailW - 14f, 18f);

            // 页容器（标题下方右侧，贴 Content 底）
            BuildStatusPage(content, "Page_状态");
            BuildEmptyPage(content, "Page_记录");
            var backpackPage = BuildBackpackPage(content, "Page_背包");

            // 默认只开背包页
            backpackPage.gameObject.SetActive(true);
            content.Find("Page_状态").gameObject.SetActive(false);
            content.Find("Page_记录").gameObject.SetActive(false);
        }

        private static void BuildTab(RectTransform content, string pageName, int order)
        {
            var btnGo = new GameObject($"Tab_{pageName}", typeof(RectTransform), typeof(CanvasRenderer), typeof(Image));
            var btnRt = btnGo.GetComponent<RectTransform>();
            btnRt.SetParent(content, false);
            TopLeftRect(btnRt, 2f, 3f + order * RowH, RailW - 4f, RowInnerH);

            var bg = btnGo.GetComponent<Image>();
            bg.color = Color.clear; // 选中时运行时填 TealDark
            bg.raycastTarget = true;

            var label = NewText(btnRt, "Label", pageName, 11, FontStyle.Normal, Muted, TextAnchor.MiddleCenter);
            FullStretch(label.rectTransform, 0f, 0f, 0f, 0f);

            var bar = NewImage(btnRt, "AmberBar", Amber);
            LeftStretch(bar.rectTransform, 2.5f);
            bar.enabled = false; // 选中时启用

            var button = btnGo.AddComponent<Button>();
            button.transition = Selectable.Transition.None;
            button.targetGraphic = bg;
        }

        /// <summary>建一个空态页（居中「暂无数据」）。</summary>
        private static void BuildEmptyPage(RectTransform content, string pageName)
        {
            var page = NewRect(content, pageName);
            FullStretch(page, RailW + 3f, 3f, PageTopInset, 2f);

            var empty = NewText(page, "EmptyText", "暂无数据", 10, FontStyle.Normal, Muted, TextAnchor.MiddleCenter);
            FullStretch(empty.rectTransform, 0f, 0f, 0f, 0f);
        }

        /// <summary>
        /// 建状态页：只放一个内容根容器（StatusBody）。属性格 + 「常用检定」标题 + 检定格
        /// 全部由运行时 PlayerSwitcherUI 按玩家 AttributeList（group=attr / group=check）动态生成，
        /// 后台增删属性时 UI 自动跟上，无需重烘焙。
        /// </summary>
        private static void BuildStatusPage(RectTransform content, string pageName)
        {
            var page = NewRect(content, pageName);
            FullStretch(page, RailW + 3f, 3f, PageTopInset, 2f);

            var body = NewRect(page, "StatusBody");
            FullStretch(body, 0f, 0f, 0f, 0f);
        }

        /// <summary>建背包页：行列表 + 隐藏的行模板。</summary>
        private static RectTransform BuildBackpackPage(RectTransform content, string pageName)
        {
            var page = NewRect(content, pageName);
            FullStretch(page, RailW + 3f, 3f, PageTopInset, 2f);

            var list = NewRect(page, "BackpackList");
            FullStretch(list, 0f, 0f, 0f, 0f);
            list.gameObject.AddComponent<RectMask2D>();

            // 行模板（默认隐藏；整宽贴列表顶、行高固定；运行时克隆后按行下移 offset）
            var template = NewImage(list, "ItemRowTemplate", PaperLight);
            TopBandRect(template.rectTransform, 0f, RowInnerH);

            var bar = NewImage(template.transform, "TealBar", TealDark);
            LeftStretch(bar.rectTransform, 2.5f);

            var itemName = NewText(template.transform, "ItemName", string.Empty, 11, FontStyle.Bold, Ink, TextAnchor.MiddleLeft);
            FullStretch(itemName.rectTransform, 9f, 34f, 0f, 0f);

            var count = NewText(template.transform, "Count", string.Empty, 10, FontStyle.Normal, TealDark, TextAnchor.MiddleRight);
            FullStretch(count.rectTransform, 0f, 5f, 0f, 0f);

            template.gameObject.SetActive(false);
            return page;
        }

        // ---------- 矩形定位工具：只用 offsetMin/offsetMax 定义边缘 ----------
        // 约定：rect.min = anchorMin*parentSize + offsetMin；rect.max = anchorMax*parentSize + offsetMax。
        // 因此给定位好的锚点 + 两个 offset 向量，矩形就是确定的。

        /// <summary>锚点铺满父矩形 (0,0)-(1,1)，四边内缩 (l, r, t, b)。</summary>
        private static void FullStretch(RectTransform rt, float l, float r, float t, float b)
        {
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.offsetMin = new Vector2(l, b);
            rt.offsetMax = new Vector2(-r, -t);
        }

        /// <summary>贴父左上角、显式宽高：锚点并拢在父左上 (0,1)。x/yTop 从父左上角向右/向下。</summary>
        private static void TopLeftRect(RectTransform rt, float x, float yTop, float w, float h)
        {
            rt.anchorMin = new Vector2(0f, 1f);
            rt.anchorMax = new Vector2(0f, 1f);
            rt.offsetMin = new Vector2(x, -(yTop + h));
            rt.offsetMax = new Vector2(x + w, -yTop);
        }

        /// <summary>贴父左缘、纵向拉满、宽 w（锚点并拢在父左 (0,0)-(0,1)）。</summary>
        private static void LeftStretch(RectTransform rt, float w)
        {
            rt.anchorMin = new Vector2(0f, 0f);
            rt.anchorMax = new Vector2(0f, 1f);
            rt.offsetMin = new Vector2(0f, 0f);
            rt.offsetMax = new Vector2(w, 0f);
        }

        /// <summary>整宽横条：x 铺满 (0..1)，y 锚在父顶 (1)，从距顶 yTop 处向下 h（顶部横排/行用）。</summary>
        private static void TopBandRect(RectTransform rt, float yTop, float h)
        {
            rt.anchorMin = new Vector2(0f, 1f);
            rt.anchorMax = new Vector2(1f, 1f);
            rt.offsetMin = new Vector2(0f, -(yTop + h));
            rt.offsetMax = new Vector2(0f, -yTop);
        }

        // ---------- 对象创建 ----------

        private static RectTransform NewRect(Transform parent, string name)
        {
            var go = new GameObject(name, typeof(RectTransform));
            var rt = go.GetComponent<RectTransform>();
            rt.SetParent(parent, false);
            return rt;
        }

        private static Image NewImage(Transform parent, string name, Color color)
        {
            var go = new GameObject(name, typeof(RectTransform), typeof(CanvasRenderer), typeof(Image));
            go.transform.SetParent(parent, false);
            var image = go.GetComponent<Image>();
            image.color = color;
            image.raycastTarget = false;
            return image;
        }

        private static Text NewText(Transform parent, string name, string content, int size, FontStyle style, Color color, TextAnchor alignment)
        {
            var go = new GameObject(name, typeof(RectTransform), typeof(CanvasRenderer), typeof(Text));
            go.transform.SetParent(parent, false);
            var text = go.GetComponent<Text>();
            text.font = font;
            text.text = content;
            text.fontSize = size;
            text.fontStyle = style;
            text.color = color;
            text.alignment = alignment;
            text.raycastTarget = false;
            return text;
        }

        /// <summary>描边条：锚点给定贴边线，offset 把矩形推到边内 2px。</summary>
        private static void CreateBorderStrip(Transform slot, string name,
            Vector2 anchorMin, Vector2 anchorMax, Vector2 offsetMin, Vector2 offsetMax)
        {
            var go = new GameObject(name, typeof(RectTransform), typeof(CanvasRenderer), typeof(Image));
            go.transform.SetParent(slot, false);
            var rt = go.GetComponent<RectTransform>();
            rt.anchorMin = anchorMin;
            rt.anchorMax = anchorMax;
            rt.offsetMin = offsetMin;
            rt.offsetMax = offsetMax;
            var image = go.GetComponent<Image>();
            image.color = Amber;
            image.raycastTarget = false;
            image.enabled = false; // 仅当前玩家时启用
        }

        private static Font FindOrCreateFont(Transform panelRoot)
        {
            var old = panelRoot.Find("PlayerSlot_0/Name");
            if (old != null)
            {
                var t = old.GetComponent<Text>();
                if (t != null && t.font != null)
                {
                    return t.font;
                }
            }

            var f = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            if (f == null)
            {
                f = Resources.GetBuiltinResource<Font>("Arial.ttf");
            }

            return f;
        }
    }
}
