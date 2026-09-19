using UnityEngine;
using NuLight.ProjectionAlignment;

namespace DiceTale
{
    /// <summary>
    /// 压板设备输入源：消费装置生成的虚拟触摸屏，与 uGUI 共用相机全画面的像素坐标。
    /// 装置负责坐标映射、触点跟踪和校正取消；游戏只把屏幕坐标投到当前地图平面。
    /// 玩家编号沿用输入帧约定：本帧第 k 个按住的触点对应玩家 k，无鼠标或键盘透传。
    /// </summary>
    public class DevicePipeInputSource : InputSource
    {
        /// <summary>宿主的虚拟触摸屏；未指定时自动查找，支持装置稍后加载。</summary>
        public ProjectionVirtualTouchscreen ProjectionTouchscreen { get; set; }

        /// <summary>新按下时打印装置像素坐标、游戏世界坐标与实际压力。</summary>
        public bool LogDiagnostics = true;

        private string lastWarning;

        public override void Sample(InputFrame frame, bool suspended, Camera pointerCamera)
        {
            frame.Reset();
            frame.ScreenPositionsAvailable = true;
            if (suspended)
            {
                return;
            }

            if (ProjectionTouchscreen == null)
            {
                ProjectionTouchscreen = Object.FindFirstObjectByType<ProjectionVirtualTouchscreen>();
            }

            if (ProjectionTouchscreen == null || !ProjectionTouchscreen.isActiveAndEnabled)
            {
                WarnOnce("缺少启用的 ProjectionVirtualTouchscreen。请从 DMGameLibraryProjection 进入 Demo；独立调试请启用模拟输入。");
                return;
            }

            // 校正取消事件可能还在 Input System 队列中，不能继续消费上一帧的按压。
            if (ProjectionTouchscreen.Suspended)
            {
                return;
            }

            var device = ProjectionTouchscreen.Device;
            if (device == null || !device.added)
            {
                WarnOnce("投影装置的虚拟触摸屏尚未就绪。");
                return;
            }

            if (pointerCamera == null)
            {
                WarnOnce("缺少游戏指针相机，无法把压感触点转换到地图平面。");
                return;
            }

            lastWarning = null;
            int pressedOrder = 0;
            // 只读宿主拥有的设备：Touchscreen.current 可能被其它触屏抢占。
            foreach (var touch in device.touches)
            {
                if (!touch.press.isPressed)
                {
                    continue;
                }

                pressedOrder++;
                Vector2 screen = touch.position.ReadValue();
                Vector3 world = PointerWorldConversion.ScreenToPlane(pointerCamera, screen);
                float pressure = Mathf.Clamp01(touch.pressure.ReadValue());
                frame.PressedWorldPositions.Add(world);
                frame.PressedPressures.Add(pressure);
                frame.PressedScreenPositions.Add(screen);
                frame.PressedIds.Add((PointerId)pressedOrder);

                if (!touch.press.wasPressedThisFrame)
                {
                    continue;
                }

                frame.NewlyPressed.Add(new PointerPress { Id = (PointerId)pressedOrder, Screen = screen, Pressure = pressure });

                if (LogDiagnostics)
                {
                    Debug.Log($"[DevicePipe] f={Time.frameCount} Id={(PointerId)pressedOrder} screen={screen:F1} world={world:F3} P={pressure:F2}");
                }
            }
        }

        private void WarnOnce(string message)
        {
            if (lastWarning == message)
            {
                return;
            }

            lastWarning = message;
            Debug.LogWarning($"[DevicePipe] {message}");
        }
    }
}
