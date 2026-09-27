using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

namespace DiceTale.Editor
{
    /// <summary>
    /// 放大镜窗（<see cref="MagnifierWindow"/>）的**预设（prefab）**工具：
    /// 一键预览 + 由代码重建预设。
    ///
    /// - **`DiceTale/预览放大镜窗口`**：进播放态，在 Game 视图里把那扇真窗搭出来（**从 prefab 加载**，
    ///   不是代码现场搭），用一张代码画的示例道具图（透明底线稿）调 `Show()`。一次点击就够
    ///   （不在播放态先进播放、过完域重载再搭，靠 <see cref="SessionState"/> 记住意图）。
    /// - **`DiceTale/重建放大镜窗预设（开发用）`**：把 <see cref="MagnifierWindow.Build"/> 造的那套层级
    ///   存成 `Assets/DiceTale/Resources/UI/MagnifierWindow.prefab`。**改了 `Build()` 里的配色 / 版式就点它**，
    ///   让预设跟上代码（预设才是运行时加载的那份）。
    ///
    /// 说明：`Build()` 是私有的（它是代码构建那条路的内部实现），这里用反射调一次——
    /// 开发工具，不值得为它把 `Build()` 开成公开 API。
    /// </summary>
    public static class MagnifierPreview
    {
        private const string PendingImageKey = "DiceTale.MagnifierPreview.PendingImage";
        private const string PendingVideoKey = "DiceTale.MagnifierPreview.PendingVideo";
        private const string RootName = "MagnifierPreview";

        /// <summary>预设的资产路径（由 <see cref="MagnifierWindow.PrefabResourcePath"/> 拼出来）。</summary>
        private static string PrefabAssetPath => $"Assets/DiceTale/Resources/{MagnifierWindow.PrefabResourcePath}.prefab";

        [MenuItem("DiceTale/预览放大镜窗口")]
        public static void Show()
        {
            Request(false);
        }

        /// <summary>视频那一版（v33）：拿仓库样例工程里的 mp4 走一遍「视频 + 动画」那条路。</summary>
        [MenuItem("DiceTale/预览放大镜窗口（视频）")]
        public static void ShowVideo()
        {
            Request(true);
        }

        private static void Request(bool withVideo)
        {
            if (!EditorApplication.isPlaying)
            {
                SessionState.SetBool(withVideo ? PendingVideoKey : PendingImageKey, true);
                EditorApplication.isPlaying = true;
                return;
            }

            Build(withVideo);
        }

        /// <summary>进播放态会域重载：重载完在这里接着搭（只认一次，搭完清标记）。</summary>
        [InitializeOnLoadMethod]
        private static void ResumeAfterDomainReload()
        {
            var withVideo = SessionState.GetBool(PendingVideoKey, false);
            var withImage = SessionState.GetBool(PendingImageKey, false);
            if (!withVideo && !withImage)
            {
                return;
            }

            SessionState.SetBool(PendingVideoKey, false);
            SessionState.SetBool(PendingImageKey, false);
            EditorApplication.delayCall += () =>
            {
                if (EditorApplication.isPlaying)
                {
                    Build(withVideo);
                }
            };
        }

        /// <summary>把当前 `Build()` 那套层级存成预设（改了代码就点一下让预设跟上）。</summary>
        [MenuItem("DiceTale/重建放大镜窗预设（开发用）")]
        public static void RebuildPrefab()
        {
            var temp = new GameObject("MagnifierWindow", typeof(RectTransform));
            var window = temp.AddComponent<MagnifierWindow>();

            var build = typeof(MagnifierWindow).GetMethod(
                "Build",
                BindingFlags.Instance | BindingFlags.NonPublic);
            if (build == null)
            {
                Object.DestroyImmediate(temp);
                Debug.LogError("[放大镜预览] 找不到 MagnifierWindow.Build()，无法重建预设。");
                return;
            }

            build.Invoke(window, null);

            var saved = PrefabUtility.SaveAsPrefabAsset(temp, PrefabAssetPath);
            Object.DestroyImmediate(temp);
            AssetDatabase.Refresh();

            Debug.Log(saved == null
                ? $"[放大镜预览] 预设保存失败：{PrefabAssetPath}"
                : $"[放大镜预览] 预设已重建：{PrefabAssetPath}");
        }

        private static void Build(bool withVideo)
        {
            var previous = GameObject.Find(RootName + "Canvas");
            if (previous != null)
            {
                Object.Destroy(previous);
            }

            var canvasGo = new GameObject(
                RootName + "Canvas",
                typeof(Canvas),
                typeof(CanvasScaler),
                typeof(GraphicRaycaster));
            var canvas = canvasGo.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            var scaler = canvasGo.GetComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920f, 1080f);
            scaler.matchWidthOrHeight = 0.5f;

            // **从预设加载**（这正是"UI 从预设来"的那条路）：预设里层级已经在了，组件会绑定它，不再代码搭。
            var prefab = Resources.Load<GameObject>(MagnifierWindow.PrefabResourcePath);
            if (prefab == null)
            {
                Debug.LogError($"[放大镜预览] 找不到预设 {MagnifierWindow.PrefabResourcePath}（先跑一次「重建放大镜窗预设」）。");
                return;
            }

            var go = Object.Instantiate(prefab, canvasGo.transform, false);
            go.name = RootName;
            var window = go.GetComponent<MagnifierWindow>();
            window.Open();

            var state = new MagnifierStateView
            {
                Title = "密室里的黄铜钥匙",
                Text =
                    "钥匙柄上刻着三枚小齿，齿尖的方向对准窗户。\n" +
                    "对着窗台那道光举起来时，墙上的影子会排成一串数字——那才是柜子的密码。",
            };

            if (withVideo)
            {
                var url = PreviewVideoUrl();
                if (string.IsNullOrEmpty(url))
                {
                    Debug.LogError("[放大镜预览] 找不到示例视频（样例工程 Assets/video/Map001.mp4）——先用「预览放大镜窗口」看图那版。");
                    return;
                }

                state.Video = new MagnifierVideoView { Id = "preview", Loop = true, Audio = false };
                state.Tween = MagnifierTween.Float;
                window.ShowVideo(state, url);
                Debug.Log("[放大镜预览] 已从预设搭好（视频 + 漂浮动画）：看 Game 视图。");
                return;
            }

            state.Id = RootName;
            state.Sprite = null;
            window.Show(state, PropTexture());
            Debug.Log("[放大镜预览] 已从预设搭好：看 Game 视图（再点一次菜单可重建）。");
        }

        /// <summary>仓库样例工程里那条 mp4 的 `file://` 地址（开发预览用；找不到返回 null）。</summary>
        private static string PreviewVideoUrl()
        {
            var repo = System.IO.Path.GetFullPath(System.IO.Path.Combine(Application.dataPath, "..", ".."));
            var candidate = System.IO.Path.Combine(
                repo,
                "server",
                "resources",
                "projects",
                "测试项目",
                "Assets",
                "video",
                "Map001.mp4");
            if (!System.IO.File.Exists(candidate))
            {
                return null;
            }

            // 路径里有中文（测试项目）：一定要用 Uri 转成**编码过**的 file://，否则 VideoPlayer 解不开
            return new System.Uri(candidate).AbsoluteUri;
        }

        /// <summary>
        /// 代码画一张示例道具图：**透明底 + 线稿**——正是"深底会把它吞掉"的那类图，
        /// 用它最能看出图区底色合不合适。
        /// </summary>
        private static Texture2D PropTexture()
        {
            const int size = 512;
            var texture = new Texture2D(size, size, TextureFormat.RGBA32, false)
            {
                hideFlags = HideFlags.DontSave,
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Bilinear,
            };

            var ink = new Color(0.23f, 0.16f, 0.08f, 1f);
            var seal = new Color(0.55f, 0.18f, 0.12f, 1f);
            var ring = new Vector2(size * 0.36f, size * 0.66f);
            var tipA = new Vector2(size * 0.44f, size * 0.58f);
            var tipB = new Vector2(size * 0.86f, size * 0.16f);

            var pixels = new Color[size * size];
            var clear = new Color(0f, 0f, 0f, 0f);
            for (var y = 0; y < size; y++)
            {
                for (var x = 0; x < size; x++)
                {
                    var p = new Vector2(x + 0.5f, y + 0.5f);

                    // 钥匙环（一个圆环）+ 杆 + 两枚齿：**深棕墨水**
                    var inkAlpha = Mathf.Clamp01(14f - Mathf.Abs(Vector2.Distance(p, ring) - 90f));
                    inkAlpha = Mathf.Max(inkAlpha, Mathf.Clamp01(16f - Segment(p, tipA, tipB)));
                    inkAlpha = Mathf.Max(
                        inkAlpha,
                        Mathf.Clamp01(12f - Segment(p, new Vector2(size * 0.78f, size * 0.24f), new Vector2(size * 0.86f, size * 0.32f))));
                    inkAlpha = Mathf.Max(
                        inkAlpha,
                        Mathf.Clamp01(12f - Segment(p, new Vector2(size * 0.68f, size * 0.34f), new Vector2(size * 0.76f, size * 0.42f))));

                    // 环上一小段红蜡色高光
                    var sealAlpha = Mathf.Clamp01(
                        7f - Segment(p, new Vector2(size * 0.22f, size * 0.80f), new Vector2(size * 0.34f, size * 0.86f))) * 0.75f;

                    var color = Over(new Color(seal.r, seal.g, seal.b, sealAlpha), new Color(ink.r, ink.g, ink.b, inkAlpha));
                    pixels[y * size + x] = color.a <= 0f ? clear : color;
                }
            }

            texture.SetPixels(pixels);
            texture.Apply();
            return texture;
        }

        /// <summary>`src` 叠在 `dst` 上（都是非预乘 alpha）。</summary>
        private static Color Over(Color src, Color dst)
        {
            var outAlpha = src.a + dst.a * (1f - src.a);
            if (outAlpha <= 0f)
            {
                return new Color(0f, 0f, 0f, 0f);
            }

            return new Color(
                (src.r * src.a + dst.r * dst.a * (1f - src.a)) / outAlpha,
                (src.g * src.a + dst.g * dst.a * (1f - src.a)) / outAlpha,
                (src.b * src.a + dst.b * dst.a * (1f - src.a)) / outAlpha,
                outAlpha);
        }

        /// <summary>点到线段 AB 的距离（像素）。</summary>
        private static float Segment(Vector2 p, Vector2 a, Vector2 b)
        {
            var ab = b - a;
            var lengthSq = ab.sqrMagnitude;
            var t = lengthSq <= 0f ? 0f : Mathf.Clamp01(Vector2.Dot(p - a, ab) / lengthSq);
            return Vector2.Distance(p, a + t * ab);
        }
    }
}
