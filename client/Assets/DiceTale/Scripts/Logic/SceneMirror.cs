using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 场景镜像：**后台有什么对象，前端就有什么对象**。
    ///
    /// **层级按场景分**——每个场景在宿主下有一棵**以场景名命名的子树**：
    ///
    /// <code>
    /// Game
    /// └─ 场景（容器，只负责把各个场景归在一起）
    ///    ├─ 场景1        ← 一个场景 = 一个 GameObject，名字就是场景名
    ///    │  ├─ 地图（map_…）
    ///    │  ├─ FogOverlay（战争雾：**开着开关**、也绑了雾区的地图才有，**与地图同级**、盖在最前面）
    ///    │  └─ 精灵（obj_…）
    ///    └─ 场景2        ← 只是隐藏，**不销毁**
    /// </code>
    ///
    /// **切换场景 = 切可见性，不是删除**：一次运行里可能同时存在多个场景（玩家可能在场景1 做完事
    /// 再切到场景2），所以离开一个场景只是把它 `SetActive(false)` 藏起来，对象、贴图、状态都留着；
    /// 再切回去直接把整棵子树显示出来即可，不必重建。
    ///
    /// **根节点可以自由变换**：容器（`场景`）与每个场景根节点都是**单位变换**起步，而对象视图用的是
    /// **局部坐标**（`localPosition` / `localRotation`，尺寸烘在网格里、`localScale` 恒为 1）。
    /// 所以要整场景平移 / 旋转 / **缩放**（例如缩到 0.5 倍看全局），直接改容器或场景根节点的
    /// Transform 即可——里面的对象跟着一起变，不需要逐个改世界坐标。
    ///
    /// 收到 `scene_sync`（整份场景）后：
    /// - 这份场景第一次出现 → 建一棵以它命名的子树；
    /// - 同一个场景再来 → 按 `id` **增 / 改 / 删**（新 id 建视图、老 id 更新属性、名单里没有的销毁）；
    /// - **其他场景不动**（只把它们藏起来）；
    /// - 场景名变了 → 隐藏旧的、显示新的。
    ///
    /// 同时把每份场景的模型都留一份（<see cref="Find"/> 会在**所有场景**里找），因为命令是**触发器**：
    /// 比如播放声音时，前端要读出那个对象自己声明的 `sound.picked`——数据在镜像里，不在命令里。
    ///
    /// **动作对象（`PlaySound` / `Teleport`）只有模型、没有视图**：前端连 GameObject 都不为它们建
    /// （判据在 <see cref="SceneObjectView.NeedsView"/>，建视图前问一次）。所以两张表不是一一对应的：
    /// 增 / 改 / 删都要**按模型表**走，否则会漏掉它们（删掉的声音会永远留在镜像里，命令还会读到）。
    ///
    /// **真的换了一个场景时套一层淡入淡出**（参照参考实现 `LLMNPC_NEWLIGHT_EX` 的
    /// `GameSceneManager.LoadScene`）：先淡出到全黑 → **黑屏里**建 / 显新场景 → 淡入还原
    /// （遮罩是 <see cref="SceneFadeUI"/>，代码构建、由 UIManager 管）。淡出期间屏幕已经罩住，
    /// 所以「旧图消失、新图出现」那一瞬不会闪。
    /// **第一次载入与同一场景的增量更新都不淡**：前者没有可交叉的画面（一进游戏先黑一下是白等），
    /// 后者每改一笔就闪一下根本没法用。
    /// </summary>
    public class SceneMirror : MonoBehaviour
    {
        /// <summary>等资源包最多等多久（秒）——到点照常载入，不让画面空着。</summary>
        private const float SceneWaitTimeoutSeconds = 30f;

        /// <summary>场景容器名：把各个场景归在一起，免得和对象视图混在同一层。</summary>
        private const string ContainerName = "场景";

        [Header("切场景的淡入淡出")]
        [Tooltip("淡出到全黑的时长（秒）。0 = 不淡出（切的那一瞬会露出旧图消失的过程）")]
        [SerializeField] private float fadeOutDuration = 0.25f;

        [Tooltip("从全黑淡入的时长（秒）。0 = 直接显像")]
        [SerializeField] private float fadeInDuration = 0.3f;

        [Tooltip("关掉 = 切场景直接切（排查「画面被遮罩挡住」这类问题时用）")]
        [SerializeField] private bool sceneFadeEnabled = true;

        /// <summary>每个场景一棵子树：场景名 → 该场景的根节点。</summary>
        private readonly Dictionary<string, Transform> sceneRoots = new Dictionary<string, Transform>();

        /// <summary>每个场景自己的视图表（场景名 → 对象 id → 视图）。</summary>
        private readonly Dictionary<string, Dictionary<string, SceneObjectView>> sceneViews =
            new Dictionary<string, Dictionary<string, SceneObjectView>>();

        /// <summary>每个场景自己的模型表（场景名 → 对象 id → 模型）；命令要在这里取数据。</summary>
        private readonly Dictionary<string, Dictionary<string, MirrorObject>> sceneObjects =
            new Dictionary<string, Dictionary<string, MirrorObject>>();

        private readonly Dictionary<string, Dictionary<string, AutoplayState>> autoplayStates =
            new Dictionary<string, Dictionary<string, AutoplayState>>();

        private sealed class AutoplayState
        {
            public bool active;
            public bool hasPosition;
            public bool enabled;
            public string picked;
        }

        private Transform container;
        private ResourceImageLoader imageLoader;
        private ResourceBundleCache bundleCache;
        private ClientSession session;

        /// <summary>Configured by the host to resolve and start an autoplay video.</summary>
        public System.Action<string, string> AutoPlayVideoRequested { get; set; }

        /// <summary>等资源包期间挂起的那份场景（只留最新一份）。</summary>
        private MirrorScene pendingScene;
        private string pendingProject;
        private Coroutine pendingTimer;

        /// <summary>正在播的那一轮淡入淡出（null = 空闲）。</summary>
        private Coroutine fadeRoutine;

        /// <summary>淡入淡出期间到达的场景：只留最新一份，由进行中的那一轮在黑屏里落地。</summary>
        private MirrorScene queuedScene;
        private bool hasQueuedScene;

        /// <summary>当前**显示中**的场景名（null = 还没镜像任何场景）。其余场景只是被隐藏。</summary>
        public string SceneName { get; private set; }

        public System.Action<string, string> AutoPlayVideoRequested { get; set; }

        /// <summary>接上会话（由 <see cref="BackendManager"/> 调用一次）。</summary>
        public void Initialize(ClientSession clientSession, ResourceImageLoader loader, ResourceBundleCache cache = null)
        {
            session = clientSession;
            imageLoader = loader;
            bundleCache = cache;

            var root = new GameObject(ContainerName);
            root.transform.SetParent(transform, false);
            container = root.transform;

            session.SceneReceived += Apply;

            if (bundleCache != null)
            {
                bundleCache.Completed += OnResourcesCompleted;
            }
        }

        private void OnDestroy()
        {
            if (session != null)
            {
                session.SceneReceived -= Apply;
            }

            if (bundleCache != null)
            {
                bundleCache.Completed -= OnResourcesCompleted;
            }
        }

        /// <summary>按 id 找到镜像里的对象（命令要用它取数据）；**所有场景**里找，没有返回 null。</summary>
        public MirrorObject Find(string objectId)
        {
            if (string.IsNullOrEmpty(objectId))
            {
                return null;
            }

            foreach (var table in sceneObjects.Values)
            {
                if (table.TryGetValue(objectId, out var found))
                {
                    return found;
                }
            }

            return null;
        }

        /// <summary>
        /// 按 id 找到镜像里的**视图**（命令要动视图本身时用，例如战争雾层挂在视图的子物体上）；
        /// **所有场景**里找，没有返回 null。动作对象只有模型、没有视图，所以这里自然是 null
        /// （要它的数据用 <see cref="Find"/>）。
        /// </summary>
        public SceneObjectView FindView(string objectId)
        {
            if (string.IsNullOrEmpty(objectId))
            {
                return null;
            }

            foreach (var table in sceneViews.Values)
            {
                if (table.TryGetValue(objectId, out var found) && found != null)
                {
                    return found;
                }
            }

            return null;
        }

        /// <summary>应用一份场景（`null` = 编辑器没有打开的场景 → 把当前场景藏起来，但**不销毁**）。</summary>
        public void Apply(MirrorScene scene)
        {
            if (scene == null)
            {
                pendingScene = null;

                // 淡入淡出中：别在已经被罩住的屏幕上单独演一遍「全藏起来」，
                // 交给那一轮统一处理（黑屏里藏完再淡入）
                if (fadeRoutine != null)
                {
                    QueueForFade(null);
                    return;
                }

                ApplySceneOrHide(null);
                return;
            }

            // **顺序要求：先下资源、再载入场景。** 资源包还没处理完就把这份场景挂起，
            // 等 ResourceBundleCache 报完成（成功或失败都算）再落地——
            // 否则会先按远程逐张取图建一遍视图，等包下完再全部重来一次。
            var project = ProjectOf(scene);
            if (!string.IsNullOrEmpty(project) && bundleCache != null && !bundleCache.IsFinishedFor(project))
            {
                if (pendingScene == null)
                {
                    Debug.Log($"[镜像] 场景「{scene.name}」先挂起：等「{project}」的资源包处理完再载入");
                }
                else
                {
                    Debug.Log($"[镜像] 用更新的场景「{scene.name}」替换挂起中的那一份");
                }

                pendingScene = scene;
                pendingProject = project;
                if (pendingTimer == null)
                {
                    pendingTimer = StartCoroutine(ApplyPendingAfterTimeout());
                }

                return;
            }

            ApplyReady(scene);
        }

        /// <summary>
        /// 资源就绪（或本来就不用等）→ 落地。
        ///
        /// 三个去向，顺序就是优先级：
        /// 1. **正在淡入淡出** → 排队（只留最新一份），由进行中的那一轮在黑屏里应用——
        ///    连点几次换台不会叠出几层遮罩，也不会在淡入到一半时又跳一下；
        /// 2. **真的换了一个场景** → 开一轮淡入淡出（见 <see cref="SwitchWithFade"/>）；
        /// 3. 其余（第一次载入 / 同一场景的增量更新 / 遮罩关掉）→ 直接落地。
        /// </summary>
        private void ApplyReady(MirrorScene scene)
        {
            if (fadeRoutine != null)
            {
                QueueForFade(scene);
                return;
            }

            if (ShouldFade(scene))
            {
                fadeRoutine = StartCoroutine(SwitchWithFade(scene));
                return;
            }

            ApplySceneOrHide(scene);
        }

        /// <summary>
        /// 该淡吗：**换了一个场景**才淡。
        ///
        /// - 第一次载入不淡（`SceneName == null`）：没有可交叉的画面，先黑一下只是白等；
        /// - 同一个场景再来不淡：那是编辑器的增量更新（改一笔推一次），一改就闪没法用；
        /// - `sceneFadeEnabled` 关掉 = 直接切（排查「画面被遮罩挡住」这类问题时用）。
        /// </summary>
        private bool ShouldFade(MirrorScene scene)
        {
            return sceneFadeEnabled
                && scene != null
                && SceneName != null
                && SceneName != scene.name;
        }

        /// <summary>
        /// 淡入淡出切场景：**淡出到全黑 → 黑屏里落地 → 淡入还原**。
        ///
        /// 黑屏期间 / 淡入期间又来了新的场景（连点几次换台、资源包刚好处理完），
        /// 就留在黑屏里换成最新那份、或者在淡入结束后再走一轮——所以这个方法是个循环，
        /// 屏幕上**始终只有一层遮罩**（`SceneFadeUI` 按类型注册，一个类型至多一个实例）。
        ///
        /// 遮罩开不出来（没有 UIManager，例如纯逻辑测试）就退化成直接切，绝不因为过渡效果挡住换台。
        /// </summary>
        private IEnumerator SwitchWithFade(MirrorScene scene)
        {
            var fade = OpenFadeWindow();
            if (fade == null)
            {
                Debug.LogWarning("[镜像] 拿不到全屏遮罩窗口：这次切场景直接切（没有淡入淡出）");
                ApplySceneOrHide(scene);
                fadeRoutine = null;
                yield break;
            }

            while (true)
            {
                // 1) 淡出到全黑：屏幕先被罩住，后面无论怎么建 / 删都不会露出过程
                fade.FadeToBlack(Mathf.Max(fadeOutDuration, 0.001f));
                while (fade.IsFading)
                {
                    yield return null;
                }

                // 2) 黑屏里落地（建 / 改 / 删视图 + 显现新场景，与直接切完全同一条路）
                ApplySceneOrHide(scene);

                // 3) 黑屏期间又来了（连点几次换台）：就地换成最新那份，不让屏幕闪一下
                while (hasQueuedScene)
                {
                    ApplySceneOrHide(TakeQueuedScene());
                }

                // 黑屏期间可能建出了新的 UI（以后加场景 HUD 时）：淡入前把遮罩再提到 Canvas 最上层，
                // 保证「慢慢变亮」盖住所有新东西
                fade.transform.SetAsLastSibling();

                // 4) 淡入还原
                fade.FadeFromBlack(Mathf.Max(fadeInDuration, 0.001f));
                while (fade.IsFading)
                {
                    yield return null;
                }

                // 5) 淡入期间又来了：再走一轮（从当前透明度接着淡出）
                if (!hasQueuedScene)
                {
                    break;
                }

                scene = TakeQueuedScene();
            }

            // 淡入完成：关掉遮罩窗口（Close 只隐藏、保留注册，下次切场景再 Open）
            fade.Close();
            fadeRoutine = null;
        }

        /// <summary>把场景排给进行中的那一轮淡入淡出（只留最新一份；`null` = 编辑器关掉了场景）。</summary>
        private void QueueForFade(MirrorScene scene)
        {
            queuedScene = scene;
            hasQueuedScene = true;
        }

        /// <summary>取走排队的那份场景（取完即清）。</summary>
        private MirrorScene TakeQueuedScene()
        {
            var scene = queuedScene;
            queuedScene = null;
            hasQueuedScene = false;
            return scene;
        }

        /// <summary>打开（或取已打开的）全屏淡入淡出遮罩窗口；没有 UIManager 时返回 null。</summary>
        private static SceneFadeUI OpenFadeWindow()
        {
            var game = Game.Instance;
            var ui = game != null ? game.UIManager : null;
            return ui != null ? ui.OpenWindow<SceneFadeUI>() : null;
        }

        /// <summary>落地一份场景；`null` = 编辑器没有打开场景（全藏起来，**不销毁**）。</summary>
        private void ApplySceneOrHide(MirrorScene scene)
        {
            if (scene != null)
            {
                ApplyNow(scene);
                return;
            }

            HideAll();
            SceneName = null;
            Debug.Log("[镜像] 编辑器没有打开场景：已隐藏全部场景（对象与状态都留着）");
        }

        private void ApplyNow(MirrorScene scene)
        {
            var sceneActivated = SceneName != scene.name;
            var viewTable = ViewsOf(scene.name);
            var objectTable = ObjectsOf(scene.name);
            var autoplayTable = AutoplayStatesOf(scene.name);
            var sceneRoot = RootOf(scene.name);

            var present = new HashSet<string>();
            var autoPlayObjects = new List<string>();
            foreach (var obj in scene.objects)
            {
                present.Add(obj.id);
                autoplayTable.TryGetValue(obj.id, out var previousAutoplay);
                objectTable[obj.id] = obj;

                if (ShouldAutoplayVideo(obj, previousAutoplay, sceneActivated))
                {
                    autoPlayObjects.Add(obj.id);
                }
                autoplayTable[obj.id] = AutoplayStateOf(obj);

                // **动作对象（PlaySound / Teleport）不建视图**：它们只是「一条给前端的指令」，
                // 数据留在镜像里够用（命令要用它取数据）；编辑器画布上那两枚徽标是编辑器的画法。
                // 这里连 GameObject 都不建，不是「建了再隐藏」——所以也不会占层级、不会进相机的剔除。
                // 判据看的是**组件**（v9 起），见 `SceneObjectView.NeedsView`。
                if (!SceneObjectView.NeedsView(obj))
                {
                    if (viewTable.TryGetValue(obj.id, out var stale) && stale != null)
                    {
                        // 之前建过（改了 kind、或老版本建的）就销毁，别留下一个孤儿面片
                        Destroy(stale.gameObject);
                    }

                    viewTable.Remove(obj.id);
                    continue;
                }

                if (!viewTable.TryGetValue(obj.id, out var view) || view == null)
                {
                    view = SceneObjectView.Create(obj, sceneRoot, imageLoader);
                    viewTable[obj.id] = view;
                }

                view.Apply(obj);
            }

            // 名单里没有的 → 这个场景里不该有（删除 / 复制后改名都走这里）。
            // **按模型表找**而不是按视图表：动作对象只有模型、没有视图，漏掉它们的话
            // 删掉的声音 / 传送阵会永远留在镜像里（命令还会读到它）。
            var removed = new List<string>();
            foreach (var id in objectTable.Keys)
            {
                if (!present.Contains(id))
                {
                    removed.Add(id);
                }
            }

            foreach (var id in removed)
            {
                if (viewTable.TryGetValue(id, out var view) && view != null)
                {
                    Destroy(view.gameObject);
                }

                viewTable.Remove(id);
                objectTable.Remove(id);
                autoplayTable.Remove(id);
            }

            // **切换 = 只切可见性**：显示这份场景，其他场景藏起来（不销毁）
            var switched = SceneName != null && SceneName != scene.name;
            SceneName = scene.name;
            ShowOnly(scene.name);

            foreach (var objectId in autoPlayObjects)
            {
                AutoPlayVideoRequested?.Invoke(scene.name, objectId);
            }

            Debug.Log(
                $"[镜像] 场景「{scene.name}」：{objectTable.Count} 个对象" +
                (removed.Count > 0 ? $"，移除 {removed.Count} 个" : "") +
                (switched || sceneRoots.Count > 1 ? $"（镜像里共 {sceneRoots.Count} 个场景，隐藏的不销毁）" : ""));
        }

        private Dictionary<string, AutoplayState> AutoplayStatesOf(string sceneName)
        {
            if (!autoplayStates.TryGetValue(sceneName, out var table))
            {
                table = new Dictionary<string, AutoplayState>();
                autoplayStates.Add(sceneName, table);
            }

            return table;
        }

        private static AutoplayState AutoplayStateOf(MirrorObject obj)
        {
            return new AutoplayState
            {
                active = obj.active,
                hasPosition = obj.hasPosition,
                enabled = obj.video != null && obj.video.enabled && obj.video.autoPlay,
                picked = obj.video != null ? obj.video.picked : null,
            };
        }

        private static bool ShouldAutoplayVideo(MirrorObject current, AutoplayState previous, bool sceneActivated)
        {
            var video = current.video;
            if (!current.active || !current.hasPosition || video == null || !video.enabled || !video.autoPlay
                || string.IsNullOrEmpty(video.picked) || !video.clips.Contains(video.picked))
            {
                return false;
            }

            return sceneActivated
                || previous == null
                || !previous.active
                || !previous.hasPosition
                || !previous.enabled
                || previous.picked != video.picked;
        }

        public MirrorObject FindInScene(string sceneName, string objectId)
        {
            if (sceneName == null || objectId == null) return null;
            return ObjectsOf(sceneName).TryGetValue(objectId, out var obj) ? obj : null;
        }

        public SceneObjectView FindViewInScene(string sceneName, string objectId)
        {
            if (sceneName == null || objectId == null) return null;
            var table = ViewsOf(sceneName);
            return table.TryGetValue(objectId, out var view) ? view : null;
        }

        /// <summary>资源包处理完了（成功或失败）→ 把挂起的场景放行。</summary>
        private void OnResourcesCompleted(ResourceBundleCache cache)
        {
            if (pendingScene == null)
            {
                return;
            }

            StopPendingTimer();
            var scene = pendingScene;
            pendingScene = null;
            pendingProject = null;
            ApplyReady(scene);
        }

        /// <summary>
        /// 兜底：等资源包等太久就别再等了。
        ///
        /// 资源包是**优化**，不是载入场景的前提——服务端没实现、素材超大、网络卡住时都不该让画面空着。
        /// 到点照常载入（图片回落逐文件远程取），并说明原因。
        /// </summary>
        private IEnumerator ApplyPendingAfterTimeout()
        {
            yield return new WaitForSeconds(SceneWaitTimeoutSeconds);
            pendingTimer = null;

            if (pendingScene == null)
            {
                yield break;
            }

            var scene = pendingScene;
            var project = pendingProject;
            pendingScene = null;
            pendingProject = null;

            Debug.LogWarning(
                $"[镜像] 等「{project}」的资源包超过 {SceneWaitTimeoutSeconds} 秒，先载入场景「{scene.name}」；" +
                "图片回落逐文件远程取（资源包就绪后新图会走本地）");
            ApplyReady(scene);
        }

        /// <summary>
        /// 从一份场景里推出它属于哪个项目。
        ///
        /// 走的还是逻辑 ID 本身（`project:测试项目/Assets/…`），与后端 `projectNameFromId` 同口径。
        /// 服务端会在 `resources_prepare` 里提前告知项目名，所以这条路主要用于兜底
        /// （服务端还不知道项目、或老服务端不发那条消息时）。取第一个带 `project:` 前缀的资源即可
        /// ——同一场景必属同一项目，顺序无关。
        /// </summary>
        private static string ProjectOf(MirrorScene scene)
        {
            foreach (var obj in scene.objects)
            {
                var project = LocalResourceStore.ProjectNameOf(ResourceIdOf(obj));
                if (!string.IsNullOrEmpty(project))
                {
                    return project;
                }
            }

            return null;
        }

        /// <summary>
        /// 取一个对象身上第一个资源逻辑 ID（贴图 → 地图贴图 → 声音），没有则返回 null。
        ///
        /// **没有资源的对象是常态**（动作对象、还没挑图的精灵、以及协议版本不匹配时收到的
        /// 「什么组件都没有」的对象），所以这里必须一路 null 安全：`obj.sound?.clips` 为 null
        /// 时**不能**把它喂给 `foreach`——对 null 做 foreach 会抛 NullReferenceException，
        /// 而那会把整份场景的载入打断在一次兜底的「推项目名」上。
        /// </summary>
        private static string ResourceIdOf(MirrorObject obj)
        {
            var display = obj.DisplayImage;
            if (display != null && !string.IsNullOrEmpty(display.id))
            {
                return display.id;
            }

            var clips = obj.sound != null ? obj.sound.clips : null;
            if (clips == null)
            {
                return null;
            }

            foreach (var clip in clips)
            {
                if (!string.IsNullOrEmpty(clip))
                {
                    return clip;
                }
            }

            return null;
        }

        // ---------------------------------------------------------------- 场景子树的建立与显隐

        /// <summary>取（必要时建）某个场景的根节点——**以场景名命名**，直接看出这是哪个场景。</summary>
        private Transform RootOf(string sceneName)
        {
            if (sceneRoots.TryGetValue(sceneName, out var existing) && existing != null)
            {
                return existing;
            }

            var go = new GameObject(sceneName);
            go.transform.SetParent(container, false);
            sceneRoots[sceneName] = go.transform;
            return go.transform;
        }

        private Dictionary<string, SceneObjectView> ViewsOf(string sceneName)
        {
            if (!sceneViews.TryGetValue(sceneName, out var table))
            {
                table = new Dictionary<string, SceneObjectView>();
                sceneViews[sceneName] = table;
            }

            return table;
        }

        private Dictionary<string, MirrorObject> ObjectsOf(string sceneName)
        {
            if (sceneName == null)
            {
                return new Dictionary<string, MirrorObject>();
            }

            if (!sceneObjects.TryGetValue(sceneName, out var table))
            {
                table = new Dictionary<string, MirrorObject>();
                sceneObjects[sceneName] = table;
            }

            return table;
        }

        private void StopPendingTimer()
        {
            if (pendingTimer != null)
            {
                StopCoroutine(pendingTimer);
                pendingTimer = null;
            }
        }

        /// <summary>只显示指定场景，其余全部隐藏（**不销毁**）。</summary>
        private void ShowOnly(string sceneName)
        {
            foreach (var pair in sceneRoots)
            {
                if (pair.Value != null)
                {
                    pair.Value.gameObject.SetActive(pair.Key == sceneName);
                }
            }
        }

        /// <summary>把全部场景藏起来（编辑器没有打开场景时）。</summary>
        private void HideAll()
        {
            foreach (var root in sceneRoots.Values)
            {
                if (root != null)
                {
                    root.gameObject.SetActive(false);
                }
            }
        }
    }
}
