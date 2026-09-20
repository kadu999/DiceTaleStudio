using UnityEditor;
using UnityEngine;

namespace DiceTale.Editor
{
    /// <summary>
    /// `GroundTextureRenderer` 的 Inspector：把**运行时真正生效的那几个值**显示出来（只读）。
    ///
    /// 为什么需要它：这个组件**没有序列化字段**——尺寸 / 染色 / 显示顺序全是 `Apply(...)` 传进来的
    /// （见类注释），而 `MeshRenderer` 的 Inspector 里**看不到 Sorting Layer / Order in Layer**，
    /// 于是「这块面片现在盖在谁上面、实际多大」在编辑器里根本没地方看。地图 / 战争雾 / 令牌的
    /// 层叠关系出问题时，这里是最好核对的一处（战争雾那层固定是 `32767`，盖在所有东西最前面）。
    ///
    /// 显示的是 **`MeshRenderer` 与网格上实际生效的值**，不是「调用方想给的值」：两者不一致时
    /// （例如还没 `Apply`、或别处动过 `sortingOrder`）这里看得出来。
    ///
    /// **全部只读**（`DisabledScope`）：这些值由运行时数据驱动，在 Inspector 里改没有意义——
    /// 下一次 `Apply` 就把它们覆盖回去了。要改对象的前后关系去编辑器属性面板的「显示顺序」。
    /// </summary>
    [CustomEditor(typeof(GroundTextureRenderer))]
    public class GroundTextureRendererEditor : UnityEditor.Editor
    {
        public override void OnInspectorGUI()
        {
            var component = (GroundTextureRenderer)target;
            var meshRenderer = component.GetComponent<MeshRenderer>();
            var meshFilter = component.GetComponent<MeshFilter>();
            var mesh = meshFilter != null ? meshFilter.sharedMesh : null;
            var material = meshRenderer != null ? meshRenderer.sharedMaterial : null;

            EditorGUILayout.LabelField("运行时状态（只读）", EditorStyles.boldLabel);

            using (new EditorGUI.DisabledScope(true))
            {
                // 网格与材质都是第一次 `Apply` 时按需建的（本组件没有 Awake 预热）：
                // 编辑态 / 还没收到场景推送时它们就是空的，这时候干脆说清楚，别拿一串 0 冒充真实值
                if (meshRenderer == null || material == null)
                {
                    EditorGUILayout.LabelField("面片", "还没建起来（等第一次 Apply：尺寸与显示顺序那时才烘进去）");
                }
                else
                {
                    EditorGUILayout.IntField("显示顺序 sortingOrder", meshRenderer.sortingOrder);
                    EditorGUILayout.TextField(
                        "排序层",
                        string.IsNullOrEmpty(meshRenderer.sortingLayerName) ? "Default" : meshRenderer.sortingLayerName);
                    EditorGUILayout.ObjectField("贴图", material.mainTexture, typeof(Texture), false);

                    // 长宽：网格顶点烘的就是它（世界单位）。`localScale` 恒为 1，所以 bounds 就是最终尺寸
                    var worldWidth = mesh != null ? mesh.bounds.size.x : 0f;
                    var worldHeight = mesh != null ? mesh.bounds.size.z : 0f;
                    EditorGUILayout.FloatField("长 W（世界单位）", worldWidth);
                    EditorGUILayout.FloatField("宽 H（世界单位）", worldHeight);

                    // 反推回**文档像素**（声明尺寸 × 对象缩放）：世界尺寸 = 它 × GlobalScale，
                    // 这样能和编辑器属性面板上那几个数直接对上
                    var globalScale = SceneObjectView.GlobalScale;
                    if (globalScale > 0f)
                    {
                        EditorGUILayout.Vector2Field(
                            "≈ 文档像素（÷ GlobalScale）",
                            new Vector2(worldWidth / globalScale, worldHeight / globalScale));
                    }
                }

                EditorGUILayout.FloatField("离地高度 Y（世界单位）", component.transform.localPosition.y);
            }

            EditorGUILayout.HelpBox(
                "这些值由运行时数据驱动（对象的位置 / 尺寸 / 显示顺序、以及战争雾那层的摆放），在这里改没有用。\n" +
                "要改对象的前后关系，去编辑器属性面板的「显示顺序」；战争雾固定盖在最前面（32767）。",
                MessageType.Info);
        }
    }
}
