using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.InputSystem;

namespace NuLight.ProjectionAlignment
{
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(-40)]
    public sealed partial class ProjectionCalibrationController : MonoBehaviour
    {
        public event Action DrawAdditionalOperatorControls;
        public event Action<bool> OperatorUiVisibilityChanged;
        public bool OperatorUiVisible => showOperatorUi;
        private bool operatorModalOpen;
        public bool OperatorModalOpen
        {
            get => operatorModalOpen;
            set
            {
                if (operatorModalOpen && !value) lastOperatorCloseFrame = Time.frameCount;
                operatorModalOpen = value;
                SyncOperatorInput();
            }
        }

        [Header("References")]
        [SerializeField] private ProjectionAlignmentController alignment;
        [SerializeField] private PressureInputRouter pressureInput;

        [Tooltip("Optional. The panel that covers the running game while calibration is in progress.")]
        [SerializeField] private ProjectionCalibrationOverlay overlay;

        [Tooltip("Optional. Suspended for the duration of a calibration session so that stepping "
            + "on a marker cannot also reach the game.")]
        [SerializeField] private ProjectionVirtualTouchscreen virtualTouchscreen;

        [Tooltip("Optional. Moves the player window onto the projector; M cycles screens.")]
        [SerializeField] private ProjectionDisplayRouter displayRouter;

        [Header("Capture")]
        [SerializeField, Min(0.1f)] private float holdDuration = 0.35f;
        [SerializeField, Min(0.1f)] private float stableRadiusCells = 1.25f;
        [SerializeField, Range(0f, 1f)] private float minimumConfidence = 0.1f;

        [Header("Validation")]
        [SerializeField, Min(0.1f)] private float targetRmsErrorCells = 2f;
        [SerializeField, Min(0.1f)] private float targetMaxErrorCells = 3f;
        [SerializeField, Range(0, 3)] private int refinementRounds = 1;

        [Header("Primary Expected Board Points")]
        [Tooltip("Known target coordinates on the pressure mat. The marker projector UV is derived from the current physical mapping.")]
        [SerializeField] private Vector2[] primaryBoardTargets =
        {
            new Vector2(0.10f, 0.10f),
            new Vector2(0.90f, 0.10f),
            new Vector2(0.90f, 0.90f),
            new Vector2(0.10f, 0.90f)
        };

        [Tooltip("Used instead of the list above when two mats are connected. Five points, not four, "
            + "and that fifth one is the whole reason the rig can work out by itself which mat is on "
            + "the left: four points always fit a homography exactly, so a wrong left/right guess "
            + "leaves no trace in the residual. The fifth point makes the fit over-determined, and a "
            + "wrong guess — which offsets one mat's readings by half the area — then shows up as an "
            + "error tens of times larger than the right one.")]
        [SerializeField] private Vector2[] dualBoardPrimaryTargets =
        {
            new Vector2(0.10f, 0.10f),
            new Vector2(0.90f, 0.10f),
            new Vector2(0.90f, 0.90f),
            new Vector2(0.10f, 0.90f),
            new Vector2(0.30f, 0.50f)
        };

        [Header("Validation Board Points")]
        [SerializeField] private Vector2[] validationBoardPoints =
        {
            new Vector2(0.50f, 0.10f),
            new Vector2(0.90f, 0.50f),
            new Vector2(0.50f, 0.50f),
            new Vector2(0.50f, 0.90f),
            new Vector2(0.10f, 0.50f)
        };

        [Tooltip("Used instead of the list above when two mats are connected. The single-mat set "
            + "puts three of its five points on x = 0.50, which on a two-mat rig is exactly the "
            + "seam — the dead strip where the mats butt together. These stay clear of it.")]
        [SerializeField] private Vector2[] dualBoardValidationPoints =
        {
            new Vector2(0.25f, 0.15f),
            new Vector2(0.75f, 0.15f),
            new Vector2(0.25f, 0.85f),
            new Vector2(0.75f, 0.85f),
            new Vector2(0.60f, 0.50f)
        };

        private const float SizeStep = 0.05f;
        private const float MinSizeInFrame = 0.3f;

        /// <summary>
        /// How far from the seam a calibration point has to stay, in board UV. The mats have
        /// a border each, so the strip where they meet reads nothing and a marker placed there
        /// can never be captured.
        /// </summary>
        private const float SeamClearanceBoardUv = 0.06f;

        /// <summary>Widest seam the estimator will consider, and how finely it looks, in cm.</summary>
        private const float MaximumSeamGapCm = 8f;
        private const float SeamSearchStepCm = 0.25f;
        private const float SeamAdjustStepCm = 0.5f;

        /// <summary>One sensor cell. The seam is stored in whole cells, so the slider snaps to them.</summary>
        private const float SeamCellCm = 0.5f;

        private readonly List<CalibrationSample> samples = new List<CalibrationSample>(16);
        private readonly List<Vector2> stablePositions = new List<Vector2>(64);
        private readonly List<float> validationErrors = new List<float>(8);

        private Matrix4x4 backupMatrix;
        private bool backupWasCalibrated;
        private Vector2 backupShiftCm;
        private bool sessionSwapXY;
        private bool sessionFlipX;
        private bool sessionFlipY;
        private bool sessionBoardsSwapped;
        private Vector2 activeProjectorPoint;
        private Vector2 activeExpectedBoardPoint;
        private int pointIndex;
        private int currentRefinementRound;
        private float stableTime;
        private bool waitForRelease;
        private float lastCaptureDeviationCells;
        private bool rejectedByPressure;
        private float lastRejectedPressure;
        private bool showDiagnostics;

        // H controls only the menu. Debug displays have independent opt-in visibility.
        private bool showOperatorUi;
        private Canvas[] operatorCanvases;
        private bool sessionActive;
        private int appliedBoardCount;
        private float appliedSeamGapCm;
        private float seamSliderCm;
        private bool seamSliderDirty;
        private bool guidesBeforeSession = true;
        private float resultDisplayTimer;
        private ProjectionCalibrationState lastSyncedState = ProjectionCalibrationState.Idle;
        private string sessionResultTitle = string.Empty;
        private string statusMessage = "按 C 开始测量投影光斑到压力板的物理映射。16:9游戏画面不会被裁剪。";

        /// <summary>
        /// How long the outcome of a calibration stays on the table after the session ends.
        /// Without it, hiding the operator panel by default would make a failed calibration
        /// look like the C key did nothing at all.
        /// </summary>
        private const float ResultDisplaySeconds = 7f;

        public ProjectionCalibrationState State { get; private set; } = ProjectionCalibrationState.Idle;
        public float LastRmsErrorCells { get; private set; }
        public float LastMaxErrorCells { get; private set; }
        public string StatusMessage => statusMessage;

        /// <summary>
        /// True from the moment calibration is started until it succeeds, fails or is
        /// cancelled. While it is true the game is covered and receives no touches.
        /// </summary>
        public bool IsCalibrating =>
            State == ProjectionCalibrationState.CollectingPrimary
            || State == ProjectionCalibrationState.Solving
            || State == ProjectionCalibrationState.Validating;

        /// <summary>Raised when a calibration session opens (true) and when it closes (false).</summary>
        public event Action<bool> CalibrationSessionChanged;

        public void Configure(
            ProjectionAlignmentController configuredAlignment,
            PressureInputRouter configuredPressureInput,
            ProjectionCalibrationOverlay configuredOverlay = null,
            ProjectionVirtualTouchscreen configuredVirtualTouchscreen = null,
            ProjectionDisplayRouter configuredDisplayRouter = null)
        {
            alignment = configuredAlignment;
            pressureInput = configuredPressureInput;
            overlay = configuredOverlay;
            virtualTouchscreen = configuredVirtualTouchscreen;
            displayRouter = configuredDisplayRouter;
        }

        /// <summary>Enters calibration if the game is running, leaves it if it is already up.</summary>
        public void ToggleCalibration()
        {
            if (IsCalibrating)
            {
                CancelCalibration();
                return;
            }

            StartCalibration();
        }

        /// <summary>
        /// Screen-space-overlay canvases draw after every camera, so they sit on top
        /// of Camera B's warped output and would be projected onto the table. They are
        /// operator-side debug UI; the heatmap toggle controls their visibility independently
        /// from the menu. Restrict discovery to this rig so hosted game canvases are untouched.
        /// </summary>
        private void CollectOperatorCanvases()
        {
            // The projector output is itself an overlay canvas; hiding it along with
            // the operator UI would black out the projection instead of cleaning it.
            Canvas outputCanvas = null;
            ProjectorFeed feed = FindFirstObjectByType<ProjectorFeed>();
            if (feed != null && feed.OutputImage != null)
            {
                outputCanvas = feed.OutputImage.canvas;
            }

            var found = new List<Canvas>(4);
            Canvas[] all = transform.root.GetComponentsInChildren<Canvas>(true);
            for (int index = 0; index < all.Length; index++)
            {
                if (all[index].renderMode == RenderMode.ScreenSpaceOverlay
                    && all[index] != outputCanvas)
                {
                    found.Add(all[index]);
                }
            }

            operatorCanvases = found.ToArray();
        }

        public void SetOperatorUiVisible(bool visible)
        {
            operatorPressurePointer.Reset();
            if (showOperatorUi && !visible) operatorAwaitPressureRelease = OperatorHasPressure;
            if (!visible) StopPressureTest("菜单已收起，本轮提前结束。");
            if (showOperatorUi && !visible) lastOperatorCloseFrame = Time.frameCount;
            if (visible && !showOperatorUi) ResetOperatorNavigation();
            UpdateOperatorCursor(visible);
            showOperatorUi = visible;
            if (!visible && IsCalibrating) { waitForRelease = true; ResetStability(); }
            SyncOperatorInput();
            OperatorUiVisibilityChanged?.Invoke(visible);
        }

        private void Start()
        {
            LoadPoseOverrides();
            CollectOperatorCanvases();
            SetOperatorHeatmapVisible(showOperatorHeatmap);
            SetOperatorUiVisible(showOperatorUi);
            appliedBoardCount = alignment != null ? alignment.BoardCount : 1;

            // One pull, at startup only: the saved calibration carries the seam width in its
            // rect, and the hardware has no way to know it. From here on the hardware is the
            // authority and SyncBoardLayout pushes the other way.
            if (alignment != null && pressureInput != null && alignment.BoardCount > 1)
            {
                pressureInput.SetSeamGapCm(alignment.SeamGapCm);
            }

            appliedSeamGapCm = pressureInput != null ? pressureInput.SeamGapCm : 0f;
            seamSliderCm = appliedSeamGapCm;

            if (alignment != null && alignment.HasValidCalibration)
            {
                State = ProjectionCalibrationState.Ready;
                statusMessage = "已加载投影→压力板校准。16:9画面保持完整；按 C 可重新校准。";
            }
        }

        private void Update()
        {
            SyncBoardLayout();
            HandleKeyboard();
            UpdateOperatorPressure();
            SyncOperatorInput();

            UpdatePressureDiagnostics();

            if (!OperatorInputBlocked && (State == ProjectionCalibrationState.CollectingPrimary
                || State == ProjectionCalibrationState.Validating))
            {
                CaptureStableContact();
            }

            SyncSession();
        }

        /// <summary>
        /// Reshapes the interactive area when the number of connected mats changes. The mats
        /// are detected asynchronously — the serial ports open a moment after the scene does,
        /// and a second mat can appear later — so the geometry cannot be decided once at
        /// startup; it follows whatever is plugged in.
        ///
        /// A matrix solved against a different number of mats maps to a board that no longer
        /// exists, so it is dropped here rather than left to produce a plausible-looking but
        /// wrong alignment. The saved file is kept: unplugging one mat for a moment should
        /// not destroy a calibration.
        /// </summary>
        private void SyncBoardLayout()
        {
            if (alignment == null || pressureInput == null || !pressureInput.HasConnectedHardware || IsCalibrating)
            {
                return;
            }

            int boardCount = pressureInput.BoardCount;
            float seamGapCm = pressureInput.SeamGapCm;
            if (boardCount == appliedBoardCount && Mathf.Abs(seamGapCm - appliedSeamGapCm) < 0.01f)
            {
                return;
            }

            bool hadCalibration = alignment.HasValidCalibration;
            bool reshaped = alignment.SetMatLayout(boardCount, seamGapCm);
            appliedBoardCount = alignment.BoardCount;
            appliedSeamGapCm = alignment.SeamGapCm;
            if (!reshaped)
            {
                return;
            }

            alignment.InvalidateCalibration();
            Rect rect = alignment.InteractionRectInGameUv;
            float widthCm = ProjectionCoordinateMapper.AreaWidthCm(appliedBoardCount, appliedSeamGapCm);
            State = ProjectionCalibrationState.Idle;
            sessionResultTitle = "压感区已变化";
            statusMessage = $"检测到 {appliedBoardCount} 块压力板，可交互区改为 {widthCm:F0} × "
                + $"{ProjectionCoordinateMapper.MatEdgeCm:F0} cm"
                + (appliedBoardCount > 1 ? $"（含 {appliedSeamGapCm:F1} cm 接缝死区）" : string.Empty)
                + $"（画面的 {rect.width:F2} 宽 × {rect.height:F2} 高）。"
                + (hadCalibration ? "原有标定针对的板数不同，已失效，请按 C 重新校正。" : "按 C 开始校正。");
            ShowResultMessage();
            Debug.Log($"[ProjectionAlignment] 压感区随板数变化：{appliedBoardCount} 块板，"
                + $"Rect w={rect.width:F4} h={rect.height:F4}。"
                + (hadCalibration
                    ? "**原有标定已作废**（存档保留），在重新校正之前画面不做预畸变——"
                      + "投影仪自身的梯形会原样落在桌面上。"
                    : string.Empty), this);
        }

        /// <summary>The primary set that matches the current layout.</summary>
        private Vector2[] ActivePrimaryTargets =>
            appliedBoardCount > 1 && dualBoardPrimaryTargets != null && dualBoardPrimaryTargets.Length >= 4
                ? dualBoardPrimaryTargets
                : primaryBoardTargets;

        /// <summary>The validation set that matches the current layout — the seam rules them out on two mats.</summary>
        private Vector2[] ActiveValidationPoints =>
            appliedBoardCount > 1 && dualBoardValidationPoints != null && dualBoardValidationPoints.Length > 0
                ? dualBoardValidationPoints
                : validationBoardPoints;

        /// <summary>
        /// Opens and closes the calibration layer purely from <see cref="State"/>, so every
        /// path out of calibration — success, failure, cancellation — restores the game
        /// without each of them having to remember to.
        /// </summary>
        private void SyncSession()
        {
            bool shouldBeActive = IsCalibrating;
            if (shouldBeActive != sessionActive)
            {
                sessionActive = shouldBeActive;
                if (sessionActive)
                {
                    guidesBeforeSession = alignment == null || alignment.GuidesVisible;
                    if (alignment != null)
                    {
                        alignment.SetGuidesVisible(true);
                    }
                }
                else if (alignment != null)
                {
                    alignment.SetGuidesVisible(guidesBeforeSession);
                }

                if (virtualTouchscreen != null)
                {
                    virtualTouchscreen.SetSuspended(sessionActive || OperatorInputBlocked);
                }

                if (sessionActive)
                {
                    resultDisplayTimer = 0f;
                    if (overlay != null)
                    {
                        overlay.SetVisible(true);
                    }
                }
                else
                {
                    ShowResultMessage();
                }

                CalibrationSessionChanged?.Invoke(sessionActive);
            }

            // A calibration can also fail before it ever counts as active — an unreachable
            // first marker fails inside StartCalibration, in the same frame. Without this
            // the verdict would be swallowed and pressing C would look like nothing.
            if (!sessionActive
                && State != lastSyncedState
                && State == ProjectionCalibrationState.Failed)
            {
                ShowResultMessage();
            }

            lastSyncedState = State;

            if (sessionActive)
            {
                if (overlay != null)
                {
                    overlay.SetMessage("投影校正", statusMessage, DescribeProgress());
                }

                return;
            }

            if (resultDisplayTimer > 0f)
            {
                resultDisplayTimer -= Time.unscaledDeltaTime;
                if (resultDisplayTimer <= 0f && overlay != null)
                {
                    overlay.SetVisible(false);
                }
            }
        }

        /// <summary>
        /// Puts the outcome on the table for a few seconds. The veil comes off first: the
        /// game is already running again, and only the verdict should linger.
        /// </summary>
        private void ShowResultMessage()
        {
            resultDisplayTimer = ResultDisplaySeconds;
            if (overlay == null)
            {
                return;
            }

            overlay.SetVisible(true);
            overlay.SetBackdropVisible(false);
            overlay.SetMessage(sessionResultTitle, statusMessage, string.Empty);
        }

        private string DescribeProgress()
        {
            switch (State)
            {
                case ProjectionCalibrationState.CollectingPrimary:
                    return $"标定点 {Mathf.Min(pointIndex + 1, ActivePrimaryTargets.Length)}"
                        + $" / {ActivePrimaryTargets.Length}";
                case ProjectionCalibrationState.Validating:
                    return $"验证点 {Mathf.Min(pointIndex + 1, ActiveValidationPoints.Length)}"
                        + $" / {ActiveValidationPoints.Length}";
                case ProjectionCalibrationState.Solving:
                    return "解算中";
                default:
                    return string.Empty;
            }
        }

        public void StartCalibration()
        {
            if (alignment == null || pressureInput == null)
            {
                State = ProjectionCalibrationState.Failed;
                statusMessage = "缺少 ProjectionAlignmentController 或 PressureInputRouter。";
                return;
            }

            if (ActivePrimaryTargets == null || ActivePrimaryTargets.Length < 4)
            {
                State = ProjectionCalibrationState.Failed;
                statusMessage = "至少需要配置四个主标定点。";
                return;
            }

            if (!ValidatePointsClearOfSeam(out string seamError))
            {
                State = ProjectionCalibrationState.Failed;
                statusMessage = seamError;
                return;
            }

            backupMatrix = alignment.ProjectorToBoardMatrix;
            backupWasCalibrated = alignment.HasValidCalibration;
            backupShiftCm = alignment.ImageShiftCm;
            sessionSwapXY = pressureInput.SwapXY;
            sessionFlipX = pressureInput.FlipX;
            sessionFlipY = pressureInput.FlipY;
            sessionBoardsSwapped = pressureInput.BoardsSwapped;
            samples.Clear();
            validationErrors.Clear();
            pointIndex = 0;
            currentRefinementRound = 0;
            LastRmsErrorCells = 0f;
            LastMaxErrorCells = 0f;
            State = ProjectionCalibrationState.CollectingPrimary;
            sessionResultTitle = "校正结束";
            waitForRelease = true;
            ResetStability();
            ShowPrimaryPoint();
        }

        public void CancelCalibration()
        {
            if (!IsCalibrating)
            {
                statusMessage = "没有进行中的标定。";
                return;
            }

            string progress = DescribeProgress();
            RestoreSessionBackup();
            State = backupWasCalibrated ? ProjectionCalibrationState.Ready : ProjectionCalibrationState.Idle;
            sessionResultTitle = "已取消校正";
            statusMessage = backupWasCalibrated
                ? "已取消校准，退回上一次成功的标定。"
                : "已取消校准。之前没有成功的标定，所以画面回到未校正状态——投影仪自身的梯形会原样落在桌面上。";
            ResetStability();
            Debug.Log($"[ProjectionAlignment] 校正已取消（进度：{progress}）。"
                + (backupWasCalibrated ? "退回上一次成功的标定。" : "退回未校正状态，画面不做预畸变。"), this);
        }

        public void ResetCalibration()
        {
            if (alignment != null)
            {
                alignment.HideCalibrationMarker();
                alignment.ResetCalibration(true);
            }

            State = ProjectionCalibrationState.Idle;
            sessionResultTitle = "已清除校正";
            statusMessage = alignment != null
                ? $"校准已清除，压感区回到默认 {alignment.MatHeightInFrame:F2}。按 C 开始新校准。"
                : "校准已清除。按 C 开始新校准。";
            samples.Clear();
            ResetStability();
            ShowResultMessage();
            Debug.Log("[ProjectionAlignment] 已按 R 清除标定存档并回到出厂几何。"
                + "画面现在不做预畸变，投影仪自身的梯形会原样落在桌面上，直到重新校正。", this);
        }

        private void CaptureStableContact()
        {
            IReadOnlyList<BoardContact> contacts = pressureInput.Contacts;
            if (waitForRelease)
            {
                if (contacts.Count == 0)
                {
                    waitForRelease = false;
                    ResetStability();
                }
                return;
            }

            if (contacts.Count != 1)
            {
                ResetStability();
                return;
            }

            BoardContact contact = contacts[0];
            if (contact.normalizedPressure < minimumConfidence)
            {
                rejectedByPressure = true;
                lastRejectedPressure = contact.pressure;
                ResetStability();
                return;
            }

            rejectedByPressure = false;

            Vector2 position = contact.boardUv;
            Vector2 average = AverageStablePositions();
            if (stablePositions.Count > 0 && CellDistance(position, average) > stableRadiusCells)
            {
                ResetStability();
            }

            stablePositions.Add(position);
            stableTime += Time.unscaledDeltaTime;
            if (stableTime < holdDuration)
            {
                return;
            }

            CapturePoint(AverageStablePositions(), contact.normalizedPressure);
            waitForRelease = true;
            ResetStability();
        }

        private void CapturePoint(Vector2 actualBoardUv, float confidence)
        {
            if (State == ProjectionCalibrationState.CollectingPrimary)
            {
                lastCaptureDeviationCells = CellDistance(activeExpectedBoardPoint, actualBoardUv);
                samples.Add(new CalibrationSample(activeProjectorPoint, actualBoardUv, confidence));
                pointIndex++;
                if (pointIndex >= ActivePrimaryTargets.Length)
                {
                    SolvePrimarySamples();
                }
                else
                {
                    ShowPrimaryPoint();
                }
                return;
            }

            if (State == ProjectionCalibrationState.Validating)
            {
                Vector2 expected = ActiveValidationPoints[pointIndex];
                validationErrors.Add(CellDistance(expected, actualBoardUv));
                samples.Add(new CalibrationSample(activeProjectorPoint, actualBoardUv, confidence));
                pointIndex++;
                if (pointIndex >= ActiveValidationPoints.Length)
                {
                    FinishValidationRound();
                }
                else
                {
                    ShowValidationPoint();
                }
            }
        }

        private void SolvePrimarySamples()
        {
            State = ProjectionCalibrationState.Solving;
            HomographySolveResult result = HomographySolver.Solve(samples);
            if (!result.success)
            {
                Fail(result.error);
                return;
            }

            result = ResolveMatOrder(result);
            result = NormaliseBoardOrientation(result);
            alignment.SetMatrix(result.projectorToBoard, false);
            BeginValidationRound();
        }

        /// <summary>
        /// Works out which physical mat is the left one, from the samples alone.
        ///
        /// The serial ports enumerate in whatever order the OS feels like, which says nothing
        /// about how the mats were laid out, so the tiling starts as a coin flip. Getting it
        /// wrong shifts every reading from one mat by half the interactive area — a
        /// discontinuity no single homography can absorb. So: re-express the samples under the
        /// other assignment, solve again, and keep whichever fit is tighter. A wrong assignment
        /// loses by a wide margin, which is why the primary set has five points on two mats
        /// rather than four; with four the fit is exact either way and the question is
        /// unanswerable.
        ///
        /// This runs before the orientation search, and the two do not interfere: mirroring
        /// the whole area is a projective transform that both assignments absorb equally, so
        /// the winner here stays the winner whatever flips get chosen afterwards.
        /// </summary>
        private HomographySolveResult ResolveMatOrder(HomographySolveResult current)
        {
            if (appliedBoardCount < 2 || pressureInput.SwapXY)
            {
                return current;
            }

            var swappedSamples = new List<CalibrationSample>(samples.Count);
            for (int index = 0; index < samples.Count; index++)
            {
                CalibrationSample sample = samples[index];
                swappedSamples.Add(new CalibrationSample(
                    sample.projectorUv,
                    SwapMatHalves(sample.boardUv, appliedBoardCount),
                    sample.confidence));
            }

            HomographySolveResult swapped = HomographySolver.Solve(swappedSamples);
            if (!swapped.success || swapped.rmsError >= current.rmsError)
            {
                return current;
            }

            for (int index = 0; index < samples.Count; index++)
            {
                samples[index] = swappedSamples[index];
            }

            pressureInput.ToggleBoardSwap();
            Debug.Log("[ProjectionAlignment] 两块压力板左右接反，已自动对调："
                + $"拟合误差 {current.rmsError:F4} → {swapped.rmsError:F4}", this);
            return swapped;
        }

        /// <summary>
        /// Moves a board coordinate one mat to the left or right, wrapping — the coordinate
        /// change that corresponds to exchanging which mat is tiled first.
        /// </summary>
        private static Vector2 SwapMatHalves(Vector2 boardUv, int boardCount)
        {
            float share = 1f / Mathf.Max(1, boardCount);
            float shifted = boardUv.x + share;
            if (shifted > 1f)
            {
                shifted -= 1f;
            }

            return new Vector2(shifted, boardUv.y);
        }

        /// <summary>
        /// A mat rotated or mirrored relative to the projector makes the solver
        /// return a homography carrying that rotation, and the shader then rotates
        /// the whole picture to compensate — alignment is correct but the content
        /// is sideways. The rotation belongs on the input side instead: pick the
        /// swap/flip triple that leaves the homography upright, re-express the
        /// samples in it, and re-solve. The picture keeps the projector's own
        /// orientation and the mat coordinates are rotated to match.
        /// </summary>
        private HomographySolveResult NormaliseBoardOrientation(HomographySolveResult current)
        {
            bool fromSwap = pressureInput.SwapXY;
            bool fromFlipX = pressureInput.FlipX;
            bool fromFlipY = pressureInput.FlipY;

            float bestScore = UprightScore(current.projectorToBoard);
            bool bestSwap = fromSwap;
            bool bestFlipX = fromFlipX;
            bool bestFlipY = fromFlipY;
            HomographySolveResult best = current;
            var candidateSamples = new List<CalibrationSample>(samples.Count);

            for (int mask = 0; mask < 8; mask++)
            {
                bool swap = (mask & 1) != 0;
                bool flipX = (mask & 2) != 0;
                bool flipY = (mask & 4) != 0;
                if (swap == fromSwap && flipX == fromFlipX && flipY == fromFlipY)
                {
                    continue;
                }

                // On a pair, SwapXY is not just a relabelling: the tiling axis follows it, so
                // flipping it re-tiles the raw frame and every sample was measured under the
                // old tiling. ReinterpretBoardUv cannot express that — it rewrites coordinates
                // and assumes the readings behind them stand. So two mats leave four
                // candidates, and getting SwapXY wrong is a failed validation the operator
                // fixes with key 1, not something to solve for here.
                if (swap != fromSwap && appliedBoardCount > 1)
                {
                    continue;
                }

                candidateSamples.Clear();
                for (int index = 0; index < samples.Count; index++)
                {
                    CalibrationSample sample = samples[index];
                    Vector2 reinterpreted = ProjectionCoordinateMapper.ReinterpretBoardUv(
                        sample.boardUv,
                        fromSwap, fromFlipX, fromFlipY,
                        swap, flipX, flipY);
                    candidateSamples.Add(new CalibrationSample(
                        sample.projectorUv, reinterpreted, sample.confidence));
                }

                HomographySolveResult candidate = HomographySolver.Solve(candidateSamples);
                if (!candidate.success)
                {
                    continue;
                }

                float score = UprightScore(candidate.projectorToBoard);
                if (score > bestScore)
                {
                    bestScore = score;
                    bestSwap = swap;
                    bestFlipX = flipX;
                    bestFlipY = flipY;
                    best = candidate;
                }
            }

            if (bestSwap == fromSwap && bestFlipX == fromFlipX && bestFlipY == fromFlipY)
            {
                return current;
            }

            for (int index = 0; index < samples.Count; index++)
            {
                CalibrationSample sample = samples[index];
                samples[index] = new CalibrationSample(
                    sample.projectorUv,
                    ProjectionCoordinateMapper.ReinterpretBoardUv(
                        sample.boardUv,
                        fromSwap, fromFlipX, fromFlipY,
                        bestSwap, bestFlipX, bestFlipY),
                    sample.confidence);
            }

            pressureInput.SetOrientation(bestSwap, bestFlipX, bestFlipY);
            Debug.Log($"[ProjectionAlignment] 画面朝向已归正：SwapXY={bestSwap} FlipX={bestFlipX} FlipY={bestFlipY}", this);
            return best;
        }

        /// <summary>
        /// 2.0 when the projected image's X axis runs along the mat's X axis and its
        /// Y axis along the mat's Y axis — i.e. the homography carries no rotation
        /// or mirroring and the content will appear the right way up.
        /// </summary>
        private static float UprightScore(Matrix4x4 projectorToBoard)
        {
            var centre = new Vector2(0.5f, 0.5f);
            const float step = 0.05f;
            if (!HomographyUtility.TryApply(projectorToBoard, centre, out Vector2 boardCentre)
                || !HomographyUtility.TryApply(projectorToBoard, centre + new Vector2(step, 0f), out Vector2 boardRight)
                || !HomographyUtility.TryApply(projectorToBoard, centre + new Vector2(0f, step), out Vector2 boardDown))
            {
                return float.NegativeInfinity;
            }

            Vector2 alongX = boardRight - boardCentre;
            Vector2 alongY = boardDown - boardCentre;
            if (alongX.sqrMagnitude < 1e-10f || alongY.sqrMagnitude < 1e-10f)
            {
                return float.NegativeInfinity;
            }

            return alongX.normalized.x + alongY.normalized.y;
        }

        private void BeginValidationRound()
        {
            State = ProjectionCalibrationState.Validating;
            pointIndex = 0;
            validationErrors.Clear();
            waitForRelease = true;
            ResetStability();
            ShowValidationPoint();
        }

        /// <summary>
        /// Puts the round's numbers in the console. The on-table verdict lasts seven seconds
        /// and nothing else records it, so a failed calibration used to leave no trace at all —
        /// the only way to tell afterwards was that no file had been written. Per-point errors
        /// are what name the culprit: all bad on one mat is a mat problem, all bad vertically
        /// is a scale problem, one bad point is a mis-step.
        /// </summary>
        private void LogValidationRound(bool passed)
        {
            Vector2[] points = ActiveValidationPoints;
            var report = new System.Text.StringBuilder();
            report.Append($"[ProjectionAlignment] 验证第 {currentRefinementRound + 1} 轮 ")
                .Append(passed ? "通过" : "未通过")
                .Append($"：RMS {LastRmsErrorCells:F2} 格，最大 {LastMaxErrorCells:F2} 格")
                .Append($"（阈值 {targetRmsErrorCells:F1} / {targetMaxErrorCells:F1}），")
                .Append($"{appliedBoardCount} 块板，板坐标 {pressureInput.BoardResolution.x}×")
                .Append($"{pressureInput.BoardResolution.y} 格");
            for (int index = 0; index < validationErrors.Count && index < points.Length; index++)
            {
                report.Append($"\n  点 {index + 1}{DescribeTargetMat(points[index])} ")
                    .Append($"期望 B=({points[index].x:F2}, {points[index].y:F2})  ")
                    .Append($"误差 {validationErrors[index]:F2} 格");
            }

            // Signed residuals of the refit, per sample. Their pattern names the cause of a
            // misfit that the RMS alone hides: one mat's y all one sign = that mat sits
            // higher; everything one sign = a shared press offset, which no round can see.
            Matrix4x4 solved = alignment.ProjectorToBoardMatrix;
            Vector2Int resolution = pressureInput.BoardResolution;
            for (int index = 0; index < samples.Count; index++)
            {
                CalibrationSample sample = samples[index];
                if (!HomographyUtility.TryApply(solved, sample.projectorUv, out Vector2 predicted))
                {
                    continue;
                }

                Vector2 residual = predicted - sample.boardUv;
                report.Append($"\n  样本 {index + 1}{DescribeTargetMat(sample.boardUv)} ")
                    .Append($"P=({sample.projectorUv.x:F3}, {sample.projectorUv.y:F3}) ")
                    .Append($"B=({sample.boardUv.x:F3}, {sample.boardUv.y:F3}) ")
                    .Append($"残差=({residual.x * resolution.x:+0.00;-0.00}, {residual.y * resolution.y:+0.00;-0.00}) 格");
            }

            if (appliedBoardCount > 1)
            {
                report.Append('\n').Append(DescribeSeamEstimate().Trim());
            }

            if (passed)
            {
                Debug.Log(report.ToString(), this);
            }
            else
            {
                Debug.LogWarning(report.ToString(), this);
            }
        }

        /// <summary>
        /// Reads the seam width back out of the samples that were just collected.
        ///
        /// The seam is one scalar on top of the homography's eight, so it can be searched for
        /// directly: re-express every sample as if the strip were this wide, solve, and keep
        /// whichever width the points agree on best. Getting it wrong offsets one mat's
        /// readings bodily, which no homography can absorb, so the residual has a clear
        /// minimum. Ten points put the standard deviation around 7 mm — good enough to catch a
        /// seam nobody accounted for, not good enough to beat a ruler, which is why this only
        /// reports and never silently changes the geometry a calibration was just solved on.
        /// </summary>
        private bool TryEstimateSeamGapCm(out float estimateCm, out float currentRms, out float bestRms)
        {
            estimateCm = 0f;
            currentRms = 0f;
            bestRms = 0f;
            if (appliedBoardCount < 2 || samples.Count < 8 || pressureInput == null)
            {
                return false;
            }

            float current = pressureInput.SeamGapCm;
            bool flipX = pressureInput.FlipX;
            var candidate = new List<CalibrationSample>(samples.Count);

            HomographySolveResult asIs = HomographySolver.Solve(samples);
            if (!asIs.success)
            {
                return false;
            }

            currentRms = asIs.rmsError;
            bestRms = asIs.rmsError;
            estimateCm = current;

            for (float gap = 0f; gap <= MaximumSeamGapCm + 0.001f; gap += SeamSearchStepCm)
            {
                candidate.Clear();
                for (int index = 0; index < samples.Count; index++)
                {
                    CalibrationSample sample = samples[index];
                    float x = ProjectionCoordinateMapper.ReexpressAcrossSeam(
                        sample.boardUv.x, appliedBoardCount, current, gap, flipX);
                    candidate.Add(new CalibrationSample(
                        sample.projectorUv, new Vector2(x, sample.boardUv.y), sample.confidence));
                }

                HomographySolveResult result = HomographySolver.Solve(candidate);
                if (result.success && result.rmsError < bestRms)
                {
                    bestRms = result.rmsError;
                    estimateCm = gap;
                }
            }

            return true;
        }

        /// <summary>
        /// Says what the samples think the seam is, next to what the rig is using. Deliberately
        /// advisory: adopting it would invalidate the matrix solved moments ago in the old
        /// geometry, so the operator sets it with 7 / 8 and runs one more calibration.
        /// </summary>
        private string DescribeSeamEstimate()
        {
            float estimate, currentRms, bestRms;
            if (!TryEstimateSeamGapCm(out estimate, out currentRms, out bestRms))
            {
                return string.Empty;
            }

            float scale = pressureInput.BoardResolution.x;
            float current = pressureInput.SeamGapCm;
            if (Mathf.Abs(estimate - current) < SeamAdjustStepCm * 0.5f)
            {
                return $"　接缝 {current:F1} cm 与样本一致（拟合 {currentRms * scale:F2} 格）。";
            }

            return $"　接缝：当前设定 {current:F1} cm，但样本更像 {estimate:F1} cm"
                + $"（拟合 {currentRms * scale:F2} → {bestRms * scale:F2} 格）。"
                + "按 7 / 8 调到该值后重标一次可拿到这个收益。";
        }

        private void FinishValidationRound()
        {
            CalculateValidationError();
            HomographySolveResult refined = HomographySolver.Solve(samples);
            if (!refined.success)
            {
                Fail(refined.error);
                return;
            }

            alignment.SetMatrix(refined.projectorToBoard, false);
            bool passed = LastRmsErrorCells <= targetRmsErrorCells
                       && LastMaxErrorCells <= targetMaxErrorCells;
            LogValidationRound(passed);
            if (!passed && currentRefinementRound < refinementRounds)
            {
                currentRefinementRound++;
                statusMessage = $"误差 {LastRmsErrorCells:F2} 格，正在进行第 {currentRefinementRound + 1} 轮验证。";
                BeginValidationRound();
                return;
            }

            if (!passed)
            {
                Fail($"验证未通过：RMS {LastRmsErrorCells:F2} 格，最大 {LastMaxErrorCells:F2} 格。"
                    + (appliedBoardCount > 1
                        ? DescribeSeamEstimate() + "另外检查：两块是否同朝向（接线口朝同一边）、是否歪斜。"
                          + "程序能吃掉左右接反和已设定的接缝宽度，吃不掉歪斜。"
                        : string.Empty));
                return;
            }

            alignment.SetMatrix(refined.projectorToBoard, true);
            if (!alignment.SaveCalibration(samples, LastRmsErrorCells, LastMaxErrorCells, pressureInput, out string saveError))
            {
                Fail($"校准有效，但保存失败：{saveError}");
                return;
            }

            alignment.HideCalibrationMarker();
            State = ProjectionCalibrationState.Ready;
            sessionResultTitle = "校正完成";
            statusMessage = $"物理映射已校准：RMS {LastRmsErrorCells:F2} 格，最大 {LastMaxErrorCells:F2} 格。"
                + "完整16:9画面正在预畸变输出。" + DescribeSeamEstimate();
            Debug.Log($"[ProjectionAlignment] 校正完成并已保存：{appliedBoardCount} 块板，"
                + $"RMS {LastRmsErrorCells:F2} 格，最大 {LastMaxErrorCells:F2} 格，样本 {samples.Count} 个 → "
                + ProjectionCalibrationStore.FilePath, this);
        }

        private void ShowPrimaryPoint()
        {
            activeExpectedBoardPoint = ActivePrimaryTargets[pointIndex];
            if (!alignment.TryBoardToProjector(activeExpectedBoardPoint, out activeProjectorPoint)
                || !ProjectionCoordinateMapper.IsInsideUnitSquare(activeProjectorPoint))
            {
                Fail("理论标定点超出投影输出。请移动投影仪，让梯形光斑覆盖压力板后重试。");
                return;
            }

            alignment.ShowCalibrationMarker(activeProjectorPoint, new Color(1f, 0.2f, 0.05f, 1f));
            string previous = pointIndex > 0 ? $" 上一点偏差 {lastCaptureDeviationCells:F1} 格。" : string.Empty;
            Vector2Int cells = ExpectedBoardCell(activeExpectedBoardPoint);
            statusMessage = $"物理标定 {pointIndex + 1}/{ActivePrimaryTargets.Length}"
                + $"{DescribeTargetMat(activeExpectedBoardPoint)}：理论板坐标 "
                + $"({cells.x}, {cells.y})，"
                + $"请把指尖或棋子底座压在橙圈正中、四周露出圈；程序记录压力板实际坐标。{previous}";
        }

        private void ShowValidationPoint()
        {
            Vector2 expectedBoardUv = ActiveValidationPoints[pointIndex];
            if (!alignment.TryBoardToProjector(expectedBoardUv, out activeProjectorPoint)
                || !ProjectionCoordinateMapper.IsInsideUnitSquare(activeProjectorPoint))
            {
                Fail("验证点超出投影输出范围，请调整投影仪使光斑完整覆盖压力板。");
                return;
            }

            alignment.ShowCalibrationMarker(activeProjectorPoint, new Color(0.1f, 1f, 0.35f, 1f));
            statusMessage = $"验证 {pointIndex + 1}/{ActiveValidationPoints.Length}：同样压在绿圈正中。"
                + DescribeTargetMat(expectedBoardUv);
        }

        /// <summary>
        /// Which mat a target sits on, for the instruction text. Only worth saying when there
        /// is more than one: "left mat" is the difference between walking to the right place
        /// and hunting for a dot.
        /// </summary>
        private string DescribeTargetMat(Vector2 boardUv)
        {
            if (appliedBoardCount < 2)
            {
                return string.Empty;
            }

            return boardUv.x < 0.5f ? "（左板）" : "（右板）";
        }

        /// <summary>
        /// A board UV as a sensor cell, which is what the operator can count on the mat. The
        /// horizontal axis spans every mat, so on a two-mat rig it runs 0..199, not 0..99.
        /// </summary>
        private Vector2Int ExpectedBoardCell(Vector2 boardUv)
        {
            Vector2Int resolution = pressureInput != null
                ? pressureInput.BoardResolution
                : new Vector2Int(100, 100);

            return new Vector2Int(
                Mathf.RoundToInt(boardUv.x * Mathf.Max(1, resolution.x - 1)),
                Mathf.RoundToInt(boardUv.y * Mathf.Max(1, resolution.y - 1)));
        }

        /// <summary>
        /// Rejects a calibration whose points would land on the seam between two mats. That
        /// strip reads nothing, so the session would stall on a marker nobody can trigger —
        /// with no way to tell it apart from a mat that is simply not responding.
        /// </summary>
        private bool ValidatePointsClearOfSeam(out string error)
        {
            error = string.Empty;
            if (appliedBoardCount < 2)
            {
                return true;
            }

            for (int index = 0; index < ActivePrimaryTargets.Length; index++)
            {
                if (Mathf.Abs(ActivePrimaryTargets[index].x - 0.5f) < SeamClearanceBoardUv)
                {
                    error = $"主标定点 {index + 1} 落在两块板的接缝上（x={ActivePrimaryTargets[index].x:F2}），"
                        + "那条缝不出数据，按不出来。请把它挪开接缝至少 3 cm。";
                    return false;
                }
            }

            Vector2[] validation = ActiveValidationPoints;
            for (int index = 0; index < validation.Length; index++)
            {
                if (Mathf.Abs(validation[index].x - 0.5f) < SeamClearanceBoardUv)
                {
                    error = $"验证点 {index + 1} 落在两块板的接缝上（x={validation[index].x:F2}），"
                        + "那条缝不出数据，按不出来。请把它挪开接缝至少 3 cm。";
                    return false;
                }
            }

            return true;
        }

        /// <summary>
        /// A board-UV distance in sensor cells. Cells are 5 mm square but board UV is not:
        /// with two mats the horizontal axis spans 200 cells and the vertical 100, so scaling
        /// a distance by one scalar counts vertical error at double. That is the difference
        /// between a calibration that passes and one that fails for no visible reason.
        /// </summary>
        private float CellDistance(Vector2 a, Vector2 b)
        {
            Vector2Int resolution = pressureInput != null
                ? pressureInput.BoardResolution
                : new Vector2Int(100, 100);
            Vector2 delta = a - b;
            return new Vector2(
                delta.x * Mathf.Max(1, resolution.x),
                delta.y * Mathf.Max(1, resolution.y)).magnitude;
        }

        private void CalculateValidationError()
        {
            float sumSquared = 0f;
            float maximum = 0f;
            for (int index = 0; index < validationErrors.Count; index++)
            {
                float cells = validationErrors[index];
                sumSquared += cells * cells;
                maximum = Mathf.Max(maximum, cells);
            }

            LastRmsErrorCells = validationErrors.Count > 0
                ? Mathf.Sqrt(sumSquared / validationErrors.Count)
                : float.PositiveInfinity;
            LastMaxErrorCells = maximum;
        }

        /// <summary>
        /// Everything a session may have changed goes back together. The matrix alone is not
        /// enough: mat order and swap/flip are rewritten by the solve, and a session that then
        /// fails would leave the previous matrix driving input measured in a different frame —
        /// mirrored touches until the next successful calibration.
        /// </summary>
        private void RestoreSessionBackup()
        {
            if (alignment != null)
            {
                alignment.SetMatrix(backupMatrix, backupWasCalibrated);
                if (backupWasCalibrated)
                {
                    alignment.RestoreImageShift(backupShiftCm);
                }

                alignment.HideCalibrationMarker();
            }

            if (pressureInput != null)
            {
                pressureInput.SetOrientation(sessionSwapXY, sessionFlipX, sessionFlipY);
                if (pressureInput.BoardsSwapped != sessionBoardsSwapped)
                {
                    pressureInput.ToggleBoardSwap();
                }
            }
        }

        private void Fail(string message)
        {
            RestoreSessionBackup();
            State = ProjectionCalibrationState.Failed;
            sessionResultTitle = "校正失败";
            statusMessage = message;
            ResetStability();

            // The matrix has just gone back to the backup. If that backup was never calibrated,
            // the rig is now running the preview mapping, which applies no pre-distortion at
            // all — the projector's own keystone lands on the table untouched. Say so, because
            // "the picture is a trapezoid" is exactly what that looks like from the room.
            Debug.LogWarning($"[ProjectionAlignment] 校正失败：{message}"
                + (alignment != null && !alignment.HasValidCalibration
                    ? "　已退回未校正状态：画面不做预畸变，投影仪自身的梯形会原样落在桌面上。"
                    : "　已退回上一次成功的标定。"), this);
        }

        // ---- 实物上色层（2026-08-31 起：单应锚定射线层，见 ProjectorCameraRig 类注释）----
        // 不再从单应反解位姿：近垂直吊装的投影仪给出的单应接近仿射，位姿在数学上不存在，
        // 而且新投影仪的内参拿不到。整条链的唯一未知量是**镜头的三维位置 C**（垫面厘米），
        // 三个数都能用卷尺量个大概，再照着验证靶拧准。存 PlayerPrefs —— 它们是这套吊装的
        // 物理常数，与画面分辨率无关，所以编辑器和打包版**共用同一组值**（旧投射比时代
        // 两边必须不同的那条规则作废）。
        // 旧键 ProjectionAlignment.PoseThrow / MirrorAcrossY 已无人读，躺在磁盘上可忽略。
        private Vector3 lensCm = new Vector3(float.NaN, float.NaN, ProjectorCameraRig.DefaultLensHeightCm);
        private int lensKnob;                       // 9/0 正在拧哪个分量:0=高度 1=左右(x) 2=前后(y)
        private float lensRepeatAt;
        private const float LensStepCm = 1f;        // 每按一下 1cm —— 厘米是线性的，没有旧投射比的「越拧越钝」
        private static readonly string[] LensKnobNames = { "高度", "左右", "前后" };

        // 上一次架层用的板框架。生效中的框架可能来自外部（DarkwaterM0 把它锚在棋盘上），
        // 9/0/B 重架时必须沿用，不能退回隐藏角落的默认框架。
        private Matrix4x4 colorFrame;
        private bool colorFrameSet;
        private bool colorFrameExternal;
        // 这一层是不是**外部宿主**（DarkwaterM0 托管）架起来的。是的话它退场时整层拆掉：
        // 外壳里本来就没有上色层，退回默认框架等于在游戏库画面上白留一圈红色垫子轮廓线。
        private bool colorLayerSpawnedByExternal;
        private float colorUnitsPerCm = 1f;
        private float colorMatWidthCm = 100f;
        private float colorMatHeightCm = 50f;

        // N 的短按/长按。短按 = 点亮或换落点，长按 = 收起（见 HandleKeyboard 里那段）。
        // 0.6s：比手快按一下长得多，又短到按着不会以为没反应。
        private const float TestSolidsHideHoldSeconds = 0.6f;
        private float nHeldSince = -1f;
        private bool nHoldConsumed;

        private void LoadPoseOverrides()
        {
            lensCm = ProjectorCameraRig.LoadLensCm();
        }

        /// <summary>当前旋钮值（NaN 分量落到垫子正中/默认高之后）。</summary>
        private Vector3 ResolvedLensCm()
            => ProjectorCameraRig.ResolveLensCm(lensCm, colorMatWidthCm, colorMatHeightCm);

        /// <summary>
        /// 供外部（DarkwaterM0 的物理桌面模式）架上色层：框架由调用方给（锚在棋盘上），
        /// 旋钮、验证靶、按键都归本控制器管。
        /// </summary>
        public void SetupPropColoring(
            Matrix4x4 boardUvToWorld, float unitsPerCm, float matWidthCm, float matHeightCm)
        {
            // 头一回从外部架：记下这一层本来有没有。没有的话宿主退场时要整层拆掉。
            if (!colorFrameExternal)
                colorLayerSpawnedByExternal = FindFirstObjectByType<ProjectorCameraRig>() == null;
            colorFrame = boardUvToWorld;
            colorFrameSet = true;
            colorFrameExternal = true;
            colorUnitsPerCm = unitsPerCm;
            colorMatWidthCm = matWidthCm;
            colorMatHeightCm = matHeightCm;
            ApplyPropColoring(quiet: true);
        }

        /// <summary>
        /// 外部框架退场（DarkwaterM0 交还）。
        ///
        /// 进游戏前外壳里**本来就没有上色层**（是宿主架起来的）就整层拆掉：退回默认框架的话，
        /// 验证靶会照默认值把那圈**红色垫子轮廓线**再画一遍 —— 那是标定判据，不是游戏库画面的一部分。
        /// 之前就架着（有人按过 Z）才退回隐藏角落的默认框架，保住操作员要的那一层。
        /// </summary>
        public void ClearExternalColoringFrame()
        {
            if (!colorFrameExternal) return;
            colorFrameExternal = false;
            colorFrameSet = false;

            var rig = FindFirstObjectByType<ProjectorCameraRig>();
            if (rig == null) { colorLayerSpawnedByExternal = false; return; }

            if (colorLayerSpawnedByExternal)
            {
                colorLayerSpawnedByExternal = false;
                rig.Teardown();   // 验证靶是挂在 rig 上的组件，跟着一起没
                statusMessage = "上色层已拆（进游戏前本来就没架）。要用按 Z 重架。";
                return;
            }

            SetupPropColoring(quiet: true);
        }

        /// <summary>
        /// 架起实物上色层（`Z`）。读的是 <see cref="alignment"/> 当前那份标定，所以
        /// 「重做戳点校正 → 按 Z」就是完整流程。没有外部框架时用一个藏在世界角落的默认框架 ——
        /// 框架的世界端在哪无所谓，C、验证靶、shader 三方共用同一个就自洽。
        /// </summary>
        private void SetupPropColoring(bool quiet = false)
        {
            if (alignment == null)
            {
                statusMessage = "没有对齐组件，上色层架不起来。";
                return;
            }

            if (!colorFrameExternal)
            {
                // ⚠ 垫子尺寸必须取**标定当时**的板数/接缝，不能取实时压感硬件的 ——
                // 单应是按标定时那副垫子解出来的。`alignment` 这两个值从 interaction rect 派生，
                // 随标定一起存读，天然同源。
                int boards = alignment.BoardCount;
                float seamCm = alignment.SeamGapCm;
                if (pressureInput != null && pressureInput.HasConnectedHardware && pressureInput.BoardCount != boards)
                {
                    Debug.LogWarning($"[ProjectionAlignment] 实时压感是 {pressureInput.BoardCount} 块板，"
                        + $"但当前标定是按 {boards} 块解的。上色层按标定那份算；两者不一致时该重做戳点校正。", this);
                }
                colorMatWidthCm = ProjectionCoordinateMapper.AreaWidthCm(boards, seamCm);
                colorMatHeightCm = ProjectionCoordinateMapper.MatEdgeCm;
                colorUnitsPerCm = 1f;
                // 隐藏框架：藏在世界下方远处（映射层物件只该被 rig 相机看到）；1 单位 = 1cm。
                var origin = new Vector3(0f, -500f, 0f);
                colorFrame = new Matrix4x4(
                    new Vector4(colorMatWidthCm, 0f, 0f, 0f),          // 板 U → +X
                    new Vector4(0f, 0f, colorMatHeightCm, 0f),         // 板 V → +Z
                    new Vector4(0f, 1f, 0f, 0f),                       // 高度 → +Y，每厘米 1 单位
                    new Vector4(origin.x, origin.y, origin.z, 1f));
                colorFrameSet = true;
                // 站在默认框架上的层是**操作员**按 Z（或面板）架的，不再归任何宿主，
                // 宿主退场时不该被拆。
                colorLayerSpawnedByExternal = false;
            }

            ApplyPropColoring(quiet);
        }

        private void ApplyPropColoring(bool quiet)
        {
            if (!colorFrameSet)
            {
                SetupPropColoring(quiet);
                return;
            }

            var rig = FindFirstObjectByType<ProjectorCameraRig>() ?? CreateProjectorRig();
            bool ok = rig.ApplyPlaneAnchored(
                colorFrame, colorUnitsPerCm, colorMatWidthCm, colorMatHeightCm, ResolvedLensCm());
            statusMessage = rig.LastMessage
                          + $"　B=切旋钮（当前 {LensKnobNames[lensKnob]}）　9/0=∓{LensStepCm:0}cm";
            if (!quiet) Debug.Log($"[ProjectionAlignment] 实物上色层：{rig.LastMessage}", this);
            if (!ok) return;

            var target = FindFirstObjectByType<ProjectionMappedTestTarget>();
            if (target == null) target = rig.gameObject.AddComponent<ProjectionMappedTestTarget>();
            target.Build(rig, colorMatWidthCm * 10f, colorMatHeightCm * 10f);
            if (!quiet)
            {
                statusMessage += "　" + target.LastReport;
                Debug.Log($"[ProjectionAlignment] 验证靶：{target.LastReport}", this);
            }
        }

        /// <summary>
        /// 短按 `N`：立体件收着就点出来（落在当前范围的正中），已经亮着就巡到下一个预设落点。
        /// 方块永远跟着圆柱走 —— 它俩是同一件靶的两个落点，分开挪就失去了「对比」这个用处。
        /// </summary>
        private void ShowOrCycleTestSolids()
        {
            if (!TryGetTestTarget(out var t, out var r)) return;
            float wMm = colorMatWidthCm * 10f, hMm = colorMatHeightCm * 10f;
            if (!t.CylinderVisible)
            {
                t.CylinderVisible = true;
                // 第一次点亮先落到当前范围的正中：序列化的默认落点是按整块垫子算的，
                // 托管时范围已收到棋盘，不归零的话第一下就投到棋盘外面去了。
                if (t.PresetIndex < 0) t.CyclePreset(wMm, hMm);
                t.Build(r, wMm, hMm);
                statusMessage = $"验证靶已点亮（再按 N 换落点，长按 N 收起）　{t.LastReport}";
            }
            else
            {
                string where = t.CyclePreset(wMm, hMm);
                t.Build(r, wMm, hMm);
                statusMessage = $"落点 → {where}（长按 N 收起）　{t.LastReport}";
            }
        }

        /// <summary>长按 `N`：把立体件收回去，桌上只剩游戏画面（和轮廓线，若开着）。</summary>
        private void HideTestSolids()
        {
            if (!TryGetTestTarget(out var t, out var r)) return;
            if (!t.CylinderVisible) return;
            t.CylinderVisible = false;
            t.Build(r, colorMatWidthCm * 10f, colorMatHeightCm * 10f);
            statusMessage = $"验证靶已收起（按 N 点出来）　{t.LastReport}";
        }

        private bool TryGetTestTarget(out ProjectionMappedTestTarget target, out ProjectorCameraRig rig)
        {
            target = FindFirstObjectByType<ProjectionMappedTestTarget>();
            rig = FindFirstObjectByType<ProjectorCameraRig>();
            if (target == null || rig == null || !colorFrameSet)
            {
                statusMessage = "还没有验证靶 —— 先按 Z 架上色层。";
                return false;
            }
            return true;
        }

        /// <summary>
        /// 运行时建投影仪相机装置(与 ReachLab / ProjectorCameraTakeover 同一条惯例:不进场景文件)。
        ///
        /// 锚点刻意放在世界原点**下方很远处**:映射层的物件只该被投影仪相机看到,
        /// 但万一某台游戏相机的 cullingMask 是 Everything,它们就会在游戏画面里也冒出来。
        /// 挪到视锥外是零风险的隔离手段,比去改别人的 cullingMask 干净。
        /// </summary>
        private ProjectorCameraRig CreateProjectorRig()
        {
            var go = new GameObject("ProjectorCameraRig (runtime)");
            // ⚠ 必须搬进**装置自己的场景**。new GameObject 落在当前活动场景 —— 托管时活动场景
            // 是被托管的游戏，rig 会随游戏卸载一起死，装置画布上留一张引用已死 RT 的 RawImage，
            // 回外壳后上色层也没法重建（实测 2026-08-31 踩到）。
            UnityEngine.SceneManagement.SceneManager.MoveGameObjectToScene(go, gameObject.scene);
            go.transform.position = new Vector3(0f, -500f, 0f);
            var rig = go.AddComponent<ProjectorCameraRig>();
            rig.Configure(alignment);
            return rig;
        }

        private void HandleKeyboard()
        {
            Keyboard keyboard = Keyboard.current;
            if (keyboard == null)
            {
                return;
            }

            // The ring owns input above every hosted game; fields must not trigger legacy hotkeys.
            if (HandleOperatorMenuKeyboard(keyboard)) return;

            // C is a toggle rather than a start, so calibration can be dropped into and
            // backed out of at any point in a running game with one key.
            if (keyboard.cKey.wasPressedThisFrame)
            {
                ToggleCalibration();
            }
            if (keyboard.rKey.wasPressedThisFrame)
            {
                ResetCalibration();
            }
            if (keyboard.gKey.wasPressedThisFrame && alignment != null)
            {
                alignment.SetGridVisible(!alignment.ShowBoardGrid);
            }
            if (keyboard.mKey.wasPressedThisFrame && displayRouter != null && !IsCalibrating)
            {
                displayRouter.CycleDisplay();
                statusMessage = displayRouter.StatusMessage;
            }
            if (keyboard.fKey.wasPressedThisFrame && alignment != null && !IsCalibrating)
            {
                alignment.SetGuidesVisible(!alignment.GuidesVisible);
                statusMessage = alignment.GuidesVisible
                    ? "已显示对齐参考（16:9 框、压感区框、实时压力点）。"
                    : "已隐藏对齐参考，投影上只剩游戏画面。";
            }
            if (keyboard.escapeKey.wasPressedThisFrame
                && (State == ProjectionCalibrationState.CollectingPrimary || State == ProjectionCalibrationState.Validating))
            {
                CancelCalibration();
            }

            // Z = 架起实物上色层（rig 相机站到镜头位置 C、建验证靶）。只读当前标定；
            // 平面预畸变链不受影响。仍建议先关掉投影仪的自动梯形校正再标定 —— 不关也能上色
            // （形变被单应吸收），但标定期间机内自适应若中途改画面，单应就作废了。
            if (keyboard.zKey.wasPressedThisFrame && !IsCalibrating)
            {
                SetupPropColoring();
            }
            // V = 摆放模式开关:只投落脚圆 ⇄ 投完整色带靶。
            // 摆实物时要的是一个干净的落脚圆,色带会把它遮掉大半(理由见 ProjectionMappedTestTarget)。
            if (keyboard.vKey.wasPressedThisFrame && !IsCalibrating)
            {
                var t = FindFirstObjectByType<ProjectionMappedTestTarget>();
                var r = FindFirstObjectByType<ProjectorCameraRig>();
                if (t == null || r == null || !colorFrameSet)
                {
                    statusMessage = "还没有验证靶 —— 先按 Z 架上色层。";
                }
                else
                {
                    t.TogglePlacementMode();
                    t.Build(r, colorMatWidthCm * 10f, colorMatHeightCm * 10f);
                    statusMessage = t.LastReport;
                }
            }
            // N = 验证靶的立体件（圆柱 + 跟着它的 2cm 方块）。**短按**：收着就点出来，
            // 亮着就巡到下一个预设落点（正中 / 左中 / 右中 / 近边中 / 远边中）——
            // 巡游是在**验覆盖范围**：偏差随离镜头铅垂点的距离长，边上的点才是判据。
            // **长按**：收起来。默认就是收起来的，桌上不平白多一摊彩色光斑。
            if (!IsCalibrating)
            {
                if (keyboard.nKey.wasPressedThisFrame) { nHeldSince = Time.unscaledTime; nHoldConsumed = false; }
                // 按满就立刻收，不等松手 —— 现场按着的人当场看见反应；同时把这次按键记成
                // 已消费，松手那一帧就不会再走短按那一支（否则长按会「收起又点亮」）。
                if (keyboard.nKey.isPressed && !nHoldConsumed && nHeldSince >= 0f
                    && Time.unscaledTime - nHeldSince >= TestSolidsHideHoldSeconds)
                {
                    nHoldConsumed = true;
                    HideTestSolids();
                }
                if (keyboard.nKey.wasReleasedThisFrame)
                {
                    if (!nHoldConsumed && nHeldSince >= 0f) ShowOrCycleTestSolids();
                    nHeldSince = -1f;
                }
            }
            else
            {
                nHeldSince = -1f;
            }

            // B = 换 9/0 拧哪个旋钮：高度 → 左右 → 前后。
            // （旧含义「换边」已随位姿反解一起退役 —— 射线层里没有极性分支可换，
            //   镜头在哪一侧由「前后」旋钮直接给。）
            if (keyboard.bKey.wasPressedThisFrame && !IsCalibrating && colorFrameSet)
            {
                lensKnob = (lensKnob + 1) % LensKnobNames.Length;
                Vector3 lensNow = ResolvedLensCm();
                statusMessage = $"9/0 现在拧「{LensKnobNames[lensKnob]}」"
                              + $"　镜头：左右 {lensNow.x:F0}・前后 {lensNow.y:F0}・高 {lensNow.z:F0} cm";
            }

            // 9 / 0 拧镜头位置 C 的当前分量，每下 1cm，按住连发。三个数都是物理厘米：
            // 高度=镜头到桌面的垂距，左右/前后=镜头铅垂点落在垫面哪里 —— 可以先拿卷尺
            // 量个大概，再照着「色带和阴影同向同长」拧准。厘米是线性的，没有旧投射比
            // 「越往上越钝」的问题。
            //
            // ⚠ 键位是躲出来的,别再挪回顺手的那几个:
            //   · `[`/`]` 与 `,`/`.` 是标定流程自己的两个**尺寸**旋钮(压感区 / 16:9 框)。
            //     再往这一族里塞第三对「变小变大」但改的是镜头,现场必然按错。
            //   数字键 1~8 已是压感板的开关族,9/0 是这台面板上仅剩的空位。
            if (!IsCalibrating && colorFrameSet)
            {
                bool minus = keyboard.digit9Key.isPressed, plus = keyboard.digit0Key.isPressed;
                bool fresh = keyboard.digit9Key.wasPressedThisFrame || keyboard.digit0Key.wasPressedThisFrame;
                if (fresh) lensRepeatAt = Time.unscaledTime + 0.35f;
                if ((minus ^ plus) && (fresh || Time.unscaledTime >= lensRepeatAt))
                {
                    if (!fresh) lensRepeatAt = Time.unscaledTime + 0.05f;
                    Vector3 lens = ResolvedLensCm();
                    float delta = plus ? LensStepCm : -LensStepCm;
                    if (lensKnob == 0) lens.z = Mathf.Clamp(lens.z + delta, 10f, 300f);
                    else if (lensKnob == 1) lens.x += delta;
                    else lens.y += delta;
                    lensCm = lens;

                    var rig = FindFirstObjectByType<ProjectorCameraRig>();
                    if (rig != null && rig.Configured) rig.SetLensCm(lens);
                    else ProjectorCameraRig.SaveLensCm(lens);
                    statusMessage = $"镜头：左右 {lens.x:F0}・前后 {lens.y:F0}・高 {lens.z:F0} cm"
                                  + $"　（9/0 在拧「{LensKnobNames[lensKnob]}」，B 换旋钮）";
                }
            }

            // The packaged build has no Inspector, and these are the knobs that have to be
            // tuned against the real spot, so they get keys. Not mid-session: a size change
            // during validation replaces the solve just made with the preview mapping, and an
            // axis or mat-order change re-expresses later samples in a frame the earlier ones
            // were not measured in.
            bool sessionLockedKey = keyboard.leftBracketKey.wasPressedThisFrame
                || keyboard.rightBracketKey.wasPressedThisFrame
                || keyboard.commaKey.wasPressedThisFrame
                || keyboard.periodKey.wasPressedThisFrame
                || keyboard.digit1Key.wasPressedThisFrame
                || keyboard.digit2Key.wasPressedThisFrame
                || keyboard.digit3Key.wasPressedThisFrame
                || keyboard.digit4Key.wasPressedThisFrame
                || keyboard.digit6Key.wasPressedThisFrame;
            const string sessionLockNote = "　（标定中不能改尺寸 / 轴向，先 Esc 退出）";
            if (IsCalibrating && sessionLockedKey && !statusMessage.EndsWith(sessionLockNote))
            {
                statusMessage += sessionLockNote;
            }

            if (alignment != null && !IsCalibrating)
            {
                float matDelta = 0f;
                if (keyboard.leftBracketKey.wasPressedThisFrame) matDelta -= SizeStep;
                if (keyboard.rightBracketKey.wasPressedThisFrame) matDelta += SizeStep;
                if (matDelta != 0f)
                {
                    AdjustMatHeightInFrame(matDelta);
                }

                float screenDelta = 0f;
                if (keyboard.commaKey.wasPressedThisFrame) screenDelta -= SizeStep;
                if (keyboard.periodKey.wasPressedThisFrame) screenDelta += SizeStep;
                if (screenDelta != 0f)
                {
                    AdjustScreenAreaHeightInFrame(screenDelta);
                }
            }

            if (pressureInput != null)
            {
                if (keyboard.tabKey.wasPressedThisFrame) showDiagnostics = !showDiagnostics;
                if (keyboard.digit5Key.wasPressedThisFrame) pressureInput.AdoptHighestPressureAsFullScale();
                if (!IsCalibrating)
                {
                    if (keyboard.digit1Key.wasPressedThisFrame) pressureInput.ToggleSwapXY();
                    if (keyboard.digit2Key.wasPressedThisFrame) pressureInput.ToggleFlipX();
                    if (keyboard.digit3Key.wasPressedThisFrame) pressureInput.ToggleFlipY();
                    if (keyboard.digit4Key.wasPressedThisFrame) pressureInput.ToggleHardwareRowColumnSwap();
                    if (keyboard.digit6Key.wasPressedThisFrame && pressureInput.BoardCount > 1)
                    {
                        pressureInput.ToggleBoardSwap();
                        statusMessage = $"已手动对调两块压力板的左右（当前 {(pressureInput.BoardsSwapped ? "反序" : "正序")}）。"
                            + "校正时程序会自己判定一次，这个键只在不想重标、想直接试的时候用。";
                    }
                }

                float seamDelta = 0f;
                if (keyboard.digit7Key.wasPressedThisFrame) seamDelta -= SeamAdjustStepCm;
                if (keyboard.digit8Key.wasPressedThisFrame) seamDelta += SeamAdjustStepCm;
                if (seamDelta != 0f && pressureInput.BoardCount > 1 && !IsCalibrating)
                {
                    AdjustSeamGap(seamDelta);
                }
            }

            if (State == ProjectionCalibrationState.CollectingPrimary && !waitForRelease)
            {
                Vector2 delta = Vector2.zero;
                const float step = 0.005f;
                if (keyboard.aKey.wasPressedThisFrame) delta.x -= step;
                if (keyboard.dKey.wasPressedThisFrame) delta.x += step;
                if (keyboard.wKey.wasPressedThisFrame) delta.y -= step;
                if (keyboard.sKey.wasPressedThisFrame) delta.y += step;
                if (delta.sqrMagnitude > 0f)
                {
                    activeProjectorPoint = new Vector2(
                        Mathf.Clamp01(activeProjectorPoint.x + delta.x),
                        Mathf.Clamp01(activeProjectorPoint.y + delta.y));
                    alignment.ShowCalibrationMarker(activeProjectorPoint, new Color(1f, 0.2f, 0.05f, 1f));
                    Vector2Int nudgedCell = ExpectedBoardCell(activeExpectedBoardPoint);
                    statusMessage = $"已微调投影标记 P=({activeProjectorPoint.x:F3}, {activeProjectorPoint.y:F3})；"
                        + $"理论板坐标仍为 ({nudgedCell.x}, {nudgedCell.y})。";
                }
            }
        }

        /// <summary>
        /// Grows or shrinks the mat region about the frame centre. Safe at any time: the
        /// homography maps projector to board, so alignment is untouched — only how much of
        /// the game image lands on the mat changes. Calibrate afterwards to store the value.
        /// </summary>
        private void AdjustMatHeightInFrame(float delta)
        {
            float current = alignment.MatHeightInFrame;
            float ceiling = alignment.MaximumMatHeightInFrame;
            float target = Mathf.Clamp(Mathf.Round((current + delta) * 100f) / 100f, MinSizeInFrame, ceiling);
            if (Mathf.Approximately(target, current))
            {
                return;
            }

            alignment.SetMatHeightInFrame(target);
            statusMessage = $"压感区已调整为画面高度的 {target:F2}"
                + $"（投影光斑需高于垫子 {1f / target:F2} 倍；{ceiling:F2} = 画面刚好盖住垫子，无浪费）。"
                + (alignment.HasValidCalibration ? "对齐不受影响，标定无需重做；按 C 重标才会存下这个值。" : string.Empty);
        }

        /// <summary>
        /// Changes the assumed dead strip between mats. Unlike the size knobs this is not
        /// cosmetic: it changes what board coordinate a given cell has, so any calibration
        /// solved under the old width no longer describes the same board. SyncBoardLayout
        /// notices on the next frame and drops it.
        /// </summary>
        private void AdjustSeamGap(float deltaCm)
        {
            // Never mid-session: the samples already captured were measured in the old
            // coordinate system, and re-expressing them is not something a stray keypress
            // should be doing halfway through a calibration.
            if (IsCalibrating || pressureInput == null || pressureInput.BoardCount < 2)
            {
                return;
            }

            float target = Mathf.Clamp(pressureInput.SeamGapCm + deltaCm, 0f, MaximumSeamGapCm);
            if (Mathf.Approximately(target, pressureInput.SeamGapCm))
            {
                return;
            }

            pressureInput.SetSeamGapCm(target);
            statusMessage = $"接缝死区已设为 {pressureInput.SeamGapCm:F1} cm"
                + $"（{Mathf.RoundToInt(pressureInput.SeamGapCm * 2f)} 格）。"
                + "这会改变板坐标，原有标定随之失效——按 C 重新校正。";
        }

        private const float ImageShiftStepMm = 1f;

        /// <summary>
        /// Moves the calibrated picture on the table and writes it straight back into the
        /// saved file. What it corrects is the one error calibration cannot see: a fingertip's
        /// pressure peak sits behind where the finger visibly is, every sample shares that
        /// offset, so the solve is self-consistent and validation passes while the mat outline
        /// sits a few millimetres off the mat. Pressing the markers with a piece base avoids
        /// most of it; this takes care of the rest, against the mat's own edge.
        /// </summary>
        private void ShiftImage(Vector2 deltaMm)
        {
            if (alignment == null || !alignment.ShiftImage(deltaMm * 0.1f))
            {
                return;
            }

            Vector2 shift = alignment.ImageShiftCm * 10f;
            string saved = alignment.PersistCalibration(out string error) ? "已写入存档" : $"未能写入存档：{error}";
            statusMessage = $"画面微调：右 {shift.x:+0.#;-0.#;0} mm，下 {shift.y:+0.#;-0.#;0} mm（{saved}；重新标定会归零）。";
        }

        /// <summary>
        /// Draws a millimetre more or less of picture beyond the mat on each side of an axis.
        /// For the strip along the mat's edge that still takes a press but lies outside the
        /// solved outline. Nothing moves and nothing is stretched — the solve and the touch
        /// path stay as calibrated; the viewport and canvas grow and the game keeps drawing
        /// into the strip. Stored with the calibration; R clears it.
        /// </summary>
        private void GrowMargin(Vector2 deltaMmPerSide)
        {
            if (alignment == null)
            {
                return;
            }

            alignment.GrowRenderMargin(deltaMmPerSide * 0.1f);
            ReportMargin();
        }

        private void ReportMargin()
        {
            Vector2 asked = alignment.RenderMarginCm * 10f;
            Vector2 applied = alignment.EffectiveRenderMarginCm * 10f;
            string saved = alignment.HasValidCalibration
                ? (alignment.PersistCalibration(out string error) ? "已写入存档" : $"未能写入存档：{error}")
                : "标定后随存档保存";
            string clipped = (applied - asked).sqrMagnitude > 0.01f
                ? $"，实际 横 {applied.x:0.#} / 竖 {applied.y:0.#} mm——已顶到画面边缘，按 [ 缩小压感区腾位"
                : string.Empty;
            statusMessage = $"画面外扩：每边 横 {asked.x:0.#} mm、竖 {asked.y:0.#} mm{clipped}（映射与触摸不变；{saved}）。";
        }

        /// <summary>Resizes the 16:9 outline only — it is a guide, nothing else reads it.</summary>
        private void AdjustScreenAreaHeightInFrame(float delta)
        {
            float current = alignment.ScreenAreaHeightInFrame;
            float target = Mathf.Clamp(Mathf.Round((current + delta) * 100f) / 100f, MinSizeInFrame, 1f);
            if (Mathf.Approximately(target, current))
            {
                return;
            }

            alignment.SetScreenAreaHeightInFrame(target);
            statusMessage = $"16:9 屏幕框已调整为画面高度的 {target:F2}（1.00 = 整幅相机画面）。";
        }

        private Vector2 AverageStablePositions()
        {
            if (stablePositions.Count == 0)
            {
                return default;
            }

            Vector2 sum = Vector2.zero;
            for (int index = 0; index < stablePositions.Count; index++)
            {
                sum += stablePositions[index];
            }
            return sum / stablePositions.Count;
        }

        private void ResetStability()
        {
            stablePositions.Clear();
            stableTime = 0f;
        }

        private void OnGUI()
        {
            DrawOperatorOutputBorder();
            DrawOperatorRadialMenu();
            DrawStandaloneOperatorDiagnostics();
        }

    }
}
