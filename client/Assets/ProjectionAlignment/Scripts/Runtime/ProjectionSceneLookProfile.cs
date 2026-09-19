using UnityEngine;
using UnityEngine.Rendering;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// One complete presentation look for the projection scene. Keeping the generated
    /// panorama and its lighting/post-processing together prevents a bright sky from
    /// inheriting the cavern grading (or the other way around) when looks are switched.
    /// </summary>
    [CreateAssetMenu(
        fileName = "ProjectionSceneLook",
        menuName = "NuLight/Projection Alignment/Scene Look")]
    public sealed class ProjectionSceneLookProfile : ScriptableObject
    {
        [SerializeField] private string displayName = "Projection Look";
        [SerializeField] private Material skyboxMaterial;
        [SerializeField] private VolumeProfile volumeProfile;

        [Header("Environment")]
        [Min(0f)]
        [SerializeField] private float ambientIntensity = 1f;
        [Range(0f, 1f)]
        [SerializeField] private float reflectionIntensity = 1f;

        [Header("Key Light")]
        [ColorUsage(false, true)]
        [SerializeField] private Color directionalLightColor = Color.white;
        [Min(0f)]
        [SerializeField] private float directionalLightIntensity = 1f;

        [Header("Atmosphere")]
        [SerializeField] private bool fogEnabled;
        [ColorUsage(false, true)]
        [SerializeField] private Color fogColor = Color.black;
        [Min(0f)]
        [SerializeField] private float fogDensity = 0.005f;

        public string DisplayName => string.IsNullOrWhiteSpace(displayName)
            ? name
            : displayName;
        public Material SkyboxMaterial => skyboxMaterial;
        public VolumeProfile VolumeProfile => volumeProfile;
        public float AmbientIntensity => ambientIntensity;
        public float ReflectionIntensity => reflectionIntensity;
        public Color DirectionalLightColor => directionalLightColor;
        public float DirectionalLightIntensity => directionalLightIntensity;
        public bool FogEnabled => fogEnabled;
        public Color FogColor => fogColor;
        public float FogDensity => fogDensity;
    }
}
