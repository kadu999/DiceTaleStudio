using System.Collections;
using UnityEngine;
using UnityEngine.UI;

namespace DiceTale
{
    public class Game : MonoBehaviour
    {
        [Header("输入源")]
        [Tooltip("输入方案（初始化统一在 InputManager.InstallInputSource，切版本只改这里）：\n" +
            "SimulatedTouch=鼠标+数字键 1..6 模拟触点（开发）；PipeSource=压板 v1 全触点顺序编号；\n" +
            "PipeSource2=压板 v2 单点指挥（只触发压力最大点，Id 由 CommandId 控制）。")]
        [SerializeField] private InputManager.InputSourceKind inputSourceKind = InputManager.InputSourceKind.SimulatedTouch;

        /// <summary>宿主实例：所有管理器（Character/Input/Scene/Backend/UI/Registry）都挂在本组件所在物体，
        /// 随宿主一起销毁（本组件所在场景物体卸载即全部销毁，退出即清、重进可重建）。</summary>
        public static Game Instance { get; private set; }

        /// <summary>所有管理器统一由宿主 Game 初始化并持有（唯一入口，经 Game.Instance 访问），不再各自使用单例。</summary>
        public CharacterManager CharacterManager { get; private set; }
        public InputManager InputManager { get; private set; }
        public GameSceneManager GameSceneManager { get; private set; }
        public BackendManager BackendManager { get; private set; }
        public BackendRegistry BackendRegistry { get; private set; }
        public UIManager UIManager { get; private set; }
        public PlayerMoveManager PlayerMoveManager { get; private set; }
        public AudioPlayerManager AudioPlayerManager { get; private set; }
        public RecordingManager RecordingManager { get; private set; }
        public ReplayClient ReplayClient { get; private set; }
        public PhotoClickGlow PhotoClickGlow { get; private set; }

        /// <summary>后台 WebSocket 连接（由 BackendManager 创建并持有；未创建/已销毁时为 null）。</summary>
        public Server.ServerConnection ServerConnection =>
            BackendManager != null ? BackendManager.Connection : null;

        public bool CanInteract { get; private set; } = true;

        private void Awake()
        {
            if (Instance != null && Instance != this)
            {
                // 宿主已有且不是本组件：场景里出现重复 Game（一般不该有），只销毁多余的自身组件，
                // 避免 Destroy(gameObject) 把真正的宿主整根带走（与其他管理器守卫一致）
                Destroy(this);
                return;
            }

            Instance = this;
            // 初始化并持有全部管理器：所有管理器都挂在宿主物体上（GetOrCreateManager 找到即用、
            // 没有则挂一个），经 Game.Instance.X 访问
            CharacterManager = GetOrCreateManager<CharacterManager>();
            InputManager = GetOrCreateManager<InputManager>();
            InitializeInputSource(); // 输入方案：按开关装模拟源或压板设备源
            GameSceneManager = GetOrCreateManager<GameSceneManager>();
            BackendManager = GetOrCreateManager<BackendManager>();
            BackendRegistry = GetOrCreateManager<BackendRegistry>();
            UIManager = GetOrCreateManager<UIManager>();
            PlayerMoveManager = GetOrCreateManager<PlayerMoveManager>();
            AudioPlayerManager = GetOrCreateManager<AudioPlayerManager>();
            // 录音管理器：随宿主创建开启本局录音文件夹（一局开始），随宿主销毁停止收尾（一局结束）
            RecordingManager = GetOrCreateManager<RecordingManager>();
            // Replay 客户端：开局创建唯一 sessionId，上传录音分段、触发小说生成
            ReplayClient = GetOrCreateManager<ReplayClient>();
            // 拍照点击发光：拍照指针点地时点击处点光闪烁（参考 Scene002 Photograph02 预设）
            PhotoClickGlow = GetOrCreateManager<PhotoClickGlow>();
        }

        private void OnDestroy()
        {
            if (Instance == this)
            {
                Instance = null; // 宿主销毁：清静态引用，重进场景可重建
            }
        }

        /// <summary>开始场景人数选择 UI（StartSceneUI）的加载/卸载已移交场景脚本 Game000，Game 不再持有。</summary>
        private Coroutine unlockRoutine;

        public void LockInteraction(float duration)
        {
            CanInteract = false;
            if (unlockRoutine != null)
            {
                // 缓存句柄停止：StartCoroutine(方法调用) 启动的协程用 StopCoroutine(string)
                // 停止存在版本差异（Unity 2022.2+ 该重载已 Obsolete），句柄停止最可靠，
                // 避免连续锁定时叠加多个解锁协程、交互锁被最早完成的旧协程提前释放
                StopCoroutine(unlockRoutine);
            }

            unlockRoutine = StartCoroutine(UnlockInteractionAfter(duration));
        }

        private IEnumerator UnlockInteractionAfter(float duration)
        {
            yield return new WaitForSeconds(duration);
            CanInteract = true;
            unlockRoutine = null;
        }

        private T GetOrCreateManager<T>() where T : MonoBehaviour
        {
            // 管理器一律只挂在本组件所在物体上：与宿主共存亡，场景卸载即全部销毁，重进可重建；
            // 不找场景里游离的管理器（本方案下不应存在），避免生命周期不跟着宿主走
            var manager = GetComponent<T>();
            if (manager != null)
            {
                return manager;
            }

            return gameObject.AddComponent<T>();
        }

        /// <summary>按场景开关安装输入方案（统一走 InputManager.InstallInputSource；切换版本改
        /// <c>inputSourceKind</c> 一处即可）。</summary>
        private void InitializeInputSource()
        {
            InputManager.InstallInputSource(inputSourceKind);
        }
    }
}
