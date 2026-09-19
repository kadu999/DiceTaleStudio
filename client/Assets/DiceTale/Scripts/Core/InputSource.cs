using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>一次指针按下（屏幕坐标 + 压力（0..1，Unity 源为固定值））。
    /// 按下事件只带屏幕坐标，世界坐标由消费侧（InputManager）经
    /// <see cref="PointerWorldConversion.ScreenToPlane"/> 统一换算。</summary>
    public struct PointerPress
    {
        /// <summary>指针 Id：取值见 <see cref="PointerId"/>。1..5 = 玩家编号（玩家 1..5，对应玩家索引 0..4）；
        /// 鼠标恒为 <see cref="PointerId.Mouse"/>（-1，非玩家指针）；6 = 拍照指针（非玩家）。
        /// 手指类指针（触摸/模拟手指/压板触点）按本帧按压顺序给玩家编号（第 k 个 → 玩家 k+1），
        /// 供消费者按 Id 追踪与映射玩家（<see cref="PointerIdExtensions.ToPlayerIndex(PointerId)"/>）。</summary>
        public PointerId Id;

        public Vector2 Screen;
        public float Pressure;
    }

    /// <summary>
    /// <see cref="PointerPress.Id"/> 的取值定义：1..5 = 玩家编号（玩家 1..5，对应玩家索引 0..4）；
    /// 0 = 未分配（预留）；-1 = 鼠标（单指针，非玩家）；6 = 拍照指针（相机快门，非玩家）；
    /// 7 = 多点触屏标记（仅用于 CommandId 设置，不是真实指针 Id）。
    /// 暂时用到 1..5 玩家区段、鼠标、拍照与 7 号多点标记，其余为将来预留。
    /// </summary>
    public enum PointerId
    {
        /// <summary>鼠标指针（单指针，非玩家）。</summary>
        Mouse = -1,

        /// <summary>未分配/占位（预留，当前无使用）。</summary>
        Unassigned = 0,

        /// <summary>玩家 1（玩家索引 0）。</summary>
        Player1 = 1,

        /// <summary>玩家 2（玩家索引 1）。</summary>
        Player2 = 2,

        /// <summary>玩家 3（玩家索引 2）。</summary>
        Player3 = 3,

        /// <summary>玩家 4（玩家索引 3）。</summary>
        Player4 = 4,

        /// <summary>玩家 5（玩家索引 4）。</summary>
        Player5 = 5,

        /// <summary>拍照指针（相机快门触发，非玩家）。</summary>
        Photo = 6,

        /// <summary>多点触屏标记（仅用于 <c>CommandId</c> 设置，非真实指针 Id）：
        /// 选中时压板源按全触点口径上报（MultiPointRegion / SurroundRegion 等多人玩法才可触发）。</summary>
        MultiTouch = 7,
    }

    /// <summary><see cref="PointerId"/> 的工具方法。</summary>
    public static class PointerIdExtensions
    {
        /// <summary>Id → 玩家索引（0 起）；非玩家 Id（鼠标/未分配/拍照/未定义值）返回 -1。</summary>
        public static int ToPlayerIndex(this PointerId id)
        {
            int value = (int)id;
            return value >= (int)PointerId.Player1 && value <= (int)PointerId.Player5 ? value - 1 : -1;
        }
    }

    /// <summary>
    /// 一帧输入采样：设备层原始输入 → 统一指针语义（世界坐标）。
    /// 由 InputSource 各方案填充，InputManager 只消费它做游戏逻辑，不碰设备。
    /// </summary>
    public class InputFrame
    {
        /// <summary>当前被按住的指针（世界坐标，全触点/全手指）。</summary>
        public readonly List<Vector3> PressedWorldPositions = new List<Vector3>();

        /// <summary>与 <see cref="PressedWorldPositions"/> 一一对应的压力值（0..1：
        /// 模拟源固定值 1，压板源取触点真实压力）。</summary>
        public readonly List<float> PressedPressures = new List<float>();

        /// <summary>与 <see cref="PressedWorldPositions"/> 一一对应的屏幕像素坐标
        /// （当前被按住的触点；供调试圆点等显示按需使用）。</summary>
        public readonly List<Vector2> PressedScreenPositions = new List<Vector2>();

        /// <summary>与 <see cref="PressedWorldPositions"/> 一一对应的指针 Id（玩家编号/拍照；
        /// 单点 v2 = <c>CommandId</c>；供调试圆点标注等按需使用）。</summary>
        public readonly List<PointerId> PressedIds = new List<PointerId>();

        /// <summary>本帧新按下的指针（Id + 屏幕 + 压力，按下顺序；世界坐标由消费侧换算）。</summary>
        public readonly List<PointerPress> NewlyPressed = new List<PointerPress>();

        /// <summary>新按下指针是否带有效屏幕坐标（UI 点击豁免需要屏幕坐标；为 false 时
        /// InputManager 会跳过逐点 UI 检查。各源自定：触屏/鼠标/模拟源为 true，压板源经
        /// 装置虚拟触摸屏同样取得有效屏幕坐标）。</summary>
        public bool ScreenPositionsAvailable;

        /// <summary>鼠标右键是否按住。</summary>
        public bool RightMouseHeld;

        /// <summary>鼠标右键当前世界坐标（未按住时无效）。</summary>
        public Vector3 RightMouseWorldPosition;

        public void Reset()
        {
            PressedWorldPositions.Clear();
            PressedPressures.Clear();
            PressedScreenPositions.Clear();
            PressedIds.Clear();
            NewlyPressed.Clear();
            ScreenPositionsAvailable = false;
            RightMouseHeld = false;
            RightMouseWorldPosition = Vector3.zero;
        }
    }

    /// <summary>
    /// 输入源抽象：不同输入方案（触摸屏/鼠标、投影虚拟触摸、未来其它设备/协议）统一产出
    /// <see cref="InputFrame"/>，供 InputManager 消费。输入与逻辑分离的接缝就在这一类。
    /// </summary>
    public abstract class InputSource
    {
        /// <summary>采样一帧输入写入 frame。suspended：宿主挂起（校正期）时不采样；
        /// pointerCamera：屏幕→世界换算用的相机（逻辑侧提供）。</summary>
        public abstract void Sample(InputFrame frame, bool suspended, Camera pointerCamera);
    }

    /// <summary>屏幕坐标 → 网格平面世界坐标的共用换算（GridMap.ScreenToPlane，无网格退化 y=0 平面）。
    /// 压板源与模拟源共用同一实现，保证两种方案落点口径一致。</summary>
    public static class PointerWorldConversion
    {
        public static Vector3 ScreenToPlane(Camera camera, Vector2 screenPosition)
        {
            var gridMap = Object.FindFirstObjectByType<GridMap>();
            if (gridMap != null)
            {
                return gridMap.ScreenToPlane(camera, screenPosition);
            }

            var plane = new Plane(Vector3.up, Vector3.zero);
            var ray = camera.ScreenPointToRay(screenPosition);
            return plane.Raycast(ray, out var distance) ? ray.GetPoint(distance) : Vector3.zero;
        }
    }
}
