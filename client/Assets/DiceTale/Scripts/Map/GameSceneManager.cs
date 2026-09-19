using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 场景容器管理器：负责加载/切换「场景」。
    /// 场景是更高一层概念：场景包含地图、出生点、门、装饰等设计内容；
    /// 「地图」只是场景的一部分（带 <see cref="GridMap"/> 的网格/障碍/位置标记，见 <see cref="MapMarker"/>）。
    /// 场景从 Resources 按名加载同名 prefab：兼容两种结构——
    /// 旧结构（MapNNN.prefab 根节点直接带 GridMap，场景＝地图）与新结构
    /// （SceneNNN.prefab 根节点是容器、子物体 MapNNN 带 GridMap，地图是场景的一部分）。
    ///
    /// 场景级配置与生命周期（场景 id / 默认出生点 / 下一传送目标 / 加载卸载钩子）
    /// 由场景脚本（<see cref="GameScene"/>，如 Game000/Game001…，挂在场景预制体根节点）声明；
    /// 本管理器只负责加载、切换、落位与上报的通用流程。
    /// </summary>
    public class GameSceneManager : MonoBehaviour
    {
        [SerializeField]
        private string initialSceneName = "Scene000";

        [SerializeField]
        private Transform sceneRoot;

        [SerializeField]
        private float interactionLockDuration = 0.5f;

        [SerializeField, Tooltip("场景切换淡出时长（秒，画面慢慢变暗到全黑）；<=0 淡出瞬间完成")]
        private float fadeOutDuration = 0.8f;

        [SerializeField, Tooltip("场景切换淡入时长（秒，从全黑慢慢变亮到新场景）；<=0 淡入瞬间完成")]
        private float fadeInDuration = 0.8f;

        [SerializeField, Tooltip("是否启用场景切换淡入淡出（false 时切图无过渡）")]
        private bool sceneFadeEnabled = true;

        /// <summary>进行中的淡入淡出切换协程（防重入：切换期间忽略新的 LoadScene 请求，多玩家传送靠待落位队列合并）。</summary>
        private Coroutine sceneFadeRoutine;

        /// <summary>跨场景传送待落位队列：切换协程在黑屏中切完场景后统一落位（多人传送只触发一次切换）。</summary>
        private readonly List<PendingTeleport> pendingTeleports = new List<PendingTeleport>();

        /// <summary>待落位传送项：目标场景标记 + 落位偏移（多人错开站位）。</summary>
        private class PendingTeleport
        {
            public BackendObject Player;
            public string MarkerId;
            public Vector3 Offset;
        }

        /// <summary>当前场景 id。</summary>
        public string CurrentSceneName { get; private set; }
        private GameObject CurrentScene { get; set; }

        /// <summary>当前场景的场景脚本（无场景脚本时为 null）。</summary>
        public GameScene CurrentSceneScript =>
            CurrentScene != null ? CurrentScene.GetComponentInChildren<GameScene>() : null;

        private void Awake()
        {
            if (sceneRoot == null)
            {
                var rootGo = new GameObject("SceneRoot");
                sceneRoot = rootGo.transform;
            }
        }

        private void Start()
        {
            var game = Game.Instance;
            var connection = game != null ? game.ServerConnection : null;
            if (connection != null && game != null)
            {
                // 后台连接（或重连）成功后统一补报所有 BackendObject（门、出生点、玩家）
                connection.OnConnected += game.BackendRegistry.ReportAll;
                // 补报玩家当前位置：出生落点可能早于连接就绪被丢弃，连接后重报刷新 GM 网页位置
                connection.OnConnected += ReportPlayerPositions;
                // 请求角色卡（4 张角色卡 JSON 配置，供玩家创建时按角色 ID 初始化身份与属性）
                connection.OnConnected += game.CharacterManager.RequestCharacterCards;
            }

            // 初始场景：LoadScene 自带淡入淡出（开场从黑屏淡入）
            LoadScene(ResolveInitialScene(), null);
        }

        private void OnDisable()
        {
            var game = Game.Instance;
            var connection = game != null ? game.ServerConnection : null;
            if (connection == null || game == null)
            {
                return;
            }

            // 解绑不依赖 registry 是否存在：registry 先销毁时也能正常退订，避免事件悬挂
            var registry = game.BackendRegistry;
            if (registry != null)
            {
                connection.OnConnected -= registry.ReportAll;
            }

            connection.OnConnected -= ReportPlayerPositions;
            connection.OnConnected -= game.CharacterManager.RequestCharacterCards;
        }

        /// <summary>连接建立（或重连）后补报所有玩家的当前位置（移动/传送落点由各自调用方上报）。</summary>
        private void ReportPlayerPositions()
        {
            var characterManager = Game.Instance != null ? Game.Instance.CharacterManager : null;
            if (characterManager == null)
            {
                return;
            }

            foreach (var player in characterManager.Players)
            {
                if (player != null)
                {
                    player.ReportPosition();
                }
            }
        }

        /// <summary>
        /// 加载并切换到指定场景（可选出生点 id；缺省用当前场景脚本的 DefaultSpawnId）。
        ///
        /// 所有场景/地图切换（流程命令、服务端切图、传送动作）都汇聚到这里，**统一带淡入淡出**：
        /// 协程先打开全屏遮罩（SceneFadeUI）→ 淡出到黑 → 黑屏中同步切换（卸载旧/加载新/落位/上报/钩子）→ 淡入还原。
        /// 遮罩不可用（无 UIManager/窗口）或 sceneFadeEnabled=false 时退化为直接同步切换。
        /// </summary>
        public void LoadScene(string sceneName, string spawnId = null)
        {
            if (string.IsNullOrEmpty(sceneName))
            {
                return;
            }

            if (CurrentSceneName == sceneName)
            {
                return;
            }

            if (!sceneFadeEnabled)
            {
                SwitchSceneCore(sceneName, spawnId);
                ApplyPendingTeleports(); // 关闭淡入淡出时也统一落位跨场景传送的玩家
                return;
            }

            if (sceneFadeRoutine != null)
            {
                return; // 已有淡入淡出切换进行中：忽略重入（玩家已进待落位队列，由进行中的协程统一处理）
            }

            sceneFadeRoutine = StartCoroutine(LoadSceneWithFadeCoroutine(sceneName, spawnId));
        }

        /// <summary>
        /// 淡入淡出切换协程：**先打开遮罩 UI**（SceneFadeUI，保证切图瞬间屏幕已被罩住，不会闪）→
        /// 淡出到全黑 → 黑屏中同步调用 <see cref="SwitchSceneCore"/> 切场景并统一落位待传送玩家 → 淡入还原 → 关闭遮罩。
        /// </summary>
        private IEnumerator LoadSceneWithFadeCoroutine(string sceneName, string spawnId)
        {
            var fade = OpenFadeWindow();
            if (fade == null)
            {
                // 遮罩不可用（无 UIManager/窗口）：退化为直接同步切换
                SwitchSceneCore(sceneName, spawnId);
                sceneFadeRoutine = null;
                yield break;
            }

            // 1) 淡出到全黑（遮罩先行盖住屏幕，切换瞬间无闪烁）
            fade.FadeToBlack(Mathf.Max(fadeOutDuration, 0.001f));
            while (fade.IsFading)
            {
                yield return null;
            }

            // 2) 黑屏中同步切换场景（卸载旧场景/建新场景/玩家落位/上报/场景钩子，时序与直接切换一致）
            SwitchSceneCore(sceneName, spawnId);

            // 3) 统一落位待传送玩家（跨场景传送在黑屏切换后定位，避免切图瞬间玩家乱跳/闪烁）
            ApplyPendingTeleports();

            // 黑屏切换期间场景钩子可能创建了新 UI（如 Game000 加载 StartSceneUI），
            // 淡入前把遮罩再提到 Canvas 最上层，保证「慢慢变亮」的效果盖住所有新 UI
            fade.transform.SetAsLastSibling();

            // 4) 淡入还原新场景
            fade.FadeFromBlack(Mathf.Max(fadeInDuration, 0.001f));
            while (fade.IsFading)
            {
                yield return null;
            }

            // 5) 淡入完成：隐藏遮罩窗口（保留注册，可再开）
            fade.Close();
            sceneFadeRoutine = null;
        }

        /// <summary>打开（或获取已打开的）全屏淡入淡出遮罩窗口；无 UIManager 时返回 null。</summary>
        private static SceneFadeUI OpenFadeWindow()
        {
            var ui = Game.Instance != null ? Game.Instance.UIManager : null;
            return ui != null ? ui.OpenWindow<SceneFadeUI>() : null;
        }

        /// <summary>同步切换核心：真正的场景替换（卸载旧/加载新/落位/上报/钩子），供淡入淡出黑屏中调用，
        /// 也供遮罩不可用时直接切换。调用方需自行保证防重入。</summary>
        private void SwitchSceneCore(string sceneName, string spawnId)
        {
            var game = Game.Instance; // 宿主：管理器与宿主同物体，直接引用
            game?.LockInteraction(interactionLockDuration);

            // 玩家挂在当前场景节点下，切场景前先摘下来，避免随旧场景一起销毁
            DetachPlayersFromScene();
            UnloadCurrentScene();

            CurrentScene = CreateSceneGameObject(sceneName);
            if (CurrentScene == null)
            {
                Debug.LogError($"Scene prefab not found: {sceneName}（Resources 里没有同名预设，场景只能通过预设加载）");
                return;
            }

            CurrentSceneName = sceneName;

            MovePlayersToSpawn(spawnId ?? ResolveDefaultSpawnId());

            // 场景变化后统一上报所有后台对象（门/出生点/玩家名单）
            if (game != null)
            {
                game.BackendRegistry.ReportAll();
            }

            // 场景脚本生命周期钩子：场景加载完成（各场景脚本处理自己的 UI/初始化，如 Game000 加载人数选择 UI）
            CurrentScene.GetComponentInChildren<GameScene>()?.OnSceneLoaded(this);
        }

        /// <summary>黑屏切换后统一落位所有待传送玩家（多人传送只触发一次切换，落位在此合并执行）。</summary>
        private void ApplyPendingTeleports()
        {
            if (pendingTeleports.Count == 0)
            {
                return;
            }

            foreach (var pending in pendingTeleports)
            {
                if (pending == null || pending.Player == null)
                {
                    continue;
                }

                var marker = FindMarker(pending.MarkerId);
                if (marker == null)
                {
                    Debug.LogWarning($"[GameSceneManager] 传送标记不存在：{pending.MarkerId}（scene={CurrentSceneName}），玩家仍留在出生点");
                    continue;
                }

                pending.Player.transform.position = marker.Position + pending.Offset;
                pending.Player.ReportPosition(); // 传送落点：上报位置
            }

            pendingTeleports.Clear();
        }

        /// <summary>当前场景脚本声明的默认出生点；无场景脚本的旧场景回退 "Default"。</summary>
        private string ResolveDefaultSpawnId()
        {
            var scene = CurrentScene != null ? CurrentScene.GetComponentInChildren<GameScene>() : null;
            return scene != null ? scene.DefaultSpawnId : "Default";
        }

        /// <summary>把世界坐标换算成地图图片上的归一化坐标（y 向下，左上角为原点）。
        /// 地图大小以当前场景内地图（GridMap）的格子数量 × 格子大小计算（不依赖 SpriteRenderer——地图视觉可能已移到子物体或缺失）。</summary>
        public Server.Position GetNormalizedPosition(Vector3 worldPosition)
        {
            var gridMap = CurrentScene != null ? CurrentScene.GetComponentInChildren<GridMap>() : null;
            if (gridMap == null)
            {
                return new Server.Position { x = 0.5f, y = 0.5f };
            }

            var origin = gridMap.GridOrigin;
            var width = gridMap.GridWidth;
            var height = gridMap.GridHeight;
            if (width <= 0f || height <= 0f)
            {
                return new Server.Position { x = 0.5f, y = 0.5f };
            }

            // 网格左下角（-X/-Z）→ 图片 (0,0) 左上角；网格上边界（+Z）→ 图片 y=0（顶部）
            return new Server.Position
            {
                x = Mathf.Clamp01((worldPosition.x - origin.x) / width),
                y = Mathf.Clamp01(1f - (worldPosition.z - origin.z) / height)
            };
        }

        /// <summary>建出场景实例：Resources 里必须有同名预设；没有预设返回 null（由 LoadScene 报错）。
        /// 从场景内找到地图（GridMap）并用其 .bytes 网格数据覆盖（保持服务器/客户端一致的障碍数据）。</summary>
        private GameObject CreateSceneGameObject(string sceneName)
        {
            // 场景只能通过 Resources 里的预设加载（含地图、出生点、门、装饰等设计内容）。
            // 场景/地图资源集中在 Resources/Scenes/ 子目录：Resources.Load 短名只匹配 Resources 根的直接资产，
            // 子目录资产必须带路径（如 "Scenes/Scene001"），故先短名（兼容旧布局）再子目录兜底。
            var prefab = Resources.Load<GameObject>(sceneName);
            if (prefab == null)
            {
                prefab = Resources.Load<GameObject>("Scenes/" + sceneName);
            }

            if (prefab == null)
            {
                return null;
            }

            var go = Instantiate(prefab, sceneRoot);
            go.name = sceneName;

            // 从场景里找地图：兼容旧结构（根节点带 GridMap）与新结构（子物体 MapNNN 带 GridMap）。
            // 用 .bytes 网格数据覆盖地图的 GridMap；.bytes 按地图物体名加载（LoadData 默认用自身名字，
            // 如 MapNNN.bytes），命名属于地图层，不随场景名变化
            var gridMap = go.GetComponentInChildren<GridMap>();
            if (gridMap != null)
            {
                gridMap.LoadData();
                // 网格尺寸被 .bytes 覆盖后，重新计算动态阻挡占用的格子
                gridMap.RefreshDynamicObstacles();
            }

            return go;
        }

        /// <summary>把玩家移动到指定出生点（spawnId 为空时用场景脚本的默认出生点），并挂到当前场景节点下。
        /// 落位点由场景脚本（<see cref="GameScene.ResolveLandingPoint"/>）解析；无脚本的旧场景保留内置回退。</summary>
        public void MovePlayersToSpawn(string spawnId)
        {
            var characterManager = Game.Instance != null ? Game.Instance.CharacterManager : null;
            if (characterManager == null || characterManager.Players.Count == 0)
            {
                Debug.LogWarning($"[GameSceneManager] MovePlayersToSpawn skipped: no players (players={(characterManager != null ? characterManager.Players.Count : -1)})");
                return;
            }

            // 玩家挂在当前场景节点下（层级跟随场景）
            var parent = CurrentScene != null ? CurrentScene.transform : sceneRoot;
            foreach (var player in characterManager.Players)
            {
                if (player != null)
                {
                    player.transform.SetParent(parent, true);
                    // 正式落位才显现：角色创建期（Scene000）的玩家是隐藏的（CreatePlayers 创建时
                    // SetActive(false)），切到游戏场景落位时激活——避免在淡出阶段以世界原点穿帮
                    if (!player.gameObject.activeSelf)
                    {
                        player.gameObject.SetActive(true);
                    }
                }
            }

            Vector3? target = null;
            string targetDesc;

            var sceneScript = CurrentScene != null ? CurrentScene.GetComponentInChildren<GameScene>() : null;
            if (sceneScript != null)
            {
                // 场景脚本解析落位点（出生点 → 第一个 MapMarker → 网格锚点；子类可覆写）
                target = sceneScript.ResolveLandingPoint(spawnId);
                targetDesc = $"scene script '{sceneScript.SceneId}'";
            }
            else
            {
                // 无场景脚本的旧场景（MapNNN）：保留原回退逻辑
                var spawn = FindSpawn(spawnId);
                if (spawn != null)
                {
                    target = spawn.position;
                    targetDesc = $"spawn '{spawn.name}'";
                }
                else
                {
                    // 无出生点（Spawn_* 物体）时回退到当前场景第一个 MapMarker（部分地图用标记作为出生点，如 Map002）
                    var marker = FindFirstMarkerOnCurrentScene();
                    if (marker != null)
                    {
                        target = marker.Position;
                        targetDesc = $"marker '{marker.Id}' (no spawn point)";
                    }
                    else
                    {
                        // 最终兜底：网格锚点（网格原点 + 半格）。没有出生点/标记的场景也能落位，
                        // 否则玩家会全部停在 Player 预制体的同一位置（出生叠人 BUG 的根因）
                        var grid = CurrentScene != null ? CurrentScene.GetComponentInChildren<GridMap>() : null;
                        if (grid != null)
                        {
                            target = grid.GridOrigin + new Vector3(grid.CellSize * 0.5f, 0f, grid.CellSize * 0.5f);
                            targetDesc = "grid anchor (no spawn point / marker)";
                        }
                        else
                        {
                            Debug.LogWarning($"[GameSceneManager] Spawn point not found: {spawnId ?? "(default)"} (scene={CurrentSceneName})");
                            return;
                        }
                    }
                }
            }

            if (target == null)
            {
                Debug.LogWarning($"[GameSceneManager] Spawn point not found: {spawnId ?? "(default)"} (scene={CurrentSceneName})");
                return;
            }

            Debug.Log($"[GameSceneManager] Moving {characterManager.Players.Count} player(s) to {targetDesc} at {target.Value} (scene={CurrentSceneName})");
            for (int i = 0; i < characterManager.Players.Count; i++)
            {
                var player = characterManager.Players[i];
                if (player != null)
                {
                    // 多人落位错开站位（按玩家精灵宽度 + 间隙排成方阵），避免完全重叠难以区分
                    player.transform.position = target.Value + GetSpawnOffset(i, characterManager.Players.Count);
                    player.ReportPosition(); // 传送/出生落点：上报位置
                }
            }
        }

        /// <summary>
        /// 多人落位错开偏移：按玩家精灵宽度 + 间隙排成方阵（间距≥玩家宽度，保证不重叠）；
        /// 拿不到玩家尺寸时回退 0.5 世界单位。
        /// </summary>
        public static Vector3 GetSpawnOffset(int index, int total)
        {
            var spacing = GetPlayerSpacing();
            var cols = Mathf.Max(1, Mathf.CeilToInt(Mathf.Sqrt(total)));
            return new Vector3((index % cols) * spacing, 0f, (index / cols) * spacing);
        }

        /// <summary>玩家落位间距：取玩家精灵的世界宽度 ×1.2（宽度 + 20% 间隙）；无玩家/无精灵时回退 0.5。</summary>
        private static float GetPlayerSpacing()
        {
            var manager = Game.Instance != null ? Game.Instance.CharacterManager : null;
            if (manager != null && manager.CurrentPlayer != null)
            {
                var renderer = manager.CurrentPlayer.GetComponent<BoxCollider>();
                if (renderer != null)
                {
                    return renderer.bounds.size.x * 1.2f;
                }
            }

            return 0.5f;
        }

        /// <summary>
        /// 把指定玩家主体传送到指定场景上位置标记（<see cref="MapMarker"/>）所在的位置。
        /// 跨场景：登记待落位队列并触发（或复用进行中的）一次淡入淡出切换，黑屏中统一落位；
        /// 同场景：不重载场景，直接定位落位（无淡入淡出）。
        /// <paramref name="offset"/> 用于多人传送时错开站位。
        /// </summary>
        /// <returns>同场景标记存在返回 true；跨场景登记成功也返回 true（标记有效性在切换后落位时校验）；参数无效返回 false。</returns>
        public bool TeleportPlayer(BackendObject player, string sceneName, string markerId, Vector3 offset = default)
        {
            if (player == null || string.IsNullOrEmpty(sceneName))
            {
                return false;
            }

            if (CurrentSceneName == sceneName)
            {
                // 同场景传送：不重载场景，直接按标记定位
                var marker = FindMarker(markerId);
                if (marker == null)
                {
                    Debug.LogWarning($"[GameSceneManager] Map marker not found: {markerId} (scene={CurrentSceneName})");
                    return false;
                }

                TeleportPlayerToPosition(player, marker.Position + offset);
                return true;
            }

            // 跨场景传送：登记待落位（多人传送合并到同一次切换），再触发（或复用进行中的）淡入淡出切换
            pendingTeleports.Add(new PendingTeleport { Player = player, MarkerId = markerId, Offset = offset });
            LoadScene(sceneName, null);
            return true;
        }

        /// <summary>同场景/切换后把玩家直接放到指定世界位置并上报（不触发切换，不做标记查找）。</summary>
        private void TeleportPlayerToPosition(BackendObject player, Vector3 position)
        {
            if (player == null)
            {
                return;
            }

            player.transform.position = position;
            player.ReportPosition(); // 传送落点：上报位置
        }

        /// <summary>在当前场景上按 ID 查找位置标记（忽略大小写）；找不到返回 null。</summary>
        private MapMarker FindMarker(string markerId)
        {
            if (CurrentScene == null || string.IsNullOrEmpty(markerId))
            {
                return null;
            }

            foreach (var marker in CurrentScene.GetComponentsInChildren<MapMarker>())
            {
                if (string.Equals(marker.Id, markerId, System.StringComparison.OrdinalIgnoreCase))
                {
                    return marker;
                }
            }

            return null;
        }

        /// <summary>
        /// 判断物体是否属于其他场景（切场景时旧场景销毁前的残留物体）。
        /// 沿父链向上找 SceneRoot 的直接子物体：若是其他场景（场景根或其子树，判定为「带 GridMap 的地图子树
        /// 或地图所在场景容器」）→ 属于旧场景；不在任何场景下的物体（如过渡期挂在 SceneRoot/场景根的玩家）返回 false，照常上报。
        /// </summary>
        public bool IsFromOtherScene(Transform t)
        {
            if (t == null || CurrentScene == null || sceneRoot == null)
            {
                return false;
            }

            var current = t;
            while (current != null)
            {
                if (current.parent == sceneRoot)
                {
                    // 当前场景本体 → 不是其他场景；其他场景根：兼容旧结构（根带 GridMap）
                    // 与新结构（子树内带 GridMap 的地图属于某场景容器）
                    if (current == CurrentScene.transform)
                    {
                        return false;
                    }

                    return current.GetComponent<GridMap>() != null || current.GetComponentInChildren<GridMap>() != null;
                }

                current = current.parent;
            }

            return false;
        }

        /// <summary>切换场景前把玩家从当前场景节点摘下来（挂到 SceneRoot），避免随旧场景销毁。</summary>
        private void DetachPlayersFromScene()
        {
            var characterManager = Game.Instance != null ? Game.Instance.CharacterManager : null;
            if (characterManager == null)
            {
                return;
            }

            foreach (var player in characterManager.Players)
            {
                if (player != null)
                {
                    player.transform.SetParent(sceneRoot, true);
                }
            }
        }

        /// <summary>只在当前场景上按名字查找出生点（旧场景无 GameScene 脚本时的回退）：优先找名为
        /// 「Spawn_{spawnId}」的子物体（忽略大小写），找不到回退到第一个名字以 Spawn_ 开头或名为
        /// SpawnPoint 的子物体；没有则返回 null。注意只搜当前场景：切场景时旧场景虽已 Destroy
        /// 但销毁延迟到帧末，全局搜索会拿到旧场景的出生点。</summary>
        private Transform FindSpawn(string spawnId)
        {
            if (CurrentScene == null)
            {
                return null;
            }

            var expected = "Spawn_" + (spawnId ?? "Default");
            Transform fallback = null;
            foreach (var t in CurrentScene.GetComponentsInChildren<Transform>(true))
            {
                if (string.Equals(t.name, expected, System.StringComparison.OrdinalIgnoreCase))
                {
                    return t;
                }

                // 兜底：任意 Spawn_* 前缀物体，或名为 SpawnPoint 的物体（旧命名约定，如 Map001）
                if (fallback == null &&
                    (t.name.StartsWith("Spawn_", System.StringComparison.OrdinalIgnoreCase) ||
                     string.Equals(t.name, "SpawnPoint", System.StringComparison.OrdinalIgnoreCase)))
                {
                    fallback = t;
                }
            }

            return fallback;
        }

        /// <summary>按名字收集当前场景的出生点（Spawn_* 命名物体）并登记到地图对象上报消息
        /// （后台/GM 的出生点名单，id = 名字去掉 Spawn_ 前缀，如 Spawn_Default → Default）。
        /// 注意：消息名（RegisterMapObjectsMessage）沿用「地图对象」协议命名，仅内部语义为场景。</summary>
        public void FillSpawnPoints(Server.RegisterMapObjectsMessage mapMsg)
        {
            if (CurrentScene == null)
            {
                return;
            }

            foreach (var t in CurrentScene.GetComponentsInChildren<Transform>(true))
            {
                if (t.name.StartsWith("Spawn_", System.StringComparison.OrdinalIgnoreCase))
                {
                    mapMsg.spawnPoints.Add(new Server.SpawnInfo { id = t.name.Substring("Spawn_".Length) });
                }
                else if (string.Equals(t.name, "SpawnPoint", System.StringComparison.OrdinalIgnoreCase))
                {
                    mapMsg.spawnPoints.Add(new Server.SpawnInfo { id = "SpawnPoint" });
                }
            }
        }

        /// <summary>把当前场景脚本的场景状态列表登记到上报消息（GM 页地图下方从左到右显示；
        /// id = 下标串，name = 显示名，active = 是否当前激活）。</summary>
        public void FillSceneStates(Server.RegisterMapObjectsMessage mapMsg)
        {
            var scene = CurrentSceneScript;
            if (scene == null)
            {
                return;
            }

            for (int i = 0; i < scene.States.Count; i++)
            {
                mapMsg.states.Add(new Server.SceneStateInfo
                {
                    id = i.ToString(),
                    name = scene.States[i].DisplayName,
                    active = i == scene.CurrentStateIndex,
                });
            }
        }

        /// <summary>当前场景上第一个位置标记（旧场景无 GameScene 脚本、且无出生点 Spawn_* 物体时的回退）。
        /// 包含未激活物体：标记不因所在状态未激活而失效（与出生点收集口径一致）。</summary>
        private MapMarker FindFirstMarkerOnCurrentScene()
        {
            if (CurrentScene == null)
            {
                return null;
            }

            var markers = CurrentScene.GetComponentsInChildren<MapMarker>(true);
            return markers.Length > 0 ? markers[0] : null;
        }

        /// <summary>卸载当前场景：先通知场景脚本（OnSceneUnloaded），再销毁场景实例。</summary>
        private void UnloadCurrentScene()
        {
            if (CurrentScene != null)
            {
                CurrentScene.GetComponentInChildren<GameScene>()?.OnSceneUnloaded();
                Destroy(CurrentScene);
                CurrentScene = null;
            }
        }

        /// <summary>初始场景：序列化字段 initialSceneName（初始场景链配置已下沉到各场景脚本声明）。</summary>
        private string ResolveInitialScene()
        {
            return initialSceneName;
        }

        /// <summary>在**当前场景实例**下按名字查找子物体（如 Scene000/Event），供独立 UI（如 StartSceneUI）
        /// 定位场景内物体（UI 不再挂载到场景内，不能直接用 transform.Find）。</summary>
        public Transform FindInCurrentScene(string childName)
        {
            if (CurrentScene == null || string.IsNullOrEmpty(childName))
            {
                return null;
            }

            return CurrentScene.transform.Find(childName);
        }

        /// <summary>查询当前场景脚本声明的「下一目标」（next.scene + next.marker）。
        /// 场景链配置由各场景脚本（<see cref="GameScene.NextTarget"/>）声明；
        /// 无场景脚本或该场景没有 next（终点场景）返回 false。传送动作调用此方法取目标。</summary>
        public bool TryGetNextTarget(string currentSceneId, out string targetScene, out string targetMarker)
        {
            targetScene = null;
            targetMarker = null;
            if (CurrentScene == null)
            {
                return false;
            }

            var sceneScript = CurrentScene.GetComponentInChildren<GameScene>();
            if (sceneScript == null)
            {
                return false;
            }

            var link = sceneScript.NextTarget;
            if (link == null || string.IsNullOrEmpty(link.Scene))
            {
                return false;
            }

            targetScene = link.Scene;
            targetMarker = link.Marker;
            return true;
        }
    }
}