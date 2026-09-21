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
        private AudioClipLoader audioLoader;

        /// <summary>服务端 HTTP 基地址（从 WebSocket 地址推导；取图走它）。</summary>
        public string HttpBaseUrl => Protocol.DeriveHttpBase(serverUrl);

        /// <summary>当前那份项目级全局设置（三档音量）；还没收到时是一份缺省设置。</summary>
        public MirrorSettings Settings { get; private set; } = new MirrorSettings();

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

            // 取音频（背景音乐 / 音效 / 旁白都用它）：与取图同一套「本地优先、远程兜底」
            audioLoader = gameObject.AddComponent<AudioClipLoader>();
            audioLoader.Initialize(HttpBaseUrl);
            audioLoader.Attach(bundleCache);

            mirror = gameObject.AddComponent<SceneMirror>();
            mirror.Initialize(session, imageLoader, bundleCache);

            commandRouter = gameObject.AddComponent<CommandRouter>();
            // 命令路由要资源包、HTTP 地址与音频（视频 / 音频的「本地优先、远程兜底」都在这里解析）。
            // 播放器由宿主 Game 持有：`Game.Awake` 里**先建它再建本组件**，所以这里通常拿得到；
            // 拿不到也不致命——命令路由会在用到时再解析一次，真没有就如实回失败
            var game = Game.Instance;
            commandRouter.Initialize(
                session,
                mirror,
                bundleCache,
                HttpBaseUrl,
                audioLoader,
                game != null ? game.AudioPlayerManager : null);

            // 项目级全局设置：收到就整套应用到播放器（音量立刻生效，不需要命令）
            session.SettingsReceived += OnSettingsReceived;

            // 会话结束（编辑器关闸 / 断线）：**停掉所有声音**——前端被踢下线后不该继续响
            session.OnClosed += OnSessionClosed;

            // 立刻开始连：编辑器还没点「运行」时会被服务端拒（正常现象，连接会一直重试）
            connection.Connect(serverUrl);
        }

        private void OnDestroy()
        {
            if (session != null)
            {
                session.SettingsReceived -= OnSettingsReceived;
                session.OnClosed -= OnSessionClosed;
            }
        }

        private void OnSessionClosed()
        {
            var game = Game.Instance;
            if (game != null && game.AudioPlayerManager != null)
            {
                game.AudioPlayerManager.StopAll();
            }
        }

        private void OnSettingsReceived(MirrorSettings settings)
        {
            Settings = settings ?? new MirrorSettings();

            var game = Game.Instance;
            if (game != null && game.AudioPlayerManager != null)
            {
                game.AudioPlayerManager.ApplySettings(Settings);
            }

            Debug.Log(
                $"[设置] 全局设置已应用：音量 bgm={Settings.audio.bgm.volume:0.##}" +
                $" / sfx={Settings.audio.sfxVolume:0.##} / voice={Settings.audio.voiceVolume:0.##}" +
                "（背景音乐放哪一首由 play_bgm 命令说）");
        }
    }
}
