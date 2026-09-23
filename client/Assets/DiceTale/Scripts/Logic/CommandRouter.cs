using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 命令路由：把服务端下发的命令变成前端的动作，并**无论成败都回执**。
    ///
    /// 命令是**触发器**，不是数据：例如 `play_sound{objectId, layer}` 里没有音频路径，
    /// 前端要从**自己的镜像**里读出那个对象声明的 `sound.picked`（数据在后台推下来的场景里）。
    /// 所以镜像里找不到对象时，就直接告诉编辑器「镜像里没有这个对象」——
    /// 这类失败恰恰说明镜像没同步上，不该被掩盖。
    ///
    /// 战争雾的两条命令同理：`erase_mask` 只给**鼠标轨迹**，`reveal_fog_region` 只给区域位，
    /// 雾层本身在前端镜像里那张地图上（`map.fog.enabled` + `map.fog.regions` + `map.cells`），由
    /// <see cref="SceneObjectView.Fog"/> 执行——开关关着时那一层根本不存在，命令会如实回失败原因。
    ///
    /// 声音（v7 起**真的出声**）：`play_sound` / `stop_sound` / `pause_sound` / `resume_sound`
    /// 按**层级**作用在 <see cref="AudioPlayerManager"/> 的三条通道上（音效 / 旁白）。
    /// `layer == "bgm"` 的老对象会被明确拒掉——背景音乐不在对象上，
    /// 走的是另一组命令（`play_bgm` / `pause_bgm` / `resume_bgm` / `stop_bgm`）。
    /// 那组命令是**唯一带数据**的一组（`clip`）：清单就是编辑器弹框里列出来的项目音频，
    /// 点一首就发一条。音频片段按逻辑 ID 取（本地资源包优先，见 <see cref="AudioClipLoader"/>）。
    ///
    /// 视频（`play_video` / `pause_video` / `resume_video` / `stop_video`）同样**已经实现**：
    /// 放哪一条、循环、声音都从镜像里那个对象的 `video` 读，画面盖在它自己的矩形上
    /// （<see cref="SceneObjectView.PlayVideo"/> → <see cref="VideoOverlay"/>）。
    /// </summary>
    public class CommandRouter : MonoBehaviour
    {
        private ClientSession session;
        private SceneMirror mirror;

        /// <summary>资源包（视频 / 音频的「本地优先」要用它把逻辑 ID 换成 `file://` 地址）。</summary>
        private ResourceBundleCache bundleCache;

        /// <summary>服务端 HTTP 基地址（本地没有那份资源时回退到 `/api/resources/raw`）。</summary>
        private string httpBaseUrl = "";

        /// <summary>按逻辑 ID 取音频片段（缓存 + 去重，见 <see cref="AudioClipLoader"/>）。</summary>
        private AudioClipLoader audioLoader;

        /// <summary>
        /// 声源（三条通道：背景音乐 / 音效 / 旁白）。
        ///
        /// **用到时再解析一次**：装配顺序曾经让这里拿到过 null（`BackendManager` 比
        /// `AudioPlayerManager` 先建），而 `Game.Instance.AudioPlayerManager` 后来是有的——
        /// 所以不把「装配那一刻的值」当永恒事实（真机上 `play_bgm` 因此回过一次
        /// 「前端没有装配音频播放器」）。
        /// </summary>
        private AudioPlayerManager audio;

        private AudioPlayerManager Audio
        {
            get
            {
                if (audio == null)
                {
                    var game = Game.Instance;
                    audio = game != null ? game.AudioPlayerManager : null;
                }

                return audio;
            }
        }

        /// <summary>
        /// 「暂停」赶在「播放」前头到时的补丁：记下意图 + **一个短窗口**。
        ///
        /// 为什么需要它：编辑器补发暂停态是 `play` + `pause` 两条连发，而取音频要几十毫秒——
        /// `pause` 到时那条通道还没有内容可暂停，不记意图的话重连后会从头响起来。
        ///
        /// 为什么还要有**窗口**（几秒内有效）：这个意图不能无限期留着。真机上踩过一次——
        /// 上一轮运行态里发过一条「暂停」（那时什么都没在放），几分钟后 DM 手动放一首，
        /// 一落地就被那条陈旧意图暂停了：`play_bgm` 回执成功、`AudioSource` 却停在第 0 秒。
        /// </summary>
        private readonly Dictionary<string, float> pendingPauseLayers = new Dictionary<string, float>();

        /** 上面那个意图的有效窗口（秒）。 */
        private const float PendingPauseWindowSeconds = 5f;

        /// <summary>接上会话、镜像、资源来源与播放器（由 <see cref="BackendManager"/> 调用一次）。</summary>
        public void Initialize(
            ClientSession clientSession,
            SceneMirror sceneMirror,
            ResourceBundleCache cache,
            string httpBase,
            AudioClipLoader clipLoader,
            AudioPlayerManager player)
        {
            session = clientSession;
            mirror = sceneMirror;
            bundleCache = cache;
            httpBaseUrl = httpBase ?? "";
            audioLoader = clipLoader;
            audio = player;
            session.CommandReceived += OnCommand;
        }

        private void OnDestroy()
        {
            if (session != null)
            {
                session.CommandReceived -= OnCommand;
            }
        }

        private void OnCommand(CommandRequest command)
        {
            try
            {
                Handle(command);
            }
            catch (System.Exception error)
            {
                // 前端自己炸了也要回执：不回的话编辑器只能等到 5 秒超时，看不出真正的原因
                Debug.LogError($"[命令] 处理 {command.kind} 时出错：{error}");
                if (session != null)
                {
                    session.SendCommandResult(command, false, $"前端处理这条命令时出错：{error.Message}");
                }
            }
        }

        private void Handle(CommandRequest command)
        {
            switch (command.kind)
            {
                case Protocol.CommandPlaySound:
                    HandlePlaySound(command);
                    return;

                case Protocol.CommandStopSound:
                    HandleStopSound(command);
                    return;

                case Protocol.CommandPauseSound:
                    HandlePauseSound(command);
                    return;

                case Protocol.CommandResumeSound:
                    HandleResumeSound(command);
                    return;

                case Protocol.CommandEraseMask:
                    HandleEraseMask(command);
                    return;

                case Protocol.CommandRevealFogRegion:
                    HandleRevealFogRegion(command);
                    return;

                case Protocol.CommandPlayVideo:
                    HandlePlayVideo(command);
                    return;

                case Protocol.CommandPauseVideo:
                    HandlePauseVideo(command);
                    return;

                case Protocol.CommandResumeVideo:
                    HandleResumeVideo(command);
                    return;

                case Protocol.CommandStopVideo:
                    HandleStopVideo(command);
                    return;

                case Protocol.CommandPlayBgm:
                    HandlePlayBgm(command);
                    return;

                case Protocol.CommandPauseBgm:
                    HandlePauseBgm(command);
                    return;

                case Protocol.CommandResumeBgm:
                    HandleResumeBgm(command);
                    return;

                case Protocol.CommandStopBgm:
                    HandleStopBgm(command);
                    return;

                default:
                    Debug.LogWarning($"[命令] 不认识的命令：{command.kind}");
                    session.SendCommandResult(command, false, $"前端不认识这条命令：{command.kind}");
                    return;
            }
        }

        // ---------------------------------------------------------------- 声音对象（音效 / 旁白）

        /// <summary>
        /// 播这个声音对象选中的那一条（命令只给 `objectId + layer`）。
        ///
        /// 三件事：对象在不在镜像里、有没有选中一条、那一层是不是**对象能用的层**
        /// （背景音乐已改成编辑器顶栏「音乐」弹框，对象上只剩音效 / 旁白）。
        /// 取音频是异步的，所以回执在加载完成后发——成功报「正在播放」，失败报拿不到的原因。
        /// </summary>
        private void HandlePlaySound(CommandRequest command)
        {
            var obj = mirror != null ? mirror.Find(command.objectId) : null;
            if (obj == null)
            {
                session.SendCommandResult(command, false, $"镜像里没有这个对象：{command.objectId}（场景可能还没同步到）");
                return;
            }

            var sound = obj.sound;
            if (sound == null || string.IsNullOrEmpty(sound.picked))
            {
                session.SendCommandResult(command, false, $"{obj.name}：还没选要播的音频（sound.picked 为空）");
                return;
            }

            // 镜像里的这条就是编辑器要前端播的那一条（命令里只给了 objectId + layer）
            var layer = string.IsNullOrEmpty(command.layer) ? sound.layer : command.layer;
            if (layer == "bgm")
            {
                var reason = $"「{obj.name}」用的是背景音乐层：背景音乐已改成编辑器顶栏「音乐」弹框（点项目音频），请把这条改成音效或旁白";
                Debug.LogWarning($"[命令] 播放声音失败：{reason}");
                session.SendCommandResult(command, false, reason);
                return;
            }

            var clipId = sound.picked;
            LoadAudioThen(clipId, command, $"「{obj.name}」在 {layer} 层播放", clip =>
            {
                Audio.Play(layer, clip);
                ApplyPendingPause(layer);
            });
        }

        /// <summary>停掉某一层（同层只响一条，所以按层停就够）。</summary>
        private void HandleStopSound(CommandRequest command)
        {
            var layer = command.layer;
            if (!IsKnownLayer(layer))
            {
                session.SendCommandResult(command, false, $"不认识的层级：{layer}");
                return;
            }

            if (layer == "bgm")
            {
                session.SendCommandResult(command, false, BgmLayerReason);
                return;
            }

            if (!HasAudio(command, "停止声音"))
            {
                return;
            }

            Audio.Stop(layer);
            pendingPauseLayers.Remove(layer);
            session.SendCommandResult(command, true, effects: new[] { $"已停掉 {LayerLabel(layer)} 层" });
        }

        /// <summary>暂停某一层（同层只响一条，所以「暂停这一层」= 暂停当前那条）。</summary>
        private void HandlePauseSound(CommandRequest command)
        {
            var layer = command.layer;
            if (!IsKnownLayer(layer))
            {
                session.SendCommandResult(command, false, $"不认识的层级：{layer}");
                return;
            }

            if (layer == "bgm")
            {
                session.SendCommandResult(command, false, BgmLayerReason);
                return;
            }

            if (!HasAudio(command, "暂停声音"))
            {
                return;
            }

            // 还没内容可暂停（音频正在取）时记下意图：取到之后立刻补一次暂停（窗口见常量注释）
            if (!Audio.Pause(layer))
            {
                pendingPauseLayers[layer] = Time.realtimeSinceStartup + PendingPauseWindowSeconds;
            }

            session.SendCommandResult(command, true, effects: new[] { $"已暂停 {LayerLabel(layer)} 层" });
        }

        /// <summary>从暂停处继续放某一层（没在暂停的通道上会如实回失败）。</summary>
        private void HandleResumeSound(CommandRequest command)
        {
            var layer = command.layer;
            if (!IsKnownLayer(layer))
            {
                session.SendCommandResult(command, false, $"不认识的层级：{layer}");
                return;
            }

            if (layer == "bgm")
            {
                session.SendCommandResult(command, false, BgmLayerReason);
                return;
            }

            if (!HasAudio(command, "继续播放声音"))
            {
                return;
            }

            if (!Audio.Resume(layer))
            {
                session.SendCommandResult(command, false, $"{LayerLabel(layer)} 层现在没有暂停着的音频");
                return;
            }

            session.SendCommandResult(command, true, effects: new[] { $"{LayerLabel(layer)} 层继续播放" });
        }

        // ---------------------------------------------------------------- 全局背景音乐（v7）

        /// <summary>
        /// 放 / **切换**到某一首（命令里带着 `clip`——清单就是编辑器弹框里的项目音频）。
        ///
        /// 与声音那条同一个套路：先取到片段，再交给播放器；同一首重复来一条 = 从头再放一遍。
        /// </summary>
        private void HandlePlayBgm(CommandRequest command)
        {
            if (string.IsNullOrEmpty(command.clip))
            {
                session.SendCommandResult(command, false, "这条背景音乐命令没有说要放哪一首（clip 为空）");
                return;
            }

            var clipId = command.clip;
            LoadAudioThen(clipId, command, "背景音乐", clip =>
            {
                Audio.Play("bgm", clip);
                ApplyPendingPause("bgm");
            });
        }

        /// <summary>暂停背景音乐（没在放时记下意图：等这一首起播就停在开头）。</summary>
        private void HandlePauseBgm(CommandRequest command)
        {
            if (!HasAudio(command, "暂停背景音乐"))
            {
                return;
            }

            if (!Audio.Pause("bgm"))
            {
                pendingPauseLayers["bgm"] = Time.realtimeSinceStartup + PendingPauseWindowSeconds;
            }

            session.SendCommandResult(command, true, effects: new[] { "背景音乐已暂停" });
        }

        /// <summary>从暂停处继续放背景音乐。</summary>
        private void HandleResumeBgm(CommandRequest command)
        {
            if (!HasAudio(command, "继续播放背景音乐"))
            {
                return;
            }

            if (!Audio.Resume("bgm"))
            {
                session.SendCommandResult(command, false, "现在的背景音乐没有暂停着（先放一首）");
                return;
            }

            session.SendCommandResult(command, true, effects: new[] { "背景音乐继续播放" });
        }

        /// <summary>停掉背景音乐（停完再放 = 从头开始）。</summary>
        private void HandleStopBgm(CommandRequest command)
        {
            if (!HasAudio(command, "停止背景音乐"))
            {
                return;
            }

            Audio.Stop("bgm");
            pendingPauseLayers.Remove("bgm");
            session.SendCommandResult(command, true, effects: new[] { "背景音乐已停止" });
        }

        /// <summary>
        /// 取音频 → 成功就执行 `onLoaded` 并回执，失败就如实回原因。
        ///
        /// 回执是**异步**的（在加载完成后发）：编辑器那边不播画面只记账，等一两百毫秒没关系；
        /// 后端等回执有 15 秒，本地包命中时通常几毫秒。
        /// </summary>
        private void LoadAudioThen(string clipId, CommandRequest command, string label, System.Action<AudioClip> onLoaded)
        {
            if (Audio == null || audioLoader == null)
            {
                var reason = "前端没有装配音频播放器 / 加载器（Game 上的 AudioPlayerManager / AudioClipLoader）";
                Debug.LogWarning($"[命令] {label}失败：{reason}");
                session.SendCommandResult(command, false, reason);
                return;
            }

            audioLoader.Load(clipId, clip =>
            {
                if (clip == null)
                {
                    var reason = $"音频拿不到：{clipId}（本地资源包里没有，服务端 /api/resources/raw 也没取到）";
                    Debug.LogWarning($"[命令] {label}失败：{reason}");
                    session.SendCommandResult(command, false, reason);
                    return;
                }

                onLoaded(clip);
                Debug.Log($"[命令] {label}：{clipId}");
                session.SendCommandResult(command, true, effects: new[] { $"{label}：{clipId}" });
            });
        }

        /// <summary>
        /// 声音类命令的公共前提：**得有播放器**。
        ///
        /// 没有就如实回失败（而不是抛 `NullReferenceException`——那会被上层兜成一句
        /// 「前端处理这条命令时出错：Object reference not set…」，现场看不出真正缺的是什么）。
        /// </summary>
        private bool HasAudio(CommandRequest command, string label)
        {
            if (Audio != null)
            {
                return true;
            }

            var reason = "前端没有装配音频播放器（Game 上的 AudioPlayerManager）";
            Debug.LogWarning($"[命令] {label}失败：{reason}");
            session.SendCommandResult(command, false, reason);
            return false;
        }

        /// <summary>
        /// 「播放」落地时补一次被提前要求的暂停（见 <see cref="pendingPauseLayers"/>）。
        ///
        /// 无论窗口过没过，这一条意图都**消费掉**：过期的意思是「那次暂停跟现在这次播放无关」。
        /// </summary>
        private void ApplyPendingPause(string layer)
        {
            if (!pendingPauseLayers.TryGetValue(layer, out var deadline))
            {
                return;
            }

            pendingPauseLayers.Remove(layer);
            if (Time.realtimeSinceStartup <= deadline)
            {
                Audio.Pause(layer);
            }
        }

        private static bool IsKnownLayer(string layer)
        {
            return layer == "bgm" || layer == "sfx" || layer == "voice";
        }

        /// <summary>老对象用了背景音乐层时的统一说法（前端不再支持按对象放背景音乐）。</summary>
        private const string BgmLayerReason =
            "背景音乐已改成编辑器顶栏「音乐」弹框（点项目音频）——这一层请用 play_bgm / pause_bgm / resume_bgm / stop_bgm";

        private static string LayerLabel(string layer)
        {
            switch (layer)
            {
                case "bgm":
                    return "背景音乐";

                case "voice":
                    return "旁白";

                default:
                    return "音效";
            }
        }

        // ---------------------------------------------------------------- 战争雾

        /// <summary>擦一笔：**沿后台发来的轨迹**擦掉这张地图上的雾（轨迹不是遮罩数据）。</summary>
        private void HandleEraseMask(CommandRequest command)
        {
            var fog = FogOf(command.objectId);
            if (fog == null)
            {
                var reason = $"{DescribeFogTarget(command.objectId)}，没有雾层可擦";
                Debug.LogWarning($"[命令] 擦除战争雾失败：{reason}");
                session.SendCommandResult(command, false, reason);
                return;
            }

            if (command.points.Count == 0)
            {
                Debug.LogWarning("[命令] 擦除战争雾失败：这笔擦除没有落点（stroke.points 为空）");
                session.SendCommandResult(command, false, "这笔擦除没有落点（stroke.points 为空）");
                return;
            }

            if (!fog.EraseStroke(command.points, command.radius, command.softness))
            {
                Debug.LogWarning("[命令] 擦除战争雾失败：雾层还没准备好（数据不全或遮罩没建起来）");
                session.SendCommandResult(command, false, "雾层还没准备好（这张地图的数据不全或遮罩没建起来）");
                return;
            }

            var effect = $"沿轨迹擦掉 1 笔（{command.points.Count} 个落点）";
            Debug.Log($"[命令] 擦除战争雾：{command.objectId} {effect}");
            session.SendCommandResult(command, true, effects: new[] { effect });
        }

        /// <summary>整区开关：含该区域位的格子整片揭示 / 盖回。</summary>
        private void HandleRevealFogRegion(CommandRequest command)
        {
            var fog = FogOf(command.objectId);
            if (fog == null)
            {
                var reason = $"{DescribeFogTarget(command.objectId)}，没有雾层可改";
                Debug.LogWarning($"[命令] 战争雾整区操作失败：{reason}");
                session.SendCommandResult(command, false, reason);
                return;
            }

            var obj = mirror.Find(command.objectId);
            if (!ContainsRegion(obj?.map?.fogRegions, command.region))
            {
                var reason = $"区域位 {command.region} 不是这张地图的雾区";
                Debug.LogWarning($"[命令] 战争雾整区操作失败：{reason}");
                session.SendCommandResult(command, false, reason);
                return;
            }

            if (!fog.RevealRegion(command.region, command.revealed))
            {
                Debug.LogWarning("[命令] 战争雾整区操作失败：雾层还没准备好（数据不全或遮罩没建起来）");
                session.SendCommandResult(command, false, "雾层还没准备好（这张地图的数据不全或遮罩没建起来）");
                return;
            }

            var effect = command.revealed ? "这一区整片揭示" : "这一区整片盖回";
            Debug.Log($"[命令] 战争雾：{command.objectId} 区域位 {command.region} {effect}");
            session.SendCommandResult(command, true, effects: new[] { effect });
        }

        /// <summary>取某个地图对象上的雾层（对象不在镜像里 / 不是地图 / 开关关着 / 没绑雾区时都是 null）。</summary>
        private FogOfWar FogOf(string objectId)
        {
            var view = mirror != null ? mirror.FindView(objectId) : null;
            return view != null ? view.Fog : null;
        }

        // ---------------------------------------------------------------- 视频（地图 / 精灵）

        /// <summary>
        /// 在某张地图 / 某个精灵上放它选中的那条视频（命令 `play_video` 只给 `objectId`）。
        ///
        /// 三件事按顺序做，任何一件不成立都**如实回失败原因**（编辑器那边看得见）：
        /// 1. 镜像里有没有这个对象、它是不是地图 / 精灵、有没有加视频并选中一条；
        /// 2. 那条视频的字节在哪：**本地资源包优先**（`file://`），没有就回退到服务端
        ///    `/api/resources/raw`；两处都没有就不放；
        /// 3. 交给视图建那一层（`SceneObjectView.PlayVideo`）。
        ///
        /// **回执是同步的**：`VideoPlayer.Prepare()` 之后立刻回 `ok:true`——后端等回执只有 5 秒，
        /// 而解码可能要更久；真的解不出来时由 <see cref="VideoOverlay"/> 往 Unity 控制台写一条
        /// 明确的错误（协议里没有「晚到的失败」这条通道，这一点写在 README 的已知限制里）。
        /// </summary>
        private void HandlePlayVideo(CommandRequest command)
        {
            var problem = DescribeVideoTarget(command.objectId, out var obj, out var view);
            if (problem != null)
            {
                Debug.LogWarning($"[命令] 播放视频失败：{problem}");
                session.SendCommandResult(command, false, problem);
                return;
            }

            var clip = obj.video.picked;
            var url = VideoUrlOf(clip);
            if (url == null)
            {
                var reason = $"「{obj.name}」的视频拿不到：本地资源包里没有，而且还不知道服务端地址（{clip}）";
                Debug.LogWarning($"[命令] 播放视频失败：{reason}");
                session.SendCommandResult(command, false, reason);
                return;
            }

            view.PlayVideo(url, clip, obj.video.loop, obj.video.audio);

            var effect = $"开始播放「{clip}」（循环={obj.video.loop}，声音={obj.video.audio}）";
            Debug.Log($"[命令] 播放视频：{command.objectId} {effect}");
            session.SendCommandResult(command, true, effects: new[] { effect });
        }

        /// <summary>Play a video's selected clip from scene autoplay without a network command.</summary>
        public void PlayVideoAutomatically(string sceneName, string objectId)
        {
            var obj = mirror != null ? mirror.FindInScene(sceneName, objectId) : null;
            var view = mirror != null ? mirror.FindViewInScene(sceneName, objectId) : null;
            if (obj == null || view == null || obj.video == null || !obj.video.enabled || !obj.video.autoPlay)
            {
                return;
            }

            var clip = obj.video.picked;
            if (string.IsNullOrEmpty(clip) || !obj.video.clips.Contains(clip))
            {
                Debug.LogWarning($"[视频] 自动播放跳过：对象「{obj.name}」没有有效的选中视频");
                return;
            }

            var url = VideoUrlOf(clip);
            if (string.IsNullOrEmpty(url))
            {
                Debug.LogWarning($"[视频] 自动播放无法解析资源地址：{clip}");
                return;
            }

            view.PlayVideo(url, clip, obj.video.loop, obj.video.audio);
        }

        /// <summary>暂停：没在放就如实回失败（前端那一层可能已经被 `stop_video` 拆了）。</summary>
        private void HandlePauseVideo(CommandRequest command)
        {
            var problem = DescribeVideoTarget(command.objectId, out var obj, out var view);
            if (problem != null)
            {
                Debug.LogWarning($"[命令] 暂停视频失败：{problem}");
                session.SendCommandResult(command, false, problem);
                return;
            }

            view.PauseVideo();

            var effect = $"「{obj.name}」的视频已暂停";
            Debug.Log($"[命令] 暂停视频：{command.objectId}");
            session.SendCommandResult(command, true, effects: new[] { effect });
        }

        /// <summary>继续：从暂停的那一帧接着放（还没建层时前端会自己 Prepare 一遍）。</summary>
        private void HandleResumeVideo(CommandRequest command)
        {
            var problem = DescribeVideoTarget(command.objectId, out var obj, out var view);
            if (problem != null)
            {
                Debug.LogWarning($"[命令] 继续播放视频失败：{problem}");
                session.SendCommandResult(command, false, problem);
                return;
            }

            view.ResumeVideo();

            var effect = $"「{obj.name}」的视频继续播放";
            Debug.Log($"[命令] 继续播放视频：{command.objectId}");
            session.SendCommandResult(command, true, effects: new[] { effect });
        }

        /// <summary>
        /// 停止：**拆掉那一层**（露出对象原来的贴图）。
        ///
        /// 这里**不要求**「还选着一条视频」——停止是收拾动作，数据被改坏了也该停得掉。
        /// </summary>
        private void HandleStopVideo(CommandRequest command)
        {
            var obj = mirror != null ? mirror.Find(command.objectId) : null;
            if (obj == null)
            {
                var reason = $"镜像里没有这个对象：{command.objectId}（场景可能还没同步到）";
                Debug.LogWarning($"[命令] 停止视频失败：{reason}");
                session.SendCommandResult(command, false, reason);
                return;
            }

            var view = mirror.FindView(command.objectId);
            if (view == null)
            {
                var reason = $"「{obj.name}」没有视图（动作对象不建视图，也不放视频）";
                Debug.LogWarning($"[命令] 停止视频失败：{reason}");
                session.SendCommandResult(command, false, reason);
                return;
            }

            view.StopVideo();

            var effect = $"「{obj.name}」的视频已停止（露出它自己的贴图）";
            Debug.Log($"[命令] 停止视频：{command.objectId}");
            session.SendCommandResult(command, true, effects: new[] { effect });
        }

        /// <summary>
        /// 「现在能不能放这个对象上的视频」：不能就返回一句人话，能就把对象与视图一起给出去。
        ///
        /// 判据与编辑器那边（`videoTargetOf`）**逐条对齐**：对象在不在、是不是地图或精灵、
        /// 有没有加视频、有没有选一条——两边说法一致，现场才有可排查性。
        /// </summary>
        private string DescribeVideoTarget(
            string objectId,
            out MirrorObject obj,
            out SceneObjectView view)
        {
            obj = mirror != null ? mirror.Find(objectId) : null;
            view = null;

            if (obj == null)
            {
                return $"镜像里没有这个对象：{objectId}（场景可能还没同步到）";
            }

            // v9 起「能不能放视频」看**组件**：编辑器只会给地图 / 精灵挂 `VideoOverlay`
            if (!obj.HasComponent(Protocol.ComponentType.Video))
            {
                return $"「{obj.name}」没有视频组件（kind={obj.kind}），放不了视频";
            }

            // 与编辑器那边（`videoTargetOf`）逐条对齐：没开 / 没加 / 没选是三种不同的拒绝
            if (obj.video == null || !obj.video.enabled)
            {
                return $"「{obj.name}」的视频开关关着（video.enabled = false，这个对象现在不放视频）";
            }

            if (obj.video.clips.Count == 0)
            {
                return $"「{obj.name}」还没加视频（编辑器：属性面板 → 视频）";
            }

            if (string.IsNullOrEmpty(obj.video.picked) || !obj.video.clips.Contains(obj.video.picked))
            {
                return $"「{obj.name}」还没选要放哪一条视频（video.picked 为空或不在列表里）";
            }

            view = mirror.FindView(objectId);
            if (view == null)
            {
                return $"「{obj.name}」还没有视图（它可能没落位 / 没激活）";
            }

            return null;
        }

        /// <summary>
        /// 视频逻辑 ID → 可播的地址：**本地资源包优先**（`file://`），否则回退服务端逐文件接口。
        ///
        /// 与取图（<see cref="ResourceImageLoader"/>）同一条口径：本地有一个字节的网络都不走；
        /// 本地没有（包没下完 / 超了整包上限 / 文件被删）时，服务端那份照样能**边下边播**。
        /// </summary>
        private string VideoUrlOf(string logicalId)
        {
            var localUrl = bundleCache != null ? bundleCache.LocalUrlOf(logicalId) : null;
            if (localUrl != null)
            {
                return localUrl;
            }

            if (string.IsNullOrEmpty(httpBaseUrl) || string.IsNullOrEmpty(logicalId))
            {
                return null;
            }

            return $"{httpBaseUrl}/api/resources/raw?id={UnityEngine.Networking.UnityWebRequest.EscapeURL(logicalId)}";
        }

        /// <summary>「为什么没有雾层」的一句人话：对象不在镜像里 / 不是地图 / 开关关着 / 没指定雾区。</summary>
        private string DescribeFogTarget(string objectId)
        {
            var obj = mirror != null ? mirror.Find(objectId) : null;
            if (obj == null)
            {
                return $"镜像里没有这个对象：{objectId}（场景可能还没同步到）";
            }

            if (obj.map == null)
            {
                return $"「{obj.name}」不是地图对象";
            }

            if (!obj.map.fogEnabled)
            {
                return $"「{obj.name}」的战争雾开关关着（map.fog.enabled = false，这张地图现在没有雾层）";
            }

            return $"「{obj.name}」这张地图没指定雾区（map.fog.regions 为空）";
        }

        private static bool ContainsRegion(int[] regions, int region)
        {
            if (regions == null)
            {
                return false;
            }

            for (int i = 0; i < regions.Length; i++)
            {
                if (regions[i] == region)
                {
                    return true;
                }
            }

            return false;
        }
    }
}
