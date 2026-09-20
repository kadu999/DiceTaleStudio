using UnityEditor;
using UnityEngine;

namespace DiceTale.Editor
{
    /// <summary>
    /// Read-only Inspector for <see cref="GroundTextureRenderer"/>: the component has no serialized
    /// fields (size / tint / order all come from `Apply`), and `MeshRenderer` does not expose
    /// Sorting Layer or Order in Layer — so this shows what is actually applied.
    /// </summary>
    [CustomEditor(typeof(GroundTextureRenderer))]
    public class GroundTextureRendererEditor : UnityEditor.Editor
    {
        public override void OnInspectorGUI()
        {
            var component = (GroundTextureRenderer)target;
            var meshRenderer = component.GetComponent<MeshRenderer>();
            if (meshRenderer == null)
            {
                return;
            }

            var meshFilter = component.GetComponent<MeshFilter>();
            var mesh = meshFilter != null ? meshFilter.sharedMesh : null;
            var material = meshRenderer.sharedMaterial;

            using (new EditorGUI.DisabledScope(true))
            {
                EditorGUILayout.IntField("Sorting Order", meshRenderer.sortingOrder);
                EditorGUILayout.TextField(
                    "Sorting Layer",
                    string.IsNullOrEmpty(meshRenderer.sortingLayerName) ? "Default" : meshRenderer.sortingLayerName);
                EditorGUILayout.ObjectField(
                    "Texture",
                    material != null ? material.mainTexture : null,
                    typeof(Texture),
                    false);
                EditorGUILayout.FloatField("Width", mesh != null ? mesh.bounds.size.x : 0f);
                EditorGUILayout.FloatField("Height", mesh != null ? mesh.bounds.size.z : 0f);
                EditorGUILayout.FloatField("Lift Y", component.transform.localPosition.y);
            }
        }
    }
}
