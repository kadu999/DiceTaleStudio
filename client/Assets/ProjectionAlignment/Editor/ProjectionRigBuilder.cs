using DeviceViz;
using UnityEditor;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem.UI;
using UnityEngine.UI;

namespace NuLight.ProjectionAlignment.Editor
{
    /// <summary>
    /// Builds the projection rig — everything between "a camera renders the game" and
    /// "the projector shows it on the mat" — into an arbitrary scene.
    ///
    /// It is deliberately independent of what the game is: it takes a camera, points it
    /// at the render texture and wraps it. The demo scene and the DM Game Library scene
    /// both go through here, so the two can never drift apart.
    /// </summary>
    public static class ProjectionRigBuilder
    {
        public const string RootFolder = "Assets/ProjectionAlignment";
        public const string SceneFolder = RootFolder + "/Scenes";
        public const string MaterialFolder = RootFolder + "/Materials";
        public const string RenderTextureFolder = RootFolder + "/RenderTextures";
        public const string MaterialPath = MaterialFolder + "/ProjectionWarp.mat";
        public const string OverlayUiMaterialPath = MaterialFolder + "/ProjectionOverlayUi.mat";
        public const string RenderTexturePath = RenderTextureFolder + "/GameRenderTexture.renderTexture";
        public const int UiLayer = 5;

        /// <summary>Everything a caller might want to wire further, in one place.</summary>
        public sealed class Result
        {
            public GameObject Root;
            public Camera GameCamera;
            public RenderTexture GameTexture;
            public ProjectionAlignmentController Alignment;
            public ProjectionCalibrationController Calibration;
            public ProjectionVirtualTouchscreen VirtualTouchscreen;
            public PressureInputRouter PressureInput;
            public ProjectionGameCameraBinder CameraBinder;
            public Canvas GameCanvas;
            public RectTransform InteractionFrame;
            public RectTransform ScreenAreaFrame;
        }

        /// <summary>
        /// Points a camera at the render texture that is the 16:9 screen. After this the
        /// camera's pixel rect is 1920x1080 no matter how big the player window is, which
        /// is what makes screen pixels a stable coordinate system for input.
        ///
        /// The same routine runs at runtime when a hosted game's camera takes the role over,
        /// so "being Camera A" means one thing whether it was arranged by the builder or by
        /// a scene load.
        /// </summary>
        public static void ConfigureGameCamera(Camera camera, RenderTexture gameTexture)
        {
            ProjectionGameCameraBinder.ConfigureAsGameCamera(camera, gameTexture);
        }

        public static Result Build(
            GameObject rigRoot,
            Camera gameCamera,
            RenderTexture gameTexture,
            Material warpMaterial,
            bool guidesVisible)
        {
            var result = new Result
            {
                Root = rigRoot,
                GameCamera = gameCamera,
                GameTexture = gameTexture
            };

            Rect interactionRect = ProjectionCoordinateMapper.DefaultInteractionRect;
            Material overlayUiMaterial = CreateOrLoadOverlayUiMaterial();

            Canvas gameCanvas = CreateGameCanvas(gameCamera, rigRoot.transform);

            // Order inside the canvas is the whole design of the calibration layer: the
            // dimming backdrop first so the guides stay bright over it, the instruction
            // panel last so nothing can cover the instructions.
            GameObject backdrop = BuildCalibrationBackdrop((RectTransform)gameCanvas.transform);
            RectTransform screenAreaFrame = BuildScreenAreaOverlay(
                (RectTransform)gameCanvas.transform,
                new Rect(0f, 0f, 1f, 1f),
                out GameObject screenAreaGuide);
            RectTransform interactionFrame = BuildInteractionOverlay(
                (RectTransform)gameCanvas.transform,
                interactionRect,
                out GameObject interactionGuide,
                out RectTransform markerHost,
                out Text interactionFrameLabel,
                out GameObject boardSeamGuide);
            ProjectionCalibrationOverlay overlay = BuildCalibrationMessage(
                (RectTransform)gameCanvas.transform,
                rigRoot,
                backdrop);
            SetLayerRecursively(gameCanvas.gameObject, UiLayer);
            ApplyOverlayMaterial(gameCanvas.transform, overlayUiMaterial);

            MatrixHeatmap heatmap = CreateOperatorHeatmap(rigRoot.transform);

            var hardwareSource = rigRoot.AddComponent<DevicePipePressureSource>();
            hardwareSource.Configure(heatmap, true);
            var simulationSource = rigRoot.AddComponent<MousePressureSource>();
            var pressureRouter = rigRoot.AddComponent<PressureInputRouter>();
            pressureRouter.Configure(hardwareSource, simulationSource);

            var alignment = rigRoot.AddComponent<ProjectionAlignmentController>();
            alignment.Configure(warpMaterial, gameTexture, interactionFrame, screenAreaFrame);
            alignment.ConfigureMatDecorations(interactionFrameLabel, boardSeamGuide);
            alignment.SetInteractionRect(interactionRect);
            alignment.ConfigureGuides(
                new[] { interactionGuide, screenAreaGuide },
                guidesVisible);

            var virtualTouchscreen = rigRoot.AddComponent<ProjectionVirtualTouchscreen>();
            virtualTouchscreen.Configure(alignment, pressureRouter, gameCamera);

            // Who is Camera A. Built after the canvas and the touchscreen because it owns
            // re-seating both when a hosted game's camera takes the role over, and after the
            // alignment controller because the mat area is what its viewport is cut from.
            var cameraBinder = rigRoot.AddComponent<ProjectionGameCameraBinder>();
            cameraBinder.Configure(gameTexture, gameCamera, gameCanvas, virtualTouchscreen, alignment);
            CreateGameTextureClearCamera(rigRoot.transform, gameTexture);

            var displayRouter = rigRoot.AddComponent<ProjectionDisplayRouter>();
            displayRouter.Configure(alignment);

            var calibration = rigRoot.AddComponent<ProjectionCalibrationController>();
            calibration.Configure(alignment, pressureRouter, overlay, virtualTouchscreen, displayRouter);

            var touchVisualizer = rigRoot.AddComponent<ProjectionTouchVisualizer>();
            touchVisualizer.Configure(pressureRouter, markerHost, overlayUiMaterial);

            CreateDisplayCamera(rigRoot.transform);
            RawImage outputImage = CreateProjectorOutputSurface(rigRoot.transform, gameTexture, warpMaterial);
            var projectorFeed = rigRoot.AddComponent<ProjectorFeed>();
            projectorFeed.Configure(alignment, outputImage);

            EnsureEventSystem(rigRoot.transform);

            result.Alignment = alignment;
            result.Calibration = calibration;
            result.VirtualTouchscreen = virtualTouchscreen;
            result.PressureInput = pressureRouter;
            result.CameraBinder = cameraBinder;
            result.GameCanvas = gameCanvas;
            result.InteractionFrame = interactionFrame;
            result.ScreenAreaFrame = screenAreaFrame;
            return result;
        }

        /// <summary>
        /// uGUI needs an EventSystem to deliver anything. One per scene — a second one
        /// disables itself and logs, so check before adding.
        ///
        /// The check is scoped to the scene being built, not the whole editor: scenes are
        /// built while another one is open, and a global search would see that one's
        /// EventSystem and leave this scene without any.
        /// </summary>
        public static void EnsureEventSystem(Transform parent)
        {
            GameObject[] roots = parent.gameObject.scene.GetRootGameObjects();
            for (int index = 0; index < roots.Length; index++)
            {
                if (roots[index].GetComponentInChildren<EventSystem>(true) != null)
                {
                    return;
                }
            }

            var eventSystemObject = new GameObject(
                "Event System",
                typeof(EventSystem),
                typeof(InputSystemUIInputModule));
            eventSystemObject.transform.SetParent(parent, false);
        }

        private static Canvas CreateGameCanvas(Camera gameCamera, Transform parent)
        {
            var canvasObject = new GameObject(
                "Game Screen Canvas (Camera A)",
                typeof(RectTransform),
                typeof(Canvas),
                typeof(CanvasScaler),
                typeof(GraphicRaycaster));
            canvasObject.transform.SetParent(parent, false);
            Canvas canvas = canvasObject.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceCamera;
            canvas.worldCamera = gameCamera;

            // Sorting order beats render queue in Unity's sort key, and game renderers set
            // it freely — the DM library's thumbnails sit at 240. A screen-space canvas left
            // at 0 therefore ends up underneath the very content the alignment guides and
            // the calibration panel exist to sit over. Far above any plausible game value.
            canvas.sortingOrder = 10000;

            // Just clear of the near plane: at a larger distance any geometry that gets
            // between the camera and the canvas would punch through the UI.
            canvas.planeDistance = gameCamera != null
                ? gameCamera.nearClipPlane + 0.01f
                : 0.11f;

            CanvasScaler scaler = canvasObject.GetComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920f, 1080f);
            scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
            scaler.matchWidthOrHeight = 0.5f;
            return canvas;
        }

        /// <summary>
        /// The 16:9 screen outline. Built before the interaction frame so the mat frame
        /// draws on top where they touch. It lives in the same Camera A canvas, so the
        /// projection homography warps it exactly like the mat frame.
        /// </summary>
        private static RectTransform BuildScreenAreaOverlay(
            RectTransform parent,
            Rect gameUvRect,
            out GameObject guide)
        {
            RectTransform frame = CreateRect("Screen Area Frame 16x9 (2D)", parent);
            AnchorToGameUvRect(frame, gameUvRect);

            RectTransform guideRect = CreateRect("Guide Visuals", frame);
            Stretch(guideRect, 0f);
            guide = guideRect.gameObject;

            // At the default height this frame sits on the image border, where an edge
            // centred on the boundary would lose its outer half. Draw it inside instead.
            const float thickness = 5f;
            const float inset = thickness * 0.5f;
            Color frameColor = new Color(1f, 0.78f, 0.12f, 0.95f);
            CreateFrameEdge("Screen Top", guideRect, frameColor, new Vector2(0f, 1f), new Vector2(1f, 1f), new Vector2(0f, thickness), new Vector2(0f, -inset));
            CreateFrameEdge("Screen Bottom", guideRect, frameColor, new Vector2(0f, 0f), new Vector2(1f, 0f), new Vector2(0f, thickness), new Vector2(0f, inset));
            CreateFrameEdge("Screen Left", guideRect, frameColor, new Vector2(0f, 0f), new Vector2(0f, 1f), new Vector2(thickness, 0f), new Vector2(inset, 0f));
            CreateFrameEdge("Screen Right", guideRect, frameColor, new Vector2(1f, 0f), new Vector2(1f, 1f), new Vector2(thickness, 0f), new Vector2(-inset, 0f));

            Text label = CreateText("Screen Area Label", guideRect, "16:9 SCREEN AREA");
            label.rectTransform.anchorMin = new Vector2(1f, 1f);
            label.rectTransform.anchorMax = new Vector2(1f, 1f);
            label.rectTransform.pivot = new Vector2(1f, 1f);
            label.rectTransform.anchoredPosition = new Vector2(-18f, -16f);
            label.rectTransform.sizeDelta = new Vector2(560f, 44f);
            label.alignment = TextAnchor.UpperRight;
            label.fontSize = 22;
            label.color = frameColor;
            return frame;
        }

        /// <summary>
        /// The mat outline. The live pressure dots are parented to the same guide object as
        /// the borders, so one switch takes the whole alignment overlay off the table when
        /// the game is running for an audience.
        /// </summary>
        private static RectTransform BuildInteractionOverlay(
            RectTransform parent,
            Rect gameUvRect,
            out GameObject guide,
            out RectTransform markerHost,
            out Text frameLabel,
            out GameObject seamGuide)
        {
            RectTransform frame = CreateRect("Pressure Board Interaction Frame (2D)", parent);
            AnchorToGameUvRect(frame, gameUvRect);

            RectTransform guideRect = CreateRect("Guide Visuals", frame);
            Stretch(guideRect, 0f);
            guide = guideRect.gameObject;
            markerHost = guideRect;

            // Drawn inside the rect for the same reason as the screen frame: at a mat height
            // of 1 the top and bottom edges sit on the image border.
            const float thickness = 7f;
            const float inset = thickness * 0.5f;
            Color frameColor = new Color(0.05f, 0.9f, 1f, 0.95f);
            CreateFrameEdge("Top", guideRect, frameColor, new Vector2(0f, 1f), new Vector2(1f, 1f), new Vector2(0f, thickness), new Vector2(0f, -inset));
            CreateFrameEdge("Bottom", guideRect, frameColor, new Vector2(0f, 0f), new Vector2(1f, 0f), new Vector2(0f, thickness), new Vector2(0f, inset));
            CreateFrameEdge("Left", guideRect, frameColor, new Vector2(0f, 0f), new Vector2(0f, 1f), new Vector2(thickness, 0f), new Vector2(inset, 0f));
            CreateFrameEdge("Right", guideRect, frameColor, new Vector2(1f, 0f), new Vector2(1f, 1f), new Vector2(thickness, 0f), new Vector2(-inset, 0f));

            // The dead strip between two mats, drawn at its real width — the controller anchors
            // it from the measured seam, so what you see on the table is the band that reports
            // nothing. Lining the mats up against it is what makes the "one wide board" model
            // true, and it is how the seam width gets set without a ruler: widen it until the
            // projected band covers the real gap.
            //
            // Parented to the frame rather than to Guide Visuals so it can be summoned on its
            // own — setting the seam is a job you do with the game running and the rest of the
            // alignment overlay off the table.
            Image seam = CreateImage(
                "Board Seam",
                frame,
                new Color(frameColor.r, frameColor.g, frameColor.b, 0.35f),
                new Vector2(0.5f, 0f),
                new Vector2(0.5f, 1f));
            seam.rectTransform.sizeDelta = new Vector2(thickness * 0.6f, 0f);
            seam.rectTransform.anchoredPosition = Vector2.zero;
            seamGuide = seam.gameObject;

            Text title = CreateText("Frame Label", guideRect, "PRESSURE INPUT AREA  /  50 × 50 CM");
            frameLabel = title;
            title.rectTransform.anchorMin = new Vector2(0f, 1f);
            title.rectTransform.anchorMax = new Vector2(0f, 1f);
            title.rectTransform.pivot = new Vector2(0f, 1f);
            title.rectTransform.anchoredPosition = new Vector2(18f, -16f);
            title.rectTransform.sizeDelta = new Vector2(900f, 48f);
            title.fontSize = 24;
            title.color = frameColor;

            Text hint = CreateText("Frame Hint", guideRect, "INPUT ONLY · GAME IMAGE REMAINS 16:9");
            hint.rectTransform.anchorMin = new Vector2(0.5f, 0f);
            hint.rectTransform.anchorMax = new Vector2(0.5f, 0f);
            hint.rectTransform.pivot = new Vector2(0.5f, 0f);
            hint.rectTransform.anchoredPosition = new Vector2(0f, 14f);
            hint.rectTransform.sizeDelta = new Vector2(900f, 42f);
            hint.alignment = TextAnchor.MiddleCenter;
            hint.fontSize = 19;
            hint.color = new Color(frameColor.r, frameColor.g, frameColor.b, 0.8f);
            return frame;
        }

        /// <summary>
        /// The veil that puts the running game behind the calibration. First child of the
        /// canvas, so the alignment guides drawn after it stay at full brightness.
        /// </summary>
        private static GameObject BuildCalibrationBackdrop(RectTransform parent)
        {
            Image backdrop = CreateImage(
                "Calibration Backdrop",
                parent,
                new Color(0.004f, 0.008f, 0.02f, 0.88f),
                Vector2.zero,
                Vector2.one);
            backdrop.rectTransform.sizeDelta = Vector2.zero;
            backdrop.rectTransform.anchoredPosition = Vector2.zero;
            backdrop.gameObject.SetActive(false);
            return backdrop.gameObject;
        }

        /// <summary>
        /// The calibration instructions. Deliberately on Camera A rather than in the
        /// operator's IMGUI panel: the person doing the calibration is standing on the mat
        /// looking at the table, not at the laptop.
        /// </summary>
        private static ProjectionCalibrationOverlay BuildCalibrationMessage(
            RectTransform parent,
            GameObject rigRoot,
            GameObject backdrop)
        {
            // Kept inside the middle 56% of the frame, which is where the square mat is at
            // the default size — the text lands under the operator's feet, not in the bands.
            RectTransform panel = CreateRect("Calibration Message", parent);
            panel.anchorMin = new Vector2(0.22f, 0.30f);
            panel.anchorMax = new Vector2(0.78f, 0.70f);
            panel.offsetMin = Vector2.zero;
            panel.offsetMax = Vector2.zero;

            // A dimmed game is still a lit game: bright content behind the instructions
            // would make them unreadable at the exact moment they matter.
            var panelBackground = panel.gameObject.AddComponent<Image>();
            panelBackground.color = new Color(0.01f, 0.02f, 0.05f, 0.93f);
            panelBackground.raycastTarget = false;

            Text title = CreateText("Title", panel, "投影校正");
            title.rectTransform.anchorMin = new Vector2(0f, 1f);
            title.rectTransform.anchorMax = new Vector2(1f, 1f);
            title.rectTransform.pivot = new Vector2(0.5f, 1f);
            title.rectTransform.sizeDelta = new Vector2(0f, 70f);
            title.rectTransform.anchoredPosition = new Vector2(0f, -24f);
            title.alignment = TextAnchor.MiddleCenter;
            title.fontSize = 52;
            title.color = new Color(1f, 0.86f, 0.3f, 1f);

            Text progress = CreateText("Progress", panel, string.Empty);
            progress.rectTransform.anchorMin = new Vector2(0f, 1f);
            progress.rectTransform.anchorMax = new Vector2(1f, 1f);
            progress.rectTransform.pivot = new Vector2(0.5f, 1f);
            progress.rectTransform.sizeDelta = new Vector2(0f, 52f);
            progress.rectTransform.anchoredPosition = new Vector2(0f, -98f);
            progress.alignment = TextAnchor.MiddleCenter;
            progress.fontSize = 36;
            progress.color = new Color(0.05f, 0.9f, 1f, 1f);

            Text body = CreateText("Body", panel, string.Empty);
            body.rectTransform.anchorMin = new Vector2(0f, 0f);
            body.rectTransform.anchorMax = new Vector2(1f, 1f);
            body.rectTransform.offsetMin = new Vector2(36f, 28f);
            body.rectTransform.offsetMax = new Vector2(-36f, -172f);
            body.alignment = TextAnchor.UpperCenter;
            body.fontSize = 26;
            body.horizontalOverflow = HorizontalWrapMode.Wrap;
            body.verticalOverflow = VerticalWrapMode.Truncate;
            body.color = new Color(0.92f, 0.95f, 1f, 1f);

            var overlay = rigRoot.AddComponent<ProjectionCalibrationOverlay>();
            overlay.Configure(backdrop, panel.gameObject, title, body, progress);
            panel.gameObject.SetActive(false);
            return overlay;
        }

        /// <summary>
        /// Game content picks its own render queues — the DM library's thumbnails sit at
        /// 3900 — and a screen-space canvas draws at 3000, so without this the alignment
        /// guides and the calibration panel end up underneath the very thing they are meant
        /// to sit over. Putting every overlay graphic on one material at the Overlay queue
        /// settles it once for whatever game is attached.
        /// </summary>
        private static void ApplyOverlayMaterial(Transform canvas, Material material)
        {
            if (material == null)
            {
                return;
            }

            Graphic[] graphics = canvas.GetComponentsInChildren<Graphic>(true);
            for (int index = 0; index < graphics.Length; index++)
            {
                graphics[index].material = material;
            }
        }

        public static Material CreateOrLoadOverlayUiMaterial()
        {
            Shader shader = Shader.Find("UI/Default");
            if (shader == null)
            {
                return null;
            }

            EnsureFolder(MaterialFolder);
            Material material = AssetDatabase.LoadAssetAtPath<Material>(OverlayUiMaterialPath);
            if (material == null)
            {
                material = new Material(shader) { name = "ProjectionOverlayUi" };
                AssetDatabase.CreateAsset(material, OverlayUiMaterialPath);
            }
            else
            {
                material.shader = shader;
            }

            material.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Overlay;
            EditorUtility.SetDirty(material);
            return material;
        }

        /// <summary>
        /// Clears the whole render texture before the game draws into part of it.
        ///
        /// Game Camera A only clears its own viewport, and once that viewport is the mat area
        /// rather than the whole frame, everything outside it would keep last frame's pixels
        /// forever — a smear of the game frozen around the mat, projected onto the table.
        /// Black there is also the right answer in its own right: no light outside the area
        /// anyone can stand on.
        /// </summary>
        private static Camera CreateGameTextureClearCamera(Transform parent, RenderTexture gameTexture)
        {
            var cameraObject = new GameObject("Game Texture Clear Camera", typeof(Camera));
            cameraObject.transform.SetParent(parent, false);
            Camera camera = cameraObject.GetComponent<Camera>();
            camera.cullingMask = 0;
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = Color.black;
            camera.orthographic = true;
            camera.orthographicSize = 1f;
            camera.nearClipPlane = 0.1f;
            camera.farClipPlane = 1f;
            // Before Game Camera A, which sits at -10.
            camera.depth = -20f;
            camera.targetTexture = gameTexture;
            camera.targetDisplay = 0;
            camera.allowHDR = false;
            camera.allowMSAA = false;
            return camera;
        }

        /// <summary>
        /// Game Camera A draws into a render texture, so without this nothing owns the
        /// display: the Game view reports "No cameras rendering" and a build would
        /// present an undefined backbuffer. This camera draws no objects at all — it
        /// only claims the display and clears it. The picture itself comes from the
        /// output canvas, which overlay-renders after every camera.
        /// </summary>
        private static Camera CreateDisplayCamera(Transform parent)
        {
            var cameraObject = new GameObject("Display Camera (clear only)", typeof(Camera));
            cameraObject.transform.SetParent(parent, false);
            Camera camera = cameraObject.GetComponent<Camera>();
            camera.cullingMask = 0;
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = Color.black;
            camera.orthographic = true;
            camera.orthographicSize = 1f;
            camera.nearClipPlane = 0.1f;
            camera.farClipPlane = 1f;
            camera.depth = -100f;
            camera.targetDisplay = 0;
            camera.allowHDR = false;
            camera.allowMSAA = false;
            return camera;
        }

        /// <summary>
        /// The projector output: a full-screen RawImage carrying the warp material,
        /// on its own overlay canvas below the operator UI. Drawn by the UI pipeline,
        /// so it never touches the editor's active render target.
        /// </summary>
        private static RawImage CreateProjectorOutputSurface(
            Transform parent,
            RenderTexture gameTexture,
            Material warpMaterial)
        {
            var canvasObject = new GameObject(
                "Projection Output Canvas",
                typeof(Canvas),
                typeof(CanvasScaler));
            canvasObject.transform.SetParent(parent, false);

            Canvas canvas = canvasObject.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            canvas.sortingOrder = -1000;
            canvas.targetDisplay = 0;

            CanvasScaler scaler = canvasObject.GetComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920f, 1080f);

            var imageObject = new GameObject("Projector Output Image", typeof(RectTransform), typeof(RawImage));
            imageObject.transform.SetParent(canvasObject.transform, false);
            var imageRect = (RectTransform)imageObject.transform;
            imageRect.anchorMin = Vector2.zero;
            imageRect.anchorMax = Vector2.one;
            imageRect.offsetMin = Vector2.zero;
            imageRect.offsetMax = Vector2.zero;

            RawImage image = imageObject.GetComponent<RawImage>();
            image.texture = gameTexture;
            image.material = warpMaterial;
            image.raycastTarget = false;
            return image;
        }

        private static MatrixHeatmap CreateOperatorHeatmap(Transform parent)
        {
            var canvasObject = new GameObject(
                "Operator Canvas (Display 1)",
                typeof(RectTransform),
                typeof(Canvas),
                typeof(CanvasScaler));
            canvasObject.transform.SetParent(parent, false);
            Canvas canvas = canvasObject.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            canvas.targetDisplay = 0;

            CanvasScaler scaler = canvasObject.GetComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920f, 1080f);

            RectTransform panel = CreateRect("DeviceViz Pressure Heatmap", canvasObject.transform);
            panel.anchorMin = panel.anchorMax = new Vector2(1f, 0f);
            panel.pivot = new Vector2(1f, 0f);
            panel.anchoredPosition = new Vector2(-20f, 20f);
            panel.sizeDelta = new Vector2(300f, 300f);
            Image panelBackground = panel.gameObject.AddComponent<Image>();
            panelBackground.color = new Color(0f, 0f, 0f, 0.72f);
            panelBackground.raycastTarget = false;

            RectTransform colorRect = CreateRect("Color Heatmap", panel);
            Stretch(colorRect, 8f);
            colorRect.gameObject.AddComponent<RawImage>().raycastTarget = false;
            ColorLayer colorLayer = colorRect.gameObject.AddComponent<ColorLayer>();

            RectTransform touchRect = CreateRect("Touch Markers", panel);
            Stretch(touchRect, 8f);
            TouchMarkerLayer touchLayer = touchRect.gameObject.AddComponent<TouchMarkerLayer>();

            MatrixHeatmap heatmap = panel.gameObject.AddComponent<MatrixHeatmap>();
            heatmap.colorLayer = colorLayer;
            heatmap.touchMarkerLayer = touchLayer;
            heatmap.showColor = true;
            heatmap.showTouchMarkers = true;
            heatmap.showDigits = false;
            heatmap.showFadingStroke = false;
            heatmap.showChessPieces = false;
            heatmap.createUI = false;
            return heatmap;
        }

        // ---- shared asset and hierarchy helpers -------------------------------------

        /// <summary>
        /// The format of this texture is not a storage decision — it is the format of URP's
        /// <b>internal</b> colour buffer for every camera that renders into it.
        ///
        /// <c>CreateRenderTextureDescriptor</c> takes the whole descriptor from the camera's
        /// target texture when there is one, and URP's own comment there calls that
        /// incorrect: "External texture replaces internal (intermediate) color buffer here,
        /// ignoring the configured internal rendering color buffer format." So an 8-bit LDR
        /// target does not merely store the result — it makes the <em>entire</em> pipeline
        /// render in 8-bit. Everything brighter than 1.0 clips before tonemapping, and ACES
        /// then runs on already-clipped values.
        ///
        /// The visible cost was a game that looked brighter and flatter through the rig than
        /// it did standalone, and a light-show scene (ShowcaseLab's campfire / roaming lights,
        /// which live almost entirely above 1.0) that fell apart completely. A float format
        /// gives URP its HDR buffer back and the two paths converge.
        ///
        /// No extra sRGB handling is needed: <c>UniversalCameraData.requireSrgbConversion</c>
        /// is <c>targetTexture == null &amp;&amp; ...</c>, so a camera rendering into this
        /// texture writes linear values either way, and the RawImage samples them linear.
        /// </summary>
        public static RenderTexture CreateOrLoadRenderTexture()
        {
            EnsureFolder(RenderTextureFolder);
            RenderTexture texture = AssetDatabase.LoadAssetAtPath<RenderTexture>(RenderTexturePath);
            if (texture != null)
            {
                UpgradeRenderTextureToHdr(texture);
                return texture;
            }

            texture = new RenderTexture(1920, 1080, 24, ProjectedColorFormat)
            {
                name = "GameRenderTexture",
                antiAliasing = 1,
                useMipMap = false,
                autoGenerateMips = false,
                filterMode = FilterMode.Bilinear,
                wrapMode = TextureWrapMode.Clamp
            };
            AssetDatabase.CreateAsset(texture, RenderTexturePath);
            return texture;
        }

        /// <summary>Half-float with alpha. 32-bit packed formats are cheaper but drop the
        /// alpha channel, and the projected image is composited through a RawImage.</summary>
        private const RenderTextureFormat ProjectedColorFormat = RenderTextureFormat.ARGBHalf;

        /// <summary>
        /// Rigs built before this was understood have an <c>ARGB32</c> texture on disk, and
        /// <see cref="CreateOrLoadRenderTexture"/> hands back whatever it finds. Converting in
        /// place means a rebuild fixes an existing project instead of only new ones.
        /// </summary>
        private static void UpgradeRenderTextureToHdr(RenderTexture texture)
        {
            if (texture.format == ProjectedColorFormat)
            {
                return;
            }

            RenderTextureFormat previous = texture.format;
            texture.Release();
            texture.format = ProjectedColorFormat;
            EditorUtility.SetDirty(texture);
            AssetDatabase.SaveAssets();
            Debug.Log(
                $"[ProjectionAlignment] GameRenderTexture upgraded from {previous} to "
                + $"{ProjectedColorFormat}. An LDR target makes URP render the whole frame in "
                + "8-bit, which clips every highlight before tonemapping.");
        }

        public static Material CreateOrLoadWarpMaterial()
        {
            Shader shader = Shader.Find("NuLight/ProjectionAlignment/HomographyWarp");
            if (shader == null)
            {
                return null;
            }

            EnsureFolder(MaterialFolder);
            Material material = AssetDatabase.LoadAssetAtPath<Material>(MaterialPath);
            if (material != null)
            {
                material.shader = shader;
                return material;
            }

            material = new Material(shader) { name = "ProjectionWarp" };
            AssetDatabase.CreateAsset(material, MaterialPath);
            return material;
        }

        public static void EnsureFolder(string path)
        {
            string[] segments = path.Split('/');
            string current = segments[0];
            for (int index = 1; index < segments.Length; index++)
            {
                string next = current + "/" + segments[index];
                if (!AssetDatabase.IsValidFolder(next))
                {
                    AssetDatabase.CreateFolder(current, segments[index]);
                }
                current = next;
            }
        }

        public static void SetLayerRecursively(GameObject gameObject, int layer)
        {
            gameObject.layer = layer;
            foreach (Transform child in gameObject.transform)
            {
                SetLayerRecursively(child.gameObject, layer);
            }
        }

        private static void AnchorToGameUvRect(RectTransform frame, Rect gameUvRect)
        {
            frame.anchorMin = new Vector2(gameUvRect.xMin, 1f - gameUvRect.yMax);
            frame.anchorMax = new Vector2(gameUvRect.xMax, 1f - gameUvRect.yMin);
            frame.pivot = new Vector2(0.5f, 0.5f);
            frame.anchoredPosition = Vector2.zero;
            frame.sizeDelta = Vector2.zero;
        }

        private static void CreateFrameEdge(
            string name,
            Transform parent,
            Color color,
            Vector2 anchorMin,
            Vector2 anchorMax,
            Vector2 sizeDelta,
            Vector2 offset = default)
        {
            Image edge = CreateImage(name + " Border", parent, color, anchorMin, anchorMax);
            edge.rectTransform.sizeDelta = sizeDelta;
            edge.rectTransform.anchoredPosition = offset;
        }

        public static RectTransform CreateRect(string name, Transform parent)
        {
            var gameObject = new GameObject(name, typeof(RectTransform));
            gameObject.transform.SetParent(parent, false);
            return gameObject.GetComponent<RectTransform>();
        }

        public static Image CreateImage(
            string name,
            Transform parent,
            Color color,
            Vector2 anchorMin,
            Vector2 anchorMax)
        {
            RectTransform rect = CreateRect(name, parent);
            rect.anchorMin = anchorMin;
            rect.anchorMax = anchorMax;
            rect.pivot = new Vector2(0.5f, 0.5f);
            var image = rect.gameObject.AddComponent<Image>();
            image.color = color;
            image.raycastTarget = false;
            return image;
        }

        public static Text CreateText(string name, Transform parent, string value)
        {
            RectTransform rect = CreateRect(name, parent);
            var text = rect.gameObject.AddComponent<Text>();
            text.text = value;
            text.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            text.fontStyle = FontStyle.Bold;
            text.alignment = TextAnchor.MiddleLeft;
            text.raycastTarget = false;
            return text;
        }

        public static void Stretch(RectTransform rect, float inset)
        {
            rect.anchorMin = Vector2.zero;
            rect.anchorMax = Vector2.one;
            rect.offsetMin = new Vector2(inset, inset);
            rect.offsetMax = new Vector2(-inset, -inset);
        }
    }
}
