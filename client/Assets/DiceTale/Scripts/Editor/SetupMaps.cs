using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace DiceTale.Editor
{
    public static class SetupMaps
    {
        [MenuItem("DiceTale/Setup Single Scene")]
        public static void SetupSingleScene()
        {
            string scenePath = "Assets/Scenes/Demo.unity";
            Scene scene;

            if (File.Exists(scenePath))
            {
                scene = EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
                ClearScene(scene);
            }
            else
            {
                scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
            }

            CreateMain();

            EditorSceneManager.SaveScene(scene, scenePath);

            var sceneList = new List<EditorBuildSettingsScene>(EditorBuildSettings.scenes);
            if (!sceneList.Exists(s => s.path == scenePath))
            {
                sceneList.Add(new EditorBuildSettingsScene(scenePath, true));
                EditorBuildSettings.scenes = sceneList.ToArray();
            }

            AssetDatabase.Refresh();
            Debug.Log("DiceTale single scene setup complete.");
        }

        private static void ClearScene(Scene scene)
        {
            var rootObjects = scene.GetRootGameObjects();
            for (int i = rootObjects.Length - 1; i >= 0; i--)
            {
                Object.DestroyImmediate(rootObjects[i]);
            }
        }

        private static void CreateMain()
        {
            // 宿主物体：Game 组件挂这里，所有管理器由 Game 自动挂到同一物体上（随宿主一起销毁）
            var mainGo = new GameObject("Game");
            mainGo.AddComponent<Game>();
        }
    }
}
