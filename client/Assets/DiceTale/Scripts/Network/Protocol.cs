using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 客户端协议（与 `server/packages/protocol` 一一对应）。
    ///
    /// 方向是单向的：**服务端 → 前端的只有 `server_hello` / `scene_sync` / `command` / `ping`**；
    /// 前端只回三样：`client_hello`（自报家门）、`command_result`（回执）、`pong`（心跳）。
    /// 前端**不上报任何游戏数据**——数据在后台，前端只是它的镜像 + 播放器。
    /// </summary>
    public static class Protocol
    {
        /// <summary>
        /// 协议版本：与 `server/packages/protocol` 的 `PROTOCOL_VERSION` 一一对应。
        ///
        /// v2（2026-09-20）：服务端新增 `resources_prepare`——连上就把「当前是哪个项目」告诉前端，
        /// 让前端**先把资源包下完、再载入场景**。
        ///
        /// v3（2026-09-21）：新增战争雾两条命令（`erase_mask` / `reveal_fog_region`）。
        /// 版本必须与服务端**完全一致**（不一致时服务端以 close `4002` 断开并写明原因），
        /// 所以编辑器和前端要一起更新——这条规矩正是为了不让「新旧混着跑」悄悄失效。
        /// </summary>
        public const int Version = 3;

        // 服务端 → 前端
        public const string TypeServerHello = "server_hello";
        public const string TypeSceneSync = "scene_sync";
        public const string TypeCommand = "command";
        public const string TypePing = "ping";
        /// <summary>「先把当前项目的资源包拉下来」（在 `scene_sync` 之前到）。</summary>
        public const string TypeResourcesPrepare = "resources_prepare";

        // 前端 → 服务端
        public const string TypeClientHello = "client_hello";
        public const string TypeCommandResult = "command_result";
        public const string TypePong = "pong";
        /// <summary>本地资源包结果（成功 / 失败都报，编辑器运行面板据此显示进度）。</summary>
        public const string TypeResourcesReady = "resources_ready";

        // 资源包（HTTP，不走 WebSocket）
        /// <summary>问项目资源清单（拿指纹，决定要不要下整包）。</summary>
        public const string ManifestPath = "/api/resources/manifest?project=";
        /// <summary>整包 zip；带 `&v=<指纹>` 时指纹一致则服务端回 304。</summary>
        public const string BundlePath = "/api/resources/bundle?project=";

        // 命令种类
        public const string CommandPlaySound = "play_sound";
        public const string CommandStopSound = "stop_sound";
        /// <summary>战争雾：沿一笔轨迹擦掉地图对象上的雾（载荷是**轨迹**，不是整张遮罩）。</summary>
        public const string CommandEraseMask = "erase_mask";
        /// <summary>战争雾：整片揭示 / 整片盖回某个区域（区域位取自 `map.fog.regions`）。</summary>
        public const string CommandRevealFogRegion = "reveal_fog_region";

        /// <summary>关闸（编辑器退出运行态）时服务端用的 close code。</summary>
        public const int CloseRuntimeStopped = 4003;

        /// <summary>协议版本不一致时服务端用的 close code。</summary>
        public const int CloseProtocolMismatch = 4002;

        /// <summary>前端自称的名字与版本（编辑器运行面板上显示的就是它）。</summary>
        public const string ClientName = "DiceTale Unity";

        /// <summary>把 `ws://host:port/client` 推导成 `http://host:port`（取图 / 取音频走 HTTP）。</summary>
        public static string DeriveHttpBase(string websocketUrl)
        {
            if (string.IsNullOrEmpty(websocketUrl))
            {
                return "";
            }

            var http = websocketUrl.Replace("wss://", "https://").Replace("ws://", "http://");
            var index = http.IndexOf("/client", System.StringComparison.Ordinal);
            return index > 0 ? http.Substring(0, index) : http;
        }

        [System.Serializable]
        public class ClientHelloMessage
        {
            public string type = "client_hello";
            public int protocolVersion = Version;
            public string name = ClientName;
            public string version = "";
        }

        [System.Serializable]
        public class PongMessage
        {
            public string type = "pong";
            public int seq;
        }

        /// <summary>
        /// 命令回执。`reason` / `effects` 都**不能留 null**：`JsonUtility` 会把 null 写成 `null`，
        /// 而服务端的 zod 只接受「字符串 / 字符串数组」，所以这里一律给空值。
        /// </summary>
        [System.Serializable]
        public class CommandResultMessage
        {
            public string type = "command_result";
            public string requestId = "";
            public bool ok;
            public string reason = "";
            public string[] effects = new string[0];
        }

        /// <summary>
        /// 本地资源包结果。同样**不留 null**：服务端 zod 里 `reason` 是可选字符串，
        /// 但显式 `null` 会校验失败，所以空值一律给 `""`。
        /// </summary>
        [System.Serializable]
        public class ResourcesReadyMessage
        {
            public string type = "resources_ready";
            public string project = "";
            public string fingerprint = "";
            public int fileCount;
            /// <summary>
            /// 整包字节数。用 `long` 是因为单个包可能超过 int 上限（2 GB）——
            /// 服务端 zod 收的是 JSON 数字，不区分整型宽度，`JsonUtility` 也照常写成数字。
            /// </summary>
            public long bytes;
            public bool ok;
            public string reason = "";
        }
    }

    /// <summary>
    /// 服务端下发的命令（触发器：数据不在命令里，在前端自己的镜像里）。
    ///
    /// 字段是**扁平的多用途**：一条命令只填自己那几个（`play_sound` 用 `objectId + layer`；
    /// `erase_mask` 用 `objectId + stroke`；`reveal_fog_region` 用 `objectId + region + revealed`）。
    /// </summary>
    public class CommandRequest
    {
        public string requestId = "";
        public string kind = "";
        public string objectId = "";
        public string layer = "";

        /// <summary>`erase_mask`：归一化笔刷半径（**半径 / 遮罩宽**，编辑器固定 `48/960 = 0.05`）。</summary>
        public float radius;

        /// <summary>`erase_mask`：软边带比例（0=硬边、1=全程衰减；编辑器固定 1）。</summary>
        public float softness;

        /// <summary>`erase_mask`：鼠标拖过的**归一化轨迹点**（`[0,1]`、y 向下）。</summary>
        public readonly List<Vector2> points = new List<Vector2>();

        /// <summary>`reveal_fog_region`：区域位（与 `map.fog.regions` 里的值同一套）。</summary>
        public int region;

        /// <summary>`reveal_fog_region`：`true` = 整片揭示、`false` = 整片盖回。</summary>
        public bool revealed;
    }
}
