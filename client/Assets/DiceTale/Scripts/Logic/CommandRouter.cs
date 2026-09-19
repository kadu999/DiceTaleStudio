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
    /// 本步只做路由与回执：**真正出声（取音频 + 按层播放）是下一步**，
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
    }
}
