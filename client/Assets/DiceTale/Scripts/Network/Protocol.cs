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
        ///
        /// v4（2026-09-21）：战争雾多一个**总开关**（`map.fog.enabled`）：只有开着才建那一层雾。
        /// 老前端不认这个字段会把它丢掉，于是「编辑器里关掉了」在前端照样生成雾——必须一起更新。
        ///
        /// v5（2026-09-21）：地图 / 精灵多了**视频**（`video` + `play_video` / `pause_video` /
        /// `resume_video` / `stop_video` 四条命令）。
        ///
        /// v6（2026-09-21）：声音补齐 `pause_sound` / `resume_sound`——编辑器里「播放声音对象」与
        /// 「视频」两组 UI 的控件行完全一致（播放 / 暂停 / 停止）。
        ///
        /// v7（2026-09-21）：**全局背景音乐**（项目级设置）落地。
        /// - 服务端新增 `project_settings`（音量 / 歌单 / 默认曲整份下发，收到即生效）；
        /// - 新增四条命令：`play_bgm` / `pause_bgm` / `resume_bgm` / `stop_bgm`；
        /// - 声音层级从四档收成三档（环境音并进背景音乐），对象只剩音效 / 旁白。
        /// 前两条老前端都接不住，所以照旧 +1。
        ///
        /// v8（2026-09-22）：**背景音乐与项目设置解耦**——`project_settings.audio.bgm` 只剩音量
        /// （歌单 / 默认曲 / 循环不再下发），命令那一组不变。载荷形状变了，所以照旧 +1。
        ///
        /// v9（2026-09-22）：**对象特性搬进组件**。场景对象上的 `map` / `image` / `sound` / `teleport` /
        /// `video` 这 5 个扁平字段没了，改成 `components[]` 里的组件实例（`GridMap` /
        /// `ImageLayer` / `SpriteLayer` / `PlaySound` / `Teleport` / `VideoOverlay`）。老前端按扁平字段读，
        /// 迁移后的场景在它眼里会变成「一个什么都不带的空对象」，所以必须 +1。
        /// **命令那一组一个字节都没动。**
        ///
        /// v10（2026-09-22）：**精灵（子图）**。贴图引用多了 `sprite`（取这张图里的第几格，
        /// `column` 从左数、`row` **从最上数**）与 `spriteGrid`（这张图几列几行）两项，
        /// 前端据此只画出那一块矩形（见 <see cref="SpriteLayer"/> 的 UV）。
        /// 老前端（v9）会**静默把整张图集铺出来**——不是崩，是画面错，所以照旧 +1：
        /// 服务端与前端必须一起更新。**命令那一组仍然一个字节都没动**（子图是数据，不是新动作）。
        ///
        /// v11（2026-09-23）：**「显示一张图」拆成两种组件 + 多一个「贴图」对象**。
        /// 对象自己那张图原来是 `TextureRenderer` 一种组件（精灵与贴图共用），现在分成
        /// `SpriteLayer`（**精灵**用，会取图集里的一格）/ `ImageLayer`（**贴图**用，整张铺满）；
        /// `kind` 多了一个 `Texture`（它是自由字符串，这一项本身不破坏兼容）。
        /// 老前端（v10）不认这两个新组件名 → 图取不到、只画一块占位色，所以必须 +1。
        /// **命令那一组仍然一个字节都没动**（这只是数据换了组件名）。
        /// </summary>
        public const int Version = 11;

        /// <summary>对象特性组件的类型名（v9 起）。与服务端 `@dts/protocol` 的 `COMPONENT_TYPE` 逐字一致。</summary>
        public static class ComponentType
        {
            public const string Map = "GridMap";
            /// <summary>「显示一张图」：**贴图对象**用它（`kind: "Texture"`），整张铺满。</summary>
            public const string Image = "ImageLayer";
            /// <summary>「显示一张图」：**精灵对象**用它（`kind: "SceneObject"`），会取图集里的一格。</summary>
            public const string Sprite = "SpriteLayer";
            public const string Sound = "PlaySound";
            public const string Teleport = "Teleport";
            public const string Video = "VideoOverlay";
        }

        // 服务端 → 前端
        public const string TypeServerHello = "server_hello";
        public const string TypeSceneSync = "scene_sync";
        public const string TypeCommand = "command";
        public const string TypePing = "ping";
        /// <summary>「先把当前项目的资源包拉下来」（在 `scene_sync` 之前到）。</summary>
        public const string TypeResourcesPrepare = "resources_prepare";
        /// <summary>项目级全局设置（三档音量）；在前端放东西之前到，收到即生效。</summary>
        public const string TypeProjectSettings = "project_settings";

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
        /// <summary>声音：暂停某一层（同层只响一条，所以「暂停这一层」= 暂停当前那条）。</summary>
        public const string CommandPauseSound = "pause_sound";
        /// <summary>声音：从暂停处继续放某一层。</summary>
        public const string CommandResumeSound = "resume_sound";
        /// <summary>战争雾：沿一笔轨迹擦掉地图对象上的雾（载荷是**轨迹**，不是整张遮罩）。</summary>
        public const string CommandEraseMask = "erase_mask";
        /// <summary>战争雾：整片揭示 / 整片盖回某个区域（区域位取自 `map.fog.regions`）。</summary>
        public const string CommandRevealFogRegion = "reveal_fog_region";
        /// <summary>视频：在对象自己的矩形上放它 `video.picked` 那一条（命令里不带数据）。</summary>
        public const string CommandPlayVideo = "play_video";
        /// <summary>视频：暂停在当前帧。</summary>
        public const string CommandPauseVideo = "pause_video";
        /// <summary>视频：从暂停处续播。</summary>
        public const string CommandResumeVideo = "resume_video";
        /// <summary>视频：停止并拆掉那一层（露出对象原来的贴图）。</summary>
        public const string CommandStopVideo = "stop_video";
        /// <summary>背景音乐（v7）：放 / 切换到**指定的那一首**（清单在编辑器弹框里，所以命令带 clip）。</summary>
        public const string CommandPlayBgm = "play_bgm";
        /// <summary>背景音乐：暂停在当前处。</summary>
        public const string CommandPauseBgm = "pause_bgm";
        /// <summary>背景音乐：从暂停处继续。</summary>
        public const string CommandResumeBgm = "resume_bgm";
        /// <summary>背景音乐：停掉。</summary>
        public const string CommandStopBgm = "stop_bgm";

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
    /// `erase_mask` 用 `objectId + stroke`；`reveal_fog_region` 用 `objectId + region + revealed`；
    /// `play_bgm` 用 `clip`）。
    /// </summary>
    public class CommandRequest
    {
        public string requestId = "";
        public string kind = "";
        public string objectId = "";
        public string layer = "";

        /// <summary>
        /// `play_bgm`：要放的那一首（资源逻辑 ID）。
        ///
        /// 背景音乐的命令**带数据**（与视频 / 声音不同）：曲目清单不在任何对象上、也不在项目设置里
        /// （v8 起），它就是**项目 `Assets/audio/` 下的音频文件**，由编辑器弹框列出来给 DM 点——
        /// 所以命令说「现在放哪一首」，前端按 `clip` 去资源包里找音频。
        /// </summary>
        public string clip = "";

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
