using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 后端入口：创建到权威服务器的连接与命令分发（WebSocket）。
    /// 对象状态由 OptionValue 选项组件（经 BackendObject 通信层）统一上报与控制，无需本地服务层。
    /// 管理器由 <see cref="Game"/> 初始化并持有（Game.Awake 挂到宿主物体），不再使用单例。
    /// </summary>
    public class BackendManager : MonoBehaviour
    {
        [SerializeField]
        private bool useServer = true;

        [SerializeField]
        private string serverUrl = "ws://localhost:1420/client";

        private Server.ServerConnection connection;
        private Server.ServerCommandDispatcher dispatcher;

        /// <summary>创建的 WebSocket 连接组件（Game.ServerConnection 即此连接）。</summary>
        public Server.ServerConnection Connection => connection;

        private void Awake()
        {
            if (useServer)
            {
                connection = gameObject.AddComponent<Server.ServerConnection>();
                connection.DefaultUrl = serverUrl;

                dispatcher = gameObject.AddComponent<Server.ServerCommandDispatcher>();
                connection.OnMessage += dispatcher.Dispatch;

                connection.Connect(serverUrl);
            }
        }

        private void OnDestroy()
        {
            // 与订阅配对：组件解挂/重建时事件不悬挂
            if (connection != null && dispatcher != null)
            {
                connection.OnMessage -= dispatcher.Dispatch;
            }
        }
    }
}