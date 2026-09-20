using System.Collections.Generic;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace DiceTale
{
    /// <summary>
    /// 输入逻辑管理器：消费 <see cref="InputSource"/> 产出的统一输入帧（<see cref="InputFrame"/>），
    /// 对外提供统一状态（<see cref="PressedWorldPositions"/> / 右键）供各系统查询。
    /// **输入采集与逻辑分离**：本类不直接采样设备（触摸/鼠标/键盘都在输入源里），
    /// 后续接入其它输入方案只需实现 <see cref="InputSource"/> 并 <see cref="SetInputSource"/>。
    ///
    /// 目前这一层只剩「纯显示响应」（拍照指针点光）与 UI 点击豁免：点击区域触发、按玩家编号移动
    /// 都属「前端拥有游戏逻辑」的旧模型，已随旧协议删除。新协议落地后，这里应当把按下事件
    /// 上报后台，由后台决定发生什么。
    /// </summary>
    public class InputManager : MonoBehaviour
    {
        /// <summary>指针挂起：投影装置在宿主校正期间置真；挂起时忽略所有输入。单机恒为假。</summary>
        public static bool PointerSuspended { get; set; }

        /// <summary>当前被按住的指针【世界坐标】快照（全触点/全手指，网格平面）。
        /// 由输入源每帧采样产出；挂起时为空。将来要做「多点同时按住」类玩法
        /// （如多点区域判定）就拿它当统一输入接口，不必再采样设备。</summary>
        public static IReadOnlyList<Vector3> PressedWorldPositions => pressedWorldPositions;

        /// <summary>与 <see cref="PressedWorldPositions"/> 一一对应的压力值（0..1：
        /// 模拟输入源为固定值 1，压板设备输入源为触点真实压力）。</summary>
        public static IReadOnlyList<float> PressedPressures => pressedPressures;

        /// <summary>与 <see cref="PressedWorldPositions"/> 一一对应的屏幕像素坐标快照
        /// （当前被按住的触点；调试圆点等显示经此读取，不依赖具体输入源类型）。</summary>
        public static IReadOnlyList<Vector2> PressedScreenPositions => pressedScreenPositions;

        /// <summary>与 <see cref="PressedWorldPositions"/> 一一对应的指针 Id 快照
        /// （玩家编号/拍照；调试圆点标注等经此读取）。</summary>
        public static IReadOnlyList<PointerId> PressedIds => pressedIds;

        /// <summary>鼠标右键是否按住（只认鼠标）。挂起时恒假。
        /// 战争雾已经改成由后台命令驱动（不再有本地的右键擦除），这里只作为通用输入快照留着。</summary>
        public static bool IsRightMouseHeld => rightMouseHeld;

        [SerializeField]
        private Camera playerCamera;

        private readonly InputFrame frame = new InputFrame();
        private InputSource inputSource = new SimulatedTouchInputSource();

        private static readonly List<Vector3> pressedWorldPositions = new List<Vector3>();
        private static readonly List<float> pressedPressures = new List<float>();
        private static readonly List<Vector2> pressedScreenPositions = new List<Vector2>();
        private static readonly List<PointerId> pressedIds = new List<PointerId>();
        private static bool rightMouseHeld;
        private static Vector3 rightMouseWorldPosition;

        private static readonly List<RaycastResult> uiRaycastResults = new List<RaycastResult>();

        /// <summary>替换输入方案（后续接入其它输入设备/协议时调用；null 忽略，保留现方案）。</summary>
        public void SetInputSource(InputSource source)
        {
            if (source != null)
            {
                inputSource = source;
            }
        }

        /// <summary>当前安装的输入方案（调试 UI 等经此取回实例）。</summary>
        public InputSource CurrentInputSource => inputSource;

        /// <summary>
        /// 输入源方案（初始化统一走 <see cref="InstallInputSource"/>，切版本只改这一个开关）：
        /// <see cref="SimulatedTouch"/>=鼠标+数字键 1..6 模拟触点；<see cref="PipeSource"/>=压板 v1 全触点顺序编号；
        /// </summary>
        public enum InputSourceKind
        {
            SimulatedTouch,
            PipeSource,
        }

        /// <summary>按方案安装输入源（所有入口统一走这里；touchscreen 仅压板源用，可空自动查找）。</summary>
        public void InstallInputSource(InputSourceKind kind)
        {
            SetInputSource(CreateSource(kind));
        }

        /// <summary>按方案创建输入源实例（初始化的唯一工厂，切换版本只改调用方传的 <paramref name="kind"/>）。</summary>
        public static InputSource CreateSource(InputSourceKind kind)
        {
            switch (kind)
            {
                case InputSourceKind.SimulatedTouch:
                    return new SimulatedTouchInputSource();
                case InputSourceKind.PipeSource:
                    return new DevicePipeInputSource2
                    {
                        // 重启/场景重载后恢复 GM 上次设置的指挥 Id（与后台"断开不清配置"配合，前后端一致）
                        CommandId = InputConfigPrefs.LoadCommandId(),
                    };
                default:
                    Debug.LogWarning($"[InputManager] 未识别的输入源方案 {kind}，退回模拟源。");
                    return new SimulatedTouchInputSource();
            }
        }

        /// <summary>安装压板设备输入源（v1），与装置的 UI 事件共用虚拟触摸屏；不依赖地图加载时机。
        /// 保留兼容入口，实际走 <see cref="InstallInputSource"/>。</summary>
        public void InstallDevicePipeSource()
        {
            InstallInputSource(InputSourceKind.PipeSource);
        }

        /// <summary>取鼠标右键当前【世界坐标】（网格平面）；右键未按住或挂起时返回 false。</summary>
        public bool TryGetRightMouseWorldPosition(out Vector3 worldPosition)
        {
            if (!rightMouseHeld)
            {
                worldPosition = Vector3.zero;
                return false;
            }

            worldPosition = rightMouseWorldPosition;
            return true;
        }

        private void Update()
        {
            // 1) 输入采集（设备层）：各种方案统一产出输入帧；挂起时不采样
            inputSource.Sample(frame, PointerSuspended, GetPointerCamera());

            // 2) 输入解释：对外统一状态快照（供各系统查询）
            pressedWorldPositions.Clear();
            pressedWorldPositions.AddRange(frame.PressedWorldPositions);
            pressedPressures.Clear();
            pressedPressures.AddRange(frame.PressedPressures);
            pressedScreenPositions.Clear();
            pressedScreenPositions.AddRange(frame.PressedScreenPositions);
            pressedIds.Clear();
            pressedIds.AddRange(frame.PressedIds);
            rightMouseHeld = frame.RightMouseHeld;
            rightMouseWorldPosition = frame.RightMouseWorldPosition;

            // 3) 游戏逻辑
            if (PointerSuspended)
            {
                return;
            }

            var game = Game.Instance;
            if (game == null || !game.CanInteract)
            {
                return;
            }

            // 点击/移动的解耦说明已成历史：点击区域触发与按玩家编号移动都随旧模型删除，
            // 现在按下事件只用来做显示响应（拍照点光）；新协议落地后这里改为上报后台。
            if (frame.NewlyPressed.Count == 0)
            {
                return;
            }

            for (int k = 0; k < frame.NewlyPressed.Count; k++)
            {
                var pointerPress = frame.NewlyPressed[k];

                // 点击 UI（玩家切换按钮等）时不处理；仅输入源声明带屏幕坐标时检查（未声明则跳过）
                if (frame.ScreenPositionsAvailable && IsPointerOverUI(pointerPress.Screen))
                {
                    // 真机联调诊断：按压被 UI 豁免吞掉时打一条，便于区分"豁免生效"与"触点丢失"
                    Debug.Log($"[Input] f={Time.frameCount} 按压被 UI 豁免吞掉 Id={pointerPress.Id} screen={pointerPress.Screen}");
                    continue;
                }

                // 按下事件只带屏幕坐标：与输入源一样，经当前相机投到当前地图平面。
                Vector3 pressWorld = PointerWorldConversion.ScreenToPlane(GetPointerCamera(), pointerPress.Screen);

                // 拍照指针：点击处发光（位置跟随点击点，参考 Scene002/Photograps/Photograph02 点光预设）
                if (pointerPress.Id == PointerId.Photo && game.PhotoClickGlow != null)
                {
                    game.PhotoClickGlow.ShowAt(pressWorld);
                }
            }
        }

        /// <summary>指针投影相机：串行 playerCamera，退化为 Camera.main。</summary>
        private Camera GetPointerCamera()
        {
            return playerCamera != null ? playerCamera : Camera.main;
        }

        /// <summary>指针是否落在 uGUI 上。只认 <see cref="GraphicRaycaster"/> 的命中（用系统
        /// IsPointerOverGameObject 会把 3D 碰撞体也算成 UI）。</summary>
        private static bool IsPointerOverUI(Vector2 screenPosition)
        {
            var events = EventSystem.current;
            if (events == null)
            {
                return false;
            }

            var pointerData = new PointerEventData(events) { position = screenPosition };
            uiRaycastResults.Clear();
            events.RaycastAll(pointerData, uiRaycastResults);

            for (int index = 0; index < uiRaycastResults.Count; index++)
            {
                if (uiRaycastResults[index].module is GraphicRaycaster)
                {
                    return true;
                }
            }

            return false;
        }
    }
}
