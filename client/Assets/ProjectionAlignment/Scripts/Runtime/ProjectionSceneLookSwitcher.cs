using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// Applies one of the authored projection looks and cycles to the next one when F6
    /// is pressed. It deliberately knows nothing about scene geometry, so switching a
    /// look can never re-enable the temporarily hidden floor.
    /// </summary>
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(-80)]
    public sealed class ProjectionSceneLookSwitcher : MonoBehaviour
    {
        [SerializeField] private ProjectionSceneLookProfile[] looks;
        [SerializeField] private Volume globalVolume;
        [SerializeField] private Light directionalLight;
        [Tooltip("Optional. Automatically resolved within this scene on Awake.")]
        [SerializeField] private ProjectionCalibrationController calibration;
        [Min(0)]
        [SerializeField] private int initialLookIndex;
        [SerializeField] private bool applyInitialLookOnAwake = true;

        private int currentLookIndex = -1;

        public int CurrentLookIndex => currentLookIndex;

        public string CurrentLookName => IsConfiguredIndex(currentLookIndex)
            ? looks[currentLookIndex].DisplayName
            : string.Empty;

        public int LookCount => looks == null ? 0 : looks.Length;

        private void Awake()
        {
            if (calibration == null)
            {
                foreach (var candidate in FindObjectsByType<ProjectionCalibrationController>(
                    FindObjectsSortMode.None))
                {
                    if (candidate.gameObject.scene == gameObject.scene)
                    {
                        calibration = candidate;
                        break;
                    }
                }
            }

            if (applyInitialLookOnAwake)
                ApplyLook(initialLookIndex);
        }

        private void Update()
        {
            // Tab belongs to pressure diagnostics. Leave calibration's background stable.
            if ((calibration == null || (!calibration.IsCalibrating && !calibration.OperatorUiVisible && !calibration.OperatorModalOpen)) && ReadNextLookPressed())
                NextLook();
        }

        [ContextMenu("Apply Next Look")]
        public void NextLook()
        {
            if (LookCount == 0)
                return;

            int sourceIndex = currentLookIndex >= 0
                ? currentLookIndex
                : initialLookIndex;
            ApplyLook(GetNextIndex(sourceIndex, LookCount));
        }

        public void ApplyLook(int index)
        {
            // RenderSettings belongs to the ACTIVE scene. Never write a hosted game's
            // environment while this switcher still lives in the library scene.
            if (SceneManager.GetActiveScene() != gameObject.scene)
                return;

            if (LookCount == 0)
            {
                Debug.LogWarning("[ProjectionAlignment] Scene look switcher has no looks.", this);
                return;
            }

            int normalizedIndex = NormalizeIndex(index, LookCount);
            ProjectionSceneLookProfile look = looks[normalizedIndex];
            if (look == null)
            {
                Debug.LogWarning(
                    $"[ProjectionAlignment] Scene look slot {normalizedIndex} is empty.", this);
                return;
            }

            if (look.SkyboxMaterial != null)
                RenderSettings.skybox = look.SkyboxMaterial;

            RenderSettings.ambientMode = AmbientMode.Skybox;
            RenderSettings.ambientIntensity = look.AmbientIntensity;
            RenderSettings.reflectionIntensity = look.ReflectionIntensity;
            RenderSettings.fog = look.FogEnabled;
            RenderSettings.fogMode = FogMode.ExponentialSquared;
            RenderSettings.fogColor = look.FogColor;
            RenderSettings.fogDensity = look.FogDensity;

            if (globalVolume != null && look.VolumeProfile != null)
                globalVolume.sharedProfile = look.VolumeProfile;

            if (directionalLight != null)
            {
                directionalLight.color = look.DirectionalLightColor;
                directionalLight.intensity = look.DirectionalLightIntensity;
            }

            currentLookIndex = normalizedIndex;
            DynamicGI.UpdateEnvironment();
            Debug.Log(
                $"[ProjectionAlignment] Scene look {currentLookIndex + 1}/{LookCount}: "
                + look.DisplayName,
                this);
        }

        public static int GetNextIndex(int currentIndex, int count)
        {
            if (count <= 0)
                return -1;
            return NormalizeIndex(currentIndex + 1, count);
        }

        public static int NormalizeIndex(int index, int count)
        {
            if (count <= 0)
                return -1;
            int remainder = index % count;
            return remainder < 0 ? remainder + count : remainder;
        }

        private bool IsConfiguredIndex(int index)
        {
            return index >= 0
                && index < LookCount
                && looks[index] != null;
        }

        private static bool ReadNextLookPressed()
        {
#if ENABLE_INPUT_SYSTEM
            return Keyboard.current != null
                && Keyboard.current.f6Key.wasPressedThisFrame;
#elif ENABLE_LEGACY_INPUT_MANAGER
            return Input.GetKeyDown(KeyCode.F6);
#else
            return false;
#endif
        }
    }
}
