using UnityEngine;
using UnityEngine.InputSystem;

namespace DiceTale
{
    /// <summary>
    /// 压板设备输入源 v2：消费装置生成的虚拟触摸屏，与 uGUI 共用相机全画面的像素坐标。
    /// 行为由 <see cref="CommandId"/> 决定（见字段注释）：
    ///   - 单点指挥（默认 / 玩家 1..5 / 拍照）：每帧只认**压力最大的触点**，不允许同帧触发多个点；
    ///   - 多点触屏（= <see cref="PointerId.MultiTouch"/> 标记）：按全触点口径上报所有按压触点，
    ///     Id 按按压顺序编号——只有这个模式才拿得到「多点同时按住」的全部触点。
    /// 装置仍负责坐标映射、触点跟踪和校正取消；游戏只把屏幕坐标投到当前地图平面。
    /// </summary>
    public class DevicePipeInputSource2 : InputSource
    {
        /// <summary>宿主的虚拟触摸屏；未指定时自动查找，支持装置稍后加载。</summary>
        //public ProjectionVirtualTouchscreen ProjectionTouchscreen { get; set; }

        /// <summary>指挥 Id（CommandId，本类行为开关，GM set_input_config 下发、PlayerPrefs 持久化）：
        /// 单点指挥（Unassigned 0 / 玩家 1..5 / 拍照 6）：每帧只上报压力最大触点，其 Id = 本值
        /// （0=未分配、1..5=对应玩家、6=拍照）；<see cref="PointerId.MultiTouch"/>（7）= 多点触屏：
        /// 上报全部按压触点、Id 按按压顺序编号——多点/包围区域只在此模式下触发。
        /// 本字段只在本类（DevicePipeInputSource2）存在；其余输入源一律按顺序编号，无此字段。</summary>
        public PointerId CommandId = PointerId.Unassigned;

        /// <summary>新按下时打印装置像素坐标、游戏世界坐标与实际压力。</summary>
        public bool LogDiagnostics = true;

        private string lastWarning;

        public override void Sample(InputFrame frame, bool suspended, Camera pointerCamera)
        {
            //frame.Reset();
            //frame.ScreenPositionsAvailable = true;
            //if (suspended)
            //{
            //    return;
            //}

            //if (ProjectionTouchscreen == null)
            //{
            //    ProjectionTouchscreen = Object.FindFirstObjectByType<ProjectionVirtualTouchscreen>();
            //}

            //if (ProjectionTouchscreen == null || !ProjectionTouchscreen.isActiveAndEnabled)
            //{
            //    WarnOnce("缺少启用的 ProjectionVirtualTouchscreen。请从 DMGameLibraryProjection 进入 Demo；独立调试请启用模拟输入。");
            //    return;
            //}

            //// 校正取消事件可能还在 Input System 队列中，不能继续消费上一帧的按压。
            //if (ProjectionTouchscreen.Suspended)
            //{
            //    return;
            //}

            //var device = ProjectionTouchscreen.Device;
            //if (device == null || !device.added)
            //{
            //    WarnOnce("投影装置的虚拟触摸屏尚未就绪。");
            //    return;
            //}

            //if (pointerCamera == null)
            //{
            //    WarnOnce("缺少游戏指针相机，无法把压感触点转换到地图平面。");
            //    return;
            //}

            //lastWarning = null;
            //// 多点触屏标记：全触点口径（多人多点玩法需要多点）；否则单点指挥（只认压力最大触点）
            //if (CommandId == PointerId.MultiTouch)
            //{
            //    SampleMultiTouch(frame, pointerCamera, device);
            //    return;
            //}

            //// 单点指挥：只读宿主拥有的设备（Touchscreen.current 可能被其它触屏抢占），
            //// 在全部按压触点里选压力最大的那个；同时按下多点也只这一个进入输入帧，
            //// 不允许同帧触发多个点。
            //var touches = device.touches;
            //int bestIndex = -1;
            //float bestPressure = 0f;
            //for (int i = 0; i < touches.Count; i++)
            //{
            //    var touch = touches[i];
            //    if (!touch.press.isPressed)
            //    {
            //        continue;
            //    }

            //    float pressure = Mathf.Clamp01(touch.pressure.ReadValue());
            //    if (bestIndex < 0 || pressure > bestPressure)
            //    {
            //        bestIndex = i;
            //        bestPressure = pressure;
            //    }
            //}

            //if (bestIndex < 0)
            //{
            //    return;
            //}

            //var selected = touches[bestIndex];
            //// Id 由 CommandId 控制：设为 1..5 / Photo 即固定为对应玩家/拍照指针。
            //PointerId pressId = CommandId;
            //Vector2 screen = selected.position.ReadValue();
            //Vector3 world = PointerWorldConversion.ScreenToPlane(pointerCamera, screen);
            //frame.PressedWorldPositions.Add(world);
            //frame.PressedPressures.Add(bestPressure);
            //frame.PressedScreenPositions.Add(screen);
            //frame.PressedIds.Add(pressId);

            //if (!selected.press.wasPressedThisFrame)
            //{
            //    return;
            //}

            //frame.NewlyPressed.Add(new PointerPress { Id = pressId, Screen = screen, Pressure = bestPressure });

            //if (LogDiagnostics)
            //{
            //    Debug.Log($"[DevicePipe] f={Time.frameCount} Id={pressId} screen={screen:F1} world={world:F3} P={bestPressure:F2}");
            //}
        }

        /// <summary>多点触屏口径：上报全部按压触点（Id 按本帧按压顺序编号 1..N）——
        /// 只有这个模式才拿得到「多点同时按住」的全部触点。</summary>
        private void SampleMultiTouch(InputFrame frame, Camera pointerCamera, Touchscreen device)
        {
            var touches = device.touches;
            int pressedOrder = 0;
            for (int i = 0; i < touches.Count; i++)
            {
                var touch = touches[i];
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
                if (touch.press.wasPressedThisFrame)
                {
                    frame.NewlyPressed.Add(new PointerPress { Id = (PointerId)pressedOrder, Screen = screen, Pressure = pressure });
                }

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