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
    /// 雾层本身在前端镜像里那张地图上（`map.fog.regions` + `map.cells`），由
    /// <see cref="SceneObjectView.Fog"/> 执行。
    ///
    /// 声音目前只做路由与回执：**真正出声（取音频 + 按层播放）是下一步**，
    /// 现在如实回 `ok:false` 并带上「镜像里该播哪一条」，不假装成功也不静默。
    /// </summary>
    public class CommandRouter : MonoBehaviour
    {
        private ClientSession session;
        private SceneMirror mirror;

        /// <summary>接上会话与镜像（由 <see cref="BackendManager"/> 调用一次）。</summary>
        public void Initialize(ClientSession clientSession, SceneMirror sceneMirror)
        {
            session = clientSession;
            mirror = sceneMirror;
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
            switch (command.kind)
            {
                case Protocol.CommandPlaySound:
                    HandlePlaySound(command);
                    return;

                case Protocol.CommandStopSound:
                    HandleStopSound(command);
                    return;

                case Protocol.CommandEraseMask:
                    HandleEraseMask(command);
                    return;

                case Protocol.CommandRevealFogRegion:
                    HandleRevealFogRegion(command);
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

        // ---------------------------------------------------------------- 战争雾

        /// <summary>擦一笔：**沿后台发来的轨迹**擦掉这张地图上的雾（轨迹不是遮罩数据）。</summary>
        private void HandleEraseMask(CommandRequest command)
        {
            var fog = FogOf(command.objectId);
            if (fog == null)
            {
                session.SendCommandResult(command, false, $"{DescribeFogTarget(command.objectId)}，没有雾层可擦");
                return;
            }

            if (command.points.Count == 0)
            {
                session.SendCommandResult(command, false, "这笔擦除没有落点（stroke.points 为空）");
                return;
            }

            if (!fog.EraseStroke(command.points, command.radius, command.softness))
            {
                session.SendCommandResult(command, false, "雾层还没准备好（这张地图的数据不全或遮罩没建起来）");
                return;
            }

            session.SendCommandResult(
                command,
                true,
                effects: new[] { $"沿轨迹擦掉 1 笔（{command.points.Count} 个落点）" });
        }

        /// <summary>整区开关：含该区域位的格子整片揭示 / 盖回。</summary>
        private void HandleRevealFogRegion(CommandRequest command)
        {
            var fog = FogOf(command.objectId);
            if (fog == null)
            {
                session.SendCommandResult(command, false, $"{DescribeFogTarget(command.objectId)}，没有雾层可改");
                return;
            }

            var obj = mirror.Find(command.objectId);
            if (!ContainsRegion(obj?.map?.fogRegions, command.region))
            {
                session.SendCommandResult(command, false, $"区域位 {command.region} 不是这张地图的雾区");
                return;
            }

            if (!fog.RevealRegion(command.region, command.revealed))
            {
                session.SendCommandResult(command, false, "雾层还没准备好（这张地图的数据不全或遮罩没建起来）");
                return;
            }

            session.SendCommandResult(
                command,
                true,
                effects: new[] { command.revealed ? "这一区整片揭示" : "这一区整片盖回" });
        }

        /// <summary>取某个地图对象上的雾层（对象不在镜像里 / 不是地图 / 没绑雾区时都是 null）。</summary>
        private FogOfWar FogOf(string objectId)
        {
            var view = mirror != null ? mirror.FindView(objectId) : null;
            return view != null ? view.Fog : null;
        }

        /// <summary>「为什么没有雾层」的一句人话：对象不在镜像里 / 不是地图 / 没绑雾区。</summary>
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
