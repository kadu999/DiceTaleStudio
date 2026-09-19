using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
using UnityEngine.Rendering;
using TouchPhase = UnityEngine.InputSystem.TouchPhase;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// Which top-left UV space receives pressure-mat contacts.
    /// </summary>
    public enum ProjectionTouchPixelSpace
    {
        /// <summary>The ordinary pre-warp chain: board UV lands in Camera A's interaction rect.</summary>
        GameSource,

        /// <summary>
        /// Camera A is already rendering the projector's view and the warp is bypassed: board UV
        /// must be inverted through the calibration homography into projector-output UV.
        /// </summary>
        ProjectorOutput
    }

    /// <summary>
    /// Publishes the pressure mat as a real Input System <see cref="Touchscreen"/> whose
    /// coordinates are pixels on the 16:9 screen — that is, pixels of Game Camera A's
    /// render texture, not of the player window.
    ///
    /// That is the whole point: everything downstream (EventSystem, GraphicRaycaster,
    /// Camera.ScreenPointToRay, Touchscreen.current) already speaks screen pixels, and
    /// a camera that renders into a render texture reports that texture as its pixel
    /// rect. So once the mapping board UV -> game UV -> render-texture pixel is done
    /// here, game code never has to hear about board coordinates or the homography again.
    ///
    /// Only the mat is a touch surface. Board UV is defined on [0,1]^2, so the side
    /// bands of the 16:9 image simply never receive events — no extra code is needed to
    /// make them non-interactive.
    /// </summary>
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(-50)]
    public sealed class ProjectionVirtualTouchscreen : MonoBehaviour
    {
        /// <summary>Touchscreen has ten finger slots; anything past that cannot be reported.</summary>
        private const int MaximumTouches = 10;

        [SerializeField] private ProjectionAlignmentController alignment;
        [SerializeField] private PressureInputRouter pressureInput;

        [Tooltip("The camera whose pixels define the screen. Its render texture is the 16:9 "
            + "image the projector shows, so its pixel rect is the coordinate system every "
            + "touch is reported in.")]
        [SerializeField] private Camera screenCamera;

        [Tooltip("How far a contact may travel between frames and still count as the same finger, "
            + "in CENTIMETRES. 4 cm is eight sensor cells: well beyond how far a finger holding a "
            + "note drifts between rasters, and under the spacing any game asks two fingers to "
            + "hold at once.")]
        [SerializeField, Range(0.5f, 20f)] private float trackingRadiusCm = 4f;

        [Tooltip("Contacts below this normalised pressure are ignored, the same threshold idea the "
            + "calibrator uses. Keeps sensor noise from producing phantom taps.")]
        [SerializeField, Range(0f, 1f)] private float minimumPressure = 0.05f;

        [Tooltip("When a game explicitly locks a single pressure contact, keep that touch alive "
            + "through a brief empty hardware sample instead of reporting an immediate release.")]
        [SerializeField, Range(0f, 0.25f)] private float singleTouchDropoutGrace = 0.12f;

        [Tooltip("关掉 URP 的运行时渲染调试器。它的开启手势是三指双击触摸屏，而压感垫就是触摸屏；"
            + "开出来的 [Debug Canvas] 是 Overlay，绕开预畸变直接画在投影帧上。")]
        [SerializeField] private bool suppressRenderingDebugger = true;

        private bool debugUiSuppressed;
        private bool debugUiWasEnabled;

        private sealed class TrackedTouch
        {
            public int touchId;
            public Vector2 boardUv;
            public Vector2 screenPosition;
            public int contactIndex;
            public float missingSince = -1f;
        }

        private readonly List<TrackedTouch> tracked = new List<TrackedTouch>(MaximumTouches);
        private readonly List<BoardContact> usableContacts = new List<BoardContact>(MaximumTouches);
        private readonly List<bool> contactClaimed = new List<bool>(MaximumTouches);

        private Touchscreen device;
        private int nextTouchId = 1;
        private bool suspended;
        private ProjectionTouchPixelSpace pixelSpace = ProjectionTouchPixelSpace.GameSource;
        private Func<BoardContact, bool> contactAcceptanceFilter;
        private bool retainSingleTouchOnBriefLoss;

        /// <summary>The device this component owns. Null before Awake and after OnDisable.</summary>
        public Touchscreen Device => device;

        /// <summary>Live touches, for diagnostics.</summary>
        public int ActiveTouchCount => tracked.Count;

        public bool RetainingSingleTouchOnBriefLoss => retainSingleTouchOnBriefLoss;

        public void SetSingleTouchDropoutRetention(bool value)
        {
            retainSingleTouchOnBriefLoss = value;
        }

        /// <summary>
        /// While suspended no touch is reported and any finger down is cancelled. Calibration
        /// uses this so stepping on a calibration marker cannot also drive the game.
        /// </summary>
        public bool Suspended => suspended;

        /// <summary>The UV space currently used for physical pressure contacts.</summary>
        public ProjectionTouchPixelSpace PixelSpace => pixelSpace;

        public void Configure(
            ProjectionAlignmentController configuredAlignment,
            PressureInputRouter configuredPressureInput,
            Camera configuredScreenCamera)
        {
            alignment = configuredAlignment;
            pressureInput = configuredPressureInput;
            screenCamera = configuredScreenCamera;
        }

        /// <summary>
        /// Follows the projected-camera role when a hosted game's camera takes it over. The
        /// pixel space is the same either way — both cameras render the same 1920x1080
        /// texture — but reading it off the camera that is actually rendering keeps the
        /// fallback honest if a game ever arrives with a different texture.
        /// </summary>
        public void SetScreenCamera(Camera camera)
        {
            screenCamera = camera;
        }

        /// <summary>
        /// Changes the pixel space used by physical pressure contacts. Any live touches are
        /// cancelled first: keeping a finger alive while its coordinates jump between source
        /// and projector space would turn one press into a large synthetic drag.
        /// </summary>
        public void SetPixelSpace(ProjectionTouchPixelSpace value)
        {
            if (pixelSpace == value)
            {
                return;
            }

            EndAllTouches();
            pixelSpace = value;
        }

        public void SetSuspended(bool value)
        {
            if (suspended == value)
            {
                return;
            }

            suspended = value;
            if (suspended)
            {
                EndAllTouches();
            }
        }

        /// <summary>
        /// The screen's size in pixels — the render texture, not the window, and the whole
        /// texture rather than the camera's viewport.
        ///
        /// The distinction matters once the game is fitted into the mat area: the camera's
        /// <c>pixelWidth</c> is then the viewport, while the UV this converts is measured
        /// across the full frame. Multiplying a full-frame UV by a viewport size lands every
        /// touch short of where it belongs — and the two agree in every other configuration,
        /// so the mistake would only show up on the rig.
        /// </summary>
        public Vector2 ScreenPixelSize
        {
            get
            {
                RenderTexture texture = screenCamera != null && screenCamera.targetTexture != null
                    ? screenCamera.targetTexture
                    : (alignment != null ? alignment.GameTexture : null);
                if (texture != null)
                {
                    return new Vector2(texture.width, texture.height);
                }

                if (screenCamera != null && screenCamera.pixelWidth > 0 && screenCamera.pixelHeight > 0)
                {
                    return new Vector2(screenCamera.pixelWidth, screenCamera.pixelHeight);
                }

                return new Vector2(Screen.width, Screen.height);
            }
        }

        /// <summary>
        /// Board UV to a pixel on the screen. Game/projector UV runs top-left down; screen
        /// pixels run bottom-left up, hence the flip on Y.
        ///
        /// The mouse simulator is different from a physical mat: its UV already describes
        /// the whole visible player window. Sending it through the calibrated interaction
        /// rect a second time compresses and offsets the pointer, so visible controls outside
        /// the mat rectangle can never be clicked. In simulation mode it therefore maps
        /// directly to the complete render texture.
        /// </summary>
        public Vector2 BoardToScreenPixels(Vector2 boardUv)
        {
            Vector2 size = ScreenPixelSize;
            if (pressureInput != null && pressureInput.UsingSimulation)
            {
                return SimulationPointerToScreenPixels(boardUv, size);
            }

            Rect interactionRect = alignment != null
                ? alignment.InteractionRectInGameUv
                : ProjectionCoordinateMapper.DefaultInteractionRect;
            Matrix4x4 boardToProjector = alignment != null
                ? alignment.BoardToProjectorMatrix
                : Matrix4x4.identity;
            Vector2 targetUv = ResolveBoardPixelUv(boardUv, interactionRect, boardToProjector, pixelSpace);
            return TopLeftUvToScreenPixels(targetUv, size);
        }

        /// <summary>
        /// Installs an optional game-side ownership filter. Returning false keeps that pressure
        /// contact available to diagnostics while preventing it from becoming a generic touch.
        /// Darkwater uses this for stable physical pieces so a piece cannot occupy primaryTouch
        /// forever. Replacing the filter cancels live touches because their slot ownership may
        /// have changed.
        /// </summary>
        public void SetContactAcceptanceFilter(Func<BoardContact, bool> filter)
        {
            if (contactAcceptanceFilter == filter) return;
            EndAllTouches();
            contactAcceptanceFilter = filter;
        }

        public void ClearContactAcceptanceFilter(Func<BoardContact, bool> filter)
        {
            if (contactAcceptanceFilter != filter) return;
            EndAllTouches();
            contactAcceptanceFilter = null;
        }

        /// <summary>
        /// Resolves a board contact into the UV space currently drawn into the render texture.
        /// The ordinary pre-warp path draws source UV; a direct projector-camera feed draws
        /// projector UV. Keeping this choice explicit is what lets UI and PhysicsRaycaster use
        /// the same virtual Touchscreen in both modes.
        /// </summary>
        public static Vector2 ResolveBoardPixelUv(
            Vector2 boardUv,
            Rect interactionRect,
            Matrix4x4 boardToProjector,
            ProjectionTouchPixelSpace pixelSpace)
        {
            if (pixelSpace == ProjectionTouchPixelSpace.ProjectorOutput
                && HomographyUtility.TryApply(boardToProjector, boardUv, out Vector2 projectorUv))
            {
                return projectorUv;
            }

            return ProjectionCoordinateMapper.BoardToSourceUv(boardUv, interactionRect);
        }

        public static Vector2 TopLeftUvToScreenPixels(Vector2 uv, Vector2 screenSize)
        {
            return new Vector2(uv.x * screenSize.x, (1f - uv.y) * screenSize.y);
        }

        public static Vector2 SimulationPointerToScreenPixels(Vector2 pointerUv, Vector2 screenSize)
        {
            return TopLeftUvToScreenPixels(new Vector2(
                Mathf.Clamp01(pointerUv.x),
                Mathf.Clamp01(pointerUv.y)), screenSize);
        }

        private void OnEnable()
        {
            if (device == null)
            {
                device = InputSystem.AddDevice<Touchscreen>("Pressure Mat");
            }

            // 触摸屏是本组件递给 Unity 的，那个手势也由它关掉。
            // enableRuntimeUI=false 连带销毁 [Debug Canvas]、拆掉 [Debug Updater]。
            if (suppressRenderingDebugger && !debugUiSuppressed)
            {
                debugUiWasEnabled = DebugManager.instance.enableRuntimeUI;
                debugUiSuppressed = true;
                DebugManager.instance.enableRuntimeUI = false;
            }
        }

        private void OnDisable()
        {
            retainSingleTouchOnBriefLoss = false;
            EndAllTouches();
            if (device != null)
            {
                InputSystem.RemoveDevice(device);
                device = null;
            }

            if (debugUiSuppressed)
            {
                DebugManager.instance.enableRuntimeUI = debugUiWasEnabled;
                debugUiSuppressed = false;
            }
        }

        private void Update()
        {
            if (device == null || pressureInput == null)
            {
                return;
            }

            if (suspended)
            {
                return;
            }

            CollectUsableContacts();
            MatchTrackedToContacts();
            ReportTouches();
        }

        private void CollectUsableContacts()
        {
            usableContacts.Clear();
            contactClaimed.Clear();

            float effectiveMinimumPressure = minimumPressure;
            if (pressureInput != null
                && !pressureInput.UsingSimulation
                && pressureInput.HardwareSource != null)
            {
                effectiveMinimumPressure = Mathf.Min(
                    effectiveMinimumPressure,
                    pressureInput.HardwareSource.MinimumPressure
                        / Mathf.Max(1f, pressureInput.PressureFullScale));
            }

            IReadOnlyList<BoardContact> contacts = pressureInput.Contacts;
            for (int index = 0; index < contacts.Count && usableContacts.Count < MaximumTouches; index++)
            {
                if (contacts[index].normalizedPressure < effectiveMinimumPressure)
                {
                    continue;
                }

                if (contactAcceptanceFilter != null && !contactAcceptanceFilter(contacts[index]))
                {
                    continue;
                }

                usableContacts.Add(contacts[index]);
                contactClaimed.Add(false);
            }
        }

        /// <summary>
        /// The mat reports positions, not identities, so a finger's identity has to be
        /// inferred: each already-tracked touch claims the nearest unclaimed contact within
        /// the tracking radius. Without this every frame would look like a fresh tap and a
        /// drag would never happen.
        ///
        /// <para>
        /// The radius is measured in centimetres, not in board UV, and that is not a
        /// refinement. Board UV is normalised over the whole interactive area, so on a two-mat
        /// rig one unit of it is 101 cm across and 50 cm down: a single board-UV radius is
        /// twice as generous horizontally as vertically, and the horizontal axis is the one a
        /// keyboard's keys are spaced along. At the old 0.08 the horizontal reach was 8 cm —
        /// two white keys — so a held note could hand its identity to the finger beside it.
        /// </para>
        /// </summary>
        private void MatchTrackedToContacts()
        {
            for (int index = 0; index < tracked.Count; index++)
            {
                tracked[index].contactIndex = -1;
            }

            float widthCm = pressureInput != null
                ? pressureInput.AreaWidthCm
                : ProjectionCoordinateMapper.MatEdgeCm;
            float heightCm = ProjectionCoordinateMapper.MatEdgeCm;

            for (int index = 0; index < tracked.Count; index++)
            {
                TrackedTouch touch = tracked[index];
                int bestContact = -1;
                float bestDistance = trackingRadiusCm;
                for (int contact = 0; contact < usableContacts.Count; contact++)
                {
                    if (contactClaimed[contact])
                    {
                        continue;
                    }

                    Vector2 apart = touch.boardUv - usableContacts[contact].boardUv;
                    float distance = new Vector2(apart.x * widthCm, apart.y * heightCm).magnitude;
                    if (distance < bestDistance)
                    {
                        bestDistance = distance;
                        bestContact = contact;
                    }
                }

                if (bestContact >= 0)
                {
                    contactClaimed[bestContact] = true;
                    touch.contactIndex = bestContact;
                }
            }

            // With one physical contact there is no identity ambiguity. Do not turn a fast
            // pressure-mat slide into an Ended/Began pair merely because its sampled centroid
            // jumped farther than the multi-touch matching radius between hardware frames.
            if (tracked.Count == 1
                && usableContacts.Count == 1
                && tracked[0].contactIndex < 0
                && !contactClaimed[0])
            {
                tracked[0].contactIndex = 0;
                contactClaimed[0] = true;
            }
        }

        private void ReportTouches()
        {
            // Lifted fingers first, so their slots are free before new ones are queued.
            for (int index = tracked.Count - 1; index >= 0; index--)
            {
                TrackedTouch touch = tracked[index];
                if (touch.contactIndex >= 0)
                {
                    touch.missingSince = -1f;
                    continue;
                }

                if (retainSingleTouchOnBriefLoss
                    && singleTouchDropoutGrace > 0f
                    && tracked.Count == 1
                    && usableContacts.Count == 0)
                {
                    if (touch.missingSince < 0f)
                        touch.missingSince = Time.unscaledTime;
                    if (Time.unscaledTime - touch.missingSince
                        <= singleTouchDropoutGrace)
                    {
                        continue;
                    }
                }

                QueueTouch(touch.touchId, touch.screenPosition, Vector2.zero, 0f, Vector2.zero, TouchPhase.Ended);
                tracked.RemoveAt(index);
            }

            for (int index = 0; index < tracked.Count; index++)
            {
                TrackedTouch touch = tracked[index];
                if (touch.contactIndex < 0)
                    continue;
                BoardContact contact = usableContacts[touch.contactIndex];
                Vector2 position = BoardToScreenPixels(contact.boardUv);
                Vector2 delta = position - touch.screenPosition;
                bool moved = delta.sqrMagnitude > 0.0001f;
                QueueTouch(
                    touch.touchId,
                    position,
                    delta,
                    contact.normalizedPressure,
                    RadiusInScreenPixels(contact),
                    moved ? TouchPhase.Moved : TouchPhase.Stationary);
                touch.boardUv = contact.boardUv;
                touch.screenPosition = position;
            }

            for (int index = 0; index < usableContacts.Count; index++)
            {
                if (contactClaimed[index] || tracked.Count >= MaximumTouches)
                {
                    continue;
                }

                BoardContact contact = usableContacts[index];
                Vector2 position = BoardToScreenPixels(contact.boardUv);
                var touch = new TrackedTouch
                {
                    touchId = nextTouchId++,
                    boardUv = contact.boardUv,
                    screenPosition = position,
                    contactIndex = index
                };
                contactClaimed[index] = true;
                tracked.Add(touch);
                QueueTouch(
                    touch.touchId,
                    position,
                    Vector2.zero,
                    contact.normalizedPressure,
                    RadiusInScreenPixels(contact),
                    TouchPhase.Began);
            }
        }

        private Vector2 RadiusInScreenPixels(BoardContact contact)
        {
            if (pressureInput == null)
            {
                return Vector2.zero;
            }

            Vector2Int resolution = pressureInput.SensorResolution;
            Rect rect = alignment != null
                ? alignment.InteractionRectInGameUv
                : ProjectionCoordinateMapper.DefaultInteractionRect;
            Vector2 size = ScreenPixelSize;
            return new Vector2(
                contact.radius / Mathf.Max(1, resolution.x) * rect.width * size.x,
                contact.radius / Mathf.Max(1, resolution.y) * rect.height * size.y);
        }

        private void QueueTouch(
            int touchId,
            Vector2 position,
            Vector2 delta,
            float pressure,
            Vector2 radius,
            TouchPhase phase)
        {
            if (device == null)
            {
                return;
            }

            InputSystem.QueueStateEvent(device, new TouchState
            {
                touchId = touchId,
                position = position,
                delta = delta,
                pressure = pressure,
                radius = radius,
                phase = phase
            });
        }

        private void EndAllTouches()
        {
            for (int index = 0; index < tracked.Count; index++)
            {
                TrackedTouch touch = tracked[index];
                QueueTouch(touch.touchId, touch.screenPosition, Vector2.zero, 0f, Vector2.zero, TouchPhase.Canceled);
            }

            tracked.Clear();
        }
    }
}
