using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 场景脚本基类：挂在场景预制体（SceneNNN）根节点上，表达该场景的场景级配置与生命周期。
    /// 场景的加载/切换/玩家落位/上报由 GameSceneManager 统一负责；
    /// 场景脚本只声明：场景 id、默认出生点、下一传送目标、加载/卸载钩子、场景状态列表，以及通用的出生点解析。
    /// 每个场景一个子类脚本（如 Game000/Game001…），类名与预制体名（SceneNNN）不必一致。
    /// </summary>
    public abstract class GameScene : MonoBehaviour
    {
        /// <summary>场景 id（与场景资源配置一致，如 "Scene000"）。</summary>
        public abstract string SceneId { get; }

        /// <summary>默认出生点 id（LoadScene 未指定 spawnId 时的落位目标）。</summary>
        public virtual string DefaultSpawnId => "Default";

        /// <summary>下一传送目标（next）：目标场景 + 目标标记；null 表示终点场景。</summary>
        public virtual SceneLink NextTarget => null;

        /// <summary>进入场景时在第 0 层播放的背景音乐（循环；每场景各配各的，留空 = 停掉第 0 层）。</summary>
        [SerializeField]
        private AudioClip sceneBackgroundMusic;

        /// <summary>场景背景音乐层（AudioPlayerManager 第 0 层：每层一首，换曲自动顶替）。</summary>
        private const int SceneMusicLayer = 0;

        /// <summary>场景加载完成钩子（场景实例已创建、已成为当前场景后调用）：默认播本场景背景音乐
        /// （第 0 层；未配置则停掉该层）。**第 0 层正在播同曲时直接保持**（不重启，避免切换突兀）。
        /// 子类覆写时须调用 base.OnSceneLoaded(manager)。</summary>
        public virtual void OnSceneLoaded(GameSceneManager manager)
        {
            var audio = Game.Instance != null ? Game.Instance.AudioPlayerManager : null;
            if (audio == null)
            {
                return;
            }

            // 相同背景音乐就不切换：第 0 层已在播同曲 → 保持续播（也不走 Stop/Play 路径）
            if (sceneBackgroundMusic != null && audio.IsBackgroundClipPlaying(SceneMusicLayer, sceneBackgroundMusic))
            {
                return;
            }

            if (sceneBackgroundMusic != null)
            {
                audio.PlayBackground(SceneMusicLayer, sceneBackgroundMusic);
            }
            else
            {
                audio.StopBackground(SceneMusicLayer);
            }
        }

        /// <summary>场景卸载前钩子（旧场景销毁前调用）。</summary>
        public virtual void OnSceneUnloaded() { }

        // ---------- 场景状态列表（GM 页地图下方显示；选中激活、上一个隐藏） ----------

        private SceneState[] cachedStates;
        private int currentStateIndex = -1;

        /// <summary>当前激活的状态下标（-1 = 无状态列表或暂无激活状态）。</summary>
        public int CurrentStateIndex => currentStateIndex;

        /// <summary>场景状态列表（按场景内 SceneState 层级顺序；含未激活的状态物体）。</summary>
        public IReadOnlyList<SceneState> States
        {
            get
            {
                if (cachedStates == null)
                {
                    CollectStates();
                }
                return cachedStates;
            }
        }

        protected virtual void Awake()
        {
            // 场景实例化时收集状态列表（子类覆写 Awake 时需调用 base.Awake()）
            CollectStates();
        }

        /// <summary>收集场景内全部 SceneState（含未激活），并把初始激活态归一化为「至多一个」：
        /// 多个同时激活时只保留第一个，其余隐藏。
        /// 同时做建模校验（只警告不阻断）：状态根嵌套、状态内包含玩家（见 GameScene 类注释）。</summary>
        private void CollectStates()
        {
            cachedStates = GetComponentsInChildren<SceneState>(true);

            for (int i = 0; i < cachedStates.Length; i++)
            {
                // a) 状态根之间应平级：嵌套会导致重复收集、状态切换互相影响
                for (int j = 0; j < cachedStates.Length; j++)
                {
                    if (i != j && cachedStates[j] != null &&
                        cachedStates[i].transform.IsChildOf(cachedStates[j].transform))
                    {
                        Debug.LogWarning(
                            $"[GameScene:{SceneId}] 场景状态 {cachedStates[i].name} 嵌套在状态 {cachedStates[j].name} 内，" +
                            "状态根应平级（嵌套会导致状态切换互相干扰）。");
                        break;
                    }
                }

                // b) 状态内不应包含玩家：状态切换会把玩家从 GM 玩家名单移除/恢复（含道具分配区）
                var players = cachedStates[i].GetComponentsInChildren<BackendObject>(true);
                for (int k = 0; k < players.Length; k++)
                {
                    if (players[k] != null && players[k].ObjectKind == "Player")
                    {
                        Debug.LogWarning(
                            $"[GameScene:{SceneId}] 状态 {cachedStates[i].name} 内包含玩家 {players[k].ObjectId}；" +
                            "状态切换会把它从 GM 玩家名单移除/恢复，建议玩家挂在场景根而非状态内。");
                    }
                }
            }

            var firstActive = -1;
            for (int i = 0; i < cachedStates.Length; i++)
            {
                if (cachedStates[i].gameObject.activeSelf)
                {
                    if (firstActive < 0)
                    {
                        firstActive = i;
                    }
                    else
                    {
                        cachedStates[i].gameObject.SetActive(false); // 归一化：只剩第一个激活
                    }
                }
            }

            currentStateIndex = firstActive;
        }

        /// <summary>切换场景状态：激活 index 对应状态 GameObject、隐藏其余（上一个自动隐藏）。
        /// index 越界/无状态列表返回 false。</summary>
        public bool ApplyState(int index)
        {
            if (cachedStates == null)
            {
                CollectStates();
            }

            if (cachedStates.Length == 0 || index < 0 || index >= cachedStates.Length)
            {
                return false;
            }

            if (index == currentStateIndex)
            {
                return true; // 已是目标状态（幂等）：不重复切换，避免无谓的注册/补报抖动
            }

            for (int i = 0; i < cachedStates.Length; i++)
            {
                cachedStates[i].gameObject.SetActive(i == index);
            }

            currentStateIndex = index;
            return true;
        }

        // ---------- 出生点与初始落位（通用实现，子类可覆写） ----------

        /// <summary>按名字查找出生点：优先「Spawn_{spawnId}」子物体（忽略大小写），
        /// 找不到回退第一个 Spawn_ 前缀或名为 SpawnPoint 的子物体；没有则返回 null。</summary>
        public virtual Transform FindSpawn(string spawnId)
        {
            var expected = "Spawn_" + (spawnId ?? "Default");
            Transform fallback = null;
            foreach (var t in GetComponentsInChildren<Transform>(true))
            {
                if (string.Equals(t.name, expected, System.StringComparison.OrdinalIgnoreCase))
                {
                    return t;
                }

                if (fallback == null &&
                    (t.name.StartsWith("Spawn_", System.StringComparison.OrdinalIgnoreCase) ||
                     string.Equals(t.name, "SpawnPoint", System.StringComparison.OrdinalIgnoreCase)))
                {
                    fallback = t;
                }
            }

            return fallback;
        }

        /// <summary>解析初始落位点：出生点（Spawn_*）→ 第一个 MapMarker → 网格锚点；都没有返回 null。
        /// 玩家落位时 GameSceneManager 调用（无场景脚本的旧场景保留管理器的回退逻辑）。
        /// 出生点与 MapMarker 的查找都包含未激活物体（与出生点名单收集口径一致——标记不因所在状态未激活而失效）。</summary>
        public virtual Vector3? ResolveLandingPoint(string spawnId)
        {
            var spawn = FindSpawn(spawnId);
            if (spawn != null)
            {
                return spawn.position;
            }

            var markers = GetComponentsInChildren<MapMarker>(true);
            if (markers.Length > 0)
            {
                return markers[0].Position;
            }

            var grid = GetComponentInChildren<GridMap>();
            if (grid != null)
            {
                return grid.GridOrigin + new Vector3(grid.CellSize * 0.5f, 0f, grid.CellSize * 0.5f);
            }

            return null;
        }
    }

    /// <summary>场景链传送目标：目标场景 + 目标标记（标记可为空）。</summary>
    public class SceneLink
    {
        public readonly string Scene;
        public readonly string Marker;

        public SceneLink(string scene, string marker = null)
        {
            Scene = scene;
            Marker = marker;
        }
    }
}