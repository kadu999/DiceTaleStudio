using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;

namespace DiceTale
{
    /// <summary>
    /// 按**资源逻辑 ID** 取音频（<see cref="AudioClip"/>）。
    ///
    /// 与取图（<see cref="ResourceImageLoader"/>）完全同一套：**本地资源包优先**
    /// （<see cref="ResourceBundleCache.LocalUrlOf"/> → `file://`），本地没有再退回服务端的原始资源接口
    /// `GET {http}/api/resources/raw?id=…`。
    ///
    /// 三件事值得单独说：
    /// - **缓存**：同一首曲子整个进程只解一次（背景音乐被反复切换时不必反复解码）；
    /// - **去重**：正在取的时候再来要，就排队等同一份结果（编辑器补发时可能连来两条）；
    /// - **失败记住**：解不出来（文件被删 / 编码这台机器不支持）只记一条日志并记住失败，
    ///   不再每次点播放都重试——命令那边会如实回 `ok:false`，编辑器日志里看得见原因。
    ///
    /// `AudioType` 按扩展名给：`.mp3` / `.wav` / `.ogg` 是三大件，也是编辑器选择器里推荐的那几种。
    /// 认不出的扩展名**照样试 `MPEG`**（Unity 会自己嗅探一部分格式），失败就按失败处理。
    /// </summary>
    public class AudioClipLoader : MonoBehaviour
    {
        private readonly Dictionary<string, AudioClip> cache = new Dictionary<string, AudioClip>();
        private readonly Dictionary<string, List<Action<AudioClip>>> pending =
            new Dictionary<string, List<Action<AudioClip>>>();
        private readonly HashSet<string> failed = new HashSet<string>();

        private string httpBaseUrl = "";
        private ResourceBundleCache bundleCache;

        /// <summary>服务端 HTTP 基地址（本地没有的音频仍走它）。</summary>
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
                bundleCache.VersionChanged += OnBundleVersionChanged;
            }
        }

        private void OnBundleVersionChanged(ResourceBundleCache cache)
        {
            // 换了本地版本：已解出来的片段是旧版的，丢掉（正在放的由调用方决定要不要重放）
            Clear();
        }

        private void OnDestroy()
        {
            if (bundleCache != null)
            {
                bundleCache.VersionChanged -= OnBundleVersionChanged;
            }
        }

        /// <summary>释放全部已加载的音频片段（换项目 / 资源包换版本时调）。</summary>
        public void Clear()
        {
            foreach (var clip in cache.Values)
            {
                if (clip != null)
                {
                    Destroy(clip);
                }
            }

            cache.Clear();
            failed.Clear();
            pending.Clear();
        }

        /// <summary>取一首曲子（命中缓存立即回调；否则去要一份）。失败时回调 `null`。</summary>
        public void Load(string logicalId, Action<AudioClip> onLoaded)
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

            pending[logicalId] = new List<Action<AudioClip>> { onLoaded };
            StartCoroutine(Fetch(logicalId));
        }

        private IEnumerator Fetch(string logicalId)
        {
            // 本地优先：资源包已就绪且这一版里有这个文件，就不再问服务端
            var localUrl = bundleCache != null ? bundleCache.LocalUrlOf(logicalId) : null;
            var isLocal = localUrl != null;

            if (!isLocal && string.IsNullOrEmpty(httpBaseUrl))
            {
                Debug.LogWarning("[取音频] 既没有本地资源包、也还不知道服务端 HTTP 地址，先不取");
                Complete(logicalId, null);
                yield break;
            }

            var url = isLocal
                ? localUrl
                : $"{httpBaseUrl}/api/resources/raw?id={UnityWebRequest.EscapeURL(logicalId)}";

            using (var request = UnityWebRequestMultimedia.GetAudioClip(url, AudioTypeOf(logicalId)))
            {
                yield return request.SendWebRequest();

                if (request.result != UnityWebRequest.Result.Success)
                {
                    Debug.LogWarning($"[取音频] 失败：{logicalId}（{(isLocal ? "本地" : "远程")} {request.error}）");
                    // 本地文件读不出来（被删 / 权限）时别把 ID 拉黑：远程还有一份
                    if (!isLocal)
                    {
                        failed.Add(logicalId);
                    }

                    Complete(logicalId, null);
                    yield break;
                }

                var clip = DownloadHandlerAudioClip.GetContent(request);
                if (clip == null)
                {
                    Debug.LogWarning($"[取音频] 解不出音频：{logicalId}");
                    failed.Add(logicalId);
                    Complete(logicalId, null);
                    yield break;
                }

                // 背景音乐要循环、音效要一次性：循环由播放侧决定，这里只保证片段本身可用
                clip.name = logicalId;
                Complete(logicalId, clip);
            }
        }

        /// <summary>按扩展名给 <see cref="AudioType"/>（认不出就按 MPEG 试一把）。</summary>
        private static AudioType AudioTypeOf(string logicalId)
        {
            var lower = logicalId.ToLowerInvariant();
            if (lower.EndsWith(".wav"))
            {
                return AudioType.WAV;
            }

            if (lower.EndsWith(".ogg"))
            {
                return AudioType.OGGVORBIS;
            }

            if (lower.EndsWith(".aiff") || lower.EndsWith(".aif"))
            {
                return AudioType.AIFF;
            }

            // `.mp3` 与认不出的扩展名都走这里
            return AudioType.MPEG;
        }

        private void Complete(string logicalId, AudioClip clip)
        {
            if (clip != null)
            {
                cache[logicalId] = clip;
            }

            if (!pending.TryGetValue(logicalId, out var waiters))
            {
                return;
            }

            pending.Remove(logicalId);
            foreach (var waiter in waiters)
            {
                waiter?.Invoke(clip);
            }
        }
    }
}
