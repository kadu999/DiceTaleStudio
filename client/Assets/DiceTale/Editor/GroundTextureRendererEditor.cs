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

            var material = meshRenderer.sharedMaterial;
            var texture = material != null ? material.mainTexture : null;

            using (new EditorGUI.DisabledScope(true))
            {
                EditorGUILayout.IntField("Sorting Order", meshRenderer.sortingOrder);
                EditorGUILayout.TextField(
                    "Sorting Layer",
                    string.IsNullOrEmpty(meshRenderer.sortingLayerName) ? "Default" : meshRenderer.sortingLayerName);
                EditorGUILayout.ObjectField("Texture", texture, typeof(Texture), false);
                EditorGUILayout.IntField("Width", texture != null ? texture.width : 0);
                EditorGUILayout.IntField("Height", texture != null ? texture.height : 0);
                EditorGUILayout.FloatField("Lift Y", component.transform.localPosition.y);
            }
        }
    }
}
