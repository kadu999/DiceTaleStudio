using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace DiceTale
{
    /// <summary>
    /// 本地资源包在磁盘上的**约定**：逻辑 ID ↔ 本地文件路径、版本目录的选择与标记。
    ///
    /// 为什么单独一层：路径规则是纯字符串 + 文件系统的事，与网络、Unity 都无关，
    /// 所以它放在数据层（Data），可以脱离 Unity 单测；<see cref="ResourceBundleCache"/>
    /// 只管「下载与解压」，<see cref="ResourceImageLoader"/> 只管「用哪份字节」。
    ///
    /// **这是运行时下载物，一律落在 `Application.persistentDataPath` 下，绝不进 Unity 工程的
    /// `Assets/`**：往 `Assets/` 写会在编辑器里触发资产导入 + 域重载（每次下载都重编译一次），
    /// 而且下载物会被打进包体、污染 git。工程 `Assets/` 只放随包发布的源素材。
    ///
    /// 目录布局（`root` 由调用方给，见 <see cref="ResourceBundleCache"/>）：
    /// <code>
    /// &lt;root&gt;/&lt;项目名&gt;/&lt;指纹&gt;/images/Map001.png    ← 一个版本（注意：**没有** Assets/ 这一层）
    /// &lt;root&gt;/&lt;项目名&gt;/&lt;指纹&gt;/.dts-fingerprint  ← 服务端给的指纹（写完才算这个版本可用）
    /// &lt;root&gt;/&lt;项目名&gt;/&lt;指纹&gt;/.dts-created      ← 本版本落盘时间（清理旧版本时排序用）
    /// </code>
    /// 本地不复制 `Assets/` 这一层：那只是**服务端项目内**的目录名（zip 条目名仍是
    /// `Assets/images/Map001.png`，前端解出时把这一层剥掉），落在客户端磁盘上只会和
    /// Unity 工程的 `Assets/` 混淆。
    ///
    /// **指纹即目录名**：换了素材就是换目录，读到的一半旧一半新的情况在结构上不可能出现。
    /// </summary>
    public static class LocalResourceStore
    {
        /// <summary>版本完成的标记文件（内容 = 服务端指纹）。没有它 = 这个版本不可用。</summary>
        public const string FingerprintFile = ".dts-fingerprint";

        /// <summary>版本落盘时间的标记文件（内容 = Unix 毫秒）。</summary>
        public const string CreatedFile = ".dts-created";

        /// <summary>解压中的临时目录后缀（解完改名成正式指纹目录）。</summary>
        public const string PartialSuffix = ".partial";

        private const string ProjectPrefix = "project:";
        private const string AssetsRoot = "Assets";

        /// <summary>
        /// 逻辑 ID → 项目根相对路径；不是项目资源（如 `config:`）或格式不对时返回 null。
        ///
        /// 与后端 `projectNameFromId` / `belongsToProject` 同一口径：
        /// `project:测试项目/Assets/images/Map001.png` → `测试项目/Assets/images/Map001.png`。
        /// </summary>
        public static string ProjectRelativePathOf(string logicalId)
        {
            if (string.IsNullOrEmpty(logicalId) || !logicalId.StartsWith(ProjectPrefix, StringComparison.Ordinal))
            {
                return null;
            }

            var relative = logicalId.Substring(ProjectPrefix.Length).Replace('\\', '/').TrimStart('/');
            return relative.Length == 0 ? null : relative;
        }

        /// <summary>逻辑 ID → 项目名（`project:测试项目/...` → `测试项目`）；不是项目资源时返回 null。</summary>
        public static string ProjectNameOf(string logicalId)
        {
            var relative = ProjectRelativePathOf(logicalId);
            if (relative == null)
            {
                return null;
            }

            var separator = relative.IndexOf('/');
            return separator <= 0 ? null : relative.Substring(0, separator);
        }

        /// <summary>
        /// 逻辑 ID → **本地包内相对路径**（已剥掉项目名与 `Assets/` 两层），如 `images/Map001.png`。
        ///
        /// 不在 `Assets/` 下的资源返回 null——那种 ID 只能走远程逐文件。
        /// 取一个对象里任意资源 ID 推断项目名，也走 <see cref="ProjectRelativePathOf"/>。
        /// </summary>
        public static string RelativePathOf(string logicalId)
        {
            var projectRelative = ProjectRelativePathOf(logicalId);
            if (projectRelative == null)
            {
                return null;
            }

            var projectSeparator = projectRelative.IndexOf('/');
            if (projectSeparator <= 0 || projectSeparator + 1 >= projectRelative.Length)
            {
                return null;
            }

            var inner = projectRelative.Substring(projectSeparator + 1);
            if (inner.StartsWith(AssetsRoot + "/", StringComparison.Ordinal))
            {
                return inner.Substring(AssetsRoot.Length + 1);
            }

            return null;
        }

        /// <summary>
        /// 服务端 zip 里的条目名（`Assets/images/Map001.png`）→ 本地包内相对路径（`images/Map001.png`）。
        ///
        /// 解压时**必须**过这一道：zip 条目名来自服务端的项目目录结构，而本地不保留 `Assets/` 那一层。
        /// 不在 `Assets/` 下的条目（不在预期内）返回 null，由调用方跳过。
        /// </summary>
        public static string LocalRelativePathOfZipEntry(string entryName)
        {
            if (string.IsNullOrEmpty(entryName))
            {
                return null;
            }

            var normalized = entryName.Replace('\\', '/').TrimStart('/');
            if (!normalized.StartsWith(AssetsRoot + "/", StringComparison.Ordinal))
            {
                return null;
            }

            var inner = normalized.Substring(AssetsRoot.Length + 1);
            return inner.Length == 0 ? null : inner;
        }

        /// <summary>项目目录：`&lt;root&gt;/&lt;项目名&gt;`。</summary>
        public static string ProjectRoot(string root, string project)
        {
            return Path.Combine(root, project);
        }

        /// <summary>一个版本的目录：`&lt;root&gt;/&lt;项目名&gt;/&lt;指纹&gt;`。</summary>
        public static string VersionRoot(string root, string project, string fingerprint)
        {
            return Path.Combine(ProjectRoot(root, project), fingerprint);
        }

        /// <summary>解压中的临时目录：`&lt;root&gt;/&lt;项目名&gt;/&lt;指纹&gt;.partial`。</summary>
        public static string PartialRoot(string root, string project, string fingerprint)
        {
            return VersionRoot(root, project, fingerprint) + PartialSuffix;
        }

        /// <summary>
        /// 逻辑 ID 在这个版本里的本地文件路径（**不判断是否存在**）。
        ///
        /// 不是项目资源、或不在 `Assets/` 下时返回 null——那种 ID 只能走远程。
        /// </summary>
        public static string LocalPathOf(string versionRoot, string logicalId)
        {
            if (string.IsNullOrEmpty(versionRoot))
            {
                return null;
            }

            var relative = RelativePathOf(logicalId);
            return relative == null ? null : Path.Combine(versionRoot, relative.Replace('/', Path.DirectorySeparatorChar));
        }

        /// <summary>这个版本里有这个资源吗（文件真的在磁盘上）。</summary>
        public static bool Exists(string versionRoot, string logicalId)
        {
            var path = LocalPathOf(versionRoot, logicalId);
            return path != null && File.Exists(path);
        }

        /// <summary>读版本标记里的指纹；没有标记 / 读失败返回 null（= 这个版本不可用）。</summary>
        public static string ReadFingerprint(string versionRoot)
        {
            if (string.IsNullOrEmpty(versionRoot))
            {
                return null;
            }

            try
            {
                var path = Path.Combine(versionRoot, FingerprintFile);
                return File.Exists(path) ? File.ReadAllText(path).Trim() : null;
            }
            catch (IOException)
            {
                return null;
            }
            catch (UnauthorizedAccessException)
            {
                return null;
            }
        }

        /// <summary>写版本标记（**解压全部成功之后**才写；写完这个版本才算可用）。</summary>
        public static void WriteFingerprint(string versionRoot, string fingerprint)
        {
            Directory.CreateDirectory(versionRoot);
            File.WriteAllText(Path.Combine(versionRoot, FingerprintFile), fingerprint);

            var created = Path.Combine(versionRoot, CreatedFile);
            if (!File.Exists(created))
            {
                File.WriteAllText(
                    created,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture));
            }
        }

        /// <summary>本版本是何时落盘的（Unix 毫秒；没有标记返回 0，排序时排最后）。</summary>
        public static long ReadCreatedAt(string versionRoot)
        {
            try
            {
                var path = Path.Combine(versionRoot, CreatedFile);
                if (!File.Exists(path))
                {
                    return 0;
                }

                return long.TryParse(File.ReadAllText(path).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var value)
                    ? value
                    : 0;
            }
            catch (IOException)
            {
                return 0;
            }
            catch (UnauthorizedAccessException)
            {
                return 0;
            }
        }

        /// <summary>
        /// 本地**可用**的版本标记（指纹）列表，新→旧。
        ///
        /// 只认「目录里有 <see cref="FingerprintFile"/>」的版本：解压到一半的目录不会被算进来。
        /// </summary>
        public static IReadOnlyList<string> ListVersions(string root, string project)
        {
            var versions = new List<string>();
            var projectRoot = ProjectRoot(root, project);
            if (!Directory.Exists(projectRoot))
            {
                return versions;
            }

            string[] directories;
            try
            {
                directories = Directory.GetDirectories(projectRoot);
            }
            catch (IOException)
            {
                return versions;
            }
            catch (UnauthorizedAccessException)
            {
                return versions;
            }

            var withTime = new List<KeyValuePair<long, string>>();
            foreach (var directory in directories)
            {
                if (directory.EndsWith(PartialSuffix, StringComparison.Ordinal))
                {
                    continue;
                }

                if (ReadFingerprint(directory) == null)
                {
                    continue;
                }

                withTime.Add(new KeyValuePair<long, string>(ReadCreatedAt(directory), directory));
            }

            withTime.Sort((left, right) =>
            {
                var byTime = right.Key.CompareTo(left.Key);
                return byTime != 0 ? byTime : string.CompareOrdinal(right.Value, left.Value);
            });

            foreach (var pair in withTime)
            {
                versions.Add(Path.GetFileName(pair.Value));
            }

            return versions;
        }

        /// <summary>本地已有这一版吗（目录在、标记匹配）——匹配就不必再下载整包。</summary>
        public static bool HasVersion(string root, string project, string fingerprint)
        {
            if (string.IsNullOrEmpty(fingerprint))
            {
                return false;
            }

            var versionRoot = VersionRoot(root, project, fingerprint);
            var marked = ReadFingerprint(versionRoot);
            return marked != null && marked == fingerprint;
        }

        /// <summary>
        /// 删掉除「保留最近 <paramref name="keep"/> 个（含当前版本）」之外的旧版本，以及中断留下的 `.partial`。
        ///
        /// 保留上一版是**故意的**：新版本刚下完还没验证时，旧的还能兜底。
        /// 失败只记不抛——清理是收尾工作，不该让一次下载因为磁盘权限问题变失败。
        /// </summary>
        public static void Cleanup(string root, string project, string currentFingerprint, int keep, out int removed)
        {
            removed = 0;
            var projectRoot = ProjectRoot(root, project);
            if (!Directory.Exists(projectRoot))
            {
                return;
            }

            string[] directories;
            try
            {
                directories = Directory.GetDirectories(projectRoot);
            }
            catch (IOException)
            {
                return;
            }
            catch (UnauthorizedAccessException)
            {
                return;
            }

            var kept = new List<string>();
            foreach (var directory in directories)
            {
                if (directory.EndsWith(PartialSuffix, StringComparison.Ordinal))
                {
                    if (TryDeleteDirectory(directory))
                    {
                        removed++;
                    }

                    continue;
                }

                kept.Add(directory);
            }

            // 保证当前版本一定在最前面（哪怕它的时间戳更旧）
            kept.Sort((left, right) =>
            {
                var leftCurrent = Path.GetFileName(left) == currentFingerprint ? 1 : 0;
                var rightCurrent = Path.GetFileName(right) == currentFingerprint ? 1 : 0;
                if (leftCurrent != rightCurrent)
                {
                    return rightCurrent.CompareTo(leftCurrent);
                }

                return ReadCreatedAt(right).CompareTo(ReadCreatedAt(left));
            });

            var limit = Math.Max(1, keep);
            for (var index = limit; index < kept.Count; index++)
            {
                if (TryDeleteDirectory(kept[index]))
                {
                    removed++;
                }
            }
        }

        /// <summary>删掉一个版本目录（用于「这份包坏了，重下」）。</summary>
        public static bool TryDeleteDirectory(string path)
        {
            if (string.IsNullOrEmpty(path) || !Directory.Exists(path))
            {
                return false;
            }

            try
            {
                Directory.Delete(path, true);
                return true;
            }
            catch (IOException)
            {
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                return false;
            }
        }
    }
}
