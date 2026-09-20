using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 后端入口：把「连接 + 会话 + 镜像 + 命令 + 资源」这几件事装配起来。
    ///
    /// 数据方向是单向的（后台 → 前端）：
    /// - <see cref="ServerConnection"/>：WebSocket 连接（编辑器没点「运行」时服务端拒握手，自动重试）；
    /// - <see cref="ClientSession"/>：协议会话（握手、心跳、把原始消息变成事件）；
    /// - <see cref="SceneMirror"/>：把推下来的场景变成前端自己的对象（**后台有什么，前端就有什么**）；
    /// - <see cref="CommandRouter"/>：把命令变成动作并回执；
    /// - <see cref="ResourceBundleCache"/>：连上就把当前项目的 `Assets/` 整包拉到本地；
    /// - <see cref="ResourceImageLoader"/>：按资源逻辑 ID 取图（本地包优先，缺的回落服务端 HTTP）。
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
        private ResourceBundleCache bundleCache;
        private ResourceImageLoader imageLoader;

        /// <summary>创建的 WebSocket 连接组件（Game.ServerConnection 即此连接）。</summary>
        public ServerConnection Connection => connection;

        /// <summary>协议会话（连接状态、会话 id 都在它身上）。</summary>
        public ClientSession Session => session;

        /// <summary>场景镜像（命令要用它读对象数据，例如该播哪一条音频）。</summary>
        public SceneMirror Mirror => mirror;

        /// <summary>本地资源包（诊断 / 手动重试用）。</summary>
        public ResourceBundleCache BundleCache => bundleCache;

        /// <summary>服务端 HTTP 基地址（从 WebSocket 地址推导；取图走它）。</summary>
        public string HttpBaseUrl => Protocol.DeriveHttpBase(serverUrl);

        private void Awake()
        {
            if (!useServer)
            {
                return;
            }

            connection = gameObject.AddComponent<ServerConnection>();
            connection.DefaultUrl = serverUrl;

            session = gameObject.AddComponent<ClientSession>();
            session.Initialize(connection);

            // 资源包与取图器：**先建出来**再喂给镜像——服务端会在 scene_sync 之前发
            // `resources_prepare`，那时资源包必须已经能收消息并按项目开下；
            // 镜像也会把场景挂起到资源包处理完为止（先下资源、再载入场景）。
            bundleCache = gameObject.AddComponent<ResourceBundleCache>();
            bundleCache.Initialize(HttpBaseUrl, session);

            imageLoader = gameObject.AddComponent<ResourceImageLoader>();
            imageLoader.Initialize(HttpBaseUrl);
            imageLoader.Attach(bundleCache);

            mirror = gameObject.AddComponent<SceneMirror>();
            mirror.Initialize(session, imageLoader, bundleCache);

            commandRouter = gameObject.AddComponent<CommandRouter>();
            commandRouter.Initialize(session, mirror);

            // 立刻开始连：编辑器还没点「运行」时会被服务端拒（正常现象，连接会一直重试）
            connection.Connect(serverUrl);
        }
    }
}
