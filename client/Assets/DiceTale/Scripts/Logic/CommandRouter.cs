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
    /// 声音目前只做路由与回执：**真正出声（取音频 + 按层播放 / 暂停 / 继续）是下一步**，
    /// 现在如实回 `ok:false` 并带上「镜像里该播哪一条」，不假装成功也不静默。
    /// 四条声音命令（`play_sound` / `pause_sound` / `resume_sound` / `stop_sound`）与四条视频命令
    /// 是**对称**的——编辑器里那两组 UI 的控件行也完全一致（播放 / 暂停 · 继续 / 停止）。
    ///
    /// 视频（`play_video` / `pause_video` / `resume_video` / `stop_video`）**已经实现**：
    /// 放哪一条、循环、声音都从镜像里那个对象的 `video` 读，画面盖在它自己的矩形上
    /// （<see cref="SceneObjectView.PlayVideo"/> → <see cref="VideoOverlay"/>）。
    /// </summary>
    public class CommandRouter : MonoBehaviour
    {
        private ClientSession session;
        private SceneMirror mirror;

        /// <summary>资源包（视频的「本地优先」要用它把逻辑 ID 换成 `file://` 地址）。</summary>
        private ResourceBundleCache bundleCache;

        /// <summary>服务端 HTTP 基地址（本地没有那份视频时回退到 `/api/resources/raw`）。</summary>
        private string httpBaseUrl = "";

        /// <summary>接上会话、镜像与资源来源（由 <see cref="BackendManager"/> 调用一次）。</summary>
        public void Initialize(
            ClientSession clientSession,
            SceneMirror sceneMirror,
            ResourceBundleCache cache,
            string httpBase)
        {
            session = clientSession;
            mirror = sceneMirror;
            bundleCache = cache;
            httpBaseUrl = httpBase ?? "";
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

                default:
                    Debug.LogWarning($"[命令] 不认识的命令：{command.kind}");
                    session.SendCommandResult(command, false, $"前端不认识这条命令：{command.kind}");
                    return;
            }
        }

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
            session.SendCommandResult(
                command,
                false,
                $"前端尚未实现声音播放（下一步）：镜像里「{obj.name}」该在 {layer} 层播 {sound.picked}");
        }

        private void HandleStopSound(CommandRequest command)
        {
            session.SendCommandResult(
                command,
                false,
                $"前端尚未实现声音播放（下一步）：收到停层 {command.layer}");
        }

        /// <summary>暂停某一层（v6 起）：与播放 / 停止一样，**前端声音播放还没实现**，如实回执。</summary>
        private void HandlePauseSound(CommandRequest command)
        {
            session.SendCommandResult(
                command,
                false,
                $"前端尚未实现声音播放（下一步）：收到暂停层 {command.layer}");
        }

        /// <summary>从暂停处继续放某一层（v6 起）：同上，如实回执。</summary>
        private void HandleResumeSound(CommandRequest command)
        {
            session.SendCommandResult(
                command,
                false,
                $"前端尚未实现声音播放（下一步）：收到继续播放层 {command.layer}");
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

            if (obj.kind != "Map" && obj.kind != "SceneObject")
            {
                return $"「{obj.name}」不是地图或精灵（kind={obj.kind}），放不了视频";
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

            if (obj.kind != "Map" || obj.map == null)
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
