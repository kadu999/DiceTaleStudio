using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 角色卡（后端 characterCards.json 下发）：角色 ID + 身份（显示名/职业）+ 属性表。
    /// 字段名与后端 JSON 一致（camelCase），由 ServerCommandDispatcher 解析写入。
    /// </summary>
    public class CharacterCardData
    {
        public string id;
        public string displayName;
        public string role;
        public List<AttributeDef> attributes = new List<AttributeDef>();
    }

    /// <summary>
    /// 角色管理：持有所有玩家主体（BackendObject 枢纽，kind=Player）并维护当前玩家。
    /// 玩家实体形态：BackendObject + Backpack——身份用枢纽 ObjectId（自动唯一），
    /// 显示名在枢纽 displayName 设置，玩家登记由枢纽按 kind=Player 处理。
    /// </summary>
    public class CharacterManager : MonoBehaviour
    {
        /// <summary>所有玩家主体（BackendObject 枢纽）。</summary>
        public List<BackendObject> Players { get; private set; } = new List<BackendObject>();

        /// <summary>当前玩家主体（BackendObject 枢纽）。</summary>
        public BackendObject CurrentPlayer { get; private set; }

        public int CurrentPlayerIndex { get; private set; }

        private void OnDestroy()
        {
            ClearPlayers(); // 销毁所有玩家并复位状态（Destroy 延迟到帧末，属正常）
        }

        /// <summary>多玩家区分色板（红/蓝/绿/黄，按序号循环取色）。</summary>
        private static readonly Color[] PlayerPalette =
        {
            new Color(0.85f, 0.3f, 0.3f, 1f),  // 红
            new Color(0.3f, 0.55f, 0.9f, 1f),  // 蓝
            new Color(0.3f, 0.8f, 0.4f, 1f),   // 绿
            new Color(0.95f, 0.8f, 0.2f, 1f),  // 黄
        };

        /// <summary>按玩家序号取区分色（与地图上玩家精灵颜色一致，超出循环取色）。</summary>
        public static Color GetPlayerColor(int index)
        {
            if (index < 0)
            {
                return Color.white;
            }

            return PlayerPalette[index % PlayerPalette.Length];
        }

        /// <summary>角色模型数量（Resources/Characters/Character001..Character004，与 Half 半身像资源区分）。</summary>
        private const int CharacterCount = 4;

        /// <summary>按玩家序号取角色编号（id）：玩家序号从 0 开始（人数上限 4 由 CreatePlayers 保证）。
        /// 直接映射 1..4 纯编号——按序分配、不循环复用，每个玩家一个角色、不可能重复。</summary>
        public static string GetCharacterId(int playerIndex)
        {
            return (Mathf.Max(0, playerIndex) + 1).ToString();
        }

        /// <summary>角色模型资源名：Character00 + 编号（如 id="1" → Character001），与 Resources/Characters 下的模型命名一致。</summary>
        public static string CharacterModelName(string characterId)
        {
            return "Character00" + characterId;
        }

        /// <summary>按序号把角色模型加载并挂到玩家物体下（Resources/Characters/Character00{id} prefab 实例化为 Player 的子物体）。
        /// 模型缺失时保留默认外观并告警；返回模型实例（加载失败返回 null）。</summary>
        public static GameObject AttachCharacterModel(GameObject player, int playerIndex)
        {
            if (player == null)
            {
                return null;
            }

            var modelName = CharacterModelName(GetCharacterId(playerIndex));
            var prefab = Resources.Load<GameObject>("Characters/" + modelName);
            if (prefab == null)
            {
                Debug.LogWarning($"[CharacterManager] 角色模型未找到: Resources/Characters/{modelName}，玩家使用默认外观");
                return null;
            }

            var model = Object.Instantiate(prefab, player.transform, false);
            model.name = "Character";
            model.transform.localPosition = Vector3.zero;
            model.transform.localRotation = Quaternion.identity;
            model.transform.localScale = Vector3.one;
            return model;
        }

        // ---------- 角色卡（后端 characterCards.json 下发；创建玩家时初始化身份与属性） ----------

        /// <summary>角色卡缓存（ServerCommandDispatcher 收到 character_cards 时更新）。</summary>
        private static readonly List<CharacterCardData> characterCards = new List<CharacterCardData>();

        /// <summary>后端下发的角色卡（只读视图）。</summary>
        public static IReadOnlyList<CharacterCardData> CharacterCards => characterCards;

        /// <summary>更新角色卡缓存（ServerCommandDispatcher 收到 character_cards 消息时调用）。
        /// 卡数据到达后同步刷新已存在的玩家（覆盖"卡未就绪时创建的占位玩家"：身份/属性随之更新），
        /// 并补报一次后台，让 GM 页立即拿到角色卡的真实名称/职称（卡可能晚于玩家创建时的首次 ReportAll 到达）。</summary>
        public static void SetCharacterCards(IEnumerable<CharacterCardData> cards)
        {
            characterCards.Clear();
            if (cards != null)
            {
                characterCards.AddRange(cards);
            }

            // 已存在玩家按当前序号重新应用卡（每玩家一张卡、不重复；卡缺失的玩家走占位身份）
            var manager = Game.Instance != null ? Game.Instance.CharacterManager : null;
            if (manager != null)
            {
                for (int i = 0; i < manager.Players.Count; i++)
                {
                    var player = manager.Players[i];
                    if (player != null)
                    {
                        ApplyCharacterCard(player.gameObject, i);
                    }
                }

                // 身份已刷新：补报一次后台（未连接时 ReportAll 内部直接返回，安全）
                if (manager.Players.Count > 0 && Game.Instance.BackendRegistry != null)
                {
                    Game.Instance.BackendRegistry.ReportAll();
                }
            }
        }

        /// <summary>向后端请求角色卡（连接建立后调用；供玩家创建时按角色 ID 初始化身份与属性）。</summary>
        public void RequestCharacterCards()
        {
            var connection = Game.Instance != null ? Game.Instance.ServerConnection : null;
            if (connection != null && connection.IsConnected)
            {
                connection.Send(new Server.RequestCharacterCardsMessage());
            }
        }

        /// <summary>按序号应用角色卡：从角色卡列表中按序选取（第 N 个玩家取第 N 张卡，每张卡只用一个玩家、不可能重复），
        /// 用其身份（显示名/职业）与属性表初始化玩家；卡数据未就绪（未连接/后端未下发）时回退占位身份
        /// （Player_{N} / 模型名 Character00{id}），属性保留默认。</summary>
        private static void ApplyCharacterCard(GameObject player, int playerIndex)
        {
            // 按序取卡：playerIndex 与角色卡列表下标一一对应（JSON 顺序 = 编号顺序 1..4），天然不重复
            var card = playerIndex >= 0 && playerIndex < characterCards.Count ? characterCards[playerIndex] : null;

            var stats = player != null ? player.GetComponent<PlayerStats>() : null;
            if (stats != null)
            {
                if (card != null)
                {
                    stats.SetIdentity(card.displayName, card.role);
                }
                else
                {
                    // 卡缺失时身份占位：名称 Player_{N}，职称留空（不显示 Character00N 之类的前缀式角色名）
                    stats.SetIdentity($"Player_{playerIndex + 1}", string.Empty);
                }
            }

            var attr = player != null ? player.GetComponent<AttributeList>() : null;
            if (attr != null && card != null)
            {
                attr.ReplaceAttributes(card.attributes);
            }
        }

        public void CreatePlayers(int count)
        {
            // 人数上限 = 角色数量（4）：每个玩家按序分配一个角色 ID，超限直接截断（不循环复用角色）
            count = Mathf.Clamp(count, 1, CharacterCount);

            ClearPlayers();

            var playerPrefab = Resources.Load<GameObject>("Player");
            if (playerPrefab == null)
            {
                Debug.LogWarning("Player prefab not found in Resources");
                return;
            }

            for (int i = 0; i < count; i++)
            {
                var playerGo = Instantiate(playerPrefab);

                var hub = playerGo.GetComponent<BackendObject>();
                if (hub != null)
                {
                    // 玩家主体：kind=Player（枢纽按此登记玩家名单），displayName 供 GM 页面显示；
                    // characterId = 角色卡编号（GM 核对玩家↔角色卡对应）
                    hub.SetKind(BackendObjectKind.Player);
                    hub.SetDisplayName($"Player_{i + 1}");
                    hub.SetCharacterId(GetCharacterId(i));
                    Players.Add(hub);
                }

                // 玩家实体 = BackendObject + Backpack（物品数据段与 GM 道具分配依赖 Backpack 组件；
                // Player prefab 上的 ItemInventory 脚本已移除，缺失时在此补建）
                if (playerGo.GetComponent<Backpack>() == null)
                {
                    playerGo.AddComponent<Backpack>();
                }

                // 按序号应用角色卡：身份/属性来自后端 characterCards.json（卡未就绪时回退占位身份）
                ApplyCharacterCard(playerGo, i);

                // 按序号绑定角色 ID（Character001..004）并加载对应模型，实例化为 Player 的子物体
                AttachCharacterModel(playerGo, i);

                // 创建期玩家不可见：角色创建场景（Scene000）没有它们的落位点，立即激活会以世界原点
                // (0,0,0) 显示在屏幕中心——场景切换淡出时穿帮（见 GameSceneManager.MovePlayersToSpawn：
                // 正式落位（切到游戏场景）时才 SetActive(true) 显现）
                playerGo.SetActive(false);
            }

            if (Players.Count > 0)
            {
                SetCurrentPlayer(0);

                // 玩家创建后立即补报一次后台：连接建立时的首次 ReportAll 早于玩家创建，
                // 若随后的流程不在同一时刻切场景（LoadScene 会再上报一次），GM 页面将收不到
                // register_players（道具分配区没有玩家列表）。创建点即补报最可靠。
                var registry = Game.Instance != null ? Game.Instance.BackendRegistry : null;
                registry?.ReportAll();
            }
        }

        public void AddPlayer(BackendObject player)
        {
            if (player == null || Players.Contains(player))
            {
                return;
            }

            Players.Add(player);
        }

        public void SetCurrentPlayer(int index)
        {
            if (index < 0 || index >= Players.Count)
            {
                return;
            }

            CurrentPlayerIndex = index;
            CurrentPlayer = Players[index];
        }

        /// <summary>按索引取玩家主体（棋子）：越界返回 null（调用方再决定回退语义，如回退当前玩家）。</summary>
        public BackendObject GetPlayer(int index)
        {
            if (index < 0 || index >= Players.Count)
            {
                return null;
            }

            return Players[index];
        }

        public void NextPlayer()
        {
            if (Players.Count == 0)
            {
                return;
            }

            SetCurrentPlayer((CurrentPlayerIndex + 1) % Players.Count);
        }

        public void ClearPlayers()
        {
            foreach (var player in Players)
            {
                if (player != null)
                {
                    Destroy(player.gameObject);
                }
            }

            Players.Clear();
            CurrentPlayer = null;
            CurrentPlayerIndex = 0;
        }
    }
}
