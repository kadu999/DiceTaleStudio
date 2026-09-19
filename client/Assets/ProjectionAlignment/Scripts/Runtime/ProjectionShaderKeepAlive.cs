using UnityEngine;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// Holds materials for shaders the game only ever reaches through
    /// <see cref="Shader.Find"/>, so that they end up in the player.
    ///
    /// Unity includes a shader in a build when a built asset references it. A shader that
    /// is only named as a string at runtime has no such reference and is stripped — the
    /// editor never shows this, because in the editor every shader is loaded. The symptom
    /// is a packaged build that logs "shader was not found" and renders nothing where that
    /// material should be.
    ///
    /// The usual cure is Graphics Settings → Always Included Shaders, but that lives in
    /// ProjectSettings, where a stray git discard silently takes it away again and the next
    /// build is quietly broken. Referencing the materials from the scene puts the guarantee
    /// in the asset graph instead, where it travels with the scene and cannot be reverted
    /// out from underneath the build.
    ///
    /// The component does nothing at runtime. The reference is the whole point.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class ProjectionShaderKeepAlive : MonoBehaviour
    {
        [Tooltip("One material per shader that is only ever obtained via Shader.Find.")]
        [SerializeField] private Material[] materials = new Material[0];

        public Material[] Materials => materials;

        public void Configure(Material[] keptMaterials)
        {
            materials = keptMaterials ?? new Material[0];
        }
    }
}
