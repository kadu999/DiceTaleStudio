using System.Collections;
using UnityEngine;
using UnityEngine.UI;
using UnityEngine.Video;

namespace DiceTale
{
    /// <summary>
    /// 放大镜窗口（**预设**：`Resources/UI/MagnifierWindow.prefab`，运行时由 `UIManager` 从它加载）。
    /// 代码里的 `Build()` 既是**没预设时的兜底**、也是**生成那份预设的来源**：两者节点名一一对应
    /// （见 <see cref="Bind"/>）。**全屏半透明底 + 居中一张「线索卡」**。
    ///
    /// 它是**跑团时给玩家看重要信息**的那块画面（DM 从编辑器推上来），所以**层次与可读性优先**：
    /// - **羊皮纸线索卡**：整张纸是暖米黄（`PanelFill`）+ 深棕描边，里面「标题 / 图 / 文字」三块
    ///   **共用同一款纸面与描边**——像 DM 递出来的一张线索纸条；深色的线稿道具在纸面上很清楚；
    /// - **一圈 1px 描边 + 圆角**：圆角白图自己造一张 9-slice（见 <see cref="RoundedRectSprite"/>），
    ///   颜色由各块自己的 `Image.color` 上；
    /// - **标题带左边一条暖黄强调条**，与画布上那枚放大镜徽标同色（`#e8c840`）——这张卡属于它；
    /// - **字号按 1080p 参考分辨率给**（标题 44 / 正文 30 / 行距 1.35），文字太长时自动缩到装下
    ///   （最小 16）——跑团时隔着桌子也要读得清，宁可小一点也不要被截断。
    ///
    /// 它由 <see cref="CommandRouter"/> 按 `open_magnifier` / `close_magnifier` 两条命令开关——
    /// **自己没有任何按钮**（没有状态槽、也没有关闭），因为这就是需求：「只能后端来关闭」。
    /// 也**不吃点击**（从头到尾 `raycastTarget = false`）：窗口盖着的时候别的交互照常穿过去。
    ///
    /// **换状态 / 换图 / 改标题文字都不经过这里**：那是**文档数据**（`Magnifier.picked` 与
    /// `Magnifier.states`）——编辑器一改就整份 `scene_sync` 推下来，命令路由在镜像落地时把新
    /// 那一屏塞进来（见 <see cref="CommandRouter.OnSceneApplied"/>）。所以这里只有
    /// 「显示这一屏 / 关掉」两件事。
    ///
    /// 与编辑器那扇窗（`apps/editor/src/app/MagnifierDialog.tsx`）版式一致：上面标题、下面左图右文字；
    /// 差别是编辑器那扇**多一排状态槽与「添加状态」、多底栏那两个按钮**，这扇只有这一屏。
    /// </summary>
    [DisallowMultipleComponent]
    public class MagnifierWindow : UIWindow
    {
        // ---------------------------------------------------------------- 版式
        // 都是**1080p 参考分辨率下的像素**（CanvasScaler 会整体缩放，见 UIManager.EnsureCanvas）。

        /// <summary>面板占画布的多少（两侧各留一点边，看得出这是浮层）。</summary>
        private const float PanelMargin = 0.055f;

        /// <summary>面板内边距：内容离面板边这么远。</summary>
        private const float Padding = 28f;

        /// <summary>标题带的高度。</summary>
        private const float TitleHeight = 88f;

        /// <summary>两块卡片之间的间距（也是标题带与内容区之间的间距）。</summary>
        private const float Gap = 18f;

        /// <summary>图那一块占内容区宽度的多少，剩下的给右边文字。</summary>
        private const float ImageWidthRatio = 0.58f;

        /// <summary>图与它的相框之间的留白。</summary>
        private const float ImageInset = 12f;

        /// <summary>文字与它那块卡片之间的留白。</summary>
        private const float TextInset = 26f;

        /// <summary>描边粗细（也是圆角贴图 9-slice 的边宽）。</summary>
        private const float BorderWidth = 1.5f;

        /// <summary>正文自动缩放的下限：再长也不缩到这个字号以下（宁可截断也不要小到读不清）。</summary>
        private const int BodyMinFontSize = 16;

        /// <summary>正文字号（跑团时是投给玩家看的，按 1080p 参考分辨率给大一号）。</summary>
        private const int BodyFontSize = 30;

        /// <summary>标题字号。</summary>
        private const int TitleFontSize = 44;

        // ---------------------------------------------------------------- 颜色
        // **羊皮纸线索卡**：暖米黄纸面 + 深棕字 + 棕描边——像 DM 递出来的一张线索纸条。
        // 遮底仍压暗场景（暖黑），让这张纸在画面里跳出来。

        private static readonly Color BackdropColor = new Color32(0x0A, 0x07, 0x04, 0xBE);
        private static readonly Color PanelFill = new Color32(0xE8, 0xD8, 0xB4, 0xFF);
        private static readonly Color PanelEdge = new Color32(0x9C, 0x7B, 0x43, 0xFF);
        /// <summary>内容卡片的表面：**标题栏 / 图 / 文字三块共用**（同一款纸面）。</summary>
        private static readonly Color CardFill = new Color32(0xF1, 0xE5, 0xC6, 0xFF);
        /// <summary>内容卡片的描边：三块共用（浅棕压边，像印在纸上的一个框）。</summary>
        private static readonly Color CardEdge = new Color32(0xBC, 0x9B, 0x60, 0xFF);
        private static readonly Color AccentColor = new Color32(0x8C, 0x2F, 0x1E, 0xFF);
        private static readonly Color TitleColor = new Color32(0x3A, 0x2A, 0x16, 0xFF);
        private static readonly Color BodyColor = new Color32(0x4A, 0x38, 0x1F, 0xFF);

        /// <summary>窗口 prefab 的 Resources 路径（运行时按它加载：`Resources/UI/MagnifierWindow.prefab`）。</summary>
        public const string PrefabResourcePath = "UI/MagnifierWindow";

        /// <summary>圆角图素材的 Resources 路径（prefab 里引用的就是它；缺了才退回代码生成）。</summary>
        private const string RoundedResourcePath = "UI/MagnifierRounded";

        /// <summary>圆角贴图（全窗共用一张白的，颜色由各块自己的 `Image.color` 上）。</summary>
        private static Sprite rounded;

        private Image image;
        private RectTransform titleBar;
        private Text titleText;
        private RectTransform frame;
        private RectTransform bodyCard;
        private RectTransform content;
        private Text bodyText;

        /// <summary>当前显示的那张资源逻辑 ID 与那一格（用来判断「同一张就别重建」）。</summary>
        private string currentId = "";
        private MirrorSprite currentSprite;
        private Texture2D currentTexture;

        /// <summary>运行时造出来的 Sprite：换一张时销毁旧的（纹理是取图器缓存的，**不能**跟着销毁）。</summary>
        private Sprite current;

        /// <summary>媒体那块的动画（v33）：跑着一条协程按预设动 <see cref="frame"/>；换屏 / 关窗停掉并归位。</summary>
        private Coroutine tweenRoutine;
        private Vector2 tweenBasePosition;
        private Vector3 tweenBaseScale;
        private Quaternion tweenBaseRotation;

        /// <summary>视频那块自己一套基准：它挂在 `Content` 上、不在 `Frame` 里，动画要**跟着一起动**。</summary>
        private Vector2 videoBasePosition;
        private Vector3 videoBaseScale = Vector3.one;
        private Quaternion videoBaseRotation = Quaternion.identity;

        /// <summary>
        /// **起过一次动画**才为真。`StopTween` 只在它为真时把基准写回去——否则（第一次铺屏、
        /// 预设里 `frame.localScale` 是 1）会拿默认的 `Vector3.zero` 基准把整块缩成 0（踩过）。
        /// </summary>
        private bool tweenApplied;

        /// <summary>视频那块（v33）：`RawImage` 显示 `RenderTexture`，`VideoPlayer` 按 URL 放（与图二选一）。</summary>
        private RawImage videoImage;
        private VideoPlayer videoPlayer;
        private RenderTexture videoTexture;

        /// <summary>视频长宽比（首帧后按真实尺寸更新；`SyncVideoRect` 用它等比装下）。</summary>
        private float videoAspect = (float)VideoTextureWidth / VideoTextureHeight;

        /// <summary>视频的默认渲染分辨率（16:9）；首帧后按视频真实尺寸改 <see cref="videoFitter"/> 的比例。</summary>
        private const int VideoTextureWidth = 1280;
        private const int VideoTextureHeight = 720;

        protected override void Awake()
        {
            base.Awake();

            /*
              **从 prefab 加载**时层级已经在了（`Resources/UI/MagnifierWindow`）：绑上它，别搭第二遍；
              只有代码构建那条路（没给 prefab 路径，如单元测试里直接 AddComponent）才现场 Build。
              两条路的节点名一一对应（见 Bind）。
            */
            if (!Bind())
            {
                Build();
            }

            HookVideoEvents();
        }

        /// <summary>给视频播放器挂回调（代码构建与 prefab 两条路都要挂一次；重复挂先摘后挂）。</summary>
        private void HookVideoEvents()
        {
            if (videoPlayer == null)
            {
                return;
            }

            videoPlayer.prepareCompleted -= OnVideoPrepared;
            videoPlayer.prepareCompleted += OnVideoPrepared;
            videoPlayer.errorReceived -= OnVideoError;
            videoPlayer.errorReceived += OnVideoError;
        }

        /// <summary>
        /// 把 **prefab 里已有的层级**绑到字段上——节点名与 <see cref="Build"/> 造的一一对应。
        /// 找齐了就返回 true（跳过 Build = prefab 那条路）；缺关键节点返回 false（调用方退回代码构建）。
        /// </summary>
        private bool Bind()
        {
            var foundTitleBar = transform.Find("Panel/PanelFill/Padding/TitleBar");
            var foundTitle = transform.Find("Panel/PanelFill/Padding/TitleBar/TitleBarFill/Title");
            var foundContent = transform.Find("Panel/PanelFill/Padding/Content");
            var foundFrame = transform.Find("Panel/PanelFill/Padding/Content/Frame");
            var foundImage = transform.Find("Panel/PanelFill/Padding/Content/Frame/FrameFill/Image");
            var foundBody = transform.Find("Panel/PanelFill/Padding/Content/Body");
            var foundBodyText = transform.Find("Panel/PanelFill/Padding/Content/Body/BodyFill/Text");
            if (foundTitleBar == null
                || foundTitle == null
                || foundContent == null
                || foundFrame == null
                || foundImage == null
                || foundBody == null
                || foundBodyText == null)
            {
                return false;
            }

            var foundTitleText = foundTitle.GetComponent<Text>();
            var foundImageGraphic = foundImage.GetComponent<Image>();
            var foundBodyTextGraphic = foundBodyText.GetComponent<Text>();
            if (foundTitleText == null || foundImageGraphic == null || foundBodyTextGraphic == null)
            {
                return false;
            }

            titleBar = foundTitleBar as RectTransform;
            titleText = foundTitleText;
            content = foundContent as RectTransform;
            frame = foundFrame as RectTransform;
            image = foundImageGraphic;
            bodyCard = foundBody as RectTransform;
            bodyText = foundBodyTextGraphic;

            // 视频那块（v33）：挂在 Content 上（**不能挂进 `FrameFill`**，见 Build 的说明）
            var foundVideo = transform.Find("Panel/PanelFill/Padding/Content/Video");
            videoImage = foundVideo == null ? null : foundVideo.GetComponent<RawImage>();
            videoPlayer = GetComponent<VideoPlayer>();
            return true;
        }

        protected override void OnDestroy()
        {
            StopTween();
            StopVideo();
            if (videoTexture != null)
            {
                videoTexture.Release();
                Destroy(videoTexture);
                videoTexture = null;
            }

            DestroySprite();
            base.OnDestroy();
        }

        /// <summary>这张图是不是已经在窗里了（同一个 id + 同一格，**而且纹理还是那一个**）。</summary>
        public bool IsShowing(string imageId, Texture2D texture, MirrorSprite sprite)
        {
            return image != null
                && image.sprite != null
                && currentId == imageId
                && SameSprite(currentSprite, sprite)
                && ReferenceEquals(currentTexture, texture);
        }

        /// <summary>
        /// 铺上**图 / 纯文字**这一屏（v33 起媒体二选一：这条是「媒体 = 图」那条）；`texture` 为空 =
        /// 这一屏没有图。换屏前会**把上一条视频停掉**（从视频换成图也走这里）。
        ///
        /// 标题与文字**每次都直接覆盖**（纯文本，改起来不要钱）；图是同一张、同一格、同一个纹理时
        /// 跳过重建——镜像每次落地都会叫一声（`OnSceneApplied`），而绝大多数推送与这一屏无关。
        /// </summary>
        public void Show(MagnifierStateView state, Texture2D texture)
        {
            if (state == null)
            {
                return;
            }

            StopVideo();

            var hasImage = !string.IsNullOrEmpty(state.Id);
            ApplyContent(state.Title, state.Text, hasImage);
            ApplyTween(state.Tween);

            if (!hasImage)
            {
                DestroySprite();
                return;
            }

            if (image == null || texture == null || IsShowing(state.Id, texture, state.Sprite))
            {
                return;
            }

            var next = SpriteOf(texture, state.Sprite);
            DestroySprite();
            current = next;
            currentId = state.Id ?? "";
            currentSprite = state.Sprite;
            currentTexture = texture;

            image.sprite = next;
            image.color = Color.white;
            image.enabled = true;
        }

        /// <summary>
        /// 铺上**视频**这一屏（v33）：`url` 是本地资源包 / 服务端的地址（与对象上的视频同一条路）。
        /// 与 <see cref="Show"/> 二选一：先把上一屏的图清掉，再放这一条。首帧到之前视频块**不显示**
        /// （别闪一块空的），`prepareCompleted` 里再打开。
        /// </summary>
        public void ShowVideo(MagnifierStateView state, string url)
        {
            if (state == null || state.Video == null)
            {
                return;
            }

            DestroySprite();
            if (image != null)
            {
                image.enabled = false;
            }

            ApplyContent(state.Title, state.Text, true);
            ApplyTween(state.Tween);

            if (videoPlayer == null || videoImage == null)
            {
                Debug.LogError("[放大镜] 这一屏要放视频，但窗口没有视频那块（prefab 可能是老版本，重建一次预设）。");
                return;
            }

            videoImage.gameObject.SetActive(true);
            videoImage.enabled = false;

            videoPlayer.Stop();
            videoPlayer.isLooping = state.Video.Loop;
            videoPlayer.audioOutputMode = state.Video.Audio
                ? VideoAudioOutputMode.Direct
                : VideoAudioOutputMode.None;
            videoPlayer.url = url;
            EnsureVideoTexture();
            videoPlayer.Prepare();

            Debug.Log($"[放大镜] 准备播放视频：{state.Video.Id}（循环={state.Video.Loop}，声音={state.Video.Audio}）");
        }

        /// <summary>视频首帧准备好：按真实尺寸设长宽比、打开视频块、开始放。</summary>
        private void OnVideoPrepared(VideoPlayer source)
        {
            if (videoImage == null)
            {
                return;
            }

            var width = source.width > 0 ? (int)source.width : VideoTextureWidth;
            var height = source.height > 0 ? (int)source.height : VideoTextureHeight;
            if (height > 0)
            {
                videoAspect = (float)width / height;
            }

            SyncVideoRect();
            videoImage.enabled = true;
            source.Play();
            Debug.Log($"[放大镜] 视频开始播放（{width}×{height}，循环={source.isLooping}）");
        }

        /// <summary>
        /// 按**媒体那块的尺寸**与视频长宽比，把视频块居中装下（≈ `Image.preserveAspect`）。
        ///
        /// 视频块挂在 `content` 上（挂 `FrameFill` 底下时不画，见 `Build`），所以位置相对内容区算：
        /// 媒体那块贴左边、占满高，中心就是「它的宽 / 2 − 内容区宽 / 2」。
        /// </summary>
        private void SyncVideoRect()
        {
            if (videoImage == null || frame == null || content == null)
            {
                return;
            }

            var media = content.rect;
            var area = frame.rect.size;
            var inset = (BorderWidth + ImageInset) * 2f;
            var availableWidth = Mathf.Max(1f, area.x - inset);
            var availableHeight = Mathf.Max(1f, area.y - inset);

            var fitWidth = availableWidth;
            var fitHeight = fitWidth / Mathf.Max(0.01f, videoAspect);
            if (fitHeight > availableHeight)
            {
                fitHeight = availableHeight;
                fitWidth = fitHeight * Mathf.Max(0.01f, videoAspect);
            }

            var rect = videoImage.rectTransform;
            rect.anchorMin = new Vector2(0.5f, 0.5f);
            rect.anchorMax = new Vector2(0.5f, 0.5f);
            rect.pivot = new Vector2(0.5f, 0.5f);
            rect.sizeDelta = new Vector2(fitWidth, fitHeight);
            rect.anchoredPosition = new Vector2(
                area.x * 0.5f - media.width * 0.5f,
                area.y * 0.5f - media.height * 0.5f);
        }

        private void OnVideoError(VideoPlayer source, string message)
        {
            if (videoImage != null)
            {
                videoImage.enabled = false;
            }

            Debug.LogError($"[放大镜] 视频播放失败：{message}");
        }

        /// <summary>确保有渲染纹理并挂在 `RawImage` 上（窗口关掉 / 换屏时留着复用）。</summary>
        private void EnsureVideoTexture()
        {
            if (videoTexture == null)
            {
                videoTexture = new RenderTexture(VideoTextureWidth, VideoTextureHeight, 0);
            }

            if (videoImage != null)
            {
                videoImage.texture = videoTexture;
            }

            videoPlayer.targetTexture = videoTexture;
        }

        /// <summary>停掉视频、收起视频块（换屏 / 关窗时用；渲染纹理留着复用）。</summary>
        private void StopVideo()
        {
            if (videoPlayer != null)
            {
                videoPlayer.Stop();
                videoPlayer.url = "";
            }

            if (videoImage != null)
            {
                videoImage.enabled = false;
                videoImage.gameObject.SetActive(false);
            }
        }

        /// <summary>窗口的显隐由基类管；关掉时**停动画与视频**（留着当前这一屏：再开一次就是同一屏）。</summary>
        protected override void OnClose()
        {
            StopTween();
            StopVideo();
        }

        // ---------------------------------------------------------------- 媒体动画（v33）

        /// <summary>震动：左右晃的像素幅度与频率。</summary>
        private const float ShakePixels = 10f;
        private const float ShakeHz = 6f;

        /// <summary>呼吸：缩放脉动的频率与幅度（比例）。</summary>
        private const float BreatheHz = 0.5f;
        private const float BreatheScale = 0.03f;

        /// <summary>漂浮：上下浮的像素幅度与频率。</summary>
        private const float FloatPixels = 12f;
        private const float FloatHz = 0.4f;

        /// <summary>摇摆：绕 Z 轴轻摆的角度与频率。</summary>
        private const float SwayDegrees = 2.5f;
        private const float SwayHz = 0.5f;

        /// <summary>按预设起 / 停**媒体那块**的动画（换屏会重起；关窗 / 没动画会停并归位）。</summary>
        private void ApplyTween(MagnifierTween tween)
        {
            StopTween();
            if (frame == null || tween == MagnifierTween.None || !isActiveAndEnabled)
            {
                return;
            }

            tweenBasePosition = frame.anchoredPosition;
            tweenBaseScale = frame.localScale;
            tweenBaseRotation = frame.localRotation;
            if (videoImage != null)
            {
                var videoRect = videoImage.rectTransform;
                videoBasePosition = videoRect.anchoredPosition;
                videoBaseScale = videoRect.localScale;
                videoBaseRotation = videoRect.localRotation;
            }

            tweenApplied = true;
            tweenRoutine = StartCoroutine(AnimateTween(tween));
        }

        private void StopTween()
        {
            if (tweenRoutine != null)
            {
                StopCoroutine(tweenRoutine);
                tweenRoutine = null;
            }

            // 没起过动画就别动它：基准还没采过（默认全 0），写回去会把媒体块缩成 0
            if (!tweenApplied)
            {
                return;
            }

            tweenApplied = false;

            if (frame != null)
            {
                frame.anchoredPosition = tweenBasePosition;
                frame.localScale = tweenBaseScale;
                frame.localRotation = tweenBaseRotation;
            }

            if (videoImage != null)
            {
                var videoRect = videoImage.rectTransform;
                videoRect.anchoredPosition = videoBasePosition;
                videoRect.localScale = videoBaseScale;
                videoRect.localRotation = videoBaseRotation;
            }
        }

        /// <summary>四套固定动画：震动（左右） / 呼吸（缩放） / 漂浮（上下） / 摇摆（绕 Z 轻摆）。</summary>
        private IEnumerator AnimateTween(MagnifierTween tween)
        {
            var phase = 0f;
            while (true)
            {
                phase += Time.deltaTime;
                var position = tweenBasePosition;
                var scale = tweenBaseScale;
                var rotation = tweenBaseRotation;
                switch (tween)
                {
                    case MagnifierTween.Shake:
                        position += new Vector2(Wave(phase, ShakeHz) * ShakePixels, 0f);
                        break;
                    case MagnifierTween.Breathe:
                        scale *= 1f + Wave(phase, BreatheHz) * BreatheScale;
                        break;
                    case MagnifierTween.Float:
                        position += new Vector2(0f, Wave(phase, FloatHz) * FloatPixels);
                        break;
                    case MagnifierTween.Sway:
                        rotation *= Quaternion.Euler(0f, 0f, Wave(phase, SwayHz) * SwayDegrees);
                        break;
                }

                frame.anchoredPosition = position;
                frame.localScale = scale;
                frame.localRotation = rotation;

                // 视频那块挂在 Content 上（不在 Frame 里）：把**同一份相对变化**套到它身上，两者一起动
                if (videoImage != null)
                {
                    var videoRect = videoImage.rectTransform;
                    var ratio = Mathf.Approximately(tweenBaseScale.x, 0f) ? 1f : scale.x / tweenBaseScale.x;
                    videoRect.anchoredPosition = videoBasePosition + (position - tweenBasePosition);
                    videoRect.localScale = videoBaseScale * ratio;
                    videoRect.localRotation = videoBaseRotation * (Quaternion.Inverse(tweenBaseRotation) * rotation);
                }

                yield return null;
            }
        }

        private static float Wave(float phase, float hz)
        {
            return Mathf.Sin(phase * 2f * Mathf.PI * hz);
        }

        /// <summary>
        /// 把标题与文字铺上去，并按「这一屏有什么」重排（**媒体** = 图或视频，v33 起两选一）：
        /// - **没有标题** → 标题带整条不占位，内容区顶上去；
        /// - **没有媒体** → 媒体那一格整块收起来（纯文字 / 只有标题的线索卡），文字铺满整行；
        /// - **没有文字** → 文字那块不占位，媒体铺满整行。
        /// </summary>
        private void ApplyContent(string title, string body, bool hasMedia)
        {
            var hasTitle = !string.IsNullOrEmpty(title);
            titleBar.gameObject.SetActive(hasTitle);
            titleText.text = hasTitle ? title : "";

            var hasBody = !string.IsNullOrEmpty(body);
            bodyCard.gameObject.SetActive(hasBody);
            bodyText.text = hasBody ? body : "";

            frame.gameObject.SetActive(hasMedia);

            content.offsetMax = new Vector2(0f, hasTitle ? -(TitleHeight + Gap) : 0f);

            // 媒体与文字各占一边；只有一边时它铺满整行（另一边不占位）
            var split = hasMedia && hasBody;
            frame.anchorMax = new Vector2(split ? ImageWidthRatio : 1f, 1f);
            frame.offsetMax = new Vector2(split ? -Gap : 0f, 0f);
            bodyCard.anchorMin = new Vector2(split ? ImageWidthRatio : 0f, 0f);

            // 视频块挂在内容区上：媒体那块一换尺寸就得跟着重算（v33）
            SyncVideoRect();
        }

        // ---------------------------------------------------------------- 搭界面

        private void Build()
        {
            // 根铺满画布：窗口一显示就盖住整屏（与字幕条那种「贴边」的不一样）
            Stretch(GetComponent<RectTransform>());

            // 遮底：最暗的一层（不吃点击）
            Stretch(CreateImage("Backdrop", transform, BackdropColor, null).rectTransform);

            // 面板：居中一块圆角卡片 + 一点投影（有投影才像浮在场景上）
            var panel = CreateImage("Panel", transform, PanelEdge, RoundedRectSprite());
            var panelRect = panel.rectTransform;
            panelRect.anchorMin = new Vector2(PanelMargin, PanelMargin);
            panelRect.anchorMax = new Vector2(1f - PanelMargin, 1f - PanelMargin);
            panelRect.offsetMin = Vector2.zero;
            panelRect.offsetMax = Vector2.zero;

            var shadow = panel.gameObject.AddComponent<Shadow>();
            shadow.effectColor = new Color(0f, 0f, 0f, 0.45f);
            shadow.effectDistance = new Vector2(0f, -8f);

            var panelFill = CreateImage("PanelFill", panelRect, PanelFill, RoundedRectSprite());
            Stretch(panelFill.rectTransform, BorderWidth);

            // 内边距：内容都挂它下面（于是内容离面板边正好 Padding）
            var padding = new GameObject("Padding", typeof(RectTransform));
            padding.transform.SetParent(panelFill.transform, false);
            var paddingRect = padding.GetComponent<RectTransform>();
            Stretch(paddingRect, Padding);

            // 标题带：上面一条（没有标题时整条不占位，见 ApplyContent）
            titleBar = CreateCard("TitleBar", paddingRect, CardFill, CardEdge, out var titleContent);
            titleBar.anchorMin = new Vector2(0f, 1f);
            titleBar.anchorMax = new Vector2(1f, 1f);
            titleBar.pivot = new Vector2(0.5f, 1f);
            titleBar.offsetMin = new Vector2(0f, -TitleHeight);
            titleBar.offsetMax = Vector2.zero;

            // 强调条：标题带左边一小截暖黄（与画布上那枚放大镜徽标同色）
            var accent = CreateImage("Accent", titleContent, AccentColor, RoundedRectSprite());
            var accentRect = accent.rectTransform;
            accentRect.anchorMin = new Vector2(0f, 0f);
            accentRect.anchorMax = new Vector2(0f, 1f);
            accentRect.pivot = new Vector2(0f, 0.5f);
            accentRect.offsetMin = new Vector2(22f, 22f);
            accentRect.offsetMax = new Vector2(30f, -22f);

            // 标题**居中**（左右留一样的边，免得长标题压到左边那条强调条上）
            titleText = CreateText("Title", titleContent, TitleFontSize, TextAnchor.MiddleCenter, FontStyle.Bold);
            titleText.color = TitleColor;
            titleText.rectTransform.anchorMin = Vector2.zero;
            titleText.rectTransform.anchorMax = Vector2.one;
            titleText.rectTransform.offsetMin = new Vector2(48f, 0f);
            titleText.rectTransform.offsetMax = new Vector2(-48f, 0f);

            // 内容区：标题带下面那一行（左边图、右边文字）
            var contentGo = new GameObject("Content", typeof(RectTransform));
            contentGo.transform.SetParent(paddingRect, false);
            content = contentGo.GetComponent<RectTransform>();
            content.anchorMin = Vector2.zero;
            content.anchorMax = Vector2.one;
            content.offsetMin = Vector2.zero;
            content.offsetMax = new Vector2(0f, -(TitleHeight + Gap));

            /*
              图那一块：与标题 / 文字**同款卡片表面**（三块一块料），里面那张等比装下。
              为什么不用「量出可视区再算像素」（编辑器那扇窗的 `fitBox` 那样）：uGUI 的
              `preserveAspect` 就是「在这个矩形里等比装下」，宽高比交给它，一行都不用算——
              编辑器那边要算是因为 canvas 还要按同一块矩形做像素级擦除，这里没有那件事。
            */
            frame = CreateCard("Frame", content, CardFill, CardEdge, out var frameContent);
            frame.anchorMin = new Vector2(0f, 0f);
            frame.anchorMax = new Vector2(ImageWidthRatio, 1f);
            frame.offsetMin = Vector2.zero;
            frame.offsetMax = new Vector2(-Gap, 0f);

            var imageGo = new GameObject("Image", typeof(Image));
            imageGo.transform.SetParent(frameContent, false);
            image = imageGo.GetComponent<Image>();
            Stretch(image.rectTransform, ImageInset);
            image.preserveAspect = true;
            image.raycastTarget = false;
            image.enabled = false;

            /*
              视频那块（v33）：与图二选一显示（媒体只有一块）。
              注意**挂在 `content` 上、不挂进 `FrameFill`**——实测挂在 `FrameFill`（一个带 Sliced
              圆角图的 Image）底下时 `RawImage` 生成不出网格（整块空白，纹理/尺寸/画布都对）。
              位置与大小自己算（挂 `content` 就用不了 `AspectRatioFitter`，它的父级是整块内容区）：
              `SyncVideoRect` 按媒体那块的尺寸与视频长宽比居中装下。一开始整块关着：首帧到了才显示。
            */
            var videoGo = new GameObject("Video", typeof(RawImage));
            videoGo.transform.SetParent(content, false);
            videoImage = videoGo.GetComponent<RawImage>();
            videoImage.raycastTarget = false;
            videoGo.SetActive(false);

            // 播放器挂在窗口根上（一个窗口一条视频）
            videoPlayer = gameObject.AddComponent<VideoPlayer>();
            videoPlayer.playOnAwake = false;
            videoPlayer.waitForFirstFrame = true;
            videoPlayer.isLooping = true;
            videoPlayer.renderMode = VideoRenderMode.RenderTexture;
            videoPlayer.aspectRatio = VideoAspectRatio.FitInside;
            videoPlayer.audioOutputMode = VideoAudioOutputMode.None;

            // 文字那一块：与标题 / 图**同款卡片表面**
            bodyCard = CreateCard("Body", content, CardFill, CardEdge, out var bodyContent);
            bodyCard.anchorMin = new Vector2(ImageWidthRatio, 0f);
            bodyCard.anchorMax = Vector2.one;
            bodyCard.offsetMin = Vector2.zero;
            bodyCard.offsetMax = Vector2.zero;

            bodyText = CreateText("Text", bodyContent, BodyFontSize, TextAnchor.UpperLeft, FontStyle.Normal);
            bodyText.color = BodyColor;
            bodyText.lineSpacing = 1.35f;
            // 长文自动缩到装下（下限 BodyMinFontSize）：跑团时信息宁可小一点，也不要被截掉半句
            bodyText.resizeTextForBestFit = true;
            bodyText.resizeTextMinSize = BodyMinFontSize;
            bodyText.resizeTextMaxSize = BodyFontSize;
            Stretch(bodyText.rectTransform, TextInset);
        }

        /// <summary>
        /// 一块**圆角卡片**（外面一圈 1px 边）：返回外层（**布局挂在它上面**），
        /// 内层（子节点挂它上面，不会被那条边压住）从 `content` 出来。
        /// </summary>
        private static RectTransform CreateCard(
            string name,
            Transform parent,
            Color fill,
            Color edge,
            out RectTransform content)
        {
            var card = CreateImage(name, parent, edge, RoundedRectSprite());
            var inner = CreateImage(name + "Fill", card.transform, fill, RoundedRectSprite());
            Stretch(inner.rectTransform, BorderWidth);
            content = inner.rectTransform;
            return card.rectTransform;
        }

        private static Image CreateImage(string name, Transform parent, Color color, Sprite sprite)
        {
            var go = new GameObject(name, typeof(Image));
            go.transform.SetParent(parent, false);
            var created = go.GetComponent<Image>();
            created.color = color;
            created.raycastTarget = false;
            if (sprite != null)
            {
                created.sprite = sprite;
                created.type = Image.Type.Sliced;
            }

            return created;
        }

        /// <summary>
        /// 造一块文本：羊皮纸上是**深色字**，不加描边（描边是"深底亮字"那一套的；颜色由调用方给）。
        /// </summary>
        private static Text CreateText(
            string name,
            Transform parent,
            int fontSize,
            TextAnchor alignment,
            FontStyle style)
        {
            var go = new GameObject(name, typeof(Text));
            go.transform.SetParent(parent, false);
            var created = go.GetComponent<Text>();
            created.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            created.fontSize = fontSize;
            created.fontStyle = style;
            created.alignment = alignment;
            created.color = Color.white;
            created.horizontalOverflow = HorizontalWrapMode.Wrap;
            created.verticalOverflow = VerticalWrapMode.Truncate;
            created.raycastTarget = false;
            return created;
        }

        /// <summary>铺满父节点（`inset` = 四边各内缩多少）。</summary>
        private static void Stretch(RectTransform rect, float inset = 0f)
        {
            rect.anchorMin = Vector2.zero;
            rect.anchorMax = Vector2.one;
            rect.offsetMin = new Vector2(inset, inset);
            rect.offsetMax = new Vector2(-inset, -inset);
        }

        /// <summary>
        /// **圆角矩形**的 9-slice 白图：**全窗共用一张**，颜色由各块自己的 `Image.color` 上
        /// （边框 = 外面铺满一张、里面再铺一张内缩 `BorderWidth` 的，两层不同色）。
        ///
        /// 优先用项目里的素材 `Resources/UI/MagnifierRounded`（**预设引用的就是它**——只有资产才存得进 prefab）；
        /// 找不到才**代码生成**一张：Unity 6 里内置的那几张 `UI/Skin/*.psd`（`Resources.GetBuiltinResource<Sprite>`）
        /// **已经拿不到了**（实测返回 null），项目里也没有别的 UI 素材。生成的那张缓存一次
        /// （`HideAndDontSave`：不进场景、不随场景卸载走）。
        /// </summary>
        private static Sprite RoundedRectSprite()
        {
            if (rounded != null)
            {
                return rounded;
            }

            // 优先用**资产**（`Resources/UI/MagnifierRounded`）：prefab 里那套引用的就是它——
            // 只有资产才存得进 prefab（下面代码生成的那张不是资产，存进 prefab 会丢引用）。
            rounded = Resources.Load<Sprite>(RoundedResourcePath);
            if (rounded != null)
            {
                return rounded;
            }

            const int size = 64;
            const int radius = 18;
            var texture = new Texture2D(size, size, TextureFormat.RGBA32, false)
            {
                hideFlags = HideFlags.HideAndDontSave,
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Bilinear,
            };

            var half = size * 0.5f;
            for (var y = 0; y < size; y++)
            {
                for (var x = 0; x < size; x++)
                {
                    // 圆角矩形的有符号距离（< 0 在里面）；边缘留 1px 过渡，圆角不锯齿
                    var qx = Mathf.Abs(x + 0.5f - half) - (half - radius);
                    var qy = Mathf.Abs(y + 0.5f - half) - (half - radius);
                    var outside = new Vector2(Mathf.Max(qx, 0f), Mathf.Max(qy, 0f)).magnitude;
                    var distance = outside + Mathf.Min(Mathf.Max(qx, qy), 0f) - radius;
                    texture.SetPixel(x, y, new Color(1f, 1f, 1f, Mathf.Clamp01(0.5f - distance)));
                }
            }

            texture.Apply();
            rounded = Sprite.Create(
                texture,
                new Rect(0f, 0f, size, size),
                new Vector2(0.5f, 0.5f),
                100f,
                0,
                SpriteMeshType.FullRect,
                new Vector4(radius, radius, radius, radius));
            rounded.hideFlags = HideFlags.HideAndDontSave;
            return rounded;
        }

        /// <summary>
        /// 从纹理造一份「整张图或其中一格」的 Sprite：`null` = 整张。
        ///
        /// 矩形由 <see cref="SpriteLayer.UvRectOf"/> 算——那里是**全链路唯一一次 y 翻转**
        /// （格序数从左上数、纹理 UV 自下而上），放大镜不另写一份，于是与对象自己的子图
        /// 画出来的是同一块。
        /// </summary>
        public static Sprite SpriteOf(Texture2D texture, MirrorSprite sprite)
        {
            var uv = SpriteLayer.UvRectOf(sprite);
            return Sprite.Create(
                texture,
                new Rect(
                    uv.x * texture.width,
                    uv.y * texture.height,
                    uv.z * texture.width,
                    uv.w * texture.height),
                new Vector2(0.5f, 0.5f),
                100f);
        }

        private void DestroySprite()
        {
            if (current != null)
            {
                Destroy(current);
                current = null;
            }

            currentId = "";
            currentSprite = null;
            currentTexture = null;
            if (image != null)
            {
                image.sprite = null;
            }
        }

        private static bool SameSprite(MirrorSprite left, MirrorSprite right)
        {
            if (left == null || right == null)
            {
                return left == right;
            }

            return left.columns == right.columns
                && left.rows == right.rows
                && left.column == right.column
                && left.row == right.row;
        }
    }
}
