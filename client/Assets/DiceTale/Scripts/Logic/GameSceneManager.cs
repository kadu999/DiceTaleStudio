using System.Collections;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 场景容器管理器：负责加载 / 切换 / 卸载「场景」。
    /// 场景从 Resources 按名加载同名 prefab（`Resources.Load&lt;GameObject&gt;(场景名)`，子目录 `Scenes/` 兜底），
    /// 实例里的地图（<see cref="GridMap"/>）再从 `Scenes/&lt;地图名&gt;.bytes` 载入网格数据。
    ///
    /// **旧模型的东西全部摘掉**：不再向上报（`register_map_objects` / 玩家与对象位置）、不再管玩家落位、
    /// 不再读场景脚本（`GameScene` / `SceneState` 已删除）、不再算归一化坐标。
    ///
    /// **场景数据载体还没定**（服务端 `.bytes` 导出属后续里程碑；也可能改成后台下发场景 JSON，
    /// 见 `client/docs/2026-09-19-unused-code-removal.md` 的 D1），所以这里只保留现有这条
    /// 「按预置体搭场景」的最小骨架：加载 / 卸载 / 淡入淡出。新方向落地后，本类要么换成
    /// 「按后台数据搭场景」，要么保留并在加载后接后台下发的对象数据。
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

        /// <summary>进行中的淡入淡出切换协程（防重入：切换期间忽略新的 LoadScene 请求）。</summary>
        private Coroutine sceneFadeRoutine;

        /// <summary>当前场景名（未加载时为 null）。</summary>
        public string CurrentSceneName { get; private set; }

        private GameObject CurrentScene { get; set; }

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
            // 初始场景：LoadScene 自带淡入淡出（开场从黑屏淡入）
            LoadScene(initialSceneName);
        }

        /// <summary>
        /// 加载并切换到指定场景。所有场景/地图切换（将来的服务端切图命令、传送命令）都汇聚到这里，
        /// **统一带淡入淡出**：协程先打开全屏遮罩（<see cref="SceneFadeUI"/>）→ 淡出到黑 →
        /// 黑屏中同步切换（卸载旧 / 加载新）→ 淡入还原。遮罩不可用（无 UIManager/窗口）或
        /// <see cref="sceneFadeEnabled"/> 为 false 时退化为直接同步切换。
        /// </summary>
        public void LoadScene(string sceneName)
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
                SwitchSceneCore(sceneName);
                return;
            }

            if (sceneFadeRoutine != null)
            {
                return; // 已有淡入淡出切换进行中：忽略重入
            }

            sceneFadeRoutine = StartCoroutine(LoadSceneWithFadeCoroutine(sceneName));
        }

        /// <summary>
        /// 淡入淡出切换协程：**先打开遮罩 UI**（保证切图瞬间屏幕已被罩住，不会闪）→ 淡出到全黑 →
        /// 黑屏中同步调用 <see cref="SwitchSceneCore"/> 切场景 → 淡入还原 → 关闭遮罩。
        /// </summary>
        private IEnumerator LoadSceneWithFadeCoroutine(string sceneName)
        {
            var fade = OpenFadeWindow();
            if (fade == null)
            {
                // 遮罩不可用（无 UIManager/窗口）：退化为直接同步切换
                SwitchSceneCore(sceneName);
                sceneFadeRoutine = null;
                yield break;
            }

            // 1) 淡出到全黑（遮罩先行盖住屏幕，切换瞬间无闪烁）
            fade.FadeToBlack(Mathf.Max(fadeOutDuration, 0.001f));
            while (fade.IsFading)
            {
                yield return null;
            }

            // 2) 黑屏中同步切换场景（卸载旧场景 / 建新场景）
            SwitchSceneCore(sceneName);

            // 黑屏切换期间可能有新 UI 出现，淡入前把遮罩再提到 Canvas 最上层，保证「慢慢变亮」的效果盖住它们
            fade.transform.SetAsLastSibling();

            // 3) 淡入还原新场景
            fade.FadeFromBlack(Mathf.Max(fadeInDuration, 0.001f));
            while (fade.IsFading)
            {
                yield return null;
            }

            // 4) 淡入完成：隐藏遮罩窗口（保留注册，可再开）
            fade.Close();
            sceneFadeRoutine = null;
        }

        /// <summary>打开（或获取已打开的）全屏淡入淡出遮罩窗口；无 UIManager 时返回 null。</summary>
        private static SceneFadeUI OpenFadeWindow()
        {
            var ui = Game.Instance != null ? Game.Instance.UIManager : null;
            return ui != null ? ui.OpenWindow<SceneFadeUI>() : null;
        }

        /// <summary>同步切换核心：真正的场景替换（卸载旧 / 加载新），供淡入淡出黑屏中调用，
        /// 也供遮罩不可用时直接切换。调用方需自行保证防重入。</summary>
        private void SwitchSceneCore(string sceneName)
        {
            var game = Game.Instance; // 宿主：管理器与宿主同物体，直接引用
            game?.LockInteraction(interactionLockDuration);

            UnloadCurrentScene();

            CurrentScene = CreateSceneGameObject(sceneName);
            if (CurrentScene == null)
            {
                Debug.LogError($"Scene prefab not found: {sceneName}（Resources 里没有同名预设，场景只能通过预设加载）");
                return;
            }

            CurrentSceneName = sceneName;
        }

        /// <summary>建出场景实例：Resources 里必须有同名预设；没有预设返回 null（由调用方报错）。
        /// 从场景内找到地图（<see cref="GridMap"/>）并用它的 .bytes 网格数据覆盖（保持服务端/客户端一致的障碍数据）。</summary>
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

        /// <summary>卸载当前场景（销毁场景实例；旧模型里的场景脚本卸载钩子已随 GameScene 删除）。</summary>
        private void UnloadCurrentScene()
        {
            if (CurrentScene != null)
            {
                Destroy(CurrentScene);
                CurrentScene = null;
            }
        }
    }
}
