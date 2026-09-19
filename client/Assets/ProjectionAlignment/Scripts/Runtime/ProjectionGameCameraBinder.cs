using System;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// Owns the answer to "which camera is Game Camera A right now".
    ///
    /// The rig is built around one camera writing the 1920x1080 render texture: the screen
    /// canvas hangs off it, the virtual touchscreen reports pixels in its space, and the
    /// pre-warp shader shows whatever lands in that texture. That is a role, not a fixed
    /// object — when the shell loads a game scene additively, the game arrives with its own
    /// camera, its own framing and its own references to it, and the cheapest correct move
    /// is to hand the role over rather than to re-point the game at the shell's camera.
    ///
    /// Everything that has to change hands is here, so there is one place to read to know
    /// what "being the projected camera" consists of. The rig still does not know what it
    /// is projecting; it only knows how to re-seat its own wiring.
    /// </summary>
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(-90)]
    public sealed class ProjectionGameCameraBinder : MonoBehaviour
    {
        /// <summary>Unity's built-in UI layer. Camera A has to see it or the rig's own overlays vanish.</summary>
        public const int UiLayer = 5;

        [SerializeField] private RenderTexture gameTexture;

        [Tooltip("The camera the rig was built around — the shell's own. The role returns here "
            + "when a hosted game is unloaded.")]
        [SerializeField] private Camera defaultCamera;

        [Tooltip("The rig's screen-space canvas: alignment guides, calibration backdrop and the "
            + "calibration instructions. It renders through whichever camera holds the role.")]
        [SerializeField] private Canvas gameCanvas;

        [SerializeField] private ProjectionVirtualTouchscreen virtualTouchscreen;

        [SerializeField] private ProjectionAlignmentController alignment;

        [Tooltip("Render the game into the mat area instead of the whole frame. On means every "
            + "pixel a game draws is a pixel someone can stand on — the price is that the image "
            + "stops filling the projector's spot and the mat's shape becomes the game's aspect "
            + "ratio. Off restores the older arrangement, where the frame is the screen and the "
            + "mat is the interactive middle of it.")]
        [SerializeField] private bool fitGameToInteractionArea = true;

        // Startup remains a desktop preview until real pressure frames confirm connected hardware.
        private int connectedBoardCount;

        /// <summary>What a guest camera looked like before it was pressed into service.</summary>
        private struct GuestState
        {
            public Camera camera;
            public RenderTexture targetTexture;
            public int targetDisplay;
            public float depth;
            public int cullingMask;
            public string tag;
            public Rect viewport;
            public bool addedPhysicsRaycaster;
        }

        private GuestState guest;
        private bool hasGuest;
        private bool defaultCameraWasEnabled;

        /// <summary>The camera currently rendering the projected image.</summary>
        public Camera Current => hasGuest && guest.camera != null ? guest.camera : defaultCamera;

        /// <summary>The shell's own camera; the role goes back to it on release.</summary>
        public Camera DefaultCamera => defaultCamera;

        /// <summary>True while a hosted game's camera holds the role.</summary>
        public bool HasGuest => hasGuest;

        /// <summary>Raised after the role moves, with the camera that now holds it.</summary>
        public event Action<Camera> ProjectedCameraChanged;

        public void Configure(
            RenderTexture texture,
            Camera camera,
            Canvas canvas,
            ProjectionVirtualTouchscreen touchscreen,
            ProjectionAlignmentController alignmentController = null)
        {
            gameTexture = texture;
            defaultCamera = camera;
            gameCanvas = canvas;
            virtualTouchscreen = touchscreen;
            alignment = alignmentController;
        }

        /// <summary>
        /// Whether the game is being drawn into the mat area rather than the whole frame.
        /// </summary>
        public bool FitsGameToInteractionArea
        {
            get => fitGameToInteractionArea;
            set
            {
                if (fitGameToInteractionArea == value)
                {
                    return;
                }

                fitGameToInteractionArea = value;
                ApplyViewport();
            }
        }

        /// <summary>The number of currently streaming, protocol-confirmed pressure mats.</summary>
        public int ConnectedBoardCount => connectedBoardCount;

        /// <summary>The policy currently applied to the projected camera.</summary>
        public bool EffectiveFitsGameToInteractionArea => ShouldFitGameToInteractionArea(
            fitGameToInteractionArea,
            connectedBoardCount);

        /// <summary>
        /// Updates the crop policy from confirmed pressure frames. Without hardware the game uses the complete
        /// 16:9 frame instead of being trapped in an empty square in the middle.
        /// </summary>
        public void SetConnectedBoardCount(int count)
        {
            count = Mathf.Max(0, count);
            if (connectedBoardCount == count)
            {
                return;
            }

            connectedBoardCount = count;
            ApplyViewport();
        }

        public static bool ShouldFitGameToInteractionArea(bool configuredFit, int confirmedBoardCount)
        {
            return configuredFit && confirmedBoardCount > 0;
        }

        /// <summary>
        /// Puts the projected camera's viewport where the mat is.
        ///
        /// This is the whole of "all of the game lands on the mat": a screen-space canvas
        /// covers its camera's viewport, and every ray, raycaster and pointer conversion goes
        /// through the same viewport, so shrinking it moves the game's UI, its world and its
        /// input together and no game has to know. What a game does have to tolerate is the
        /// aspect ratio it is handed — two mats side by side are 2:1, not 16:9.
        ///
        /// Board UV then maps onto the mat area exactly: the touchscreen's full-frame pixel
        /// is the viewport pixel underneath the finger, with no term left over. The viewport
        /// itself may be the mat area plus a render margin — more picture drawn around the
        /// mat, on the strip that still takes a press — and that changes nothing here: the
        /// mapping is tied to the mat area, the viewport only says how far the game draws.
        /// </summary>
        public void ApplyViewport()
        {
            Rect coverage = EffectiveFitsGameToInteractionArea && alignment != null
                ? alignment.ViewportRectInGameUv
                : FullFrame;

            Camera camera = Current;
            if (camera != null)
            {
                camera.rect = ToViewport(coverage);
            }

            if (alignment != null)
            {
                alignment.SetCanvasCoverage(coverage);
            }
        }

        private static readonly Rect FullFrame = new Rect(0f, 0f, 1f, 1f);

        /// <summary>Game UV runs top-left down; a camera's viewport runs bottom-left up.</summary>
        private static Rect ToViewport(Rect gameUvRect)
        {
            return new Rect(gameUvRect.x, 1f - gameUvRect.yMax, gameUvRect.width, gameUvRect.height);
        }

        /// <summary>
        /// Points a camera at the render texture that is the 16:9 screen. After this the
        /// camera's pixel rect is 1920x1080 no matter how big the player window is, which
        /// is what makes screen pixels a stable coordinate system for input.
        ///
        /// Returns whether a PhysicsRaycaster had to be added, so a guest camera can be
        /// handed back exactly as it arrived.
        /// </summary>
        public static bool ConfigureAsGameCamera(Camera camera, RenderTexture gameTexture)
        {
            if (camera == null)
            {
                return false;
            }

            camera.tag = "MainCamera";
            camera.targetTexture = gameTexture;
            camera.targetDisplay = 0;
            camera.depth = -10f;
            camera.cullingMask |= 1 << UiLayer;

            // Pointer events on 3D colliders. The rest of the UI event chain is on the
            // canvas; this is the half that reaches the world.
            if (camera.GetComponent<PhysicsRaycaster>() != null)
            {
                return false;
            }

            camera.gameObject.AddComponent<PhysicsRaycaster>();
            return true;
        }

        /// <summary>
        /// Hands the projected-camera role to a hosted game's camera. The shell's camera
        /// stands down — disabled rather than untagged, because <c>Camera.main</c> skips
        /// disabled cameras and every game resolves its camera that way.
        ///
        /// Idempotent, and refuses the shell's own camera: releasing is the way back.
        /// </summary>
        public bool Adopt(Camera camera)
        {
            if (camera == null || camera == defaultCamera)
            {
                return false;
            }

            if (hasGuest && guest.camera == camera)
            {
                return true;
            }

            if (hasGuest)
            {
                Release();
            }

            guest = new GuestState
            {
                camera = camera,
                targetTexture = camera.targetTexture,
                targetDisplay = camera.targetDisplay,
                depth = camera.depth,
                cullingMask = camera.cullingMask,
                tag = camera.tag,
                viewport = camera.rect
            };
            guest.addedPhysicsRaycaster = ConfigureAsGameCamera(camera, gameTexture);
            hasGuest = true;

            if (defaultCamera != null)
            {
                defaultCameraWasEnabled = defaultCamera.enabled;
                defaultCamera.enabled = false;
                SetAudioListenerEnabled(defaultCamera, false);
            }

            camera.enabled = true;
            SetAudioListenerEnabled(camera, true);
            Bind(camera);
            ApplyViewport();
            return true;
        }

        /// <summary>
        /// Takes the role back. Safe to call when nothing was adopted, and safe to call
        /// after the guest has already been destroyed with its scene — the shell's camera
        /// is restored either way, which is the part that must not be missed.
        /// </summary>
        public void Release()
        {
            if (!hasGuest)
            {
                return;
            }

            Camera camera = guest.camera;
            if (camera != null)
            {
                camera.targetTexture = guest.targetTexture;
                camera.targetDisplay = guest.targetDisplay;
                camera.depth = guest.depth;
                camera.cullingMask = guest.cullingMask;
                camera.tag = string.IsNullOrEmpty(guest.tag) ? "Untagged" : guest.tag;
                camera.rect = guest.viewport;
                if (guest.addedPhysicsRaycaster)
                {
                    PhysicsRaycaster raycaster = camera.GetComponent<PhysicsRaycaster>();
                    if (raycaster != null)
                    {
                        Destroy(raycaster);
                    }
                }
            }

            guest = default;
            hasGuest = false;

            if (defaultCamera != null)
            {
                defaultCamera.enabled = defaultCameraWasEnabled;
                SetAudioListenerEnabled(defaultCamera, true);
            }

            Bind(defaultCamera);
            ApplyViewport();
        }

        /// <summary>
        /// Re-seats the two pieces of the rig that are tied to a specific camera. The canvas
        /// carries the alignment guides and the calibration instructions, which are drawn on
        /// Camera A on purpose — the person calibrating is looking at the table, not at the
        /// laptop — so it has to follow the role, or calibration goes invisible the moment a
        /// game is loaded.
        /// </summary>
        private void Bind(Camera camera)
        {
            if (gameCanvas != null)
            {
                gameCanvas.worldCamera = camera;
                if (camera != null)
                {
                    // Just clear of the near plane: at a larger distance any geometry that
                    // gets between the camera and the canvas would punch through the UI.
                    gameCanvas.planeDistance = camera.nearClipPlane + 0.01f;
                }
            }

            if (virtualTouchscreen != null)
            {
                virtualTouchscreen.SetScreenCamera(camera);
            }

            ProjectedCameraChanged?.Invoke(camera);
        }

        private static void SetAudioListenerEnabled(Camera camera, bool value)
        {
            if (camera == null)
            {
                return;
            }

            var listener = camera.GetComponent<AudioListener>();
            if (listener != null)
            {
                listener.enabled = value;
            }
        }

        private void Awake()
        {
            if (defaultCamera == null)
            {
                defaultCamera = Camera.main;
            }

            if (alignment == null)
            {
                alignment = GetComponent<ProjectionAlignmentController>();
            }
        }

        private void OnEnable()
        {
            if (alignment != null)
            {
                alignment.CalibrationChanged += ApplyViewport;
            }
        }

        private void OnDisable()
        {
            if (alignment != null)
            {
                alignment.CalibrationChanged -= ApplyViewport;
            }
        }

        private void Start()
        {
            // After the alignment controller has loaded whatever calibration is on disk: the
            // mat area it restores is usually not the one serialized in the scene.
            ApplyViewport();
        }
    }
}
