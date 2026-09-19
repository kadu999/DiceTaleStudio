using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 流程命令列表：按顺序执行一组可配置命令（Inspector 中用 [SerializeReference]
    /// 添加具体命令，如「创建角色」CreatePlayersCommand、「切换场景」LoadSceneCommand）。
    /// 由流程触发点（如 Scene000 角色视频全部播完）调用 <see cref="Execute"/>。
    /// </summary>
    public class SceneFlowCommandList : MonoBehaviour
    {
        [SerializeField, Tooltip("按顺序执行的流程命令（Inspector 右上角 + 添加）")]
        private List<SceneFlowCommand> commands = new List<SceneFlowCommand>();

        /// <summary>按顺序执行所有命令。</summary>
        public void Execute()
        {
            foreach (var cmd in commands)
            {
                if (cmd != null)
                {
                    cmd.Execute();
                }
            }
        }

        /// <summary>追加一条命令（代码侧预填默认流程时使用）。</summary>
        public void AddCommand(SceneFlowCommand command)
        {
            if (command != null)
            {
                commands.Add(command);
            }
        }

        /// <summary>当前命令条数（Inspector 未配置时用于判断是否需预填默认流程）。</summary>
        public int Count => commands != null ? commands.Count : 0;
    }

    /// <summary>流程命令基类（可序列化抽象，Inspector 通过 [SerializeReference] 选择具体命令类型）。</summary>
    [System.Serializable]
    public abstract class SceneFlowCommand
    {
        public abstract void Execute();
    }

    /// <summary>创建角色命令：按人数创建玩家（CharacterManager.CreatePlayers）。</summary>
    [System.Serializable]
    public class CreatePlayersCommand : SceneFlowCommand
    {
        [SerializeField, Tooltip("创建的角色（玩家）数量")]
        private int count = 4;

        public CreatePlayersCommand() { }

        public CreatePlayersCommand(int count)
        {
            this.count = count;
        }

        public override void Execute()
        {
            var manager = Game.Instance != null ? Game.Instance.CharacterManager : null;
            if (manager != null)
            {
                manager.CreatePlayers(count);
            }
        }
    }

    /// <summary>切换场景命令：LoadScene(sceneName, spawnId)（进入下一张地图）。
    /// 淡入淡出由 GameSceneManager.LoadScene 统一处理（所有场景切换都带），命令层不控制。</summary>
    [System.Serializable]
    public class LoadSceneCommand : SceneFlowCommand
    {
        [SerializeField, Tooltip("目标场景名（如 Scene001）")]
        private string sceneName = "Scene001";

        [SerializeField, Tooltip("出生点 id（默认 Default）")]
        private string spawnId = "Default";

        public LoadSceneCommand() { }

        public LoadSceneCommand(string sceneName, string spawnId = "Default")
        {
            this.sceneName = sceneName;
            this.spawnId = spawnId;
        }

        public override void Execute()
        {
            var sceneManager = Game.Instance != null ? Game.Instance.GameSceneManager : null;
            sceneManager?.LoadScene(sceneName, spawnId);
        }
    }
}