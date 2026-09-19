using UnityEngine;
using UnityEngine.InputSystem;

namespace DiceTale
{
    /// <summary>
    /// 模拟多点触控输入源（编辑器联调/演示，不依赖任何真实设备或压板管线）：
    /// 用鼠标 + 数字键 1..6 模拟 6 个"指针位"（手指 0..4 = 玩家 1..5，手指 5 = 拍照 Id 6），
    /// 直接在输入帧层产出与 Unity 触摸/鼠标设备输入同构的指针输入——
    /// 屏幕坐标 → 网格平面世界坐标、<see cref="PointerId"/> 编号 Id（手指 f → Id f+1）、压力默认满压（<see cref="Pressure"/> 可配置）。
    /// 经 <see cref="Game"/> 的 inputSourceKind 开关在初始化时接入（或手动
    /// <c>InputManager.SetInputSource(new SimulatedTouchInputSource())</c> 替换设备输入）。
    ///
    /// 交互模型（按住=按下、弹起=抬起）：
    /// - 数字键 1..6 选择当前指针位（0..5：1..5 = 玩家 1..5，6 = 拍照），**切换不影响其它指针位的状态**；
    /// - 鼠标左键按下 = 当前指针位按下、落在鼠标位置；按住期间移动鼠标 = 该指针位跟手；
    /// - 切换指针位对齐鼠标此刻状态：按住中切 = 新指针位按下并跟手；没按住切 = 取消/抬起该指针位；
    /// - 鼠标弹起 = 当前指针位抬起（其它指针位保持按下）。
    ///
    /// 数字键在本源用于选指针位（非切玩家）；每帧触点按指针位编号序输出，Id = f+1（见 <see cref="PointerId"/>：
    /// 1..5 = 玩家编号、6 = 拍照指针），供"按 Id → 玩家"的多点移动消费。
    /// 右键默认同 Unity 设备输入透传（迷雾右键擦除等；<see cref="RightMousePassThrough"/> 可关以模拟压板无右键）。
    /// 本类只管输入；指针圆点等调试显示由 SimulatedTouchDebugUI 经 InputManager 的通用触点快照
    /// （<c>PressedScreenPositions</c>）绘制，也可读 <see cref="IsFingerDown"/> 等状态自行绘制。
    /// </summary>
    public class SimulatedTouchInputSource : InputSource
    {
        /// <summary>指针位数（0..FingerCount-1）：0..4 = 玩家 1..5，5 = 拍照指针（Id 6，见 <see cref="PointerId"/>）。</summary>
        public const int FingerCount = 6;

        /// <summary>模拟指针压力（0..1；默认满压 1，与 Unity 设备输入同量纲）。
        /// 压板源生产真实归一化压力，要对照压板口径时把本值改为压板 0..1 内的常量即可。</summary>
        public float Pressure = 1f;

        /// <summary>是否透传鼠标右键（迷雾右键擦除等）。默认开 = 与 Unity 设备输入一致（开发便利）；
        /// 关 = 模拟 <see cref="DevicePipeInputSource"/>（压板真机恒无右键）。</summary>
        public bool RightMousePassThrough = true;

        /// <summary>指针位选择键：主键盘 + 小键盘成对（1..5 = 玩家，6 = 拍照）。</summary>
        private static readonly Key[] SelectKeysMain =
        {
            Key.Digit1, Key.Digit2, Key.Digit3, Key.Digit4, Key.Digit5, Key.Digit6,
        };
        private static readonly Key[] SelectKeysNumpad =
        {
            Key.Numpad1, Key.Numpad2, Key.Numpad3, Key.Numpad4, Key.Numpad5, Key.Numpad6,
        };

        private readonly bool[] fingerDown = new bool[FingerCount];
        private readonly bool[] fingerWasDown = new bool[FingerCount];
        private readonly Vector2[] fingerScreen = new Vector2[FingerCount];
        private int activeFinger;

        /// <summary>当前活动手指（0..FingerCount-1），供调试显示等查询。</summary>
        public int ActiveFinger => activeFinger;

        /// <summary>某根手指当前是否按下（越界返回 false）。</summary>
        public bool IsFingerDown(int finger)
        {
            return finger >= 0 && finger < fingerDown.Length && fingerDown[finger];
        }

        /// <summary>某根手指当前屏幕坐标（仅按下时有效；越界返回零）。</summary>
        public Vector2 FingerScreenPosition(int finger)
        {
            return finger >= 0 && finger < fingerScreen.Length ? fingerScreen[finger] : Vector2.zero;
        }

        public override void Sample(InputFrame frame, bool suspended, Camera pointerCamera)
        {
            frame.Reset();
            frame.ScreenPositionsAvailable = true;
            if (suspended || pointerCamera == null)
            {
                return; // 挂起（投影校正期）不采样；模拟状态原地冻结
            }

            var keyboard = Keyboard.current;
            var mouse = Mouse.current;
            if (keyboard == null || mouse == null)
            {
                return;
            }

            // 1) 数字键 1..6 切换活动指针位；切换时按下状态对齐鼠标此刻（其它指针位保持不动）
            for (int i = 0; i < FingerCount; i++)
            {
                if (!keyboard[SelectKeysMain[i]].wasPressedThisFrame
                    && !keyboard[SelectKeysNumpad[i]].wasPressedThisFrame)
                {
                    continue;
                }

                if (mouse.leftButton.isPressed)
                {
                    fingerDown[i] = true;
                    fingerScreen[i] = mouse.position.ReadValue();
                }
                else if (fingerDown[i])
                {
                    fingerDown[i] = false; // 没按住切 = 取消/抬起该手指
                }

                activeFinger = i;
            }

            // 2) 鼠标左键控制活动手指：按下=落点 / 按住=跟手 / 弹起=抬起
            if (mouse.leftButton.wasPressedThisFrame)
            {
                fingerDown[activeFinger] = true;
                fingerScreen[activeFinger] = mouse.position.ReadValue();
            }
            else if (mouse.leftButton.wasReleasedThisFrame)
            {
                fingerDown[activeFinger] = false;
            }
            else if (mouse.leftButton.isPressed)
            {
                fingerScreen[activeFinger] = mouse.position.ReadValue();
            }

            // 3) 组装输入帧：按下的手指按编号序输出（世界坐标 + Pressure 压力；新按下的带 Id 触发边沿）
            float pressure = Pressure;
            for (int f = 0; f < FingerCount; f++)
            {
                if (!fingerDown[f])
                {
                    fingerWasDown[f] = false;
                    continue;
                }

                Vector2 screen = fingerScreen[f];
                Vector3 world = PointerWorldConversion.ScreenToPlane(pointerCamera, screen);
                frame.PressedWorldPositions.Add(world);
                frame.PressedPressures.Add(pressure);
                frame.PressedScreenPositions.Add(screen);
                frame.PressedIds.Add((PointerId)(f + 1));
                if (!fingerWasDown[f])
                {
                    // Id = f+1：手指 0..4 = 玩家 1..5；手指 5 = 编号 6 = 拍照指针（PointerId.Photo）
                    frame.NewlyPressed.Add(new PointerPress { Id = (PointerId)(f + 1), Screen = screen, Pressure = pressure });
                }

                fingerWasDown[f] = true;
            }

            // 4) 鼠标右键透传（迷雾右键擦除等系统经 InputManager 查询；同设备源）。
            //    默认开（开发便利）；关 = 模拟压板源的"无右键"（真机恒无，见 RightMousePassThrough）
            if (RightMousePassThrough)
            {
                frame.RightMouseHeld = mouse.rightButton.isPressed;
                if (frame.RightMouseHeld)
                {
                    frame.RightMouseWorldPosition = PointerWorldConversion.ScreenToPlane(pointerCamera, mouse.position.ReadValue());
                }
            }
        }
    }
}