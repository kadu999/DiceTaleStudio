using UnityEngine;
using NuLight.ProjectionAlignment;

namespace DMGameLibrary.Hosting
{
    /// <summary>
    /// DiceTale 的 <see cref="IDMHostedGame"/> 实现，由
    /// <see cref="DiceTaleProjectionAdapter"/> 在装载时放进客场景，随场景卸载一起消失。
    /// 这是整个工程里唯一引用 <see cref="DiceTale.InputManager"/> 的地方。
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class DiceTaleHostedGame : MonoBehaviour, IDMHostedGame
    {
        public bool InputSuspended
        {
            get => DiceTale.InputManager.PointerSuspended;
            set => DiceTale.InputManager.PointerSuspended = value;
            //get => false;
            //set { }
        }

        /// <summary>托管时使用设备输入源，不读取模拟源的数字键。</summary>
        public bool KeyboardShortcutsEnabled { get; set; } = true;

        /// <summary>在客场景 Awake 之后、Start 之前覆盖开发用输入源。</summary>
        public void ConfigureInput(ProjectionVirtualTouchscreen touchscreen)
        {
            //foreach (var root in gameObject.scene.GetRootGameObjects())
            //{
            //    foreach (var manager in root.GetComponentsInChildren<DiceTale.InputManager>(true))
            //    {
            //        manager.InstallDevicePipeSource(touchscreen);
            //    }

            //    foreach (var debugUi in root.GetComponentsInChildren<DiceTale.SimulatedTouchDebugUI>(true))
            //    {
            //        debugUi.ShowDebugUi = false;
            //        debugUi.enabled = false;
            //    }
            //}
        }

        private void OnDestroy()
        {
            DiceTale.InputManager.PointerSuspended = false;
        }
    }
}
