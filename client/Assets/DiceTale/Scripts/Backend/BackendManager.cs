using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 后端入口：创建到权威服务器的 WebSocket 连接（<see cref="Server.ServerConnection"/>）。
    ///
    /// **只做连接装配**：旧协议（上行注册与下行命令分发，`ServerCommandDispatcher`）已整层删除，
    /// 新协议在功能落地时重新定义——那时在这里（或新的管理器里）订阅
    /// <see cref="Server.ServerConnection.OnMessage"/> 并发出第一条消息即可。
    /// 管理器由 <see cref="Game"/> 初始化并持有（Game.Awake 挂到宿主物体），不再使用单例。
    /// </summary>
    public class BackendManager : MonoBehaviour
    {
        [SerializeField]
        private bool useServer = true;

        [SerializeField]
        private string serverUrl = "ws://localhost:1420/client";

        private Server.ServerConnection connection;

        /// <summary>创建的 WebSocket 连接组件（Game.ServerConnection 即此连接）。</summary>
        public Server.ServerConnection Connection => connection;

        private void Awake()
        {
            if (useServer)
            {
                connection = gameObject.AddComponent<Server.ServerConnection>();
                connection.DefaultUrl = serverUrl;
                connection.Connect(serverUrl);
            }
        }
    }
}
