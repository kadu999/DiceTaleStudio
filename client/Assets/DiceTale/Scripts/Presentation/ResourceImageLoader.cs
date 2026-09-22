using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using UnityEngine;
using UnityEngine.Networking;

namespace DiceTale
{
    /// <summary>
    /// 按**资源逻辑 ID** 取图。
    ///
    /// 优先**本地资源包**（<see cref="ResourceBundleCache"/> 已经把整个项目的 `Assets/` 下到本地），
    /// 本地没有再退回服务端的原始资源接口：
    /// `GET {http}/api/resources/raw?id=…` → <see cref="Texture2D"/>。
    ///
    /// 后台推下来的是逻辑 ID（如 `project:测试项目/Assets/images/场景1.png`），字节要么来自本地包、
    /// 要么来自服务端——前端既不自己拼文件路径，也不假设资源在本地。
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
        private ResourceBundleCache bundleCache;

        /// <summary>服务端 HTTP 基地址（从 WebSocket 地址推导；本地没有的图仍走它）。</summary>
        public void Initialize(string httpBase)
        {
            httpBaseUrl = httpBase ?? "";
        }

        /// <summary>接上资源包（可能后于本组件创建；接上后优先读本地）。</summary>
        public void Attach(ResourceBundleCache cache)
        {
            if (bundleCache != null)
            {
                bundleCache.VersionChanged -= OnBundleVersionChanged;
            }

            bundleCache = cache;

            if (bundleCache != null)
            {
                // 本地资源包换了版本（新指纹就绪）→ 丢掉旧版本解出来的贴图
                bundleCache.VersionChanged += OnBundleVersionChanged;
            }
        }

        private void OnBundleVersionChanged(ResourceBundleCache cache)
        {
            Clear();
        }

        private void OnDestroy()
        {
            if (bundleCache != null)
            {
                bundleCache.VersionChanged -= OnBundleVersionChanged;
            }
        }

        /// <summary>
        /// 释放全部已加载的贴图（换项目 / 资源包换版本时调）。
        ///
        /// 不释放的话纹理只增不减：镜像反复重建、资源包换版都会留下一堆用不到的贴图常驻内存。
        /// 注意**只销毁本加载器创建的**（它们都是运行时下载 / 解出来的）。
        /// </summary>
        public void Clear()
        {
            foreach (var texture in cache.Values)
            {
                if (texture != null)
                {
                    Destroy(texture);
                }
            }

            cache.Clear();
            failed.Clear();
            pending.Clear();
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
            // 本地优先：资源包已就绪且这一版里有这个文件，就不再问服务端
            var localUrl = bundleCache != null ? bundleCache.LocalUrlOf(logicalId) : null;
            var isLocal = localUrl != null;

            if (!isLocal && string.IsNullOrEmpty(httpBaseUrl))
            {
                Debug.LogWarning("[取图] 既没有本地资源包、也还不知道服务端 HTTP 地址，先不取图");
                Complete(logicalId, null);
                yield break;
            }

            // file:// 让同一条 UnityWebRequestTexture 链路既能读本地也能读远程
            var url = isLocal
                ? localUrl
                : $"{httpBaseUrl}/api/resources/raw?id={UnityWebRequest.EscapeURL(logicalId)}";

            using (var request = UnityWebRequestTexture.GetTexture(url))
            {
                yield return request.SendWebRequest();

                if (request.result != UnityWebRequest.Result.Success)
                {
                    Debug.LogWarning(
                        $"[取图] 失败：{logicalId}（{(isLocal ? "本地" : "远程")} {request.error}）");
                    // 本地文件读不出来（被删 / 权限）时别把 ID 拉黑：远程还有一份
                    if (!isLocal)
                    {
                        failed.Add(logicalId);
                    }

                    Complete(logicalId, null);
                    yield break;
                }

                var texture = DownloadHandlerTexture.GetContent(request);
                if (texture == null)
                {
                    Debug.LogWarning($"[取图] 解不出纹理：{logicalId}");
                    if (!isLocal)
                    {
                        failed.Add(logicalId);
                    }

                    Complete(logicalId, null);
                    yield break;
                }

                texture.name = logicalId; // Hierarchy / 调试里认得出是哪张
                // 子图（v10）要在纹理里采样**一块**：掉出格子边界时 Repeat 会绕到图片另一头
                // （双线性过滤下表现为「边缘混进对面的颜色」），Clamp 才贴着边不外溢。
                // 整张图用 Clamp 也无副作用（UV 本来就落在 0..1 内）。
                texture.wrapMode = TextureWrapMode.Clamp;
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
