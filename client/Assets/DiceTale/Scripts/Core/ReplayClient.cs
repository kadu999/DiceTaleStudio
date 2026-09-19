using System;
using System.Collections;
using System.IO;
using UnityEngine;
using UnityEngine.Networking;

namespace DiceTale
{
    /// <summary>
    /// Replay 图文小说链路客户端（挂在 Game 宿主，生命周期与宿主一致 = 「一局游戏」）。
    ///
    /// 会话模型（与后端 /replay 一致）：
    /// - 每次游戏开启（宿主 Awake）→ POST /replay/sessions 创建**唯一 sessionId**，
    ///   本局所有数据（多段录音 WAV、剧本、转写、小说、插图）都归属该 session；
    /// - 每段录音停止后调用 <see cref="QueueUploadSegment"/>，把 WAV 上传到该 session；
    /// - 本局结束（宿主销毁）前可调用 <see cref="QueueGenerate"/> 触发后端一键生成
    ///   （转写整局所有分段 → 摘要 → 大纲 → 小说 → 插图 → replay.html）。
    ///
    /// 上传/生成是异步 HTTP（UnityWebRequest），失败只记日志不阻塞游戏。
    /// </summary>
    public class ReplayClient : MonoBehaviour
    {
        /// <summary>本局 Replay 会话 ID（后端 /replay/sessions 创建；未就绪为 null）。</summary>
        public string SessionId { get; private set; }

        /// <summary>后端 HTTP 基地址（从 BackendManager 的 ws:// 地址推导）。</summary>
        public string BaseUrl { get; private set; } = "http://localhost:1420";

        /// <summary>最近一次生成出的 replay.html URL（null = 尚未生成）。</summary>
        public string LastReplayUrl { get; private set; }

        /// <summary>后台重试间隔（创建会话失败时）。</summary>
        private const float RetryDelay = 3f;

        private void Awake()
        {
            if (Game.Instance != null && Game.Instance.BackendManager != null)
            {
                var serverUrl = GetBackendUrl();
                if (!string.IsNullOrEmpty(serverUrl))
                {
                    BaseUrl = serverUrl;
                }
            }
            StartCoroutine(EnsureSessionCoroutine());
        }

        private void OnDestroy()
        {
            StopAllCoroutines();
        }

        /// <summary>从 BackendManager 的 ws://.../client 推导 http://host:port（无则用默认）。</summary>
        private string GetBackendUrl()
        {
            try
            {
                var mgr = Game.Instance != null ? Game.Instance.BackendManager : null;
                var ws = mgr != null ? mgr.Connection.DefaultUrl : null;
                if (string.IsNullOrEmpty(ws)) return BaseUrl;

                var http = ws.Replace("ws://", "http://").Replace("wss://", "https://");
                var idx = http.IndexOf("/client", StringComparison.Ordinal);
                return idx > 0 ? http.Substring(0, idx) : http;
            }
            catch
            {
                return BaseUrl;
            }
        }

        // ---------- 会话创建 ----------

        /// <summary>直到创建成功：一局开始即有唯一 sessionId（后端按其区分各局数据）。
        /// 创建成功后自动注入剧本（Resources/Replay 下的 md/json 文本）。</summary>
        private IEnumerator EnsureSessionCoroutine()
        {
            while (string.IsNullOrEmpty(SessionId) && isActiveAndEnabled)
            {
                yield return StartCoroutine(CreateSessionOnce());
                if (string.IsNullOrEmpty(SessionId))
                {
                    yield return new WaitForSeconds(RetryDelay);
                }
            }
            // 会话就绪：自动注入剧本（失败不影响游戏，只记日志）
            InjectModuleFromResources();
        }

        /// <summary>
        /// 从 Resources/Replay 读取剧本（TextAsset，如《游戏剧本》.md）并 POST /module。
        /// 路径取 Resources/Replay 下第一个 md/json；可显式指定资源名（不含扩展名）。
        /// </summary>
        public void InjectModuleFromResources(string resourceName = null)
        {
            if (string.IsNullOrEmpty(SessionId))
            {
                Debug.LogWarning("[ReplayClient] 会话未就绪，暂不注入剧本");
                return;
            }

            // Resources 短名重载限制：子目录资源须带路径（"Replay/..."）。
            // 显式名 -> 精确加载；否则枚举 Replay 目录下第一个 md/json。
            var found = LoadModuleText(resourceName);
            if (found == null)
            {
                Debug.LogWarning("[ReplayClient] Resources/Replay 下未找到剧本（md/json），跳过注入");
                return;
            }

            StartCoroutine(InjectModuleCoroutine(found.Value.Path, found.Value.Text));
        }

        private IEnumerator InjectModuleCoroutine(string resourcePath, string text)
        {
            // 手动转义 JSON 字符串（Unity JsonUtility 会把 string 包成 {"value":...}，不可用）
            var payload = "{\"raw\":\"" + EscapeJson(text) + "\"}";
            using (var req = UnityWebRequest.Post($"{BaseUrl}/replay/sessions/{SessionId}/module", payload, "application/json"))
            {
                req.timeout = 30;
                yield return req.SendWebRequest();
                if (req.result == UnityWebRequest.Result.Success)
                {
                    Debug.Log($"[ReplayClient] 剧本已注入 ({resourcePath})");
                }
                else
                {
                    Debug.LogWarning($"[ReplayClient] 剧本注入失败: {req.responseCode} {req.error}");
                }
            }
        }

        private static string EscapeJson(string s)
        {
            return s
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\n", "\\n")
                .Replace("\r", "\\r")
                .Replace("\t", "\\t");
        }

        /// <summary>从 Resources 读取 Replay 剧本文本（md/json；返回资源路径与文本）。</summary>
        private static (string Path, string Text)? LoadModuleText(string resourceName)
        {
            // 显式名：先试短名，再试 "Replay/xxx"
            if (!string.IsNullOrEmpty(resourceName))
            {
                var a = Resources.Load<TextAsset>(resourceName);
                if (a == null) a = Resources.Load<TextAsset>("Replay/" + resourceName);
                if (a != null) return ($"Replay/{resourceName}", a.text);
            }

            // 枚举 Resources/Replay 下第一个 md/json（TextAsset 只能按名加载：
            // 用 Resources.LoadAll<TextAsset>("Replay") 获取该目录全部文本资源）
            var all = Resources.LoadAll<TextAsset>("Replay");
            foreach (var ta in all)
            {
                var n = (ta.name ?? "").ToLowerInvariant();
                if (n.EndsWith(".md") || n.EndsWith(".json") || n.Contains("剧本") || n.Contains("module"))
                {
                    return ($"Replay/{ta.name}", ta.text);
                }
            }
            return null;
        }

        private IEnumerator CreateSessionOnce()
        {
            using (var req = UnityWebRequest.Post($"{BaseUrl}/replay/sessions", "{}", "application/json"))
            {
                req.timeout = 10;
                yield return req.SendWebRequest();
                if (req.result == UnityWebRequest.Result.Success)
                {
                    try
                    {
                        var data = JsonUtility.FromJson<SessionResponse>(req.downloadHandler.text)
                                   ?? JsonUtility.FromJson<SessionResponse>("{\"session_id\":\"" + ExtractId(req.downloadHandler.text) + "\"}");
                        if (data != null && !string.IsNullOrEmpty(data.session_id))
                        {
                            SessionId = data.session_id;
                            Debug.Log($"[ReplayClient] 本局 Replay 会话: {SessionId} @ {BaseUrl}");
                        }
                    }
                    catch (Exception ex)
                    {
                        Debug.LogError($"[ReplayClient] 解析会话响应失败: {ex.Message}");
                    }
                }
                else
                {
                    Debug.LogWarning($"[ReplayClient] 创建会话失败: {req.responseCode} {req.error}（将重试）");
                }
            }
        }

        private static string ExtractId(string json)
        {
            var m = System.Text.RegularExpressions.Regex.Match(json ?? "", "\"session_id\"\\s*:\\s*\"([^\"]+)\"");
            return m.Success ? m.Groups[1].Value : "";
        }

        // ---------- 上传录音分段 ----------

        /// <summary>把一段录音 WAV 上传到本局 session（后台排队，失败重试不阻塞游戏）。</summary>
        public void QueueUploadSegment(string wavPath)
        {
            if (string.IsNullOrEmpty(SessionId) || string.IsNullOrEmpty(wavPath) || !File.Exists(wavPath))
            {
                Debug.LogWarning($"[ReplayClient] 上传跳过: session={SessionId} wav={wavPath}");
                return;
            }
            StartCoroutine(UploadSegmentCoroutine(wavPath));
        }

        private IEnumerator UploadSegmentCoroutine(string wavPath)
        {
            var bytes = File.ReadAllBytes(wavPath);
            var fileName = Path.GetFileName(wavPath);
            var form = new WWWForm();
            form.AddBinaryData("file", bytes, fileName, "audio/wav");
            using (var req = UnityWebRequest.Post($"{BaseUrl}/replay/sessions/{SessionId}/audio", form))
            {
                req.timeout = 30;
                yield return req.SendWebRequest();
                if (req.result == UnityWebRequest.Result.Success)
                {
                    Debug.Log($"[ReplayClient] 已上传录音分段: {fileName}");
                }
                else
                {
                    Debug.LogWarning($"[ReplayClient] 上传失败 {fileName}: {req.responseCode} {req.error}（本地文件保留：{wavPath}）");
                }
            }
        }

        // ---------- 一键生成 ----------

        /// <summary>触发后端一键生成（转写整局分段 → 摘要/大纲/小说 → 插图 → replay.html）。</summary>
        public void QueueGenerate()
        {
            if (string.IsNullOrEmpty(SessionId))
            {
                Debug.LogWarning("[ReplayClient] 会话未就绪，无法生成");
                return;
            }
            StartCoroutine(GenerateCoroutine());
        }

        private IEnumerator GenerateCoroutine()
        {
            Debug.Log($"[ReplayClient] 开始生成小说 @ session {SessionId}（转写+叙事+生图，可能需要几分钟）");
            using (var req = UnityWebRequest.Post($"{BaseUrl}/replay/sessions/{SessionId}/generate", "{}", "application/json"))
            {
                // 生图较慢：放宽超时（默认 300s；生成含多张图时可再调大）
                req.timeout = 600;
                yield return req.SendWebRequest();
                if (req.result == UnityWebRequest.Result.Success)
                {
                    LastReplayUrl = $"{BaseUrl}/replay/sessions/{SessionId}/replay.html";
                    Debug.Log($"[ReplayClient] 小说生成完成: {LastReplayUrl}");
                }
                else
                {
                    Debug.LogError($"[ReplayClient] 生成失败: {req.responseCode} {req.error}");
                }
            }
        }

        [Serializable]
        private class SessionResponse
        {
            public string session_id;
        }
    }
}