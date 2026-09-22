using System.Collections;
using UnityEngine;
using UnityEngine.UI;

namespace DiceTale
{
    public class Game : MonoBehaviour
    {
        /// <summary>宿主实例：所有管理器（Backend/UI/Audio/Registry…）都挂在本组件所在物体，
        /// 随宿主一起销毁（本组件所在场景物体卸载即全部销毁，退出即清、重进可重建）。</summary>
        public static Game Instance { get; private set; }

        /// <summary>所有管理器统一由宿主 Game 初始化并持有（唯一入口，经 Game.Instance 访问），不再各自使用单例。
        /// 角色/玩家、后台对象注册、录音回放等管理器已随旧模型删除（见
        /// `client/docs/2026-09-19-unused-code-removal.md`）；
        /// <c>GameSceneManager</c> 也已在 2026-09-20 删除——场景内容由后台推送、由 <see cref="SceneMirror"/> 搭出来，
        /// 「按 Resources 预设加载场景」那条路已经没有资产可加载（脚本与资源一起删掉了）。</summary>
        public BackendManager BackendManager { get; private set; }
        public UIManager UIManager { get; private set; }
        public AudioPlayerManager AudioPlayerManager { get; private set; }

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
            // **音频管理器要在 BackendManager 之前**：后端那边装配命令路由时要拿到播放器
            // （命令一来就出声）。顺序反了的话 `Awake` 里那次取到的是 null——真机上就踩过一次：
            // `play_bgm` 回执写着「前端没有装配音频播放器」。
            // 命令路由本身也会在用到时再解析一次（见 `CommandRouter.Audio`），这里只是让首次装配就完整。
            AudioPlayerManager = GetOrCreateManager<AudioPlayerManager>();
            BackendManager = GetOrCreateManager<BackendManager>();
            UIManager = GetOrCreateManager<UIManager>();
        }

        private void OnDestroy()
        {
            if (Instance == this)
            {
                Instance = null; // 宿主销毁：清静态引用，重进场景可重建
            }
        }

        /// <summary>互动锁句柄：锁定期间 <see cref="CanInteract"/> 为假，输入层据此忽略按压。</summary>
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
    }
}
