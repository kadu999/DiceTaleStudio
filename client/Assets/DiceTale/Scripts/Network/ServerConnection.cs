using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 管理到 DiceTale 权威服务器的 WebSocket 连接生命周期（连接、断开、自动重连）。
    /// 收到消息后通过 <see cref="OnMessage"/> 广播原始 JSON。
    ///
    /// **纯传输骨架**：本类不认识任何协议——旧协议（`request_join` / 心跳 / 上行上报 / 下行命令）
    /// 已整层删除，新协议在功能落地时重新定义。现在这里只提供连接、收发字节、重连与代次防串台；
    /// 新协议来了之后，谁需要发消息就用 <see cref="Send{T}"/>，谁需要收消息就订阅 <see cref="OnMessage"/>。
    /// </summary>
    public class ServerConnection : MonoBehaviour
    {
        [Tooltip("服务器 WebSocket 地址（客户端通道）")]
        public string DefaultUrl = "ws://localhost:1420/client";

        [Tooltip("断线后是否自动重连")]
        public bool AutoReconnect = true;

        [Tooltip("重连间隔（秒）：编辑器点「运行」之前服务端会拒绝握手，靠这个间隔重试")]
        public float ReconnectDelay = 3f;

        /// <summary>收到服务器消息（原始 JSON 字符串）。</summary>
        public event Action<string> OnMessage;

        /// <summary>成功建立连接后触发。</summary>
        public event Action OnConnected;

        /// <summary>
        /// 连接失败（参数是原因）。**编辑器还没点「运行」时服务端会拒握手（HTTP 503），这是正常现象**：
        /// 上层据此显示「等待运行态」，而不是当成故障。
        /// </summary>
        public event Action<string> OnConnectFailed;

        /// <summary>连接断开（参数是可读原因；服务端主动踢下线时带着它是为什么）。</summary>
        public event Action<string> OnDisconnected;

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
                connectionFailed = false; // 连上了：下次失败重新提示一遍
                OnConnected?.Invoke();
            }
            catch (Exception ex)
            {
                // 编辑器还没点「运行」时服务端会以 HTTP 503 拒绝握手（**这是正常现象**，不是故障）：
                // 只在连续失败的头一次提示一下，免得每 3 秒刷一行把控制台淹掉
                if (!connectionFailed)
                {
                    connectionFailed = true;
                    Debug.Log($"[网络] 连不上服务端（{ex.Message}）。编辑器点「运行」后会自动连上，正在重试…");
                }

                OnConnectFailed?.Invoke(ex.Message);
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

        /// <summary>本轮「连不上」是否已经提示过（成功一次即复位）。</summary>
        private bool connectionFailed;

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
                    var reason = DescribeClose(socket);
                    await CloseAsync();
                    OnDisconnected?.Invoke(reason);
                    if (!closing)
                    {
                        ScheduleReconnect();
                    }
                }
            }
        }

        /// <summary>
        /// 把「连接怎么断的」翻成人能看懂的一句话。
        ///
        /// 编辑器的运行态是**服务端主动踢**的（close code 4003）；协议版本不符是 4002。
        /// </summary>
        private static string DescribeClose(ClientWebSocket socket)
        {
            try
            {
                if (socket.CloseStatus.HasValue)
                {
                    var code = (int)socket.CloseStatus.Value;
                    if (code == Protocol.CloseRuntimeStopped)
                    {
                        return "编辑器已退出运行态，等待它再次点「运行」";
                    }

                    if (code == Protocol.CloseProtocolMismatch)
                    {
                        return $"协议版本不一致（{code}）";
                    }

                    var description = socket.CloseStatusDescription;
                    return string.IsNullOrEmpty(description)
                        ? $"连接已关闭（{code}）"
                        : $"连接已关闭（{code}：{description}）";
                }
            }
            catch (Exception)
            {
                // 取不到关闭原因不影响收尾
            }

            return "与服务端断开";
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
            // 宿主销毁即退出：作废旧会话、取消未完成的收发，再关闭连接
            closing = true;
            generation++; // 作废旧会话，避免收尾逻辑在销毁流程中继续干扰
            cts?.Cancel();
            _ = CloseAsync();
        }
    }
}