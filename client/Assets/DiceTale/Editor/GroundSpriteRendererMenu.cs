using UnityEditor;
using UnityEngine;

namespace DiceTale.Editor
{
    /// <summary>
    /// 场景里创建「平行地面的纹理面片」（GroundSpriteRenderer）的菜单入口。
    /// 用法：菜单 GameObject → Create Other → DiceTale Ground Sprite Renderer（或 DiceTale/Ground Sprite Renderer），
    /// 选中新物体后在 Inspector 的 Sprite 字段拖一张图即可显示；尺寸用 Transform 缩放控制。
    /// </summary>
    public static class GroundSpriteRendererMenu
    {
        private const string MenuPath = "GameObject/Create Other/DiceTale Ground Sprite Renderer";
        private const string AltMenuPath = "DiceTale/Ground Sprite Renderer";

        [MenuItem(MenuPath, false, 20)]
        [MenuItem(AltMenuPath, false, 20)]
        public static void CreateGroundSpriteRenderer()
        {
            var go = new GameObject("GroundSpriteRenderer");
            go.AddComponent<GroundSpriteRenderer>();

            // 放到当前场景视图中心（若在场景视图中）或选中物体旁边，方便直接摆放
            if (SceneView.lastActiveSceneView != null)
            {
                go.transform.position = SceneView.lastActiveSceneView.pivot;
            }

            Undo.RegisterCreatedObjectUndo(go, "Create Ground Sprite Renderer");
            Selection.activeGameObject = go;
        }
    }
}