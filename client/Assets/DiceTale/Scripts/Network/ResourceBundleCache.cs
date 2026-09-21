using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;

namespace DiceTale
{
    /// <summary>资源包里的一个文件（服务端清单里的条目，也是包内 `dts-bundle.json` 的条目）。</summary>
    public class BundleFile
    {
        /// <summary>资源逻辑 ID（镜像里用的就是它）。</summary>
        public string id = "";

        /// <summary>包内路径 / 项目根相对路径，如 `Assets/images/Map001.png`。</summary>
        public string path = "";

        public long size;
    }

    /// <summary>
    /// 当前项目的资源包：**连上就把整个 `Assets/` 拉到本地**，之后资源从本地读，不再逐张走 HTTP。
    ///
    /// **顺序：先下资源、再载入场景。** 服务端在 `scene_sync` 之前先发 `resources_prepare`
    /// 告知项目名，前端据此立刻开下；<see cref="SceneMirror"/> 会把场景挂起，等到
    /// <see cref="Completed"/> 才落地。
    ///
    /// 流程（幂等，重复调用同一项目不会重复下载）：
    /// 1. `GET /api/resources/manifest?project=…` 拿指纹与文件数；
    /// 2. 本地已有**同指纹**的版本 → 直接就绪，一个字节都不下；
    /// 3. 否则 `GET /api/resources/bundle?project=…&v=&lt;本地已知指纹&gt;`：
    ///    服务端指纹未变会回 **304**（用现有版本），变了才回整包 zip；
    /// 4. zip 落到临时文件 → **后台线程**解到 `&lt;指纹&gt;.partial` → 改名成正式版本目录；
    /// 5. 全部成功才写指纹标记（写标记 = 这一版可用），然后清掉更旧的版本；
    /// 6. 结果（成功 / 失败）经 WebSocket 报给服务端，编辑器运行面板上看得见。
    ///
    /// 失败**不清旧版本**：图片继续能用旧的，`ResourceImageLoader` 也会退回逐文件远程取。
    /// </summary>
    public class ResourceBundleCache : MonoBehaviour
    {
        /// <summary>本地资源包的根目录名（最终路径 = `persistentDataPath/dts-bundles/&lt;服务端标识&gt;`）。</summary>
        public const string DefaultFolderName = "dts-bundles";

        /// <summary>清单请求超时（秒）：只是个小 JSON，网络不通时要尽快失败。</summary>
        private const int ManifestTimeoutSeconds = 15;

        /// <summary>整包下载超时（秒）：几十 MB 的包，给足时间。</summary>
        private const int BundleTimeoutSeconds = 300;

        /// <summary>同名失败重试上限（连接类失败才重试，见 <see cref="ShouldRetry"/>）。</summary>
        private const int MaxAttempts = 3;

        private const float RetryDelaySeconds = 3f;

        /// <summary>
        /// 本地版本目录换了一个（新指纹就绪）时触发。
        ///
        /// 订阅方（<see cref="ResourceImageLoader"/>）据此丢掉按旧版本解出来的贴图缓存——
        /// 不丢的话换版后旧纹理常驻，且可能继续显示上一版素材。
        /// </summary>
        public event Action<ResourceBundleCache> VersionChanged;

        /// <summary>
        /// 某个项目的资源包**处理完了**（成功或失败都触发一次）。
        ///
        /// <see cref="SceneMirror"/> 据此决定「现在可以载入场景了」——顺序是
        /// **先下资源、再载入场景**；失败也要放行（否则资源永远下不来时场景会一直不显示，
        /// 那种情况下宁可退回逐文件远程取的模式）。
        /// </summary>
        public event Action<ResourceBundleCache> Completed;

        /// <summary>本地已经有可用的资源包（图片可以走本地文件了）。</summary>
        public bool Ready { get; private set; }

        /// <summary>当前可用版本的目录（传给 <see cref="LocalResourceStore"/>）；没就绪时为空串。</summary>
        public string VersionRoot { get; private set; } = "";

        /// <summary>
        /// 逻辑 ID → **本地包里的 `file://` 地址**（包就绪、且这个文件真的在磁盘上时）；否则 null。
        ///
        /// 「本地优先」这条规矩只有这一个入口：取图（<see cref="ResourceImageLoader"/>）与
        /// 放视频（<see cref="VideoOverlay"/> 的 `VideoPlayer.url`）都走它——本地有就一个字节的
        /// 网络都不走，本地没有才回退到服务端的 `/api/resources/raw`。
        ///
        /// 用 `Uri` 而不是手拼 `file://` 前缀：盘符与中文路径要靠它正确转义，而
        /// `UnityWebRequest` 与 `VideoPlayer.url` 都认这种 `file:///D:/…` 形式。
        /// </summary>
        public string LocalUrlOf(string logicalId)
        {
            if (!Ready)
            {
                return null;
            }

            var path = LocalResourceStore.LocalPathOf(VersionRoot, logicalId);
            return path != null && File.Exists(path) ? new Uri(path).AbsoluteUri : null;
        }

        /// <summary>当前版本的指纹（就绪时 = 服务端指纹）。</summary>
        public string Fingerprint { get; private set; } = "";

        /// <summary>正在处理的项目名（空 = 还没被要求过）。</summary>
        public string Project { get; private set; } = "";

        /// <summary>失败原因（没人能看懂的错误也在这里，日志里打全）。</summary>
        public string LastError { get; private set; } = "";

        /// <summary>这份包里的文件清单（来自服务端 manifest / 包内 dts-bundle.json）。</summary>
        public IReadOnlyList<BundleFile> Files => files;

        /// <summary>本地根目录（测试或诊断用）。</summary>
        public string RootPath { get; private set; } = "";

        private readonly List<BundleFile> files = new List<BundleFile>();

        private string httpBaseUrl = "";
        private ClientSession session;
        private Coroutine routine;
        private bool inFlight;

        /// <summary>上次上报给服务端的指纹与结果——重连后不重复报同一件事。</summary>
        private string reportedFingerprint = "";
        private bool reportedOk;

        /// <summary>同名失败的次数（连接类失败会退避重试）。</summary>
        private int attempts;

        /// <summary>
        /// 接上服务端 HTTP 基地址与协议会话（由 <see cref="BackendManager"/> 调一次）。
        ///
        /// `root` 留空时用 `persistentDataPath/dts-bundles/&lt;服务端标识&gt;`：
        /// **一定要带服务端标识**——`persistentDataPath` 由 `companyName/productName` 决定，
        /// 同一台机器上多个工程常共用 `DefaultCompany/&lt;product&gt;` 这一层，只按项目名分目录
        /// 会让不同服务端、不同工程的同名项目互相覆盖。标识取 HTTP 基地址的哈希（见
        /// <see cref="ServerKeyOf"/>），同一个服务端永远算出同一个目录。
        /// </summary>
        public void Initialize(string httpBase, ClientSession clientSession, string root = null)
        {
            httpBaseUrl = httpBase ?? "";
            AttachSession(clientSession);
            RootPath = string.IsNullOrEmpty(root)
                ? Path.Combine(Application.persistentDataPath, DefaultFolderName, ServerKeyOf(httpBaseUrl))
                : root;
        }

        /// <summary>
        /// 由服务端地址算一个稳定的目录名：`&lt;末段可读名&gt;-&lt;8 位哈希&gt;`。
        ///
        /// 为什么要带哈希：`persistentDataPath` 是 Unity 按**工程路径**的哈希算的，同一台机器上
        /// 两个路径不同但**同名**的工程会共用同一个 `persistentDataPath`——那时两边的
        /// `dts-bundles/` 会互相看见。只按项目名分目录挡不住这种串扰，所以标识必须把
        /// **完整服务端地址**算进去。
        ///
        /// 自己算 FNV-1a 而不用 `string.GetHashCode`：后者在 .NET Core 上**每个进程都不一样**
        /// （随机化种子），拿它当目录名会导致每次启动都换一个目录、缓存永远不命中。
        /// </summary>
        internal static string ServerKeyOf(string httpBase)        {
            if (string.IsNullOrEmpty(httpBase))
            {
                return "unknown";
            }

            var hash = 2166136261u; // FNV-1a 32 位
            foreach (var character in httpBase)
            {
                hash ^= character;
                hash *= 16777619u;
            }

            var trimmed = httpBase.TrimEnd('/');
            var separator = trimmed.LastIndexOf('/');
            var label = separator >= 0 ? trimmed.Substring(separator + 1) : trimmed;
            foreach (var invalid in Path.GetInvalidFileNameChars())
            {
                label = label.Replace(invalid, '-');
            }

            if (label.Length == 0)
            {
                label = "server";
            }

            if (label.Length > 24)
            {
                label = label.Substring(0, 24);
            }

            return $"{label}-{hash:x8}";
        }

        /// <summary>接上会话（必须调，否则收不到「先下资源包」与「握手完成」这两件事）。</summary>
        private void AttachSession(ClientSession clientSession)
        {
            if (session != null)
            {
                session.ResourcesPrepareRequested -= OnResourcesPrepareRequested;
                session.SessionReady -= OnSessionReady;
            }

            session = clientSession;

            if (session != null)
            {
                session.ResourcesPrepareRequested += OnResourcesPrepareRequested;
                // 握手完成时补报一次：连接刚建立、握手还没完就发 resources_ready 服务端不认
                session.SessionReady += OnSessionReady;
            }
        }

        private void OnSessionReady()
        {
            ReportToServer();
        }

        private void OnDestroy()
        {
            if (session != null)
            {
                session.ResourcesPrepareRequested -= OnResourcesPrepareRequested;
                session.SessionReady -= OnSessionReady;
            }

            if (routine != null)
            {
                StopCoroutine(routine);
                routine = null;
            }
        }

        /// <summary>
        /// 服务端在 `scene_sync` 之前告诉我们「当前是哪个项目」——**先下资源包，再等场景**。
        /// 项目为 null 时什么都不做（等场景到了再从镜像里推）。
        /// </summary>
        private void OnResourcesPrepareRequested(string project)
        {
            if (!string.IsNullOrEmpty(project))
            {
                EnsureForProject(project);
            }
        }

        /// <summary>
        /// 这个项目的资源包**已经处理完了**（成功或失败都算）。
        ///
        /// <see cref="SceneMirror"/> 用它决定「现在能不能载入场景」——顺序是
        /// **先下资源、再载入场景**，所以场景要等到这里放行。
        /// </summary>
        public bool IsFinishedFor(string project)
        {
            return !inFlight && Project == project && (Ready || LastError.Length > 0);
        }

        /// <summary>
        /// 确保某个项目的资源包在本地可用。幂等：同一项目已在处理 / 已就绪时直接返回。
        ///
        /// 由 <see cref="SceneMirror"/> 在收到场景时调用（那时才知道当前是哪个项目）。
        /// </summary>
        public void EnsureForProject(string project)
        {
            if (string.IsNullOrEmpty(project) || string.IsNullOrEmpty(httpBaseUrl))
            {
                return;
            }

            // 已经就绪且还是同一个项目：只在「还没把结果报上去」时补报一次
            if (Ready && Project == project)
            {
                ReportToServer();
                return;
            }

            if (inFlight && Project == project)
            {
                return;
            }

            Project = project;
            Ready = false;
            VersionRoot = "";
            Fingerprint = "";
            LastError = "";
            attempts = 0;
            reportedFingerprint = "";
            reportedOk = false;
            files.Clear();

            if (routine != null)
            {
                StopCoroutine(routine);
            }

            routine = StartCoroutine(Run(project));
        }

        /// <summary>手动重来一次（下载失败后用户点了重试、或服务端素材刚更新）。</summary>
        public void Retry()
        {
            var project = Project;
            if (string.IsNullOrEmpty(project))
            {
                return;
            }

            inFlight = false;
            EnsureForProject(project);
        }

        // ------------------------------------------------------------ 主流程

        private IEnumerator Run(string project)
        {
            inFlight = true;

            while (true)
            {
                var outcome = default(Outcome);
                yield return CheckManifest(project, result => outcome = result);

                if (outcome.Kind == OutcomeKind.Ready)
                {
                    break;
                }

                if (outcome.Kind == OutcomeKind.Failed)
                {
                    // 连接类失败才重试；「确定的失败」（404 / 413 / 解压坏了）重试也是白搭
                    attempts++;
                    if (ShouldRetry(outcome.Retryable) && attempts < MaxAttempts)
                    {
                        Debug.LogWarning(
                            $"[资源包] {project} 第 {attempts} 次失败（{outcome.Reason}），{RetryDelaySeconds} 秒后重试");
                        yield return new WaitForSeconds(RetryDelaySeconds);
                        continue;
                    }

                    Ready = false;
                    VersionRoot = "";
                    LastError = outcome.Reason;
                    inFlight = false;
                    Debug.LogWarning($"[资源包] {project} 未就绪：{outcome.Reason}（图片继续走远程逐张取）");
                    ReportToServer();
                    Completed?.Invoke(this);
                    yield break;
                }

                // 需要下载（或本地版本不匹配）
                yield return DownloadAndExtract(project, outcome, result => outcome = result);

                if (outcome.Kind == OutcomeKind.Ready)
                {
                    break;
                }

                attempts++;
                if (ShouldRetry(outcome.Retryable) && attempts < MaxAttempts)
                {
                    Debug.LogWarning(
                        $"[资源包] {project} 第 {attempts} 次失败（{outcome.Reason}），{RetryDelaySeconds} 秒后重试");
                    yield return new WaitForSeconds(RetryDelaySeconds);
                    continue;
                }

                Ready = false;
                LastError = outcome.Reason;
                inFlight = false;
                Debug.LogWarning($"[资源包] {project} 未就绪：{outcome.Reason}（图片继续走远程逐张取）");
                ReportToServer();
                Completed?.Invoke(this);
                yield break;
            }

            inFlight = false;
            Ready = true;
            ReportToServer();
            Completed?.Invoke(this);
        }

        private static bool ShouldRetry(bool retryable)
        {
            return retryable;
        }

        /// <summary>第一步：要清单，决定「本地已有」还是「得下包」。</summary>
        private IEnumerator CheckManifest(string project, Action<Outcome> done)
        {
            if (string.IsNullOrEmpty(httpBaseUrl))
            {
                done(Outcome.Failed("还不知道服务端 HTTP 地址（连接没建立？）", true));
                yield break;
            }

            var url = $"{httpBaseUrl}{Protocol.ManifestPath}{UnityWebRequest.EscapeURL(project)}";
            using (var request = UnityWebRequest.Get(url))
            {
                request.timeout = ManifestTimeoutSeconds;
                yield return request.SendWebRequest();

                if (request.result != UnityWebRequest.Result.Success)
                {
                    done(Outcome.Failed($"取资源清单失败：{Describe(request)}", true));
                    yield break;
                }

                var node = JsonParser.ParseObject(request.downloadHandler.text);
                if (node == null)
                {
                    done(Outcome.Failed("资源清单不是合法 JSON", false));
                    yield break;
                }

                var fingerprint = JsonParser.GetString(node, "fingerprint") ?? "";
                if (fingerprint.Length == 0)
                {
                    done(Outcome.Failed("资源清单里没有指纹", false));
                    yield break;
                }

                files.Clear();
                var rawFiles = JsonParser.GetArray(node, "files");
                if (rawFiles != null)
                {
                    foreach (var raw in rawFiles)
                    {
                        if (!(raw is Dictionary<string, object> file))
                        {
                            continue;
                        }

                        files.Add(new BundleFile
                        {
                            id = JsonParser.GetString(file, "id") ?? "",
                            path = JsonParser.GetString(file, "path") ?? "",
                            size = (long)JsonParser.GetNumber(file, "size"),
                        });
                    }
                }

                if (LocalResourceStore.HasVersion(RootPath, project, fingerprint))
                {
                    AdoptVersion(project, fingerprint, alreadyLocal: true);
                    done(Outcome.Ready(fingerprint));
                    yield break;
                }

                done(Outcome.NeedsDownload(fingerprint));
            }
        }

        /// <summary>第二步：下整包（可能 304）→ 落到临时文件 → 后台线程解压 → 改名。</summary>
        private IEnumerator DownloadAndExtract(string project, Outcome manifest, Action<Outcome> done)
        {
            var fingerprint = manifest.Fingerprint;
            var known = LocalResourceStore.ListVersions(RootPath, project);
            var knownFingerprint = known.Count > 0 ? known[0] : "";

            var url =
                $"{httpBaseUrl}{Protocol.BundlePath}{UnityWebRequest.EscapeURL(project)}" +
                (knownFingerprint.Length == 0 ? "" : $"&v={UnityWebRequest.EscapeURL(knownFingerprint)}");

            var zipPath = Path.Combine(RootPath, $"{project}-{fingerprint}{LocalResourceStore.PartialSuffix}.zip");
            Directory.CreateDirectory(RootPath);

            using (var request = UnityWebRequest.Get(url))
            {
                request.timeout = BundleTimeoutSeconds;
                request.downloadHandler = new DownloadHandlerFile(zipPath) { removeFileOnAbort = true };

                var operation = request.SendWebRequest();
                while (!operation.isDone)
                {
                    yield return null;
                }

                // 服务端说「你本地那一版就是最新的」：直接用本地版本
                if (request.responseCode == 304)
                {
                    if (knownFingerprint.Length > 0 && LocalResourceStore.HasVersion(RootPath, project, knownFingerprint))
                    {
                        AdoptVersion(project, knownFingerprint, alreadyLocal: true);
                        done(Outcome.Ready(knownFingerprint));
                        yield break;
                    }

                    // 本地其实没有那一版（报的指纹是旧的 / 目录被清了）：不带 v 再下整包
                    done(Outcome.Failed("服务端回 304，但本地并没有这一版", true));
                    yield break;
                }

                if (request.result != UnityWebRequest.Result.Success)
                {
                    SafeDelete(zipPath);
                    // 413 = 整包太大，服务端明确要求退回逐文件，重试没意义
                    var tooLarge = request.responseCode == 413;
                    done(Outcome.Failed(
                        tooLarge ? "资源包超过服务端上限（413），已退回逐文件远程取" : $"下载资源包失败：{Describe(request)}",
                        !tooLarge));
                    yield break;
                }
            }

            // 解压是同步 IO：放后台线程，别把主线程卡住（几十 MB 要几百毫秒）
            var partialRoot = LocalResourceStore.PartialRoot(RootPath, project, fingerprint);
            var versionRoot = LocalResourceStore.VersionRoot(RootPath, project, fingerprint);
            var extracted = RunExtraction(zipPath, partialRoot, versionRoot, fingerprint);

            while (!extracted.IsCompleted)
            {
                yield return null;
            }

            if (extracted.IsFaulted)
            {
                SafeDelete(zipPath);
                done(Outcome.Failed(
                    $"解压资源包失败：{extracted.Exception?.GetBaseException().Message ?? "未知错误"}",
                    false));
                yield break;
            }

            SafeDelete(zipPath);

            int removed;
            LocalResourceStore.Cleanup(RootPath, project, fingerprint, 2, out removed);

            AdoptVersion(project, fingerprint, alreadyLocal: false);
            Debug.Log(
                $"[资源包] {project} 就绪：{files.Count} 个文件 / {fingerprint}" +
                $"（本地 {versionRoot}，清掉旧版本 {removed} 个）");

            done(Outcome.Ready(fingerprint));        }

        /// <summary>
        /// 后台线程：解压 + 写指纹标记 + 目录改名。
        ///
        /// 顺序很关键——**先解到 `.partial`、再写标记、最后改名**：任何一步失败都不会
        /// 留下一个「半截但看起来可用」的版本，读方只认带标记的正式目录。
        ///
        /// 解压用自研的 <see cref="ZipStoredReader"/>（包是 STORED 的，纯 C# 就能读）——
        /// Unity 里没有 `System.IO.Compression` 程序集，`ZipArchive` 用不了。
        /// </summary>
        private static Task RunExtraction(string zipPath, string partialRoot, string versionRoot, string fingerprint)
        {
            return Task.Run(() =>
            {
                LocalResourceStore.TryDeleteDirectory(partialRoot);
                Directory.CreateDirectory(partialRoot);

                using (var zip = new FileStream(zipPath, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    // 条目名是服务端的 `Assets/images/…`，本地落盘要剥掉 `Assets/` 那一层
                    var extracted = ZipStoredReader.ExtractAll(
                        zip,
                        partialRoot,
                        LocalResourceStore.LocalRelativePathOfZipEntry);
                    if (extracted == 0)
                    {
                        throw new InvalidDataException("资源包里没有任何文件");
                    }
                }

                // 标记 = 「这一版是完整的」，必须在解压全部成功之后写
                LocalResourceStore.WriteFingerprint(partialRoot, fingerprint);

                LocalResourceStore.TryDeleteDirectory(versionRoot);
                Directory.Move(partialRoot, versionRoot);
            });
        }

        /// <summary>把某一版设为「当前版本」。</summary>
        private void AdoptVersion(string project, string fingerprint, bool alreadyLocal)
        {
            var changed = VersionRoot != LocalResourceStore.VersionRoot(RootPath, project, fingerprint);

            Ready = true;
            Project = project;
            Fingerprint = fingerprint;
            VersionRoot = LocalResourceStore.VersionRoot(RootPath, project, fingerprint);
            LastError = "";

            if (changed)
            {
                VersionChanged?.Invoke(this);
            }

            if (!alreadyLocal)
            {
                return;
            }

            Debug.Log($"[资源包] {project} 本地已有指纹 {fingerprint}，不必重新下载（{VersionRoot}）");
        }

        /// <summary>把结果报给服务端（编辑器运行面板显示「素材下到哪了」）。重复的不再报。</summary>
        private void ReportToServer()
        {
            if (session == null || Project.Length == 0 || Fingerprint.Length == 0)
            {
                return;
            }

            if (reportedFingerprint == Fingerprint && reportedOk == Ready)
            {
                return;
            }

            reportedFingerprint = Fingerprint;
            reportedOk = Ready;

            var bytes = 0L;
            foreach (var file in files)
            {
                bytes += file.size;
            }

            session.SendResourcesReady(new Protocol.ResourcesReadyMessage
            {
                project = Project,
                fingerprint = Fingerprint,
                fileCount = files.Count,
                bytes = bytes,
                ok = Ready,
                reason = Ready ? "" : LastError,
            });
        }

        private static string Describe(UnityWebRequest request)
        {
            return request.responseCode > 0
                ? $"HTTP {request.responseCode} {request.error}"
                : request.error;
        }

        private static void SafeDelete(string path)
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (IOException)
            {
                // 删不掉就留着，下次写入会覆盖
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        // ------------------------------------------------------------ 结果

        private enum OutcomeKind
        {
            Ready,
            NeedsDownload,
            Failed,
        }

        private struct Outcome
        {
            public OutcomeKind Kind;
            public string Fingerprint;
            public string Reason;
            public long Bytes;
            public bool Retryable;

            public static Outcome Ready(string fingerprint)
            {
                return new Outcome { Kind = OutcomeKind.Ready, Fingerprint = fingerprint };
            }

            public static Outcome NeedsDownload(string fingerprint)
            {
                return new Outcome { Kind = OutcomeKind.NeedsDownload, Fingerprint = fingerprint };
            }

            public static Outcome Failed(string reason, bool retryable)
            {
                return new Outcome { Kind = OutcomeKind.Failed, Reason = reason, Retryable = retryable };
            }
        }
    }
}
