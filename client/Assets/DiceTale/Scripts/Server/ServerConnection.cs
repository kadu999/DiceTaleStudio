using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace DiceTale.Server
{
    /// <summary>
    /// 管理到 DiceTale 权威服务器的 WebSocket 连接生命周期（连接、断开、自动重连）。
    /// 收到消息后通过 <see cref="OnMessage"/> 广播原始 JSON。
    /// </summary>
    public class ServerConnection : MonoBehaviour
    {
        [Tooltip("服务器 WebSocket 地址（客户端通道）")]
        public string DefaultUrl = "ws://localhost:1420/client";

        [Tooltip("断线后是否自动重连")]
        public bool AutoReconnect = true;

        [Tooltip("重连间隔（秒）")]
        public float ReconnectDelay = 5f;

        /// <summary>收到服务器消息（原始 JSON 字符串）。</summary>
        public event Action<string> OnMessage;

        /// <summary>成功建立连接并发送 request_join 后触发。</summary>
        public event Action OnConnected;

        public bool IsConnected => webSocket != null && webSocket.State == WebSocketState.Open;

        private ClientWebSocket webSocket;
        private CancellationTokenSource cts;
        private bool closing;
        private bool reconnecting;

        /// <summary>
        /// 连接代次：每次 Connect / Close 递增。用于把旧会话（正在收尾的 ReceiveLoop / 心跳 / 排队中的发送）
        /// 与当前会话隔离——旧会话的 finally/回调只认自己的代次，不会关闭或干扰新连接（会话串台、连接反复横跳）。
        /// </summary>
        private int generation;

        /// <summary>
        /// 收到的原始消息队列：接收循环在后台线程入队，Update 在主线程统一分发
        /// （命令处理里全是 Unity API，必须在主线程执行，否则会静默失败）。
        /// </summary>
        private readonly ConcurrentQueue<string> pendingMessages = new ConcurrentQueue<string>();

        /// <summary>单帧最多分发的消息数：防止积压风暴单帧排空（服务器洪泛/主线程卡顿时不会一帧全量执行大量命令）。</summary>
        private const int MaxMessagesPerFrame = 64;

        private void Update()
        {
            // 每帧限额分发；剩余积压留到后续帧，避免单帧内连续执行大量命令（LoadScene/Instantiate 等）
            for (int i = 0; i < MaxMessagesPerFrame && pendingMessages.TryDequeue(out var json); i++)
            {
                OnMessage?.Invoke(json);
            }
        }

        private void Awake()
        {
            // 组件由 BackendManager 挂到宿主物体；同物体出现重复连接组件时保留首个、销毁多余
            // （不再使用单例 Instance，连接统一经 Game.Instance.ServerConnection 获取）
            if (GetComponents<ServerConnection>().Length > 1)
            {
                Destroy(this);
            }
        }

        public async void Connect(string url = null)
        {
            if (webSocket != null)
            {
                await CloseAsync();
            }

            closing = false;
            generation++; // 新会话代次：旧会话的收尾逻辑据此识别「已被取代」而不再打扰本连接
            var gen = generation;

            var socket = new ClientWebSocket();
            var tokenSource = new CancellationTokenSource();
            webSocket = socket;      // 本会话持有的连接（后续可能被新的 Connect 替换字段）
            cts = tokenSource;

            try
            {
                await socket.ConnectAsync(new Uri(url ?? DefaultUrl), tokenSource.Token);
                if (gen != generation)
                {
                    // 连接建立期间已被新的 Connect/Close 取代：只回收本次连接，不启动接收/心跳
                    await CloseSocketAsync(socket, tokenSource);
                    return;
                }

                if (socket.State != WebSocketState.Open)
                {
                    throw new Exception("Connection not open after ConnectAsync");
                }

                _ = ReceiveLoop(gen);
                SendJoin();
                StartCoroutine(HeartbeatCoroutine(gen)); // 应用层心跳，供后台存活检测
                OnConnected?.Invoke();
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[ServerConnection] Connect failed: {ex.Message}");
                await CloseSocketAsync(socket, tokenSource);
                if (ReferenceEquals(webSocket, socket))
                {
                    webSocket = null;
                }

                if (gen == generation)
                {
                    ScheduleReconnect(); // 已被新会话取代时不重复排队重连
                }
            }
        }

        /// <summary>串行发送链：ClientWebSocket 不允许并发 SendAsync，排队逐个发送，避免后续消息被丢弃。</summary>
        private Task sendChain = Task.CompletedTask;

        public void Send<T>(T message) where T : class
        {
            if (!IsConnected) return;

            var json = JsonUtility.ToJson(message);
            var bytes = Encoding.UTF8.GetBytes(json);
            var segment = new ArraySegment<byte>(bytes);
            var gen = generation; // 捕获发起代次：断线前排队的消息不会投递到重连后的新会话

            sendChain = sendChain.ContinueWith(
                _ => SendAsyncInternal(gen, segment),
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }

        private async Task SendAsyncInternal(int gen, ArraySegment<byte> segment)
        {
            try
            {
                // 代次校验：只对「发起时归属的会话」发送，排队的过期消息被丢弃而非投递到新连接
                if (gen == generation && webSocket != null && webSocket.State == WebSocketState.Open)
                {
                    await webSocket.SendAsync(segment, WebSocketMessageType.Text, true, cts.Token);
                }
            }
            catch (OperationCanceledException)
            {
                // 主动关闭，忽略
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[ServerConnection] Send failed: {ex.Message}");
            }
        }

        /// <summary>应用层心跳间隔（秒）：后台据此判断连接是否半开并清理死连接。</summary>
        private const float HeartbeatInterval = 15f;

        private IEnumerator HeartbeatCoroutine(int gen)
        {
            var wait = new WaitForSeconds(HeartbeatInterval);
            // 断线/会话被取代后自动退出；重连时 Connect() 会启动新一代的心跳
            while (gen == generation && IsConnected)
            {
                yield return wait;
                Send(new HeartbeatMessage());
            }
        }

        public void Close()
        {
            closing = true;
            generation++; // 立即作废旧会话：进行中的 ReceiveLoop/排队的发送不再触碰本连接
            _ = CloseAsync();
        }

        private void SendJoin()
        {
            Send(new RequestJoinMessage());
        }

        private async Task ReceiveLoop(int gen)
        {
            // 本会话持有的连接引用：即使字段被新会话替换，旧会话也只用自己的这一趟连接
            var socket = webSocket;
            var tokenSource = cts;
            try
            {
                while (gen == generation && socket != null && socket.State == WebSocketState.Open)
                {
                    var json = await ReceiveOneMessage(socket, tokenSource);
                    if (json == null)
                    {
                        break; // 收到 Close
                    }

                    pendingMessages.Enqueue(json); // 入队，由主线程 Update 分发 OnMessage
                }
            }
            catch (OperationCanceledException)
            {
                // 主动关闭，忽略
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[ServerConnection] Receive error: {ex.Message}");
            }
            finally
            {
                if (gen == generation)
                {
                    // 只有「当前代次」的接收循环有权收尾：旧会话的 finally 不碰新会话的 socket
                    await CloseAsync();
                    if (!closing)
                    {
                        ScheduleReconnect();
                    }
                }
            }
        }

        /// <summary>
        /// 接收一条完整 WebSocket 消息：累积接收直到 EndOfMessage，缓冲不足时自动翻倍扩容。
        /// 支持大消息（如遮罩图 PNG base64），避免固定 64KB 缓冲截断消息、
        /// 残留字节冲歪后续消息导致客户端停止更新。返回 null 表示连接关闭。
        /// </summary>
        private async Task<string> ReceiveOneMessage(ClientWebSocket socket, CancellationTokenSource tokenSource)
        {
            var buffer = new byte[65536];
            var offset = 0;
            while (true)
            {
                if (offset == buffer.Length)
                {
                    Array.Resize(ref buffer, buffer.Length * 2); // 扩容
                }

                var result = await socket.ReceiveAsync(
                    new ArraySegment<byte>(buffer, offset, buffer.Length - offset), tokenSource.Token);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    return null;
                }

                offset += result.Count;
                if (result.EndOfMessage)
                {
                    return Encoding.UTF8.GetString(buffer, 0, offset);
                }
            }
        }

        private void ScheduleReconnect()
        {
            if (!AutoReconnect || closing || reconnecting || !isActiveAndEnabled)
            {
                return;
            }

            reconnecting = true;
            StartCoroutine(ReconnectCoroutine());
        }

        private IEnumerator ReconnectCoroutine()
        {
            yield return new WaitForSeconds(ReconnectDelay);
            reconnecting = false;
            if (closing)
            {
                yield break; // 等待期间被主动关闭：放弃重连，避免关闭意图被重连复活
            }

            Connect();
        }

        private async Task CloseAsync()
        {
            if (webSocket == null) return;

            try
            {
                cts?.Cancel();
                if (webSocket.State == WebSocketState.Open)
                {
                    await webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[ServerConnection] Close error: {ex.Message}");
            }
            finally
            {
                webSocket?.Dispose();
                webSocket = null;
            }
        }

        /// <summary>只回收指定的连接与取消源（会话被取代时用，不触碰当前连接字段）。</summary>
        private static async Task CloseSocketAsync(ClientWebSocket socket, CancellationTokenSource tokenSource)
        {
            if (socket == null) return;

            try
            {
                tokenSource?.Cancel();
                if (socket.State == WebSocketState.Open)
                {
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[ServerConnection] Close error: {ex.Message}");
            }
            finally
            {
                socket.Dispose();
            }
        }

        private void OnDestroy()
        {
            // 连接不再使用单例：清理会话状态即可（引用统一经 Game.Instance.ServerConnection 获取）
            closing = true;
            generation++; // 作废旧会话，避免收尾逻辑在销毁流程中继续干扰
            cts?.Cancel();
            _ = CloseAsync();
        }
    }
}