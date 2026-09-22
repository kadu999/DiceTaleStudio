using UnityEditor;
using UnityEngine;

namespace DiceTale.Editor
{
    /// <summary>
    /// Read-only Inspector for the two ground-image components (<see cref="ImageLayer"/> /
    /// <see cref="SpriteLayer"/>): they have no serialized fields (size / tint / order all come from
    /// `Apply`), and `MeshRenderer` does not expose Sorting Layer or Order in Layer — so this shows
    /// what is actually applied.
    ///
    /// 两个组件共用这一个 Inspector：它们的数据与画法都在同一个基类里，差别只有取样矩形，
    /// 所以「实际生效的是什么」要看的东西完全一样——分两份只会让其中一份慢慢过期。
    /// </summary>
    [CustomEditor(typeof(ImageLayer), true)]
    public class LayerInspector : UnityEditor.Editor
    {
        public override void OnInspectorGUI()
        {
            var component = (GroundLayer)target;
            var meshRenderer = component.GetComponent<MeshRenderer>();
            if (meshRenderer == null)
            {
                return;
            }

            var material = meshRenderer.sharedMaterial;
            var texture = material != null ? material.mainTexture : null;

            using (new EditorGUI.DisabledScope(true))
            {
                EditorGUILayout.TextField("组件", target.GetType().Name);
                EditorGUILayout.IntField("Sorting Order", meshRenderer.sortingOrder);
                EditorGUILayout.TextField(
                    "Sorting Layer",
                    string.IsNullOrEmpty(meshRenderer.sortingLayerName) ? "Default" : meshRenderer.sortingLayerName);
                EditorGUILayout.ObjectField("Texture", texture, typeof(Texture), false);
                EditorGUILayout.IntField("Width", texture != null ? texture.width : 0);
                EditorGUILayout.IntField("Height", texture != null ? texture.height : 0);

                // 子图：面片是不是只取了纹理里的一块？取哪一块由**网格的 UV** 决定
                // （`Apply` 烘进顶点），所以这里读顶点、不读任何字段——显示的就是实际生效的那一块
                var filter = component.GetComponent<MeshFilter>();
                var mesh = filter != null ? filter.sharedMesh : null;
                var uv = mesh != null && mesh.uv.Length > 0 ? mesh.uv : null;
                if (uv == null)
                {
                    EditorGUILayout.TextField("UV", "(无网格)");
                }
                else
                {
                    var min = uv[0];
                    var max = uv[0];
                    foreach (var point in uv)
                    {
                        min = Vector2.Min(min, point);
                        max = Vector2.Max(max, point);
                    }

                    EditorGUILayout.TextField("UV", $"{min.x:F4}, {min.y:F4} → {max.x:F4}, {max.y:F4}");
                    EditorGUILayout.TextField(
                        "取样",
                        max.x - min.x < 0.9999f || max.y - min.y < 0.9999f ? "子图（只取一块）" : "整张图");
                }

                EditorGUILayout.FloatField("Lift Y", component.transform.localPosition.y);
            }
        }
    }
}
