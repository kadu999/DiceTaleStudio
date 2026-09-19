using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

namespace NuLight.ProjectionAlignment
{
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(-100)]
    public sealed class ProjectionAlignmentController : MonoBehaviour
    {
        private static readonly int GameTextureId = Shader.PropertyToID("_GameTexture");
        private static readonly int ProjectorToBoardId = Shader.PropertyToID("_ProjectorToBoard");
        private static readonly int InteractionRectId = Shader.PropertyToID("_InteractionRect");
        private static readonly int ContentModeId = Shader.PropertyToID("_ContentMode");
        private static readonly int ShowGridId = Shader.PropertyToID("_ShowBoardGrid");
        private static readonly int MarkerVisibleId = Shader.PropertyToID("_CalibrationMarkerVisible");
        private static readonly int MarkerUvId = Shader.PropertyToID("_CalibrationMarkerProjectorUv");
        private static readonly int MarkerColorId = Shader.PropertyToID("_CalibrationMarkerColor");

        [Header("Render Chain")]
        [SerializeField] private Material warpMaterialTemplate;
        [SerializeField] private RenderTexture gameTexture;

        [Header("Output")]
        [SerializeField] private int projectorWidth = 1920;
        [SerializeField] private int projectorHeight = 1080;
        [SerializeField] private int targetDisplay = 1;
        [SerializeField] private ProjectionContentMode contentMode = ProjectionContentMode.FullFrameWithInteractionRegion;

        [Header("Game-space pressure region")]
        [Tooltip("The mat's share of the frame height — the zoom knob, and the one to reach for when the "
            + "projected pressure area is too small for the physical mat. Raising it enlarges the mat region "
            + "and the 16:9 screen frame together; the margin left over is the headroom that absorbs rotation "
            + "and spot overshoot. The projector must throw a spot 1/this tall, so set it to roughly "
            + "(mat height / spot height) on the actual rig: 1 = no margin, mat fills the spot's height.")]
        [SerializeField, Range(0.3f, 1f)] private float matHeightInFrame = ProjectionCoordinateMapper.MatHeightInFrame;

        [Tooltip("The pressure mats' location inside Game Camera A's complete 16:9 image, in top-left game UV "
            + "coordinates. Driven by the slider above and by how many mats are connected; edit directly "
            + "only to place the area off-centre.")]
        [SerializeField] private Rect interactionRectInGameUv = ProjectionCoordinateMapper.DefaultInteractionRect;
        [SerializeField] private RectTransform interactionFrame;

        [Tooltip("Optional. The caption drawn on the mat outline; it states the physical size, which "
            + "changes with the number of mats.")]
        [SerializeField] private Text interactionFrameLabel;

        [Tooltip("Optional. The line marking where two mats butt together, so the pair can be lined up "
            + "against the projection. Shown only when two mats are connected.")]
        [SerializeField] private GameObject boardSeamGuide;

        [Header("16:9 Screen Area")]
        [Tooltip("A 16:9 outline warped by the same homography, marking where a 16:9 screen lands. "
            + "Height is this fraction of the frame height, centred in the frame — 1 (default) makes it "
            + "the camera frame itself. Independent of the pressure mat: moving the mat slider does not "
            + "move this one.")]
        [SerializeField] private RectTransform screenAreaFrame;
        [SerializeField, Range(0.3f, 1f)] private float screenAreaHeightInFrame = 1f;

        [Header("Alignment Guides")]
        [Tooltip("The outlines, labels and live pressure dots. They are projected onto the table like "
            + "everything else on Camera A, so a game that is running for an audience wants them off; "
            + "calibration turns them back on for as long as it lasts.")]
        [SerializeField] private GameObject[] guideObjects = new GameObject[0];
        [SerializeField] private bool guidesVisible = true;

        [Header("Debug")]
        [SerializeField] private bool showBoardGrid;
        [SerializeField] private bool showSeamGuide;

        private Material runtimeMaterial;
        private float lastAppliedMatHeight = -1f;
        private Matrix4x4 projectorToBoard = ProjectionCoordinateMapper.CreateDefaultProjectorToBoardPreviewMatrix();
        private Matrix4x4 boardToProjector = ProjectionCoordinateMapper.CreateDefaultBoardToProjectorPreviewMatrix();

        // The solve as calibration produced it, before the operator's fine adjustment, and
        // the file it was saved to — so the adjustment can be written back without a session.
        private Matrix4x4 calibratedProjectorToBoard;
        private Vector2 imageShiftCm;
        private Vector2 renderMarginCm;
        private ProjectionCalibrationData savedData;

        /// <summary>Per side. Past this the knob is a mistake, not an adjustment.</summary>
        private const float MaximumRenderMarginCm = 10f;

        public bool HasValidCalibration { get; private set; }

        /// <summary>How far the picture has been moved on the table after solving, in cm, + = right / down.</summary>
        public Vector2 ImageShiftCm => imageShiftCm;

        /// <summary>How far beyond the sensing grid the game keeps drawing, in cm on each side per axis, as asked for.</summary>
        public Vector2 RenderMarginCm => renderMarginCm;

        /// <summary>The margin actually in force — what asked for, less whatever the frame has no room for.</summary>
        public Vector2 EffectiveRenderMarginCm
        {
            get
            {
                ProjectionCoordinateMapper.ExpandRectByMarginCm(
                    interactionRectInGameUv, renderMarginCm, BoardCount, SeamGapCm, out Vector2 applied);
                return applied;
            }
        }

        /// <summary>
        /// Where the game draws: the mat area plus the render margin, in game UV. This is what
        /// the projected camera's viewport and the overlay canvas are cut to. The mapping from
        /// board UV to game UV stays <see cref="InteractionRectInGameUv"/>, so a press keeps
        /// landing on the pixel it always did; the margin is only more picture around it.
        /// </summary>
        public Rect ViewportRectInGameUv => ProjectionCoordinateMapper.ExpandRectByMarginCm(
            interactionRectInGameUv, renderMarginCm, BoardCount, SeamGapCm, out _);

        /// <summary>
        /// The viewport expressed in board UV — the unit square when there is no margin, a
        /// little more on every side when there is. A camera that frames the mat has to frame
        /// this instead, or the mat is drawn stretched over the larger viewport.
        /// </summary>
        public Rect ViewportInBoardUv
        {
            get
            {
                Rect viewport = ViewportRectInGameUv;
                Vector2 min = SourceToBoard(viewport.min);
                Vector2 max = SourceToBoard(viewport.max);
                return Rect.MinMaxRect(min.x, min.y, max.x, max.y);
            }
        }

        /// <summary>
        /// Sets how far beyond the sensing grid the game keeps drawing. For the strip along the
        /// mat's edge that still takes a press but lies outside the solved outline: nothing is
        /// moved or stretched — the viewport and canvas grow symmetrically, the solve and the
        /// touch path are untouched, and the game simply draws further out. A press in the
        /// strip reads the outermost cells and lands on the picture's edge pixel.
        /// </summary>
        public void SetRenderMarginCm(Vector2 marginCm)
        {
            Vector2 clamped = new Vector2(
                Mathf.Clamp(marginCm.x, 0f, MaximumRenderMarginCm),
                Mathf.Clamp(marginCm.y, 0f, MaximumRenderMarginCm));
            if (clamped == renderMarginCm)
            {
                return;
            }

            renderMarginCm = clamped;

            // The viewport is cut from this by the camera binder, which listens here.
            CalibrationChanged?.Invoke();
        }

        public void GrowRenderMargin(Vector2 deltaCmPerSide)
        {
            SetRenderMarginCm(renderMarginCm + deltaCmPerSide);
        }
        public Matrix4x4 ProjectorToBoardMatrix => projectorToBoard;
        public Matrix4x4 BoardToProjectorMatrix => boardToProjector;
        public ProjectionContentMode ContentMode => contentMode;
        public Rect InteractionRectInGameUv => interactionRectInGameUv;
        public bool ShowBoardGrid => showBoardGrid;
        public bool GuidesVisible => guidesVisible;

        /// <summary>
        /// The mat's share of the frame height — the zoom knob. The projector has to throw a
        /// spot 1/this tall for the projected mat area to reach the physical mat, so set it to
        /// roughly (mat height / spot height) on the actual rig. 1 = no waste.
        /// </summary>
        public float MatHeightInFrame => interactionRectInGameUv.height;

        /// <summary>
        /// The mat area's physical width / height, read back off the rect — the rect is the
        /// single source of truth for the geometry, exactly as it is for the height knob.
        /// </summary>
        public float MatAspect => ProjectionCoordinateMapper.MatAspectOf(interactionRectInGameUv);

        /// <summary>How many mats the current geometry is built for.</summary>
        public int BoardCount => ProjectionCoordinateMapper.BoardCountOf(interactionRectInGameUv);

        /// <summary>
        /// The dead strip between mats, in cm, read back off the rect's shape — the rect stays
        /// the single source of truth for the geometry, exactly as it is for the height knob
        /// and the mat count. It also means the seam width rides along in the saved calibration
        /// for free, because the rect is already saved.
        /// </summary>
        public float SeamGapCm
        {
            get
            {
                int boards = BoardCount;
                if (boards < 2)
                {
                    return 0f;
                }

                return Mathf.Max(0f,
                    (MatAspect - boards) * ProjectionCoordinateMapper.MatEdgeCm / (boards - 1));
            }
        }

        /// <summary>
        /// Where the dead strip lands in game UV — the band a game must keep its tap targets
        /// out of, because nothing under it reports a touch. Zero-width when there is one mat.
        /// </summary>
        public Rect SeamRectInGameUv
        {
            get
            {
                int boards = BoardCount;
                if (boards < 2)
                {
                    return new Rect(interactionRectInGameUv.center.x, interactionRectInGameUv.y, 0f,
                        interactionRectInGameUv.height);
                }

                Vector2 span = ProjectionCoordinateMapper.SeamSpanInBoardUv(0, boards, SeamGapCm);
                float xMin = interactionRectInGameUv.x + span.x * interactionRectInGameUv.width;
                float xMax = interactionRectInGameUv.x + span.y * interactionRectInGameUv.width;
                return Rect.MinMaxRect(xMin, interactionRectInGameUv.yMin, xMax, interactionRectInGameUv.yMax);
            }
        }

        /// <summary>The tallest the mat area can be before it runs out of frame width.</summary>
        public float MaximumMatHeightInFrame => ProjectionCoordinateMapper.MaximumMatHeightInFrame(MatAspect);

        /// <summary>The 16:9 screen outline's share of the frame height. 1 = the camera frame itself.</summary>
        public float ScreenAreaHeightInFrame => screenAreaHeightInFrame;

        /// <summary>Resizes the mat region about the frame centre, keeping its physical shape.</summary>
        public void SetMatHeightInFrame(float heightInFrame)
        {
            SetInteractionRect(ProjectionCoordinateMapper.CenteredMatRect(heightInFrame, MatAspect));
        }

        /// <summary>
        /// Reshapes the mat area for a different number of mats, keeping the height knob where
        /// it is (clamped to what the new width allows). Does nothing when the count already
        /// matches, so it is safe to call every frame.
        /// </summary>
        public bool SetBoardCount(int boardCount)
        {
            return SetMatLayout(boardCount, SeamGapCm);
        }

        /// <summary>
        /// Reshapes the mat area for a number of mats and a seam width, keeping the height knob
        /// where it is (clamped to what the new width allows). Returns whether anything moved,
        /// so it is safe to call every frame.
        /// </summary>
        public bool SetMatLayout(int boardCount, float seamGapCm)
        {
            int target = Mathf.Max(1, boardCount);
            float gap = target > 1 ? Mathf.Max(0f, seamGapCm) : 0f;
            if (target == BoardCount && Mathf.Abs(gap - SeamGapCm) < 0.01f)
            {
                ApplyBoardDecorations();
                return false;
            }

            SetInteractionRect(ProjectionCoordinateMapper.CenteredMatRect(
                interactionRectInGameUv.height,
                ProjectionCoordinateMapper.MatAspectFor(target, gap)));
            return true;
        }

        /// <summary>
        /// Drops the solved matrix without deleting the saved file. Used when the mat layout
        /// changes underneath a loaded calibration: that matrix maps projector coordinates to
        /// a board that no longer exists, so it has to stop being treated as valid, but the
        /// file stays put in case the other mat is simply unplugged for a moment.
        /// </summary>
        public void InvalidateCalibration()
        {
            if (!HasValidCalibration)
            {
                return;
            }

            HasValidCalibration = false;
            imageShiftCm = Vector2.zero;
            SetPreviewMatrixFromInteractionRect();
            ApplyMaterialState();
            CalibrationChanged?.Invoke();
        }

        /// <summary>Resizes the 16:9 screen outline about the frame centre. Does not touch the mat.</summary>
        public void SetScreenAreaHeightInFrame(float heightInFrame)
        {
            screenAreaHeightInFrame = Mathf.Clamp(heightInFrame, 0.05f, 1f);
            ApplyRectsToFrames();
        }

        /// <summary>
        /// The 16:9 screen area in game UV: a frame-centred rect, independent of the mat.
        ///
        /// Game UV is normalised over the 16:9 frame, so a physically 16:9 rect needs
        /// w == h in UV — which is why the square mat reads as 0.5625 x 1 while this rect
        /// is a UV square, and why 1 makes it exactly the camera frame.
        /// </summary>
        public Rect ScreenAreaRectInGameUv
        {
            get
            {
                float height = Mathf.Clamp(screenAreaHeightInFrame, 0.05f, 1f);
                float width = height;
                return new Rect(0.5f - width * 0.5f, 0.5f - height * 0.5f, width, height);
            }
        }

        /// <summary>The warp material actually in use, for presenting the game texture to the projector.</summary>
        public Material WarpMaterial => runtimeMaterial != null ? runtimeMaterial : warpMaterialTemplate;
        public RenderTexture GameTexture => gameTexture;

        public event Action CalibrationChanged;

        public void Configure(
            Material materialTemplate,
            RenderTexture sourceTexture,
            RectTransform configuredInteractionFrame = null,
            RectTransform configuredScreenAreaFrame = null)
        {
            warpMaterialTemplate = materialTemplate;
            gameTexture = sourceTexture;
            interactionFrame = configuredInteractionFrame;
            screenAreaFrame = configuredScreenAreaFrame;
        }

        /// <summary>Hands over the two parts of the mat outline that depend on how many mats there are.</summary>
        public void ConfigureMatDecorations(Text frameLabel, GameObject seamGuide)
        {
            interactionFrameLabel = frameLabel;
            boardSeamGuide = seamGuide;
            ApplyBoardDecorations();
        }

        /// <summary>
        /// Keeps the outline's caption and the seam line telling the truth about the current
        /// layout. The caption is projected onto the table, so a stale "50 x 50 CM" on a
        /// 100 cm area is worse than no caption at all.
        /// </summary>
        private void ApplyBoardDecorations()
        {
            int boards = BoardCount;
            float gap = SeamGapCm;
            if (interactionFrameLabel != null)
            {
                float width = ProjectionCoordinateMapper.AreaWidthCm(boards, gap);
                interactionFrameLabel.text =
                    $"PRESSURE INPUT AREA  /  {width:F0} × {ProjectionCoordinateMapper.MatEdgeCm:F0} CM"
                    + (boards > 1 ? $"  /  {boards} MATS · SEAM {gap:F1} CM" : string.Empty);
            }

            if (boardSeamGuide != null)
            {
                // Visible when the alignment overlay is up, or on its own while someone is
                // dialling the seam in against the real gap.
                boardSeamGuide.SetActive(boards > 1 && (guidesVisible || showSeamGuide));
                var seamRect = boardSeamGuide.transform as RectTransform;
                if (seamRect != null && boards > 1)
                {
                    // Drawn at its real width inside the mat outline, so the strip on the table
                    // is the strip that reads nothing — line the mats up against it and the
                    // model and the hardware are saying the same thing.
                    Vector2 span = ProjectionCoordinateMapper.SeamSpanInBoardUv(0, boards, gap);

                    // A visibility floor, not a claim about the geometry: at a seam of zero the
                    // band would have no width at all and the switch would look broken. A
                    // hairline says "the seam is here, now widen it until it covers the gap".
                    const float minimumWidth = 0.002f;
                    if (span.y - span.x < minimumWidth)
                    {
                        float centre = (span.x + span.y) * 0.5f;
                        span = new Vector2(centre - minimumWidth * 0.5f, centre + minimumWidth * 0.5f);
                    }

                    seamRect.anchorMin = new Vector2(span.x, 0f);
                    seamRect.anchorMax = new Vector2(span.y, 1f);
                    seamRect.offsetMin = Vector2.zero;
                    seamRect.offsetMax = Vector2.zero;
                }
            }
        }

        /// <summary>Sets which objects the guide toggle owns, and its starting state.</summary>
        public void ConfigureGuides(GameObject[] objects, bool startVisible)
        {
            guideObjects = objects ?? new GameObject[0];
            guidesVisible = startVisible;
            ApplyGuideVisibility();
        }

        /// <summary>
        /// Shows or hides the alignment outlines and pressure dots. Purely cosmetic —
        /// nothing in the mapping reads them.
        /// </summary>
        public void SetGuidesVisible(bool visible)
        {
            guidesVisible = visible;
            ApplyGuideVisibility();
        }

        /// <summary>Whether the seam band is being shown independently of the alignment guides.</summary>
        public bool ShowSeamGuide => showSeamGuide;

        /// <summary>
        /// Summons just the seam band. Its width on the table is the seam width the rig is
        /// using, so widening it until it covers the real gap sets the value by eye — no ruler,
        /// no arithmetic, and it reads the answer off the same surface the error lives on.
        /// </summary>
        public void SetSeamGuideVisible(bool visible)
        {
            showSeamGuide = visible;
            ApplyBoardDecorations();
        }

        private void ApplyGuideVisibility()
        {
            if (guideObjects != null)
            {
                for (int index = 0; index < guideObjects.Length; index++)
                {
                    if (guideObjects[index] != null)
                    {
                        guideObjects[index].SetActive(guidesVisible);
                    }
                }
            }

            // The seam band lives outside the guide group so it can be summoned alone, which
            // also means it has to be re-evaluated whenever the group is toggled.
            ApplyBoardDecorations();
        }

        private void Awake()
        {
            interactionRectInGameUv = ProjectionCoordinateMapper.SanitizeInteractionRect(interactionRectInGameUv);
            matHeightInFrame = interactionRectInGameUv.height;
            lastAppliedMatHeight = matHeightInFrame;
            SetPreviewMatrixFromInteractionRect();
            ApplyRectsToFrames();
            ApplyGuideVisibility();

            if (warpMaterialTemplate != null)
            {
                runtimeMaterial = new Material(warpMaterialTemplate)
                {
                    name = warpMaterialTemplate.name + " (Runtime)"
                };
            }

            LoadCalibration();
            ApplyMaterialState();
        }

        private void Start()
        {
            // Re-apply after all scene and prefab initialization has completed.
            // Some renderers restore their serialized material state after Awake.
            ApplyMaterialState();
        }

        private void LateUpdate()
        {
            // Matrix properties are runtime-only shader state and are not serialized
            // with the material. Keep the output surface synchronized before render.
            ApplyMaterialState();
        }

        private void OnDestroy()
        {
            if (runtimeMaterial != null)
            {
                Destroy(runtimeMaterial);
            }
        }

        public void SetMatrix(Matrix4x4 matrix, bool markAsCalibrated)
        {
            if (!HomographyUtility.TryInvert(matrix, out Matrix4x4 inverse))
            {
                Debug.LogWarning("[ProjectionAlignment] Ignored non-invertible homography.", this);
                return;
            }

            projectorToBoard = matrix;
            boardToProjector = inverse;
            HasValidCalibration = markAsCalibrated;
            if (markAsCalibrated)
            {
                // A fresh solve supersedes whatever adjustment the previous one carried.
                calibratedProjectorToBoard = matrix;
                imageShiftCm = Vector2.zero;
            }

            ApplyMaterialState();
            CalibrationChanged?.Invoke();
        }

        /// <summary>
        /// Moves the whole picture on the table by <paramref name="deltaCm"/> (+ = right / down)
        /// without touching the solve. This is the knob for what calibration cannot measure: a
        /// press lands on the sensor a little behind where it visibly is, every sample shares
        /// that offset, so the solve is self-consistent and validation passes while the mat
        /// outline sits a few millimetres off the mat. Folded into the matrix, so the shader,
        /// the guides, the touch mapping and the saved file all see one mapping.
        /// </summary>
        public bool ShiftImage(Vector2 deltaCm)
        {
            if (!HasValidCalibration)
            {
                return false;
            }

            imageShiftCm += deltaCm;
            ApplyImageShift();
            return true;
        }

        public void ResetImageShift()
        {
            if (!HasValidCalibration || imageShiftCm == Vector2.zero)
            {
                return;
            }

            imageShiftCm = Vector2.zero;
            ApplyImageShift();
        }

        /// <summary>
        /// Re-attaches the shift bookkeeping to the matrix in force, which already contains it —
        /// after loading a file, or after a cancelled session put the previous matrix back.
        /// </summary>
        public void RestoreImageShift(Vector2 shiftCm)
        {
            if (!HasValidCalibration)
            {
                return;
            }

            imageShiftCm = shiftCm;
            calibratedProjectorToBoard = HomographyUtility.Translate(projectorToBoard, -ShiftInBoardUv(shiftCm));
        }

        /// <summary>Writes the mapping and margin in force back into the saved calibration; everything else in the file stays as it was.</summary>
        public bool PersistCalibration(out string error)
        {
            if (!HasValidCalibration || savedData == null)
            {
                error = "没有可写回的标定存档。";
                return false;
            }

            savedData.projectorToBoard = HomographyUtility.ToArray(projectorToBoard);
            savedData.manualShiftMm = imageShiftCm * 10f;
            savedData.renderMarginMm = renderMarginCm * 10f;
            return ProjectionCalibrationStore.TrySave(savedData, out error);
        }

        /// <summary>Moving the picture toward +B asks the board coordinate under each pixel to be smaller.</summary>
        private Vector2 ShiftInBoardUv(Vector2 shiftCm)
        {
            return new Vector2(
                -shiftCm.x / ProjectionCoordinateMapper.AreaWidthCm(BoardCount, SeamGapCm),
                -shiftCm.y / ProjectionCoordinateMapper.MatEdgeCm);
        }

        private void ApplyImageShift()
        {
            Matrix4x4 shifted = HomographyUtility.Translate(calibratedProjectorToBoard, ShiftInBoardUv(imageShiftCm));
            if (!HomographyUtility.TryInvert(shifted, out Matrix4x4 inverse))
            {
                return;
            }

            projectorToBoard = shifted;
            boardToProjector = inverse;
            ApplyMaterialState();
            CalibrationChanged?.Invoke();
        }

        public bool TryProjectorToBoard(Vector2 projectorUv, out Vector2 boardUv)
        {
            return HomographyUtility.TryApply(projectorToBoard, projectorUv, out boardUv);
        }

        public bool TryBoardToProjector(Vector2 boardUv, out Vector2 projectorUv)
        {
            return HomographyUtility.TryApply(boardToProjector, boardUv, out projectorUv);
        }

        public Vector2 BoardToSource(Vector2 boardUv)
        {
            return ProjectionCoordinateMapper.BoardToSourceUv(boardUv, interactionRectInGameUv);
        }

        public Vector2 SourceToBoard(Vector2 sourceUv)
        {
            return ProjectionCoordinateMapper.SourceToBoardUv(sourceUv, interactionRectInGameUv);
        }

        public bool TryProjectorToSource(Vector2 projectorUv, out Vector2 sourceUv)
        {
            if (!TryProjectorToBoard(projectorUv, out Vector2 boardUv))
            {
                sourceUv = default;
                return false;
            }

            sourceUv = BoardToSource(boardUv);
            return true;
        }

        public bool TrySourceToProjector(Vector2 sourceUv, out Vector2 projectorUv)
        {
            return TryBoardToProjector(SourceToBoard(sourceUv), out projectorUv);
        }

        public void SetContentMode(ProjectionContentMode mode)
        {
            contentMode = mode;
            ApplyMaterialState();
        }

        public void SetInteractionRect(Rect gameUvRect)
        {
            interactionRectInGameUv = ProjectionCoordinateMapper.SanitizeInteractionRect(gameUvRect);
            matHeightInFrame = interactionRectInGameUv.height;
            lastAppliedMatHeight = matHeightInFrame;
            ApplyRectsToFrames();
            if (!HasValidCalibration)
            {
                SetPreviewMatrixFromInteractionRect();
            }

            ApplyMaterialState();
            CalibrationChanged?.Invoke();
        }

        public void SetGridVisible(bool visible)
        {
            showBoardGrid = visible;
            ApplyMaterialState();
        }

        public void ShowCalibrationMarker(Vector2 projectorUv, Color color)
        {
            if (runtimeMaterial == null)
            {
                return;
            }

            runtimeMaterial.SetVector(MarkerUvId, projectorUv);
            runtimeMaterial.SetColor(MarkerColorId, color);
            runtimeMaterial.SetFloat(MarkerVisibleId, 1f);
        }

        public void HideCalibrationMarker()
        {
            if (runtimeMaterial != null)
            {
                runtimeMaterial.SetFloat(MarkerVisibleId, 0f);
            }
        }

        public bool SaveCalibration(
            IReadOnlyList<CalibrationSample> samples,
            float rmsErrorCells,
            float maxErrorCells,
            PressureInputRouter pressureInput,
            out string error)
        {
            var data = new ProjectionCalibrationData
            {
                projectorWidth = projectorWidth,
                projectorHeight = projectorHeight,
                targetDisplay = targetDisplay,
                boardColumns = pressureInput != null ? pressureInput.SensorResolution.x : 100,
                boardRows = pressureInput != null ? pressureInput.SensorResolution.y : 100,
                boardCount = pressureInput != null ? pressureInput.BoardCount : 1,
                seamGapMm = SeamGapCm * 10f,
                boardWidthMm = ProjectionCoordinateMapper.AreaWidthCm(BoardCount, SeamGapCm) * 10f,
                boardHeightMm = ProjectionCoordinateMapper.MatEdgeCm * 10f,
                swapXY = pressureInput != null && pressureInput.SwapXY,
                flipX = pressureInput != null && pressureInput.FlipX,
                flipY = pressureInput != null && pressureInput.FlipY,
                sensorPointMode = pressureInput != null ? pressureInput.PointMode : SensorPointMode.CellCenter,
                contentMode = contentMode,
                interactionRectInGameUv = interactionRectInGameUv,
                projectorToBoard = HomographyUtility.ToArray(projectorToBoard),
                manualShiftMm = imageShiftCm * 10f,
                renderMarginMm = renderMarginCm * 10f,
                rmsErrorCells = rmsErrorCells,
                maxErrorCells = maxErrorCells,
                sampleCount = samples?.Count ?? 0,
                createdUtc = DateTime.UtcNow.ToString("O"),
                samples = samples != null ? new List<CalibrationSample>(samples) : new List<CalibrationSample>()
            };

            bool saved = ProjectionCalibrationStore.TrySave(data, out error);
            if (saved)
            {
                HasValidCalibration = true;
                savedData = data;
            }

            return saved;
        }

        /// <summary>
        /// Back to factory: the saved matrix goes, and so does the mat size that came with
        /// it. Leaving the size behind would mean R half-resets — the next calibration would
        /// silently be measured at whatever size the previous session had dialled in.
        /// </summary>
        public void ResetCalibration(bool deleteSavedData)
        {
            // The seam width survives a factory reset: it is a measured property of how the mats
            // physically sit, not a knob someone dialled in, and the live hardware would push it
            // straight back anyway.
            interactionRectInGameUv = ProjectionCoordinateMapper.DefaultInteractionRectFor(
                BoardCount, SeamGapCm);
            matHeightInFrame = interactionRectInGameUv.height;
            lastAppliedMatHeight = matHeightInFrame;
            ApplyRectsToFrames();
            SetPreviewMatrixFromInteractionRect();
            HasValidCalibration = false;
            imageShiftCm = Vector2.zero;
            renderMarginCm = Vector2.zero;
            savedData = null;
            if (deleteSavedData)
            {
                ProjectionCalibrationStore.Delete();
            }

            ApplyMaterialState();
            CalibrationChanged?.Invoke();
        }

        private void LoadCalibration()
        {
            if (!ProjectionCalibrationStore.TryLoad(out ProjectionCalibrationData data, out string error))
            {
                if (!string.IsNullOrEmpty(error))
                {
                    Debug.LogWarning($"[ProjectionAlignment] {error}", this);
                }
                return;
            }

            if (data.projectorWidth != projectorWidth || data.projectorHeight != projectorHeight)
            {
                Debug.LogWarning("[ProjectionAlignment] Saved calibration resolution does not match the current output.", this);
                return;
            }

            interactionRectInGameUv = ProjectionCoordinateMapper.SanitizeInteractionRect(data.interactionRectInGameUv);
            ApplyRectsToFrames();
            contentMode = Enum.IsDefined(typeof(ProjectionContentMode), data.contentMode)
                ? data.contentMode
                : ProjectionContentMode.FullFrameWithInteractionRegion;
            renderMarginCm = new Vector2(
                Mathf.Clamp(data.renderMarginMm.x * 0.1f, 0f, MaximumRenderMarginCm),
                Mathf.Clamp(data.renderMarginMm.y * 0.1f, 0f, MaximumRenderMarginCm));
            SetMatrix(data.Matrix, true);
            savedData = data;
            RestoreImageShift(data.manualShiftMm * 0.1f);
        }

        private void ApplyMaterialState()
        {
            Material material = runtimeMaterial != null ? runtimeMaterial : warpMaterialTemplate;
            if (material == null)
            {
                return;
            }

            material.SetTexture(GameTextureId, gameTexture);
            material.SetMatrix(ProjectorToBoardId, projectorToBoard);
            material.SetVector(InteractionRectId, new Vector4(
                interactionRectInGameUv.x,
                interactionRectInGameUv.y,
                interactionRectInGameUv.width,
                interactionRectInGameUv.height));
            material.SetFloat(ContentModeId, (float)contentMode);
            material.SetFloat(ShowGridId, showBoardGrid ? 1f : 0f);
        }

        private void SetPreviewMatrixFromInteractionRect()
        {
            projectorToBoard = ProjectionCoordinateMapper.CreateProjectorToBoardPreviewMatrix(
                interactionRectInGameUv);
            boardToProjector = ProjectionCoordinateMapper.CreateBoardToProjectorPreviewMatrix(
                interactionRectInGameUv);
        }

        /// <summary>Re-anchors both outlines; the 16:9 screen frame follows the mat.</summary>
        private void ApplyRectsToFrames()
        {
            AnchorFrameToGameUvRect(interactionFrame, interactionRectInGameUv, canvasCoverageInGameUv);
            AnchorFrameToGameUvRect(screenAreaFrame, ScreenAreaRectInGameUv, canvasCoverageInGameUv);
            ApplyBoardDecorations();
        }

        /// <summary>
        /// Which part of the camera's full 16:9 frame the overlay canvas actually covers.
        ///
        /// It is the whole frame in the normal case and the mat area when the game is fitted
        /// into the mat, because a screen-space canvas covers its camera's viewport and that
        /// viewport is then the mat. Everything on that canvas is authored in frame UV, so
        /// without this the mat outline would be drawn at 29%..71% of the mat instead of
        /// around it.
        /// </summary>
        public void SetCanvasCoverage(Rect coverageInGameUv)
        {
            Rect sanitized = coverageInGameUv;
            if (sanitized.width <= 0.0001f || sanitized.height <= 0.0001f)
            {
                sanitized = FullFrameRect;
            }

            if (sanitized == canvasCoverageInGameUv)
            {
                return;
            }

            canvasCoverageInGameUv = sanitized;
            ApplyRectsToFrames();
        }

        /// <summary>The part of the frame the overlay canvas covers; the whole frame by default.</summary>
        public Rect CanvasCoverageInGameUv => canvasCoverageInGameUv;

        private static readonly Rect FullFrameRect = new Rect(0f, 0f, 1f, 1f);
        private Rect canvasCoverageInGameUv = FullFrameRect;

        /// <summary>
        /// Anchors a frame-UV rect inside a canvas that may only cover part of the frame.
        /// With full coverage this is the identity it always was.
        /// </summary>
        private static void AnchorFrameToGameUvRect(RectTransform frame, Rect gameUvRect, Rect coverage)
        {
            if (frame == null)
            {
                return;
            }

            float left = (gameUvRect.xMin - coverage.xMin) / coverage.width;
            float right = (gameUvRect.xMax - coverage.xMin) / coverage.width;
            float top = (gameUvRect.yMin - coverage.yMin) / coverage.height;
            float bottom = (gameUvRect.yMax - coverage.yMin) / coverage.height;

            frame.anchorMin = new Vector2(left, 1f - bottom);
            frame.anchorMax = new Vector2(right, 1f - top);
            frame.anchoredPosition = Vector2.zero;
            frame.sizeDelta = Vector2.zero;
        }

        private void OnValidate()
        {
            // Unity does not say which field the Inspector touched, so the slider only wins
            // when it is the thing that moved; otherwise it follows a directly edited rect.
            if (lastAppliedMatHeight >= 0f && !Mathf.Approximately(matHeightInFrame, lastAppliedMatHeight))
            {
                interactionRectInGameUv = ProjectionCoordinateMapper.CenteredMatRect(
                    matHeightInFrame,
                    ProjectionCoordinateMapper.MatAspectOf(interactionRectInGameUv));
            }

            interactionRectInGameUv = ProjectionCoordinateMapper.SanitizeInteractionRect(interactionRectInGameUv);
            matHeightInFrame = interactionRectInGameUv.height;
            lastAppliedMatHeight = matHeightInFrame;
            ApplyRectsToFrames();
            ApplyGuideVisibility();
            if (!Application.isPlaying && !HasValidCalibration)
            {
                SetPreviewMatrixFromInteractionRect();
            }

            ApplyMaterialState();
        }
    }
}
