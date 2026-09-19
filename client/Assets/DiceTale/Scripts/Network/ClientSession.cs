using System;
using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>会话状态（编辑器点没点「运行」，决定前端现在能不能连上）。</summary>
    public enum ClientSessionState
    {
        /// <summary>还没开始连（组件没初始化）。</summary>
        Idle,

        /// <summary>连不上：多半是编辑器还没点「运行」（服务端以 HTTP 503 拒握手），正在重试。</summary>
        WaitingForRuntime,

        /// <summary>正在建立连接。</summary>
        Connecting,

        /// <summary>连上了：收到 `server_hello`，可以收场景与命令。</summary>
        Ready,

        /// <summary>连接已断开（编辑器退出运行态 / 网络断了）。</summary>
        Closed,
    }

    /// <summary>
    /// 前端侧的会话：把 WebSocket 上的原始 JSON 变成**类型化事件**，并负责握手与心跳应答。
    ///
    /// 职责边界：只认协议、不碰场景内容（场景交给 <see cref="SceneMirror"/>、命令交给
    /// <see cref="CommandRouter"/>）。
    ///
    /// 时序：连接成功 → 发 `client_hello` → 收 `server_hello`（置 Ready）→ 收 `scene_sync`（整份镜像）
    /// → 收 `command`（回 `command_result`）→ 收 `ping`（回 `pong`）。
    /// </summary>
    public class ClientSession : MonoBehaviour
    {
        /// <summary>收到整份场景（可能是 null = 编辑器没有打开的场景）。</summary>
        public event Action<MirrorScene> SceneReceived;

        /// <summary>收到一条命令。</summary>
        public event Action<CommandRequest> CommandReceived;

        /// <summary>会话状态变化（附带一句人能看懂的说明）。</summary>
        public event Action<ClientSessionState, string> StateChanged;

        public ClientSessionState State { get; private set; } = ClientSessionState.Idle;

        /// <summary>服务端给本次运行态的会话 id（`server_hello` 里带来，日志排查用）。</summary>
        public string SessionId { get; private set; } = "";

        /// <summary>服务端协议版本（`server_hello` 里带来）。</summary>
        public int ServerProtocolVersion { get; private set; }

        private ServerConnection connection;

        /// <summary>接上连接（由 <see cref="BackendManager"/> 调用一次）。</summary>
        public void Initialize(ServerConnection serverConnection)
        {
            connection = serverConnection;
            connection.OnConnected += OnConnected;
            connection.OnConnectFailed += OnConnectFailed;
            connection.OnDisconnected += OnDisconnected;
            connection.OnMessage += OnMessage;
            SetState(ClientSessionState.Connecting, "开始连接服务端");
        }

        private void OnDestroy()
        {
            if (connection != null)
            {
                connection.OnConnected -= OnConnected;
                connection.OnConnectFailed -= OnConnectFailed;
                connection.OnDisconnected -= OnDisconnected;
                connection.OnMessage -= OnMessage;
            }
        }

        private void OnConnectFailed(string reason)
        {
            // 多半是编辑器还没点「运行」（服务端以 503 拒握手）：不是故障，等它点
            SetState(ClientSessionState.WaitingForRuntime, $"尚未进入运行态（{reason}），正在重试…");
        }

        private void OnDisconnected(string reason)
        {
            SetState(ClientSessionState.WaitingForRuntime, reason);
        }

        private void OnConnected()
        {
            // 自报家门：服务端据此把「前端是谁」广播给编辑器（运行面板上显示的那个名字）
            connection.Send(new Protocol.ClientHelloMessage
            {
                protocolVersion = Protocol.Version,
                name = Protocol.ClientName,
                version = Application.version ?? "",
            });
        }

        private void OnMessage(string json)
        {
            Dictionary<string, object> message;
            try
            {
                message = JsonParser.ParseObject(json);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[网络] 收到解不开的消息：{ex.Message}");
                return;
            }

            if (message == null)
            {
                return;
            }

            switch (JsonParser.GetString(message, "type"))
            {
                case Protocol.TypeServerHello:
                    ServerProtocolVersion = (int)JsonParser.GetNumber(message, "protocolVersion");
                    SessionId = JsonParser.GetString(message, "sessionId") ?? "";
                    if (ServerProtocolVersion != Protocol.Version)
                    {
                        SetState(
                            ClientSessionState.WaitingForRuntime,
                            $"协议版本不一致：服务端 v{ServerProtocolVersion}，前端 v{Protocol.Version}");
                        return;
                    }

                    SetState(ClientSessionState.Ready, $"已连接服务端（会话 {SessionId}）");
                    return;

                case Protocol.TypeSceneSync:
                    if (State != ClientSessionState.Ready)
                    {
                        SetState(ClientSessionState.Ready, "已连接服务端");
                    }

                    SceneReceived?.Invoke(SceneParser.Parse(JsonParser.GetObject(message, "scene")));
                    return;

                case Protocol.TypeCommand:
                    CommandReceived?.Invoke(ParseCommand(message));
                    return;

                case Protocol.TypePing:
                    connection.Send(new Protocol.PongMessage
                    {
                        seq = (int)JsonParser.GetNumber(message, "seq"),
                    });
                    return;

                default:
                    Debug.LogWarning($"[网络] 不认识的消息类型：{JsonParser.GetString(message, "type")}");
                    return;
            }
        }

        /// <summary>把命令执行结果回给服务端（无论成功失败都要回，不静默）。</summary>
        public void SendCommandResult(CommandRequest command, bool ok, string reason = "", string[] effects = null)
        {
            if (connection == null)
            {
                return;
            }

            connection.Send(new Protocol.CommandResultMessage
            {
                requestId = command?.requestId ?? "",
                ok = ok,
                reason = reason ?? "",
                effects = effects ?? new string[0],
            });
        }

        private static CommandRequest ParseCommand(Dictionary<string, object> message)
        {
            var command = new CommandRequest
            {
                requestId = JsonParser.GetString(message, "requestId") ?? "",
            };

            var node = JsonParser.GetObject(message, "command");
            if (node == null)
            {
                return command;
            }

            command.kind = JsonParser.GetString(node, "kind") ?? "";
            command.objectId = JsonParser.GetString(node, "objectId") ?? "";
            command.layer = JsonParser.GetString(node, "layer") ?? "";
            return command;
        }

        private void SetState(ClientSessionState state, string detail)
        {
            if (State == state)
            {
                return;
            }

            State = state;
            StateChanged?.Invoke(state, detail);
        }
    }
}
