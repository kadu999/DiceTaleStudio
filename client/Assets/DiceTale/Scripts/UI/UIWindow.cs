using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// UI 窗口基类：所有由 <see cref="UIManager"/> 统一管理的窗口（StartSceneUI / PlayerSwitcherUI / 未来其它）
    /// 都继承本类。窗口实例经 UIManager.OpenWindow 实例化后挂到全局唯一 Canvas 下。
    ///
    /// 生命周期约定：
    ///   - Awake 自动向 UIManager 注册（按具体类型登记，每类至多一个实例），OnDestroy 自动注销；
    ///   - 实例化时 prefab 根默认激活即视为「已打开」；Open()/Close() 控制显隐并触发 OnOpen/OnClose 回调；
    ///   - 彻底移除用 UIManager.DestroyWindow（internal，项目内使用），Close 只隐藏、保留注册，可再 Open。
    ///
    /// 本类只做「窗口」通用行为（注册/显隐/回调），不创建任何 UI 节点：
    /// 视觉结构由各窗口 prefab 烘焙，子类负责绑定与状态切换。
    /// </summary>
    public abstract class UIWindow : MonoBehaviour
    {
        /// <summary>窗口注册键（默认 GameObject 名；登记用具体类型，一个类型至多一个实例）。</summary>
        public virtual string WindowId => gameObject != null ? gameObject.name : GetType().Name;

        /// <summary>当前是否已打开（根物体激活即视为打开）。</summary>
        public bool IsOpen => gameObject != null && gameObject.activeSelf;

        /// <summary>所属 UIManager（Awake 注册时回填；null 表示未注册，如非 UIManager 流程实例化）。</summary>
        public UIManager Manager { get; internal set; }

        protected virtual void Awake()
        {
            var manager = FindUIManager();
            if (manager != null)
            {
                manager.RegisterWindow(this);
            }
        }

        protected virtual void OnDestroy()
        {
            if (Manager != null)
            {
                Manager.UnregisterWindow(this);
            }
        }

        /// <summary>打开窗口：激活根物体并触发 OnOpen（幂等，已打开时仅触发回调）。</summary>
        public virtual void Open()
        {
            if (!IsOpen && gameObject != null)
            {
                gameObject.SetActive(true);
            }

            OnOpen();
        }

        /// <summary>关闭窗口：触发 OnClose 后隐藏根物体（实例与注册保留，可再 Open）。</summary>
        public virtual void Close()
        {
            OnClose();
            if (IsOpen && gameObject != null)
            {
                gameObject.SetActive(false);
            }
        }

        /// <summary>打开回调（子类覆写：进入界面时的初始化/刷新）。</summary>
        protected virtual void OnOpen() { }

        /// <summary>关闭回调（子类覆写：退出界面时的清理/停播）。</summary>
        protected virtual void OnClose() { }

        private static UIManager FindUIManager()
        {
            if (Game.Instance != null && Game.Instance.UIManager != null)
            {
                return Game.Instance.UIManager;
            }

            return Object.FindFirstObjectByType<UIManager>();
        }
    }
}