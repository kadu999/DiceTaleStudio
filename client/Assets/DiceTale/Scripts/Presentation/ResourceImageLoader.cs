using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;

namespace DiceTale
{
    /// <summary>
    /// 按**资源逻辑 ID** 取图：`GET {http}/api/resources/raw?id=…` → <see cref="Texture2D"/>。
    ///
    /// 后台推下来的是逻辑 ID（如 `project:测试项目/Assets/images/场景1.png`），字节走服务端的
    /// 原始资源接口——前端不自己拼文件路径，也不假设资源在本地。
    ///
    /// 缓存与去重：同一张图整个进程只取一次；正在取的时候再来要就排队等同一份结果。
    /// 取失败只记一条日志并**记住失败**（不再每帧重试），视图那边继续显示占位色。
    /// </summary>
    public class ResourceImageLoader : MonoBehaviour
    {
        private readonly Dictionary<string, Texture2D> cache = new Dictionary<string, Texture2D>();
        private readonly Dictionary<string, List<Action<Texture2D>>> pending = new Dictionary<string, List<Action<Texture2D>>>();
        private readonly HashSet<string> failed = new HashSet<string>();

        private string httpBaseUrl = "";

        /// <summary>服务端 HTTP 基地址（从 WebSocket 地址推导；取图 / 后续取音频都走它）。</summary>
        public void Initialize(string httpBase)
        {
            httpBaseUrl = httpBase ?? "";
        }

        /// <summary>取一张图（命中缓存立即回调；否则去要一份）。失败时回调 `null`。</summary>
        public void Load(string logicalId, Action<Texture2D> onLoaded)
        {
            if (string.IsNullOrEmpty(logicalId))
            {
                onLoaded?.Invoke(null);
                return;
            }

            if (cache.TryGetValue(logicalId, out var cached))
            {
                onLoaded?.Invoke(cached);
                return;
            }

            if (failed.Contains(logicalId))
            {
                onLoaded?.Invoke(null);
                return;
            }

            if (pending.TryGetValue(logicalId, out var waiters))
            {
                waiters.Add(onLoaded);
                return;
            }

            pending[logicalId] = new List<Action<Texture2D>> { onLoaded };
            StartCoroutine(Fetch(logicalId));
        }

        private IEnumerator Fetch(string logicalId)
        {
            if (string.IsNullOrEmpty(httpBaseUrl))
            {
                Debug.LogWarning("[取图] 还不知道服务端 HTTP 地址（连接没建立？），先不取图");
                Complete(logicalId, null);
                yield break;
            }

            var url = $"{httpBaseUrl}/api/resources/raw?id={UnityWebRequest.EscapeURL(logicalId)}";
            using (var request = UnityWebRequestTexture.GetTexture(url))
            {
                yield return request.SendWebRequest();

                if (request.result != UnityWebRequest.Result.Success)
                {
                    Debug.LogWarning($"[取图] 失败：{logicalId}（{request.error}）");
                    failed.Add(logicalId);
                    Complete(logicalId, null);
                    yield break;
                }

                var texture = DownloadHandlerTexture.GetContent(request);
                if (texture == null)
                {
                    Debug.LogWarning($"[取图] 解不出纹理：{logicalId}");
                    failed.Add(logicalId);
                    Complete(logicalId, null);
                    yield break;
                }

                texture.name = logicalId; // Hierarchy / 调试里认得出是哪张
                cache[logicalId] = texture;
                Complete(logicalId, texture);
            }
        }

        /// <summary>把结果发给所有等着的人，并清掉排队记录。</summary>
        private void Complete(string logicalId, Texture2D texture)
        {
            if (!pending.TryGetValue(logicalId, out var waiters))
            {
                return;
            }

            pending.Remove(logicalId);
            foreach (var waiter in waiters)
            {
                waiter?.Invoke(texture);
            }
        }
    }
}
