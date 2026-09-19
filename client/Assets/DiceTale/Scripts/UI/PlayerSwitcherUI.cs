using System.Collections.Generic;
using System.Text;
using UnityEngine;
using UnityEngine.UI;

namespace DiceTale
{
    /// <summary>
    /// 玩家信息面板（继承 <see cref="UIWindow"/>，由 UIManager 统一管理；挂在 Resources/PlayerPanel 预制体根节点上，
    /// 可通过 UIManager.OpenWindow&lt;PlayerSwitcherUI&gt;("PlayerPanel") 打开）。
    /// 注意：目前默认不常驻——不创建面板时本组件不会挂载运行。
    ///
    /// 2026-09-02 重构（参考「玩家小卡 240×270」HTML）：卡的**视觉结构全部烘焙在 prefab 里**
    /// （由 Editor 工具 PlayerPanelStructureBuilder 生成），本脚本**只绑定 + 填数据**，不再运行时创建节点。
    ///
    /// prefab 里每个 PlayerSlot_i 的约定结构（按名字查找）：
    ///   BorderTop/Bottom/Left/Right   当前玩家琥珀描边（默认关闭）
    ///   Accent                       身份区左侧玩家色竖条
    ///   Name / Role                  名字 / 角色行（Role 暂无数据留空）
    ///   Divider                      分隔线
    ///   Content/TabRail              纸深底分页栏（40px 左栏）
    ///   Content/Tab_状态|背包|记录    分页按钮（子级 Label + AmberBar）
    ///   Content/PageTitle            页标题
    ///   Content/Page_状态|背包|记录   三个页容器（状态/记录含 EmptyText 空态）
    ///   Content/Page_背包/BackpackList/ItemRowTemplate  行模板（隐藏，运行时克隆）
    ///
    /// 行为：点击卡片本体 = 切换当前玩家；点分页按钮只切页；当前玩家整卡琥珀描边。
    /// </summary>
    public class PlayerSwitcherUI : UIWindow
    {
        [SerializeField, Tooltip("最大显示玩家数（对应预制体里的格子数）")]
        private int m_MaxPlayers = 4;

        [SerializeField, Tooltip("面板背景色（应用到根 Image；参考卡外的夜色衬底）")]
        private Color m_PanelColor = new Color(0.094f, 0.129f, 0.161f, 0.62f);

        [SerializeField, Tooltip("空槽位（无玩家）底色")]
        private Color m_EmptyColor = new Color(0f, 0f, 0f, 0.2f);

        // ---- 运行时切换用的选中态配色（与 prefab 初始态一致）----
        private static readonly Color Muted = new Color(0.361f, 0.416f, 0.439f, 1f);
        private static readonly Color TealDark = new Color(0.153f, 0.424f, 0.439f, 1f);
        private static readonly Color Ink = new Color(0.125f, 0.149f, 0.161f, 1f);

        private static readonly string[] PageNames = { "状态", "背包", "记录" };

        // ---- 参考卡配色（动态格子用）----
        private static readonly Color PaperLight = new Color(0.945f, 0.937f, 0.914f, 1f);   // #f1efe9
        private static readonly Color Paper = new Color(0.910f, 0.898f, 0.863f, 1f);       // #e8e5dc
        private static readonly Color Hairline = new Color(0.125f, 0.149f, 0.161f, 0.22f);  // rgba(ink,.22)

        /// <summary>动态格子字体（烘焙 Text 继承的内置字体；运行时动态建格用同一份）。</summary>
        private static Font dynamicFont;

        /// <summary>一张卡运行时的引用集合。</summary>
        private class CardRefs
        {
            public RectTransform Slot;
            public Image SlotImage;
            public Button SlotButton;
            public Image Accent;
            public Image[] BorderStrips = new Image[4];
            public Text NameText;
            public Text RoleText;
            public Text PageTitle;
            public Image[] TabBgs = new Image[3];
            public Image[] TabAmberBars = new Image[3];
            public Text[] TabLabels = new Text[3];
            public RectTransform[] Pages = new RectTransform[3];
            public RectTransform Resources;   // 身份区资源行容器（group=identity，运行时建格）
            public RectTransform StatusBody;  // 状态页内容根（属性格+检定标题+检定格，运行时建）
            public RectTransform BackpackList;
            public RectTransform RowTemplate;
            public Page CurrentPage = Page.Backpack;
            public string CachedItems = string.Empty;
            public int RowCount; // 当前行数（Destroy 延迟到帧末，不能用 childCount 数）
            public string CachedAttrs = string.Empty; // 属性表缓存串（变化才重建格）
        }

        private enum Page
        {
            Status = 0,
            Backpack = 1,
            Records = 2
        }

        private readonly List<CardRefs> cards = new List<CardRefs>();
        private int lastPlayerCount = -1;
        private int lastCurrentIndex = -1;
        private bool bound;

        private void Start()
        {
            BindSlots();
        }

        private void Update()
        {
            if (!bound)
            {
                return;
            }

            var manager = Game.Instance != null ? Game.Instance.CharacterManager : null;
            if (manager == null)
            {
                return;
            }

            if (manager.Players.Count != lastPlayerCount)
            {
                RefreshSlots();
            }

            if (manager.CurrentPlayerIndex != lastCurrentIndex)
            {
                lastCurrentIndex = manager.CurrentPlayerIndex;
                RefreshHighlight();
            }

            RefreshItemsIfChanged(manager);
            RefreshAttrsIfChanged(manager);
        }

        /// <summary>按 prefab 约定名字绑定槽位里的节点，挂点击回调。</summary>
        private void BindSlots()
        {
            var rootImage = GetComponent<Image>();
            if (rootImage != null)
            {
                rootImage.color = m_PanelColor;
            }

            for (int i = 0; i < m_MaxPlayers; i++)
            {
                var slot = transform.Find($"PlayerSlot_{i}");
                if (slot == null)
                {
                    Debug.LogWarning($"[PlayerSwitcherUI] PlayerSlot_{i} not found in prefab, stop binding.");
                    break;
                }

                // 首次绑定从卡内 Name 文本继承字体（动态格子与烘焙文本同字体）
                if (dynamicFont == null)
                {
                    var nameRef = slot.Find("Name")?.GetComponent<Text>();
                    if (nameRef != null)
                    {
                        dynamicFont = nameRef.font;
                    }
                }

                var card = new CardRefs
                {
                    Slot = slot.GetComponent<RectTransform>(),
                    SlotImage = slot.GetComponent<Image>(),
                    SlotButton = slot.GetComponent<Button>()
                };
                if (card.Slot == null || card.SlotImage == null || card.SlotButton == null)
                {
                    Debug.LogWarning($"[PlayerSwitcherUI] PlayerSlot_{i} missing RectTransform/Image/Button, stop binding.");
                    break;
                }

                // 边框
                string[] borders = { "BorderTop", "BorderBottom", "BorderLeft", "BorderRight" };
                bool ok = true;
                for (int b = 0; b < borders.Length; b++)
                {
                    var child = slot.Find(borders[b]);
                    if (child == null)
                    {
                        ok = false;
                        break;
                    }

                    card.BorderStrips[b] = child.GetComponent<Image>();
                }

                // 身份区
                var accent = slot.Find("Accent");
                var nameText = slot.Find("Name");
                var roleText = slot.Find("Role");
                if (!ok || accent == null || nameText == null || roleText == null)
                {
                    Debug.LogWarning($"[PlayerSwitcherUI] PlayerSlot_{i} structure incomplete (borders/accent/name/role). Run DiceTale/UI/重建 PlayerPanel 卡片结构.");
                    break;
                }

                card.Accent = accent.GetComponent<Image>();
                card.NameText = nameText.GetComponent<Text>();
                card.RoleText = roleText.GetComponent<Text>();
                card.NameText.raycastTarget = false;

                // 身份区资源行容器（格子运行时按 AttributeList group=identity 动态生成）
                card.Resources = slot.Find("Resources") as RectTransform;

                // 内容区
                var content = slot.Find("Content");
                if (content == null)
                {
                    Debug.LogWarning($"[PlayerSwitcherUI] PlayerSlot_{i} missing Content. Run DiceTale/UI/重建 PlayerPanel 卡片结构.");
                    break;
                }

                card.PageTitle = content.Find("PageTitle")?.GetComponent<Text>();

                // 分页按钮
                for (int p = 0; p < PageNames.Length; p++)
                {
                    var tab = content.Find($"Tab_{PageNames[p]}");
                    if (tab == null)
                    {
                        ok = false;
                        break;
                    }

                    card.TabBgs[p] = tab.GetComponent<Image>();
                    card.TabLabels[p] = tab.Find("Label")?.GetComponent<Text>();
                    card.TabAmberBars[p] = tab.Find("AmberBar")?.GetComponent<Image>();

                    int captured = p;
                    tab.GetComponent<Button>().onClick.AddListener(() => SetPage(card, (Page)captured));
                }

                // 页容器
                for (int p = 0; p < PageNames.Length; p++)
                {
                    card.Pages[p] = content.Find($"Page_{PageNames[p]}") as RectTransform;
                }

                var pageBackpack = content.Find($"Page_{PageNames[(int)Page.Backpack]}");
                card.BackpackList = pageBackpack?.Find("BackpackList") as RectTransform;
                card.RowTemplate = card.BackpackList != null ? card.BackpackList.Find("ItemRowTemplate") as RectTransform : null;

                // 状态页内容根（属性格 + 检定标题 + 检定格，运行时按 AttributeList 动态生成）
                var statusPage = card.Pages[(int)Page.Status];
                card.StatusBody = statusPage != null ? statusPage.Find("StatusBody") as RectTransform : null;

                if (!ok || card.PageTitle == null || card.Pages[(int)Page.Backpack] == null || card.BackpackList == null || card.RowTemplate == null
                    || card.StatusBody == null)
                {
                    Debug.LogWarning($"[PlayerSwitcherUI] PlayerSlot_{i} incomplete content. Run DiceTale/UI/重建 PlayerPanel 卡片结构.");
                    break;
                }

                // 整卡点击 = 切换当前玩家（分页按钮会拦截自己的点击）
                int capturedIndex = i;
                card.SlotButton.onClick.AddListener(() =>
                {
                    var mgr = Game.Instance != null ? Game.Instance.CharacterManager : null;
                    if (mgr != null && capturedIndex < mgr.Players.Count)
                    {
                        mgr.SetCurrentPlayer(capturedIndex);
                    }
                });

                cards.Add(card);
            }

            bound = cards.Count > 0;
            if (!bound)
            {
                Debug.LogWarning("[PlayerSwitcherUI] No slots bound, player panel disabled.");
                return;
            }

            RefreshSlots();
            for (int i = 0; i < cards.Count; i++)
            {
                SetPage(cards[i], Page.Backpack);
            }
        }

        /// <summary>切页：按钮高亮 + 页容器显隐 + 标题。</summary>
        private void SetPage(CardRefs card, Page page)
        {
            card.CurrentPage = page;
            for (int i = 0; i < card.TabBgs.Length; i++)
            {
                bool selected = i == (int)page;
                card.TabBgs[i].color = selected ? TealDark : Color.clear;
                card.TabAmberBars[i].enabled = selected;
                if (card.TabLabels[i] != null)
                {
                    card.TabLabels[i].color = selected ? Color.white : Muted;
                    card.TabLabels[i].fontStyle = selected ? FontStyle.Bold : FontStyle.Normal;
                }
            }

            for (int i = 0; i < card.Pages.Length; i++)
            {
                if (card.Pages[i] != null)
                {
                    card.Pages[i].gameObject.SetActive(i == (int)page);
                }
            }

            UpdatePageTitle(card);
        }

        private void UpdatePageTitle(CardRefs card)
        {
            if (card.PageTitle == null)
            {
                return;
            }

            if (card.CurrentPage == Page.Status)
            {
                card.PageTitle.text = "状态 · 属性/检定";
            }
            else if (card.CurrentPage == Page.Backpack)
            {
                card.PageTitle.text = $"背包 · {card.RowCount} 件";
            }
            else
            {
                card.PageTitle.text = PageNames[(int)card.CurrentPage];
            }
        }

        /// <summary>玩家数量变化时全量刷新：名字/角色/属性/可用态。</summary>
        private void RefreshSlots()
        {
            var manager = Game.Instance != null ? Game.Instance.CharacterManager : null;
            lastPlayerCount = manager != null ? manager.Players.Count : 0;
            lastCurrentIndex = manager != null ? manager.CurrentPlayerIndex : 0;

            for (int i = 0; i < cards.Count; i++)
            {
                var card = cards[i];
                var player = manager != null && i < manager.Players.Count ? manager.Players[i] : null;
                var stats = player != null ? player.GetComponent<PlayerStats>() : null;
                // 名字：角色名优先（PlayerStats.DisplayName），空回退 GM 的 Player_N
                card.NameText.text = player != null ? (stats != null && !string.IsNullOrEmpty(stats.DisplayName) ? stats.DisplayName : player.DisplayName) : string.Empty;
                card.NameText.color = player != null ? CharacterManager.GetPlayerColor(i) : Ink;
                card.RoleText.text = stats != null ? stats.Role : string.Empty; // 职业（PlayerStats.Role）

                FillAttributes(card, player);
                RebuildBackpackRows(card, player);
            }

            RefreshHighlight();
        }

        /// <summary>按 AttributeList 动态生成三区（身份区资源行 / 状态页属性+检定）。
        /// 属性表变了（缓存串比对）才重建，避免每帧重建。</summary>
        private static void FillAttributes(CardRefs card, BackendObject player)
        {
            var list = player != null ? player.GetComponent<AttributeList>() : null;
            var cache = BuildAttrCache(list);
            if (cache == card.CachedAttrs)
            {
                return;
            }

            card.CachedAttrs = cache;
            if (list == null)
            {
                return;
            }

            BuildResourceCells(card.Resources, list.GetByGroup("identity"));
            BuildStatusContent(card.StatusBody, list.GetByGroup("attr"), list.GetByGroup("check"));
        }

        /// <summary>属性表摘要串（key=值 连接），用于判断是否变化。</summary>
        private static string BuildAttrCache(AttributeList list)
        {
            if (list == null)
            {
                return string.Empty;
            }

            var sb = new System.Text.StringBuilder();
            foreach (var entry in list.Attributes)
            {
                sb.Append(entry.Key).Append('=').Append(entry.Value).Append('|');
            }

            return sb.ToString();
        }

        /// <summary>身份区资源行：每格「label 小字 + value 粗体」横排，均分容器宽。</summary>
        private static void BuildResourceCells(RectTransform container, List<AttributeEntry> entries)
        {
            if (container == null)
            {
                return;
            }

            ClearChildren(container);
            if (entries == null || entries.Count == 0)
            {
                return;
            }

            float n = entries.Count;
            for (int i = 0; i < entries.Count; i++)
            {
                var entry = entries[i];
                var cellGo = new GameObject("Res_" + entry.Key, typeof(RectTransform), typeof(CanvasRenderer));
                cellGo.transform.SetParent(container, false);
                var cellRt = (RectTransform)cellGo.transform;
                // 比例锚点均分：第 i 格占 [i/n, (i+1)/n] 宽、整高，offset 归零
                cellRt.anchorMin = new Vector2(i / n, 0f);
                cellRt.anchorMax = new Vector2((i + 1) / n, 1f);
                cellRt.offsetMin = Vector2.zero;
                cellRt.offsetMax = Vector2.zero;

                var label = MakeText(cellRt, "Label", entry.Key, 10, FontStyle.Normal, Muted, TextAnchor.MiddleLeft);
                var labelRt = (RectTransform)label.transform;
                labelRt.anchorMin = Vector2.zero;
                labelRt.anchorMax = new Vector2(0.5f, 1f);
                labelRt.offsetMin = Vector2.zero;
                labelRt.offsetMax = Vector2.zero;

                var value = MakeText(cellRt, "Value", entry.DisplayText, 12, FontStyle.Bold, Ink, TextAnchor.MiddleRight);
                var valueRt = (RectTransform)value.transform;
                valueRt.anchorMin = new Vector2(0.5f, 0f);
                valueRt.anchorMax = Vector2.one;
                valueRt.offsetMin = Vector2.zero;
                valueRt.offsetMax = Vector2.zero;
            }
        }

        /// <summary>状态页内容：属性格（4 列竖排）→「常用检定」标题 → 检定格（2 列横排）。
        /// 全部动态生成，后台增删属性自动跟上。</summary>
        private static void BuildStatusContent(RectTransform body, List<AttributeEntry> attrs, List<AttributeEntry> checks)
        {
            if (body == null)
            {
                return;
            }

            ClearChildren(body);
            float w = body.rect.width;
            float gap = 3f;
            float y = 0f;

            // 属性格：4 列竖排
            if (attrs != null && attrs.Count > 0)
            {
                int cols = 4;
                float colW = (w - gap * (cols - 1)) / cols;
                float rowH = 26f;
                int rows = Mathf.CeilToInt(attrs.Count / (float)cols);
                for (int i = 0; i < attrs.Count; i++)
                {
                    int col = i % cols;
                    int row = i / cols;
                    MakeStatusCell(body, "Attr_" + attrs[i].Key, attrs[i], col * (colW + gap), y + row * (rowH + gap), colW, rowH, true);
                }

                y += rows * (rowH + gap) + 2f;
            }

            // 「常用检定」标题 + 检定格：2 列横排
            if (checks != null && checks.Count > 0)
            {
                var heading = MakeText(body, "CheckHeading", "常用检定", 10, FontStyle.Bold, Muted, TextAnchor.MiddleLeft);
                PlaceTop((RectTransform)heading.transform, 0f, y, w, 14f);
                y += 17f;

                int cols = 2;
                float colW = (w - gap) / cols;
                float rowH = 24f;
                for (int i = 0; i < checks.Count; i++)
                {
                    int col = i % cols;
                    int row = i / cols;
                    MakeStatusCell(body, "Check_" + checks[i].Key, checks[i], col * (colW + gap), y + row * (rowH + gap), colW, rowH, false);
                }
            }
        }

        /// <summary>建一个属性/检定格：纸浅底 + 青绿条 + Label/Value（竖排或横排）。</summary>
        private static void MakeStatusCell(RectTransform body, string nodeName, AttributeEntry entry,
            float x, float yTop, float w, float h, bool vertical)
        {
            var cellGo = new GameObject(nodeName, typeof(RectTransform), typeof(CanvasRenderer), typeof(Image));
            cellGo.transform.SetParent(body, false);
            var cellImage = cellGo.GetComponent<Image>();
            cellImage.color = PaperLight;
            cellImage.raycastTarget = false;
            var cellRt = (RectTransform)cellGo.transform;
            PlaceTop(cellRt, x, yTop, w, h);

            // 青绿条：属性=顶 2px，检定=左 2.5px
            var barGo = new GameObject("Bar", typeof(RectTransform), typeof(CanvasRenderer), typeof(Image));
            barGo.transform.SetParent(cellRt, false);
            var bar = barGo.GetComponent<Image>();
            bar.color = TealDark;
            bar.raycastTarget = false;
            var barRt = (RectTransform)barGo.transform;
            if (vertical)
            {
                PlaceTop(barRt, 0f, 0f, w, 2f);
            }
            else
            {
                barRt.anchorMin = new Vector2(0f, 0f);
                barRt.anchorMax = new Vector2(0f, 1f);
                barRt.offsetMin = Vector2.zero;
                barRt.offsetMax = new Vector2(2.5f, 0f);
            }

            if (vertical)
            {
                var label = MakeText(cellRt, "Label", entry.Key, 10, FontStyle.Normal, Muted, TextAnchor.MiddleCenter);
                PlaceTop((RectTransform)label.transform, 0f, 2f, w, h * 0.5f);
                var value = MakeText(cellRt, "Value", entry.DisplayText, 11, FontStyle.Bold, Ink, TextAnchor.MiddleCenter);
                PlaceTop((RectTransform)value.transform, 0f, h * 0.5f, w, h * 0.5f);
            }
            else
            {
                var label = MakeText(cellRt, "Label", entry.Key, 10, FontStyle.Normal, Ink, TextAnchor.MiddleLeft);
                PlaceTop((RectTransform)label.transform, 7f, 0f, w - 38f, h);
                var value = MakeText(cellRt, "Value", entry.DisplayText, 11, FontStyle.Bold, TealDark, TextAnchor.MiddleRight);
                PlaceTop((RectTransform)value.transform, w - 34f, 0f, 30f, h);
            }
        }

        /// <summary>动态建文本（用 dynamicFont，与烘焙文本同字体）。</summary>
        private static Text MakeText(RectTransform parent, string name, string content, int size, FontStyle style, Color color, TextAnchor align)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var text = go.AddComponent<Text>();
            text.font = dynamicFont;
            text.text = content;
            text.fontSize = size;
            text.fontStyle = style;
            text.color = color;
            text.alignment = align;
            text.raycastTarget = false;
            return text;
        }

        /// <summary>顶部对齐放置（与烘焙器同约定：锚点/pivot 左上，yTop 从父顶向下）。</summary>
        private static void PlaceTop(RectTransform rt, float x, float yTop, float w, float h)
        {
            rt.anchorMin = new Vector2(0f, 1f);
            rt.anchorMax = new Vector2(0f, 1f);
            rt.pivot = new Vector2(0f, 1f);
            rt.anchoredPosition = new Vector2(x, -yTop);
            rt.sizeDelta = new Vector2(w, h);
        }

        private static void ClearChildren(RectTransform parent)
        {
            if (parent == null)
            {
                return;
            }

            for (int i = parent.childCount - 1; i >= 0; i--)
            {
                Object.Destroy(parent.GetChild(i).gameObject);
            }
        }

        /// <summary>克隆行模板生成背包行（道具按名分组，逐行「道具名 + ×N」）。</summary>
        private void RebuildBackpackRows(CardRefs card, BackendObject player)
        {
            var backpack = player != null ? player.GetComponent<Backpack>() : null;
            var items = backpack != null ? backpack.Items : null;
            var text = BuildItemsText(items);
            if (text == card.CachedItems)
            {
                return;
            }

            card.CachedItems = text;

            // 清旧行（模板保留）
            for (int i = card.BackpackList.childCount - 1; i >= 0; i--)
            {
                var child = card.BackpackList.GetChild(i);
                if (child != card.RowTemplate)
                {
                    Destroy(child.gameObject);
                }
            }

            int count = 0;
            if (items != null)
            {
                foreach (var _ in GroupItems(items))
                {
                    count++;
                }
            }

            card.RowCount = count;
            UpdatePageTitle(card);

            if (count == 0)
            {
                return;
            }

            float y = 0f;
            const float rowH = 26f;
            const float rowInnerH = 22f;
            foreach (var pair in GroupItems(items))
            {
                var row = Instantiate(card.RowTemplate, card.BackpackList, false);
                var rowRt = row as RectTransform;
                // 模板锚点 (0,1)-(1,1)：整宽、贴顶；克隆只需把 y 下移（offset 直写，避开 pivot 反算）
                rowRt.offsetMin = new Vector2(0f, -(y + rowInnerH));
                rowRt.offsetMax = new Vector2(0f, -y);
                row.gameObject.SetActive(true);

                var itemName = row.Find("ItemName").GetComponent<Text>();
                itemName.text = pair.Key;

                var countText = row.Find("Count").GetComponent<Text>();
                countText.text = pair.Value > 1 ? "×" + pair.Value : string.Empty;
                countText.gameObject.SetActive(pair.Value > 1);

                y += rowH;
            }
        }

        /// <summary>刷新琥珀描边/色条与可用状态（空槽变暗不拦截点击）。</summary>
        private void RefreshHighlight()
        {
            var manager = Game.Instance != null ? Game.Instance.CharacterManager : null;
            for (int i = 0; i < cards.Count; i++)
            {
                var card = cards[i];
                var isEmpty = manager == null || i >= manager.Players.Count;
                var isCurrent = !isEmpty && i == manager.CurrentPlayerIndex;

                card.SlotButton.interactable = !isEmpty;
                card.SlotImage.raycastTarget = !isEmpty;
                card.SlotImage.color = isEmpty ? m_EmptyColor : new Color(0.910f, 0.898f, 0.863f, 1f);

                foreach (var strip in card.BorderStrips)
                {
                    if (strip != null)
                    {
                        strip.enabled = isCurrent;
                        strip.transform.SetAsLastSibling(); // 盖过卡内内容
                    }
                }

                card.Accent.color = isEmpty ? Color.clear : CharacterManager.GetPlayerColor(i);
            }
        }

        private void RefreshItemsIfChanged(CharacterManager manager)
        {
            for (int i = 0; i < cards.Count; i++)
            {
                var card = cards[i];
                var player = manager != null && i < manager.Players.Count ? manager.Players[i] : null;
                var backpack = player != null ? player.GetComponent<Backpack>() : null;
                var text = BuildItemsText(backpack != null ? backpack.Items : null);
                if (text != card.CachedItems)
                {
                    RebuildBackpackRows(card, player);
                }
            }
        }

        /// <summary>属性表变化时重建动态格（FillAttributes 内部用缓存串比对，这里每帧喂给它最新玩家）。</summary>
        private void RefreshAttrsIfChanged(CharacterManager manager)
        {
            for (int i = 0; i < cards.Count; i++)
            {
                var card = cards[i];
                var player = manager != null && i < manager.Players.Count ? manager.Players[i] : null;
                FillAttributes(card, player);
            }
        }

        private static string BuildItemsText(IReadOnlyList<string> items)
        {
            if (items == null || items.Count == 0)
            {
                return string.Empty;
            }

            var sb = new StringBuilder();
            foreach (var pair in GroupItems(items))
            {
                if (sb.Length > 0)
                {
                    sb.Append('\n');
                }

                sb.Append(pair.Key);
                if (pair.Value > 1)
                {
                    sb.Append(" ×").Append(pair.Value);
                }
            }

            return sb.ToString();
        }

        private static IEnumerable<KeyValuePair<string, int>> GroupItems(IReadOnlyList<string> items)
        {
            var counts = new Dictionary<string, int>();
            var order = new List<string>();
            if (items != null)
            {
                foreach (var item in items)
                {
                    if (string.IsNullOrEmpty(item))
                    {
                        continue;
                    }

                    if (!counts.ContainsKey(item))
                    {
                        order.Add(item);
                    }

                    counts.TryGetValue(item, out int count);
                    counts[item] = count + 1;
                }
            }

            foreach (var key in order)
            {
                yield return new KeyValuePair<string, int>(key, counts[key]);
            }
        }
    }
}


// touch 639239350045576543
