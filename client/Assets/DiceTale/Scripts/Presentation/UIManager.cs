using System.Collections.Generic;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem.UI;
using UnityEngine.UI;

namespace DiceTale
{
    /// <summary>
    /// UI 管理器：统一管理**唯一** Canvas 与所有 <see cref="UIWindow"/> 窗口。
    /// 所有 UI 预设（字幕窗口 / 场景淡入淡出 / 未来其它）都实例化挂在这一个 Canvas 下，
    /// 不再各自创建 Canvas；EventSystem 也统一由本管理器补建。
    ///
    /// **对外接口只暴露 <see cref="OpenWindow{T}"/> / <see cref="CloseWindow{T}"/>**，
    /// 其余（注册/注销/加载实例/查找/销毁）均为 internal（项目内使用）或 private（内部辅助）：
    /// UIWindow 子类 Awake 时自动经内部注册（<see cref="RegisterWindow"/>），OnDestroy 自动注销，
    /// 一个类型至多一个实例。
    ///
    /// **不常驻**（无 DontDestroyOnLoad）：DiceTale 只是项目里的一个小游戏，
    /// 本管理器作为场景根物体创建，退出场景（场景卸载）即随场景一起销毁，
    /// 重新进入时按需重建即可。
    /// <see cref="Game"/> 初始化并持有（Game.Awake 挂到宿主物体），不再使用单例。
    /// </summary>
    public class UIManager : MonoBehaviour
    {
        /// <summary>全局唯一 Canvas（Screen Space Camera，1920×1080 缩放）。UI 预设实例都挂其下。</summary>
        public Canvas RootCanvas { get; private set; }

        /// <summary>已注册窗口（按具体类型登记，一个类型至多一个实例）。</summary>
        private readonly Dictionary<System.Type, UIWindow> windows = new Dictionary<System.Type, UIWindow>();

        /// <summary>当前所有已注册窗口（只读快照遍历用）。</summary>
        internal IReadOnlyCollection<UIWindow> Windows => windows.Values;

        private void Awake()
        {
            EnsureCanvas();
            EnsureEventSystem();
        }

        private void EnsureCanvas()
        {
            if (RootCanvas != null)
            {
                return;
            }

            var go = GameObject.Find("UICanvas");
            RootCanvas = go.GetComponent<Canvas>();
            RootCanvas.renderMode = RenderMode.ScreenSpaceCamera;
            if (RootCanvas.worldCamera == null)
            {
                RootCanvas.worldCamera = Camera.main;
            }
            if (RootCanvas.worldCamera != null)
            {
                RootCanvas.planeDistance = RootCanvas.worldCamera.nearClipPlane + 0.01f;
            }
            var scaler = go.GetComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920f, 1080f);
            scaler.matchWidthOrHeight = 0.5f;
        }

        private static void EnsureEventSystem()
        {
            var es = Object.FindFirstObjectByType<EventSystem>();
            if (es == null)
            {
                es = new GameObject("EventSystem").AddComponent<EventSystem>();
            }

            // 项目输入配置为 Input System Only（activeInputHandler=1）：
            // 必须挂 InputSystemUIInputModule，StandaloneInputModule（旧输入）在该模式下不工作（按钮点击失效）。
            if (es.GetComponent<InputSystemUIInputModule>() != null)
            {
                return;
            }

            // 已有 EventSystem 但输入模块缺失/不兼容（如场景烘焙的旧模块）：替换为兼容模块
            var oldModule = es.GetComponent<BaseInputModule>();
            if (oldModule != null)
            {
                Object.Destroy(oldModule);
            }

            es.gameObject.AddComponent<InputSystemUIInputModule>();
        }

        /// <summary>实例化 UI 预设并挂到全局唯一 Canvas 下（内部加载辅助）。</summary>
        private GameObject InstantiateUI(GameObject prefab)
        {
            if (prefab == null)
            {
                return null;
            }

            return Instantiate(prefab, RootCanvas.transform, false);
        }

        /// <summary>按 Resources 路径加载 UI 预设并实例化到全局 Canvas（内部加载辅助）；找不到返回 null。</summary>
        private GameObject LoadUI(string resourcesPath)
        {
            var prefab = Resources.Load<GameObject>(resourcesPath);
            return prefab != null ? InstantiateUI(prefab) : null;
        }

        // ---------- 窗口管理（UIWindow） ----------

        /// <summary>注册窗口（UIWindow.Awake 自动调用；重复注册同类型时用新实例覆盖旧实例并告警）。</summary>
        internal void RegisterWindow(UIWindow window)
        {
            if (window == null)
            {
                return;
            }

            var type = window.GetType();
            if (windows.TryGetValue(type, out var existing) && existing != null && existing != window)
            {
                Debug.LogWarning($"[UIManager] 窗口类型 {type.Name} 重复注册（{existing.name} → {window.name}），旧实例将被覆盖。");
                existing.Manager = null; // 旧实例与本管理器解绑，防止其 OnDestroy 误注销新实例
            }

            window.Manager = this;
            windows[type] = window;
        }

        /// <summary>注销窗口（UIWindow.OnDestroy 自动调用）。</summary>
        internal void UnregisterWindow(UIWindow window)
        {
            if (window == null || window.Manager != this)
            {
                return;
            }

            // 只注销「登记的就是本实例」的条目，避免旧实例 OnDestroy 误删新实例
            if (windows.TryGetValue(window.GetType(), out var existing) && existing == window)
            {
                windows.Remove(window.GetType());
            }

            window.Manager = null;
        }

        /// <summary>查找已注册窗口；没有返回 null（internal，项目内使用）。</summary>
        internal T GetWindow<T>() where T : UIWindow
        {
            windows.TryGetValue(typeof(T), out var window);
            return window as T;
        }

        /// <summary>**对外主接口**：打开窗口。未注册时按 Resources 路径加载 prefab 实例化到 Canvas
        /// （路径为空则**代码构建**：直接建空物体挂组件，适合无 prefab 的窗口如 <see cref="SceneFadeUI"/>）；
        /// 已注册则直接 Open。返回窗口组件；路径给定了却加载不到返回 null。</summary>
        public T OpenWindow<T>(string resourcesPath = null) where T : UIWindow
        {
            var window = GetWindow<T>();
            if (window == null && !string.IsNullOrEmpty(resourcesPath))
            {
                var go = LoadUI(resourcesPath);
                window = go != null ? go.GetComponent<T>() : null;
            }

            if (window == null && string.IsNullOrEmpty(resourcesPath))
            {
                // 未给路径：代码构建窗口（无 prefab，结构由组件自己 Awake 生成，如 SceneFadeUI 的全屏遮罩）
                var go = new GameObject(typeof(T).Name, typeof(RectTransform));
                go.transform.SetParent(RootCanvas.transform, false);
                window = go.AddComponent<T>();
            }

            if (window == null)
            {
                Debug.LogWarning($"[UIManager] 打开窗口 {typeof(T).Name} 失败：未注册且资源 {resourcesPath} 加载不到窗口组件。");
                return null;
            }

            window.Open();
            return window;
        }

        /// <summary>**对外主接口**：关闭窗口（隐藏、保留注册，可再 Open）；未注册时忽略。</summary>
        public void CloseWindow<T>() where T : UIWindow
        {
            GetWindow<T>()?.Close();
        }

        /// <summary>销毁窗口实例（注销并从场景移除）；未注册时忽略（internal，项目内使用）。</summary>
        internal void DestroyWindow<T>() where T : UIWindow
        {
            var window = GetWindow<T>();
            if (window != null)
            {
                Destroy(window.gameObject);
            }
        }

        /// <summary>关闭所有已注册窗口（只隐藏，保留注册与实例；internal，项目内使用）。</summary>
        internal void CloseAllWindows()
        {
            foreach (var window in windows.Values)
            {
                if (window != null)
                {
                    window.Close();
                }
            }
        }
    }
}
