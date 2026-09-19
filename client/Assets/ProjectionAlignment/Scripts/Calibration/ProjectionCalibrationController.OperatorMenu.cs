using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.SceneManagement;

namespace NuLight.ProjectionAlignment
{
    public enum ProjectionOperatorPage { Home, Calibration, Picture, Pressure, Props, Recording, Display, PressureTest }

    /// <summary>Screen-space operator UI owned by the projection rig, never by a hosted game.</summary>
    public sealed partial class ProjectionCalibrationController
    {
        public event Action DrawOperatorSessionControls;
        public Func<bool> ResumeOperatorPreview { get; set; }
        public ProjectionOperatorPage OperatorPage { get; private set; }
        public int OperatorRingPage { get; private set; }
        public static int OperatorRingPageCount => (OperatorTitles.Length - 1 + 5) / 6;
        public bool OperatorHeatmapVisible => showOperatorHeatmap;
        public bool OperatorDiagnosticsVisible => showDiagnostics;
        public bool OperatorInputBlocked => showOperatorUi || OperatorModalOpen || operatorAwaitPressureRelease || Time.frameCount <= lastOperatorCloseFrame + 1;
        public bool OperatorOutputBorderVisible => showOperatorOutputBorder;
        public void SetOperatorOutputBorderVisible(bool value) => showOperatorOutputBorder = value;

        private int lastOperatorCloseFrame = -10;
        private bool showOperatorHeatmap;
        private bool operatorCursorOwned;
        private bool savedCursorVisible;
        private CursorLockMode savedCursorLock;
        private bool confirmCalibrationReset;
        private bool operatorDirectionsExpanded;
        private bool operatorSimulationExpanded;
        private Vector2 operatorScroll;
        private GUISkin operatorSkin;
        private Font operatorFont;
        private GUIStyle operatorTitle, operatorCaption, operatorSectorLabel, operatorCenterLabel;
        private GUIStyle operatorPrimary, operatorDanger;
        private readonly List<Texture2D> operatorTextures = new List<Texture2D>();
        private readonly Texture2D[] operatorSectors = new Texture2D[6];
        private readonly Dictionary<string, string> operatorNumbers = new Dictionary<string, string>();
        private Texture2D operatorCircle;
        private int operatorPressedSector = -1;
        private ProjectionSceneLookSwitcher operatorLookSwitcher;
        private static readonly string[] OperatorTitles = { "主环", "投影校正", "画面调整", "压力板", "实物上色", "录像相机", "显示诊断", "压感测试" };
        private static readonly string[] OperatorHints = { "", "采集 · 重置", "尺寸 · 位移", "方向 · 接缝", "镜头 · 验证", "相机 · CV", "输出 · 诊断", "频率 · 漏按" };
        private static readonly Color OperatorBackground = new Color(0.045f, 0.073f, 0.085f, 1f);
        private static readonly Color OperatorSurface = new Color(0.08f, 0.13f, 0.15f, 1f);
        private static readonly Color OperatorRaised = new Color(0.13f, 0.21f, 0.24f, 1f);
        private static readonly Color OperatorAccent = new Color(0.49f, 0.91f, 0.76f, 1f);
        private static readonly Color OperatorText = new Color(0.91f, 0.96f, 0.94f, 1f);
        private static readonly Color OperatorMuted = new Color(0.63f, 0.76f, 0.76f, 1f);

        public void SetOperatorHeatmapVisible(bool visible)
        {
            showOperatorHeatmap = visible;
            if (operatorCanvases == null) CollectOperatorCanvases();
            foreach (Canvas canvas in operatorCanvases)
                if (canvas != null) canvas.enabled = visible;
        }

        public void SetOperatorDiagnosticsVisible(bool visible) => showDiagnostics = visible;

        private void DrawStandaloneOperatorDiagnostics()
        {
            if (!showDiagnostics || showOperatorUi || OperatorModalOpen) return;
            EnsureOperatorResources();
            Matrix4x4 oldMatrix = GUI.matrix;
            GUISkin oldSkin = GUI.skin;
            Color oldColor = GUI.color;
            int oldDepth = GUI.depth;
            try
            {
                GUI.depth = -11000;
                GUI.color = Color.white;
                GUI.skin = operatorSkin;
                float scale = Mathf.Max(0.1f, Mathf.Min(1.2f, Screen.width / 1100f, Screen.height / 850f));
                GUI.matrix = Matrix4x4.Scale(new Vector3(scale, scale, 1f));
                // A read-only HUD: no opening button, mouse capture or game-input suspension.
                GUILayout.BeginArea(new Rect(16f, 16f, 400f, Screen.height / scale - 32f));
                GUILayout.BeginVertical(operatorSkin.box);
                GUILayout.Label("压力板实时诊断", operatorTitle);
                DrawOperatorDiagnostics();
                GUILayout.EndVertical();
                GUILayout.EndArea();
            }
            finally
            {
                GUI.matrix = oldMatrix;
                GUI.skin = oldSkin;
                GUI.color = oldColor;
                GUI.depth = oldDepth;
            }
        }

        public void SelectOperatorPage(ProjectionOperatorPage page)
        {
            // Navigation can never be used as a second way to summon the menu.
            if (!showOperatorUi || OperatorModalOpen) return;
            if (page < ProjectionOperatorPage.Home || (int)page >= OperatorTitles.Length) return;
            operatorPressurePointer.Reset();
            if (page != ProjectionOperatorPage.PressureTest) StopPressureTest("已离开测试页，本轮提前结束。");
            OperatorPage = page;
            if (page != ProjectionOperatorPage.Home) OperatorRingPage = ((int)page - 1) / 6;
            if (pressureInput != null && pressureInput.SimulationSource != null)
                pressureInput.SimulationSource.SetOperatorPressed(false);
            operatorScroll = Vector2.zero;
            confirmCalibrationReset = false;
            operatorNumbers.Clear();
            GUIFocusClear();
        }

        public static ProjectionOperatorPage OperatorPageForSector(int ringPage, int sector)
        {
            int index = ringPage * 6 + sector + 1;
            return ringPage >= 0 && ringPage < OperatorRingPageCount && sector >= 0 && sector < 6
                && index < OperatorTitles.Length ? (ProjectionOperatorPage)index : ProjectionOperatorPage.Home;
        }

        public void ChangeOperatorRingPage(int direction)
        {
            if (!showOperatorUi || OperatorModalOpen) return;
            SelectOperatorPage(ProjectionOperatorPage.Home);
            OperatorRingPage = (OperatorRingPage + direction % OperatorRingPageCount + OperatorRingPageCount) % OperatorRingPageCount;
            operatorPressedSector = -1;
        }

        private static void GUIFocusClear()
        {
            // GUI.FocusControl is only legal during OnGUI; Update also handles H / Esc.
            if (Event.current != null) GUI.FocusControl(null);
        }

        private void ResetOperatorNavigation()
        {
            OperatorPage = ProjectionOperatorPage.Home;
            operatorPressurePointer.Reset();
            OperatorRingPage = 0;
            operatorScroll = Vector2.zero;
            confirmCalibrationReset = false;
            operatorPressedSector = -1;
            operatorNumbers.Clear();
        }

        private bool HandleOperatorMenuKeyboard(Keyboard keyboard)
        {
            if (keyboard.hKey.wasPressedThisFrame)
            {
                if (OperatorModalOpen && ResumeOperatorPreview != null && ResumeOperatorPreview()) return true;
                SetOperatorUiVisible(!showOperatorUi);
                return true;
            }
            // A child window closing this frame consumes Esc before the parent can go back again.
            if (OperatorModalOpen || Time.frameCount <= lastOperatorCloseFrame + 1) return true;
            if (!showOperatorUi) return false;
            if (keyboard.pageDownKey.wasPressedThisFrame) ChangeOperatorRingPage(1);
            if (keyboard.pageUpKey.wasPressedThisFrame) ChangeOperatorRingPage(-1);
            if (keyboard.escapeKey.wasPressedThisFrame)
            {
                if (OperatorPage == ProjectionOperatorPage.Home) SetOperatorUiVisible(false);
                else SelectOperatorPage(ProjectionOperatorPage.Home);
            }
            return true;
        }

        private void SyncOperatorInput()
        {
            if (virtualTouchscreen != null) virtualTouchscreen.SetSuspended(sessionActive || OperatorInputBlocked);
            if (pressureInput != null && pressureInput.SimulationSource != null)
            {
                pressureInput.SimulationSource.SetOperatorControl(OperatorInputBlocked);
                if (!showOperatorUi || OperatorModalOpen)
                    pressureInput.SimulationSource.SetOperatorPressed(false);
            }
            if (showOperatorUi || OperatorModalOpen)
            {
                Cursor.lockState = CursorLockMode.None;
                Cursor.visible = true;
            }
        }

        private void UpdateOperatorCursor(bool visible)
        {
            if (visible && !operatorCursorOwned)
            {
                savedCursorLock = Cursor.lockState;
                savedCursorVisible = Cursor.visible;
                operatorCursorOwned = true;
            }
            if (!visible && operatorCursorOwned)
            {
                Cursor.lockState = savedCursorLock;
                Cursor.visible = savedCursorVisible;
                operatorCursorOwned = false;
            }
        }

        /// <summary>Sector index clockwise from twelve o'clock; -1 is the center, gaps or outside.</summary>
        public static int OperatorSectorAt(Vector2 point, Vector2 center, float radius)
        {
            Vector2 delta = point - center;
            float distance = delta.magnitude;
            if (distance < radius * 0.4f || distance > radius) return -1;
            float angle = Mathf.Repeat(Mathf.Atan2(delta.x, -delta.y) * Mathf.Rad2Deg + 30f, 360f);
            float within = angle % 60f;
            if (within < 2f || within > 58f) return -1;
            return Mathf.FloorToInt(angle / 60f);
        }

        private void DrawOperatorRadialMenu()
        {
            if (!showOperatorUi || OperatorModalOpen) return;
            EnsureOperatorResources();
            Matrix4x4 oldMatrix = GUI.matrix;
            GUISkin oldSkin = GUI.skin;
            Color oldColor = GUI.color;
            bool oldEnabled = GUI.enabled;
            int oldDepth = GUI.depth;
            EventType rawEvent = Event.current.rawType;
            try
            {
                GUI.depth = -12000;
                GUI.enabled = true;
                GUI.color = Color.white;
                GUI.skin = operatorSkin;
                ResolveOperatorWindow(out float scale, out Rect windowPixels);
                OperatorPressureGui.Begin(operatorPressurePointer, GUIUtility.GUIToScreenPoint(Vector2.zero), new Vector2(Screen.width, Screen.height));
                GUI.matrix = Matrix4x4.Scale(new Vector3(scale, scale, 1f));
                Vector2 screen = new Vector2(Screen.width / scale, Screen.height / scale);
                bool detail = OperatorPage != ProjectionOperatorPage.Home;
                Rect window = new Rect(windowPixels.position / scale, windowPixels.size / scale);
                float width = window.width, height = window.height;
                OperatorFill(new Rect(0, 0, screen.x, screen.y), new Color(0, 0, 0, showOperatorHeatmap ? 0.08f : 0.28f));
                OperatorFill(window, OperatorBackground);
                OperatorFill(new Rect(window.x, window.y, width, 80f), OperatorSurface);
                GUILayout.BeginArea(new Rect(window.x + 24f, window.y + 12f, width - 48f, 66f));
                GUILayout.BeginHorizontal();
                GUILayout.BeginVertical();
                GUILayout.Label("DM   装置控制", operatorTitle);
                string hardware = pressureInput != null && pressureInput.HasConnectedHardware
                    ? $"压力板 {pressureInput.ConnectedBoardCount} 块已连接" : "压力板未连接 · 模拟输入";
                GUILayout.Label(hardware, operatorCaption);
                GUILayout.EndVertical();
                OperatorPressureGui.Button("收起", () => SetOperatorUiVisible(false), GUILayout.Width(78f), GUILayout.Height(38f));
                GUILayout.EndHorizontal();
                GUILayout.EndArea();

                Rect body = new Rect(window.x + 20f, window.y + 96f, width - 40f, height - 196f);
                if (!detail)
                {
                    float ringWidth = body.width;
                    DrawOperatorPagination(new Rect(body.x, body.y, ringWidth, 38f));
                    float diameter = Mathf.Min(ringWidth, body.height - 52f);
                    var ring = new Rect(body.center.x - diameter * 0.5f,
                        body.center.y + 21f - diameter * 0.5f, diameter, diameter);
                    DrawOperatorRing(ring);
                }
                if (detail)
                {
                    DrawOperatorPage(body);
                }
                var footer = new Rect(window.x + 24f, window.yMax - 91f, width - 48f, 75f);
                GUILayout.BeginArea(footer);
                GUILayout.Label("H 收起菜单     Esc 返回上一级", operatorCaption);
                DrawOperatorSessionControls?.Invoke();
                GUILayout.EndArea();
                DrawOperatorPressureCursor(scale);
                if (rawEvent == EventType.MouseDown || rawEvent == EventType.MouseUp || rawEvent == EventType.ScrollWheel)
                    Event.current.Use();
            }
            finally
            {
                OperatorPressureGui.End();
                GUI.matrix = oldMatrix;
                GUI.skin = oldSkin;
                GUI.color = oldColor;
                GUI.enabled = oldEnabled;
                GUI.depth = oldDepth;
            }
        }

        private void DrawOperatorPagination(Rect rect)
        {
            OperatorPressureGui.Button(new Rect(rect.x, rect.y, 100f, rect.height), "‹ 上一页", () => ChangeOperatorRingPage(-1));
            GUI.Label(new Rect(rect.x + 104f, rect.y, rect.width - 208f, rect.height),
                $"第 {OperatorRingPage + 1} / {OperatorRingPageCount} 页", operatorSectorLabel);
            OperatorPressureGui.Button(new Rect(rect.xMax - 100f, rect.y, 100f, rect.height), "下一页 ›", () => ChangeOperatorRingPage(1));
        }

        private void DrawOperatorRing(Rect rect)
        {
            Vector2 mouse = Event.current.mousePosition;
            int hover = OperatorSectorAt(mouse, rect.center, rect.width * 0.5f);
            if (OperatorPageForSector(OperatorRingPage, hover) == ProjectionOperatorPage.Home) hover = -1;
            int picked = -1;
            for (int index = 0; index < 6; index++)
            {
                ProjectionOperatorPage page = OperatorPageForSector(OperatorRingPage, index);
                bool available = page != ProjectionOperatorPage.Home;
                bool selected = available && OperatorPage == page;
                OperatorTexture(rect, operatorSectors[index], selected ? new Color(0.14f, 0.34f, 0.29f)
                    : !available ? OperatorBackground : hover == index ? OperatorRaised : OperatorSurface);
                if (!available) continue;
                OperatorPressureGui.RegisterRing(rect, index, () => SelectOperatorPage(page));
                float angle = index * 60f * Mathf.Deg2Rad;
                Vector2 label = rect.center + new Vector2(Mathf.Sin(angle), -Mathf.Cos(angle)) * rect.width * 0.355f;
                operatorSectorLabel.normal.textColor = selected ? OperatorAccent : OperatorText;
                GUI.Label(new Rect(label.x - 68f, label.y - 18f, 136f, 30f), OperatorTitles[(int)page], operatorSectorLabel);
                GUI.Label(new Rect(label.x - 68f, label.y + 12f, 136f, 24f), OperatorHints[(int)page], operatorCenterLabel);
            }
            float inner = rect.width * 0.35f;
            Rect center = new Rect(rect.center.x - inner * 0.5f, rect.center.y - inner * 0.5f, inner, inner);
            OperatorTexture(center, operatorCircle, OperatorRaised);
            OperatorPressureGui.RegisterRing(rect, -1, () => SetOperatorUiVisible(false));
            GUI.Label(new Rect(center.x, center.center.y - 25f, center.width, 30f), "收起菜单", operatorSectorLabel);
            GUI.Label(new Rect(center.x, center.center.y + 7f, center.width, 24f), "H", operatorCenterLabel);
            bool inCenter = Vector2.Distance(mouse, center.center) <= inner * 0.5f;
            Event evt = Event.current;
            int control = GUIUtility.GetControlID(FocusType.Passive, rect);
            if (evt.type == EventType.MouseDown && evt.button == 0 && (hover >= 0 || inCenter))
            {
                GUIUtility.hotControl = control;
                operatorPressedSector = inCenter ? 6 : hover;
                evt.Use();
            }
            if (evt.type == EventType.MouseUp && GUIUtility.hotControl == control)
            {
                GUIUtility.hotControl = 0;
                if (operatorPressedSector == (inCenter ? 6 : hover)) picked = operatorPressedSector;
                operatorPressedSector = -1;
                evt.Use();
            }
            if (picked == 6) SetOperatorUiVisible(false);
            else if (picked >= 0) SelectOperatorPage(OperatorPageForSector(OperatorRingPage, picked));
        }

        private void DrawOperatorPage(Rect rect)
        {
            ProjectionOperatorPage page = OperatorPage;
            OperatorFill(rect, OperatorSurface);
            // The bottom row remains reachable by pressure even when long settings are scrolled.
            GUILayout.BeginArea(new Rect(rect.x + 16f, rect.y + 10f, rect.width - 32f, rect.height - 66f));
            GUILayout.BeginHorizontal();
            GUILayout.Label(OperatorTitles[(int)page], operatorTitle);
            OperatorPressureGui.Button("返回主环", () => SelectOperatorPage(ProjectionOperatorPage.Home), GUILayout.Width(106f), GUILayout.Height(36f));
            GUILayout.EndHorizontal();
            GUILayout.Space(8f);
            // Convert the fixed viewport while outside the scroll group; scrolled-off controls cannot receive taps.
            Rect clipBeforeScroll = OperatorPressureGui.SetClip(new Rect(0, 50f, rect.width - 32f, rect.height - 116f));
            operatorScroll = GUILayout.BeginScrollView(operatorScroll, false, false);
            switch (page)
            {
                case ProjectionOperatorPage.Calibration: DrawCalibrationPage(); break;
                case ProjectionOperatorPage.Picture: DrawPicturePage(); break;
                case ProjectionOperatorPage.Pressure: DrawPressurePage(); break;
                case ProjectionOperatorPage.Props: DrawPropsPage(); break;
                case ProjectionOperatorPage.Recording:
                    if (DrawAdditionalOperatorControls != null) DrawAdditionalOperatorControls.Invoke();
                    else OperatorNote("当前场景没有游戏录像服务。");
                    break;
                case ProjectionOperatorPage.Display: DrawDisplayPage(); break;
                case ProjectionOperatorPage.PressureTest: DrawPressureTestPage(); break;
            }
            GUILayout.EndScrollView();
            OperatorPressureGui.RestoreClip(clipBeforeScroll);
            GUILayout.EndArea();
            OperatorPressureGui.Button(new Rect(rect.x + 16f, rect.yMax - 46f, (rect.width - 40f) * .5f, 36f), "↑ 上移", () => operatorScroll.y = Mathf.Max(0, operatorScroll.y - 220f));
            OperatorPressureGui.Button(new Rect(rect.center.x + 4f, rect.yMax - 46f, (rect.width - 40f) * .5f, 36f), "↓ 下移", () => operatorScroll.y += 220f);
        }

        private void DrawCalibrationPage()
        {
            OperatorNote(IsCalibrating ? "校正进行中 · 菜单打开时暂停采集" : alignment != null && alignment.HasValidCalibration ? "当前标定可用" : "尚未完成投影校正");
            OperatorButton(IsCalibrating ? "继续校正" : "开始投影校正", () =>
            {
                if (!IsCalibrating) StartCalibration();
                SetOperatorUiVisible(false);
            }, true, operatorPrimary);
            if (IsCalibrating) OperatorButton("取消本次，恢复之前的标定", CancelCalibration);
            OperatorSection("主标定点微调");
            DrawOperatorPad("marker", step =>
            {
                activeProjectorPoint = new Vector2(Mathf.Clamp01(activeProjectorPoint.x + step.x * 0.005f), Mathf.Clamp01(activeProjectorPoint.y + step.y * 0.005f));
                alignment.ShowCalibrationMarker(activeProjectorPoint, new Color(1f, 0.2f, 0.05f, 1f));
                statusMessage = $"已微调标记 P=({activeProjectorPoint.x:F3}, {activeProjectorPoint.y:F3})。收起菜单后继续采集。";
            }, State == ProjectionCalibrationState.CollectingPrimary && alignment != null);
            OperatorNote(statusMessage);
            if (pressureInput != null && pressureInput.UsingSimulation) OperatorNote("模拟输入仅用于操作流程，不能用于真实投影标定。");
            OperatorSection("清除标定");
            if (confirmCalibrationReset)
            {
                OperatorNote("将删除标定存档，并清零画面平移和外扩。镜头位置与接缝设置保留。");
                GUILayout.BeginHorizontal();
                OperatorButton("确认清除", () => { ResetCalibration(); confirmCalibrationReset = false; }, true, operatorDanger);
                OperatorButton("保留标定", () => confirmCalibrationReset = false);
                GUILayout.EndHorizontal();
            }
            else OperatorButton("清除已有标定…", () => confirmCalibrationReset = true, true, operatorDanger);
        }

        private void DrawPicturePage()
        {
            if (alignment == null) { OperatorNote("未配置投影对齐组件。"); return; }
            bool editable = !IsCalibrating;
            if (!editable) OperatorNote("完成或取消校正后可以调整。");
            OperatorNumber("压感区比例", "mat", alignment.MatHeightInFrame, SizeStep, MinSizeInFrame, 1f,
                value => AdjustMatHeightInFrame(value - alignment.MatHeightInFrame), editable);
            OperatorNumber("屏幕框比例", "frame", alignment.ScreenAreaHeightInFrame, SizeStep, MinSizeInFrame, 1f,
                value => AdjustScreenAreaHeightInFrame(value - alignment.ScreenAreaHeightInFrame), editable);
            OperatorSection("画面平移 · 每次 1 mm");
            Vector2 shift = alignment.ImageShiftCm * 10f;
            OperatorNote($"向右 {shift.x:0.#} mm · 向下 {shift.y:0.#} mm");
            DrawOperatorPad("shift", direction => ShiftImage(direction * ImageShiftStepMm), editable && alignment.HasValidCalibration);
            OperatorButton("平移归零", () => { alignment.ResetImageShift(); alignment.PersistCalibration(out _); }, editable && alignment.HasValidCalibration);
            OperatorSection("边缘外扩 · 每边毫米数");
            OperatorNumber("左右 / mm", "marginX", alignment.RenderMarginCm.x * 10f, 1f, 0f, 500f,
                value => GrowMargin(new Vector2(value - alignment.RenderMarginCm.x * 10f, 0f)), editable);
            OperatorNumber("上下 / mm", "marginY", alignment.RenderMarginCm.y * 10f, 1f, 0f, 500f,
                value => GrowMargin(new Vector2(0f, value - alignment.RenderMarginCm.y * 10f)), editable);
            OperatorNote(statusMessage);
        }

        private void DrawPressurePage()
        {
            if (pressureInput == null) { OperatorNote("未配置压力输入。"); return; }
            bool editable = !IsCalibrating;
            OperatorPressureGui.Toggle("方向与板顺序", operatorDirectionsExpanded, value => operatorDirectionsExpanded = value, operatorSkin.button, GUILayout.Height(38f));
            if (operatorDirectionsExpanded)
            {
                OperatorToggle("交换 X / Y 轴", pressureInput.SwapXY, _ => pressureInput.ToggleSwapXY(), editable);
                OperatorToggle("翻转 X 轴", pressureInput.FlipX, _ => pressureInput.ToggleFlipX(), editable);
                OperatorToggle("翻转 Y 轴", pressureInput.FlipY, _ => pressureInput.ToggleFlipY(), editable);
                var hardware = pressureInput.HardwareSource;
                OperatorToggle("硬件行列交换", hardware != null && hardware.SwapRowColumn, _ => pressureInput.ToggleHardwareRowColumnSwap(), editable && hardware != null);
                OperatorToggle("左右板互换", pressureInput.BoardsSwapped, _ => pressureInput.ToggleBoardSwap(), editable && pressureInput.BoardCount > 1);
            }
            OperatorSection("双板接缝");
            bool dual = pressureInput.BoardCount > 1;
            OperatorNumber("宽度 / cm", "seam", pressureInput.SeamGapCm, SeamAdjustStepCm, 0f, MaximumSeamGapCm,
                value => AdjustSeamGap(Mathf.Round(value / SeamCellCm) * SeamCellCm - pressureInput.SeamGapCm), editable && dual);
            bool wasEnabled = GUI.enabled;
            GUI.enabled = editable && dual;
            if (!seamSliderDirty) seamSliderCm = pressureInput.SeamGapCm;
            OperatorPressureGui.Slider("seam", seamSliderCm, 0f, MaximumSeamGapCm, value =>
            {
                if (Mathf.Abs(value - seamSliderCm) > 0.001f) { seamSliderCm = value; seamSliderDirty = true; }
            }, GUILayout.Height(24f));
            if (seamSliderDirty && GUIUtility.hotControl == 0 && !operatorPressurePointer.Pressed)
            {
                AdjustSeamGap(Mathf.Round(seamSliderCm / SeamCellCm) * SeamCellCm - pressureInput.SeamGapCm);
                seamSliderDirty = false;
                seamSliderCm = pressureInput.SeamGapCm;
            }
            GUI.enabled = wasEnabled;
            if (alignment != null) OperatorToggle("显示接缝提示带", alignment.ShowSeamGuide, alignment.SetSeamGuideVisible, dual);
            OperatorNote(dual ? $"跨缝合并触点：{pressureInput.SeamMergeCount}" : "双板连接后可设置接缝。");
            OperatorSection("压力量程");
            OperatorNote($"本次最高原始压力 {pressureInput.HighestPressureSeen:0}\n当前满量程 {pressureInput.PressureFullScale:0}");
            OperatorButton("使用本次最高压力作为满量程", pressureInput.AdoptHighestPressureAsFullScale);
        }

        private void DrawPropsPage()
        {
            bool editable = !IsCalibrating;
            var rig = FindFirstObjectByType<ProjectorCameraRig>();
            OperatorButton(rig != null && rig.Configured ? "更新实物上色层" : "建立实物上色层", () => SetupPropColoring(), editable, operatorPrimary);
            bool ready = rig != null && rig.Configured && colorFrameSet;
            Vector3 lens = ResolvedLensCm();
            OperatorSection("镜头位置 · 物理厘米");
            OperatorNumber("高度 / cm", "lensH", lens.z, 1f, 10f, 300f, value => SetOperatorLens(2, value), editable && ready);
            OperatorNumber("左右 / cm", "lensX", lens.x, 1f, -10000f, 10000f, value => SetOperatorLens(0, value), editable && ready);
            OperatorNumber("前后 / cm", "lensY", lens.y, 1f, -10000f, 10000f, value => SetOperatorLens(1, value), editable && ready);
            OperatorButton("复位镜头位置", () =>
            {
                PlayerPrefs.DeleteKey(ProjectorCameraRig.PrefLensXKey);
                PlayerPrefs.DeleteKey(ProjectorCameraRig.PrefLensYKey);
                PlayerPrefs.DeleteKey(ProjectorCameraRig.PrefLensHKey);
                lensCm = ProjectorCameraRig.LoadLensCm();
                if (ready) ApplyPropColoring(true);
                operatorNumbers.Clear();
            }, editable);
            OperatorSection("上色验证靶");
            var target = FindFirstObjectByType<ProjectionMappedTestTarget>();
            OperatorToggle("显示验证靶", target != null && target.CylinderVisible,
                visible => { if (visible) ShowOrCycleTestSolids(); else HideTestSolids(); }, editable && ready);
            OperatorToggle("只显示落脚标记", target != null && target.PlacementMode,
                _ => { target.TogglePlacementMode(); target.Build(rig, colorMatWidthCm * 10f, colorMatHeightCm * 10f); }, editable && ready && target != null);
            OperatorButton("下一个落点", ShowOrCycleTestSolids, editable && ready && target != null && target.CylinderVisible);
            OperatorNote(target != null ? target.LastReport : "建立上色层后，可投出圆柱与方块验证靶。");
        }

        private void SetOperatorLens(int axis, float value)
        {
            Vector3 lens = ResolvedLensCm();
            lens[axis] = value;
            lensCm = lens;
            var rig = FindFirstObjectByType<ProjectorCameraRig>();
            if (rig != null && rig.Configured) rig.SetLensCm(lens);
            else ProjectorCameraRig.SaveLensCm(lens);
        }

        private void DrawDisplayPage()
        {
            OperatorSection("投影输出");
            OperatorNote(displayRouter != null ? displayRouter.CurrentDisplayName : "未配置显示器路由");
            OperatorButton("切换到下一台显示器", () => { displayRouter.CycleDisplay(); statusMessage = displayRouter.StatusMessage; }, displayRouter != null && !IsCalibrating);
            OperatorNote("切换显示器后需要重新校正。");
            OperatorSection("参考与诊断");
            OperatorToggle("完整光斑边框（未经校正）", showOperatorOutputBorder, SetOperatorOutputBorderVisible);
            if (alignment != null)
            {
                OperatorToggle("对齐参考框与实时压力点", alignment.GuidesVisible, alignment.SetGuidesVisible, !IsCalibrating);
                OperatorToggle("压力板网格", alignment.ShowBoardGrid, alignment.SetGridVisible);
            }
            OperatorToggle("压力热力图", showOperatorHeatmap, SetOperatorHeatmapVisible);
            OperatorToggle("实时诊断信息", showDiagnostics, SetOperatorDiagnosticsVisible);
            OperatorNote("光斑边框沿完整输出画面的四边绘制（1920 × 1080 输出即覆盖该画面），不受校正、画面平移或压感区裁切影响。边框、热力图与诊断收起菜单后继续显示。");
            if (showDiagnostics) DrawOperatorDiagnostics();
            OperatorSection("游戏库外观");
            if (operatorLookSwitcher == null)
                foreach (var look in FindObjectsByType<ProjectionSceneLookSwitcher>(FindObjectsInactive.Include, FindObjectsSortMode.None))
                    if (look.gameObject.scene == gameObject.scene) { operatorLookSwitcher = look; break; }
            OperatorNote(operatorLookSwitcher != null ? operatorLookSwitcher.CurrentLookName : "当前场景无外观预设");
            bool inLibrary = SceneManager.GetActiveScene() == gameObject.scene;
            OperatorButton("切换下一套外观", () => operatorLookSwitcher.NextLook(), operatorLookSwitcher != null && inLibrary && !IsCalibrating);
            if (!inLibrary) OperatorNote("返回游戏库后可以切换外观。");
            OperatorPressureGui.Toggle("模拟压力输入", operatorSimulationExpanded, value => operatorSimulationExpanded = value, operatorSkin.button, GUILayout.Height(38f));
            if (operatorSimulationExpanded) DrawOperatorSimulation();
            else if (pressureInput != null && pressureInput.SimulationSource != null)
                pressureInput.SimulationSource.SetOperatorPressed(false);
        }

        private void DrawOperatorDiagnostics()
        {
            if (pressureInput == null) return;
            OperatorNote($"输入：{pressureInput.ActiveSourceName}\n连接 {pressureInput.ConnectedBoardCount} 块 · 布局 {pressureInput.BoardCount} 块 · 传感器 {pressureInput.SensorResolution.x} × {pressureInput.SensorResolution.y}\n满量程 {pressureInput.PressureFullScale:0} · 最高原始压力 {pressureInput.HighestPressureSeen:0}");
            var hardware = pressureInput.HardwareSource;
            OperatorNote($"Unity 更新 {operatorUnityHz:F1} FPS（不是传感器扫描率）");
            if (hardware != null && hardware.IsReady)
                for (int i = 0; i < pressureInput.BoardCount; i++) OperatorNote(hardware.DescribeBoard(i));
            else if (hardware != null) OperatorNote(hardware.LastError);
            OperatorNote("协议 Hz 是收到的矩阵帧率；15 秒实测与漏按对比见主环第 2 页 → 压感测试。");
            if (virtualTouchscreen != null) OperatorNote($"虚拟触摸屏：{(virtualTouchscreen.Device != null ? "已注册" : "未注册")} · 活动触点 {virtualTouchscreen.ActiveTouchCount} · {(virtualTouchscreen.Suspended ? "游戏输入已挂起" : "游戏可用")}");
            var contacts = pressureInput.Contacts;
            OperatorNote($"压力触点：{contacts.Count}");
            for (int i = 0; i < contacts.Count && i < 3; i++)
            {
                var contact = contacts[i];
                OperatorNote($"板 {contact.boardIndex + 1} · raw ({contact.rawPosition.x:0.#}, {contact.rawPosition.y:0.#}) · UV ({contact.boardUv.x:0.###}, {contact.boardUv.y:0.###})\n原始压力 {contact.pressure:0} · 归一化 {contact.normalizedPressure:0.##} · 半径 {contact.radius:0.#}");
            }
            if (rejectedByPressure)
                OperatorNote($"压力 {lastRejectedPressure:0} 低于校正门槛（归一化须 ≥ {minimumConfidence:0.##}），此点未被采纳。可在压力板页面重新设置满量程。");
        }

        private void DrawOperatorSimulation()
        {
            var simulator = pressureInput != null ? pressureInput.SimulationSource : null;
            bool available = simulator != null && pressureInput.UsingSimulation;
            OperatorNote(available ? "移动模拟触点，再按住按钮模拟按压。收起菜单后，也可使用鼠标左键或方向键与空格。" : "模拟输入仅在未连接真实压力板时使用。");
            DrawOperatorPad("sim", direction => simulator.MoveOperatorPoint(direction * 0.01f), available);
            bool wasEnabled = GUI.enabled;
            GUI.enabled = available;
            bool held = GUILayout.RepeatButton("按住模拟按压", GUILayout.Height(42f));
            GUI.enabled = wasEnabled;
            if (simulator != null)
            {
                simulator.SetOperatorPressed(available && held);
                OperatorNote($"模拟触点：{simulator.OperatorPoint.x:0.00}, {simulator.OperatorPoint.y:0.00}");
            }
        }

        private void DrawOperatorPad(string name, Action<Vector2> move, bool enabled)
        {
            GUILayout.BeginHorizontal(); GUILayout.FlexibleSpace();
            OperatorButton("↑", () => move(Vector2.down), enabled, null, 56f);
            GUILayout.FlexibleSpace(); GUILayout.EndHorizontal();
            GUILayout.BeginHorizontal(); GUILayout.FlexibleSpace();
            OperatorButton("←", () => move(Vector2.left), enabled, null, 56f);
            OperatorButton("↓", () => move(Vector2.up), enabled, null, 56f);
            OperatorButton("→", () => move(Vector2.right), enabled, null, 56f);
            GUILayout.FlexibleSpace(); GUILayout.EndHorizontal();
        }

        private void OperatorNumber(string label, string key, float value, float step, float min, float max, Action<float> apply, bool enabled)
        {
            bool previousEnabled = GUI.enabled;
            GUI.enabled = previousEnabled && enabled;
            GUILayout.BeginHorizontal();
            GUILayout.Label(label, GUILayout.MinWidth(105f), GUILayout.ExpandWidth(true));
            Action<float> stepNumber = delta =>
            {
                float candidate = Mathf.Clamp(value + delta, min, max);
                operatorNumbers[key] = candidate.ToString("0.###", CultureInfo.InvariantCulture);
                GUIFocusClear();
                apply(candidate);
            };
            OperatorPressureGui.Button("−", () => stepNumber(-step), GUILayout.Width(40f), GUILayout.Height(38f));
            string control = "projection-number-" + key;
            if (!operatorNumbers.TryGetValue(key, out string text) || GUI.GetNameOfFocusedControl() != control)
                text = value.ToString("0.###", CultureInfo.InvariantCulture);
            GUI.SetNextControlName(control);
            string next = GUILayout.TextField(text, GUILayout.Width(100f), GUILayout.Height(38f));
            operatorNumbers[key] = next;
            OperatorPressureGui.Button("+", () => stepNumber(step), GUILayout.Width(40f), GUILayout.Height(38f));
            GUILayout.EndHorizontal();
            GUI.enabled = previousEnabled;
            if (!enabled) return;
            if (next != text && float.TryParse(next, NumberStyles.Float, CultureInfo.InvariantCulture, out float number)
                && !float.IsNaN(number) && !float.IsInfinity(number) && number >= min && number <= max && Mathf.Abs(number - value) > 0.0001f)
                apply(number);
        }

        private static void OperatorButton(string title, Action action, bool enabled = true, GUIStyle style = null, float width = 0f)
        {
            bool previous = GUI.enabled;
            GUI.enabled = previous && enabled;
            if (width > 0f) OperatorPressureGui.Button(title, action, style ?? GUI.skin.button, GUILayout.Height(40f), GUILayout.Width(width));
            else OperatorPressureGui.Button(title, action, style ?? GUI.skin.button, GUILayout.Height(40f));
            GUI.enabled = previous;
        }

        private void OperatorToggle(string title, bool value, Action<bool> change, bool enabled = true)
        {
            bool previous = GUI.enabled;
            GUI.enabled = previous && enabled;
            OperatorPressureGui.Toggle((value ? "●  " : "○  ") + title, value, change, operatorSkin.button, GUILayout.Height(38f));
            GUI.enabled = previous;
        }

        private void OperatorSection(string title)
        {
            GUILayout.Space(14f);
            GUILayout.Label(title, operatorSectorLabel);
            GUILayout.Space(5f);
        }

        private void OperatorNote(string text) => GUILayout.Label(text ?? string.Empty, operatorCaption);

        private static void OperatorFill(Rect rect, Color color) => OperatorTexture(rect, Texture2D.whiteTexture, color);
        private static void OperatorTexture(Rect rect, Texture texture, Color color)
        {
            Color old = GUI.color;
            GUI.color = color;
            GUI.DrawTexture(rect, texture);
            GUI.color = old;
        }

        private Texture2D OperatorSolid(Color color)
        {
            var texture = new Texture2D(1, 1, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave };
            texture.SetPixel(0, 0, color);
            texture.Apply(false, true);
            operatorTextures.Add(texture);
            return texture;
        }

        private void EnsureOperatorResources()
        {
            if (operatorSkin != null) return;
            operatorSkin = Instantiate(GUI.skin);
            operatorSkin.hideFlags = HideFlags.HideAndDontSave;
            operatorFont = Font.CreateDynamicFontFromOSFont(new[] { "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Arial Unicode MS" }, 20);
            if (operatorFont != null) operatorSkin.font = operatorFont;
            operatorSkin.label.fontSize = 18;
            operatorSkin.label.wordWrap = true;
            operatorSkin.label.normal.textColor = OperatorText;
            operatorSkin.box.normal.background = OperatorSolid(OperatorBackground);
            operatorSkin.box.padding = new RectOffset(14, 14, 12, 12);
            operatorSkin.button.fontSize = 18;
            operatorSkin.button.wordWrap = true;
            operatorSkin.button.padding = new RectOffset(10, 10, 6, 6);
            operatorSkin.button.normal.background = OperatorSolid(OperatorRaised);
            operatorSkin.button.hover.background = OperatorSolid(new Color(0.18f, 0.30f, 0.31f));
            operatorSkin.button.active.background = OperatorSolid(new Color(0.18f, 0.38f, 0.32f));
            operatorSkin.button.onNormal.background = operatorSkin.button.active.background;
            operatorSkin.button.onHover.background = operatorSkin.button.active.background;
            operatorSkin.button.onActive.background = operatorSkin.button.active.background;
            foreach (var state in new[] { operatorSkin.button.normal, operatorSkin.button.hover, operatorSkin.button.active, operatorSkin.button.onNormal, operatorSkin.button.onHover, operatorSkin.button.onActive }) state.textColor = OperatorText;
            operatorSkin.textField.fontSize = 18;
            operatorSkin.textField.alignment = TextAnchor.MiddleCenter;
            operatorSkin.textField.normal.textColor = OperatorText;
            operatorSkin.textField.focused.textColor = OperatorText;
            operatorSkin.textField.normal.background = OperatorSolid(OperatorBackground);
            operatorSkin.textField.focused.background = OperatorSolid(new Color(0.10f, 0.23f, 0.23f));
            operatorSkin.settings.cursorColor = OperatorAccent;
            operatorTitle = new GUIStyle(operatorSkin.label) { fontSize = 24, wordWrap = false };
            operatorCaption = new GUIStyle(operatorSkin.label) { fontSize = 16, wordWrap = true, padding = new RectOffset(0, 0, 4, 5) };
            operatorCaption.normal.textColor = OperatorMuted;
            operatorSectorLabel = new GUIStyle(operatorSkin.label) { fontSize = 20, alignment = TextAnchor.MiddleCenter, wordWrap = false };
            operatorCenterLabel = new GUIStyle(operatorCaption) { alignment = TextAnchor.MiddleCenter, wordWrap = false };
            operatorPrimary = new GUIStyle(operatorSkin.button);
            operatorPrimary.normal.background = OperatorSolid(new Color(0.16f, 0.38f, 0.31f));
            operatorPrimary.normal.textColor = OperatorAccent;
            operatorDanger = new GUIStyle(operatorSkin.button);
            operatorDanger.normal.textColor = new Color(1f, 0.64f, 0.58f);
            const int size = 384;
            for (int sector = 0; sector < 7; sector++)
            {
                var texture = new Texture2D(size, size, TextureFormat.RGBA32, false)
                { hideFlags = HideFlags.HideAndDontSave, filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
                var pixels = new Color32[size * size];
                Vector2 center = Vector2.one * (size * 0.5f);
                for (int y = 0; y < size; y++)
                for (int x = 0; x < size; x++)
                {
                    Vector2 point = new Vector2(x + 0.5f, size - y - 0.5f);
                    float radius = (point - center).magnitude;
                    float alpha = sector == 6 ? Mathf.Clamp01(size * 0.5f - radius - 0.5f)
                        : OperatorSectorAt(point, center, size * 0.5f - 1f) == sector ? 1f : 0f;
                    pixels[y * size + x] = new Color(1f, 1f, 1f, alpha);
                }
                texture.SetPixels32(pixels);
                texture.Apply(false, true);
                operatorTextures.Add(texture);
                if (sector == 6) operatorCircle = texture; else operatorSectors[sector] = texture;
            }
        }

        private void OnDisable()
        {
            operatorPressurePointer.Reset();
            operatorAwaitPressureRelease = false;
            ReleasePressureDiagnostics();
            if (showOperatorUi || OperatorModalOpen) SetOperatorUiVisible(false);
            if (pressureInput != null && pressureInput.SimulationSource != null)
                pressureInput.SimulationSource.SetOperatorControl(false);
            ReleaseOperatorResources();
        }

        private void OnDestroy() => ReleaseOperatorResources();

        private void ReleaseOperatorResources()
        {
            ReleaseOperatorObject(operatorSkin);
            ReleaseOperatorObject(operatorFont);
            foreach (var texture in operatorTextures) ReleaseOperatorObject(texture);
            operatorTextures.Clear();
            operatorSkin = null;
            operatorFont = null;
            operatorCircle = null;
        }

        private static void ReleaseOperatorObject(UnityEngine.Object value)
        {
            if (value == null) return;
            if (Application.isPlaying) Destroy(value); else DestroyImmediate(value);
        }
    }
}
