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
        ///
        /// v12（2026-09-23）：**两种实体的 kind 改名**——贴图 `Texture` → `Image`、
        /// 精灵 `SceneObject` → `Sprite`（后台那边 `SceneObject` 从此是**抽象基类**：
        /// 精灵与贴图都继承它，它自己不再出现在数据里）。
        /// 数据形状一个字节都没动，`kind` 也只是自由字符串；但**老前端（v11）不认这两个值**，
        /// 占位色会退回灰色（图照常显示——显示走组件名），属于「不是崩，是画面错」，
        /// 按同一条纪律 +1。**命令那一组仍然一个字节都没动。**
        ///
        /// v13（2026-09-25）：**战争雾拆成独立组件** `FogOfWar`（`components[]` 里多一种组件实例，
        /// data 是 `{ enabled, regions }`），不再挂在 `GridMap` 的 `map.fog` 下。语义不变：
        /// 没有组件 = 没开雾；组件在且 `enabled` 缺省 / true = 开；`regions` 仍是那 8 个可绘制位。
        /// 老前端（v12）只认 `map.fog`，拆出去后它眼里「雾设置」整个消失（没开雾），
        /// 不是画面错是行为丢，所以照旧 +1。**命令那一组仍然一个字节都没动。**
        ///
        /// v14（2026-09-26）：**显示顺序搬进渲染组件**。对象级 `sortingOrder` 没了，改成
        /// `GridMap` / 图片层（`ImageLayer` / `SpriteLayer`）的 data 各带一项 `sortingOrder`
        /// （int，缺省 0）；动作对象与没有渲染层的实体不再有这个字段。
        /// 老前端（v13）按对象级读，拿到 0 会让所有渲染层挤在同一层（不是崩，是遮挡顺序错乱），
        /// 所以照旧 +1。**命令那一组仍然一个字节都没动。**
        ///
        /// v15（2026-09-26）：**战争雾变成独立场景对象**（`kind: "Fog"`）。原来 `FogOfWar` 组件挂在
        /// 地图对象上；现在它挂在独立的雾对象上，data 多了 `mapId`（引用被雾罩住的那张地图，
        /// 地图上仍是 `GridMap`：贴图 + `grid` + `cells`）。雾对象**可摆放**，有自己的
        /// position / rotation / scale，但没有 `GridMap` / `ImageLayer` / `SpriteLayer`；
        /// 雾面片世界尺寸 = 被引用地图的显示图声明尺寸 × 雾对象 scale。
        /// 两条命令 `erase_mask` / `reveal_fog_region` 的 `objectId` 从此是**雾对象 id**（不再是地图 id）。
        /// 老前端（v14）眼里「雾设置」整个消失（没开雾），雾层不工作，属于「行为丢」，所以照旧 +1；
        /// 这类不兼容由握手 close `4002` 挡住，别指望老前端自己看出来。
        ///
        /// v16（2026-09-26）：**取消 `Map` 对象类型，网格变成贴图上的可选组件**。`GridMap` 的 data
        /// 去掉 `image` 与 `sortingOrder`，只剩 `grid` / `rowOrder` / `cells`；贴图 + 显示顺序改由
        /// 对象自己的 **`ImageLayer`** 组件承载（`kind` 是 `Image`）。老前端（v15）按 `map.image`
        /// 取图 → 取不到，地图对象会退成占位色（不是崩，是画面错），照旧 +1；
        /// 这类不兼容由握手 close `4002` 挡住。
        ///
        /// v17（2026-09-26）：**新增「视频混合」组件 `VideoBlend`**（两条视频叠在同一矩形上用
        /// Mask 混合：A 盖住、擦开露 B）+ 一条命令 `erase_video_mask`。老前端（v16）不认这个组件
        /// → 混合层不建（不是崩，是那一层没有），且收到 `erase_video_mask` 会回「不认识这条命令」——
        /// 属于「行为丢」，所以照旧 +1；这类不兼容由握手 close `4002` 挡住。
        ///
        /// v18（2026-09-26）：**视频混合多了 `autoPlay`**（场景激活时自动混合播放选中的两条，
        /// 与 `VideoOverlay` 的 `autoPlay` 同义）。组件 data 里多一个布尔，命令那一组一个字节都没动。
        /// 老前端（v17）不认这一项 → 不会自动播（不是崩，是行为丢），照旧 +1；
        /// 这类不兼容由握手 close `4002` 挡住。
        ///
        /// v19（2026-09-27）：**视频混合的两路从「列表 + 选中」收成单个素材**（`{ kind, id? }`），
        /// 且每路多了 `kind`（`image` / `video`）——这一路可以是**图片**也可以视频。老前端（v18）
        /// 按 `clips` / `picked` 读 → 两路都读不到（混合层放不出来），照旧 +1；
        /// 这类不兼容由握手 close `4002` 挡住。命令那一组一个字节都没动。
        ///
        /// v20（2026-09-27）：视频混合多一条命令 **`fill_video_mask`**（整张遮罩填成 1 / 0，
        /// Mask 窗口那两个「整张」按钮用）。老前端（v19）不认它 → 回一条未知命令
        /// （那两个按钮点了没反应），照旧 +1；这类不兼容由握手 close `4002` 挡住。
        /// 组件 data 一个字节都没动。
        ///
        /// v21（2026-09-27）：**新增「放大镜」对象**（与文档格式 v30 同一批）——第 9 种组件
        /// `Magnifier`（图片列表 + 当前展示的那一张），另加两条命令 `open_magnifier` /
        /// `close_magnifier`（让前端弹 / 收一扇窗）。老前端（v20）不认这个组件 → 那扇窗永远
        /// 弹不出来（不是崩，是功能丢），也不认那两条命令，照旧 +1；这类不兼容由握手
        /// close `4002` 挡住。**换图不是命令**：`picked` 是文档数据，整份 `scene_sync` 带下来。
        /// </summary>
        public const int Version = 21;

        /// <summary>对象特性组件的类型名（v9 起）。与服务端 `@dts/protocol` 的 `COMPONENT_TYPE` 逐字一致。</summary>
        public static class ComponentType
        {
            /// <summary>网格（v16 起是贴图上的**可选组件**，纯数据；贴图在 `ImageLayer` 里）。</summary>
            public const string Map = "GridMap";
            /// <summary>「显示一张图」：**贴图对象**与**带网格的贴图**都用它，整张铺满。</summary>
            public const string Image = "ImageLayer";
            /// <summary>「显示一张图」：**精灵对象**用它（`kind: "Sprite"`），会取图集里的一格。</summary>
            public const string Sprite = "SpriteLayer";
            public const string Sound = "PlaySound";
            public const string Teleport = "Teleport";
            /// <summary>
            /// 放大镜（v21 起，动作对象）：**图片列表 + 当前展示的那一张**（`{ images: [{ id, width,
            /// height, sprite?, spriteGrid? }], picked? }`，`picked` 是**下标**）。
            /// 对象自己不渲染任何东西（画布上那枚徽标是编辑器的画法）；触发它 = 由服务端的
            /// `open_magnifier` / `close_magnifier` 让前端弹 / 收一扇窗，窗里放的就是 `picked` 那张。
            /// **换图不是命令**：文档一改整份 `scene_sync` 带下来（见 `Logic/SceneMirror.cs`）。
            /// </summary>
            public const string Magnifier = "Magnifier";
            public const string Video = "VideoOverlay";
            /// <summary>
            /// 视频混合（v17 起）：**两路素材**叠在**同一个矩形**上用 Mask 混合（A 盖住、擦开露 B）。
            /// `{ a: { kind（image / video）, id }, b: { ... }, loop, autoPlay（v18 起）, audio }`——
            /// 每路只放**一个**素材（v19 起，之前是「列表 + 选中」），可以是图片或视频；
            /// **遮罩是纯运行态**（由 `erase_video_mask` 驱动），不随场景下发。与 `VideoOverlay` 语义互斥
            /// （同一对象最多其一），前端取 `VideoBlend` 优先。
            /// </summary>
            public const string VideoBlend = "VideoBlend";
            /// <summary>
            /// 战争雾：**独立组件，挂在独立的 `Fog` 对象上**（v13 起从 `GridMap` 拆出；v15 起雾自身成对象）。
            /// `{ mapId, enabled, regions }`：`mapId` 引用被雾罩住的那张地图（地图那边仍是 `GridMap`）。
            /// </summary>
            public const string FogOfWar = "FogOfWar";
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
        /// <summary>战争雾：沿一笔轨迹擦掉**雾对象**上的雾（载荷是**轨迹**，不是整张遮罩）。</summary>
        public const string CommandEraseMask = "erase_mask";
        /// <summary>战争雾：整片揭示 / 整片盖回某个区域（区域位取自**那个雾对象**的 `FogOfWar` 组件）。</summary>
        public const string CommandRevealFogRegion = "reveal_fog_region";
        /// <summary>视频混合：沿一笔轨迹擦掉**贴图对象**上的混合遮罩（载荷与 `erase_mask` 同一套 `stroke`）。</summary>
        public const string CommandEraseVideoMask = "erase_video_mask";
        /// <summary>视频混合：把**整张**混合遮罩填成 1 / 0（`covered` = true 是盖住、false 是擦开）。</summary>
        public const string CommandFillVideoMask = "fill_video_mask";
        /// <summary>
        /// 放大镜（v21）：让前端**弹一扇窗**显示**这个对象** `picked` 那张图（命令里不带数据）。
        /// 前端那扇窗**没有按钮**（没有选择、也没有关闭）——只能由后端开、由后端关。
        /// </summary>
        public const string CommandOpenMagnifier = "open_magnifier";
        /// <summary>放大镜：关掉那扇窗（`objectId` 用来**认领**：只关正为它开着的那一扇）。</summary>
        public const string CommandCloseMagnifier = "close_magnifier";
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
    /// `fill_video_mask` 用 `objectId + covered`；`open_magnifier` / `close_magnifier` 只用
    /// `objectId`；`play_bgm` 用 `clip`）。
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

        /// <summary>`reveal_fog_region`：区域位（与那个雾对象的 `FogOfWar` 组件 `regions` 里的值同一套）。</summary>
        public int region;

        /// <summary>`reveal_fog_region`：`true` = 整片揭示、`false` = 整片盖回。</summary>
        public bool revealed;

        /// <summary>`fill_video_mask`：`true` = 整张盖住（遮罩 = 1），`false` = 整张擦开（遮罩 = 0）。</summary>
        public bool covered;
    }
}
