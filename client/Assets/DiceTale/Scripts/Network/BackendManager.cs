using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 后端入口：把「连接 + 会话 + 镜像 + 命令 + 取图」这几件事装配起来。
    ///
    /// 数据方向是单向的（后台 → 前端）：
    /// - <see cref="ServerConnection"/>：WebSocket 连接（编辑器没点「运行」时服务端拒握手，自动重试）；
    /// - <see cref="ClientSession"/>：协议会话（握手、心跳、把原始消息变成事件）；
    /// - <see cref="SceneMirror"/>：把推下来的场景变成前端自己的对象（**后台有什么，前端就有什么**）；
    /// - <see cref="CommandRouter"/>：把命令变成动作并回执；
    /// - <see cref="ResourceImageLoader"/>：按资源逻辑 ID 取图（走服务端 HTTP 接口）。
    ///
    /// 管理器由 <see cref="Game"/> 初始化并持有（Game.Awake 挂到宿主物体），不再使用单例。
    /// </summary>
    public class BackendManager : MonoBehaviour
    {
        [SerializeField]
        private bool useServer = true;

        [SerializeField]
        private string serverUrl = "ws://localhost:1420/client";

        private ServerConnection connection;
        private ClientSession session;
        private SceneMirror mirror;
        private CommandRouter commandRouter;
        private ResourceImageLoader imageLoader;

        /// <summary>创建的 WebSocket 连接组件（Game.ServerConnection 即此连接）。</summary>
        public ServerConnection Connection => connection;

        /// <summary>协议会话（连接状态、会话 id 都在它身上）。</summary>
        public ClientSession Session => session;

        /// <summary>场景镜像（命令要用它读对象数据，例如该播哪一条音频）。</summary>
        public SceneMirror Mirror => mirror;

        /// <summary>服务端 HTTP 基地址（从 WebSocket 地址推导；取图走它）。</summary>
        public string HttpBaseUrl => Protocol.DeriveHttpBase(serverUrl);

        private void Awake()
        {
            if (!useServer)
            {
                return;
            }

            imageLoader = gameObject.AddComponent<ResourceImageLoader>();
            imageLoader.Initialize(HttpBaseUrl);

            connection = gameObject.AddComponent<ServerConnection>();
            connection.DefaultUrl = serverUrl;

            session = gameObject.AddComponent<ClientSession>();
            session.Initialize(connection);

            mirror = gameObject.AddComponent<SceneMirror>();
            mirror.Initialize(session, imageLoader);

            commandRouter = gameObject.AddComponent<CommandRouter>();
            commandRouter.Initialize(session, mirror);

            // 立刻开始连：编辑器还没点「运行」时会被服务端拒（正常现象，连接会一直重试）
            connection.Connect(serverUrl);
        }
    }
}
