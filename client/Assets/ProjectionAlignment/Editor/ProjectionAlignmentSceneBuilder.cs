using System.Collections.Generic;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace NuLight.ProjectionAlignment.Editor
{
    /// <summary>
    /// The standalone demo scene: a few cubes plus the projection rig. It exists to test
    /// the rig without any game attached; the rig itself is built by
    /// <see cref="ProjectionRigBuilder"/>, which the DM Game Library scene uses too.
    /// </summary>
    public static class ProjectionAlignmentSceneBuilder
    {
        private const string RootFolder = ProjectionRigBuilder.RootFolder;
        private const string SceneFolder = ProjectionRigBuilder.SceneFolder;
        private const string PrefabFolder = RootFolder + "/Prefabs";
        private const string MaterialFolder = ProjectionRigBuilder.MaterialFolder;
        private const string ScenePath = SceneFolder + "/ProjectionAlignmentDemo.unity";
        private const string PrefabPath = PrefabFolder + "/ProjectionAlignmentRoot.prefab";
        private const string GroundMaterialPath = MaterialFolder + "/DemoGround.mat";
        private const string BlueMaterialPath = MaterialFolder + "/DemoCubeBlue.mat";
        private const string OrangeMaterialPath = MaterialFolder + "/DemoCubeOrange.mat";
        private const string GreenMaterialPath = MaterialFolder + "/DemoCubeGreen.mat";

        [MenuItem("Tools/NuLight/Projection Alignment/Rebuild Demo Scene")]
        public static void CreateDemoScene()
        {
            EnsureFolders();
            AssetDatabase.Refresh();

            Material warpMaterial = ProjectionRigBuilder.CreateOrLoadWarpMaterial();
            if (warpMaterial == null)
            {
                Debug.LogError("Projection Homography shader was not found.");
                return;
            }

            RenderTexture gameTexture = ProjectionRigBuilder.CreateOrLoadRenderTexture();
            Material groundMaterial = CreateOrLoadLitMaterial(
                GroundMaterialPath,
                new Color(0.055f, 0.075f, 0.11f, 1f),
                0.05f,
                0.25f);
            Material blueMaterial = CreateOrLoadLitMaterial(
                BlueMaterialPath,
                new Color(0.05f, 0.42f, 0.95f, 1f),
                0.2f,
                0.65f);
            Material orangeMaterial = CreateOrLoadLitMaterial(
                OrangeMaterialPath,
                new Color(1f, 0.28f, 0.035f, 1f),
                0.1f,
                0.55f);
            Material greenMaterial = CreateOrLoadLitMaterial(
                GreenMaterialPath,
                new Color(0.05f, 0.82f, 0.42f, 1f),
                0.15f,
                0.6f);

            Scene previousActiveScene = SceneManager.GetActiveScene();
            bool replaceDisposableUntitledScene = string.IsNullOrEmpty(previousActiveScene.path);
            bool replaceOpenDemoScene = previousActiveScene.path == ScenePath;
            if (replaceDisposableUntitledScene && !IsDisposableDefaultScene(previousActiveScene))
            {
                Debug.LogError("The current scene is unsaved and contains user objects. Save it before creating the Projection Alignment demo.");
                return;
            }
            if (replaceOpenDemoScene && previousActiveScene.isDirty)
            {
                Debug.LogError("The open Projection Alignment demo has unsaved changes. Save or discard them before rebuilding it.");
                return;
            }

            bool replaceCurrentScene = replaceDisposableUntitledScene || replaceOpenDemoScene;

            Scene scene = EditorSceneManager.NewScene(
                NewSceneSetup.EmptyScene,
                replaceCurrentScene ? NewSceneMode.Single : NewSceneMode.Additive);
            SceneManager.SetActiveScene(scene);

            GameObject root = BuildScene(
                gameTexture,
                warpMaterial,
                groundMaterial,
                blueMaterial,
                orangeMaterial,
                greenMaterial);
            PrefabUtility.SaveAsPrefabAsset(root, PrefabPath);
            EditorSceneManager.SaveScene(scene, ScenePath);
            AddToBuildSettings(ScenePath);

            if (!replaceCurrentScene && previousActiveScene.IsValid())
            {
                SceneManager.SetActiveScene(previousActiveScene);
                EditorSceneManager.CloseScene(scene, true);
            }

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log($"Projection Alignment demo created at {ScenePath}");
        }

        private static bool IsDisposableDefaultScene(Scene scene)
        {
            if (!scene.IsValid() || !string.IsNullOrEmpty(scene.path))
            {
                return false;
            }

            GameObject[] roots = scene.GetRootGameObjects();
            if (roots.Length > 2)
            {
                return false;
            }

            for (int index = 0; index < roots.Length; index++)
            {
                string rootName = roots[index].name;
                if (rootName != "Main Camera" && rootName != "Directional Light")
                {
                    return false;
                }
            }

            return true;
        }

        [MenuItem("Tools/NuLight/Projection Alignment/Open Demo Scene")]
        public static void OpenDemoScene()
        {
            if (!System.IO.File.Exists(ScenePath))
            {
                CreateDemoScene();
            }

            EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
        }

        private static GameObject BuildScene(
            RenderTexture gameTexture,
            Material warpMaterial,
            Material groundMaterial,
            Material blueMaterial,
            Material orangeMaterial,
            Material greenMaterial)
        {
            var root = new GameObject("ProjectionAlignmentRoot");

            Transform gameWorld = CreateGameWorld(
                root.transform,
                groundMaterial,
                blueMaterial,
                orangeMaterial,
                greenMaterial);

            var cameraObject = new GameObject("Game Camera A", typeof(Camera));
            cameraObject.transform.SetParent(root.transform, false);
            Camera gameCamera = cameraObject.GetComponent<Camera>();
            gameCamera.transform.localPosition = new Vector3(0f, 4.6f, -9f);
            gameCamera.transform.LookAt(new Vector3(0f, 1.05f, 0.8f));
            gameCamera.orthographic = false;
            gameCamera.fieldOfView = 48f;
            gameCamera.nearClipPlane = 0.1f;
            gameCamera.farClipPlane = 100f;
            gameCamera.clearFlags = CameraClearFlags.SolidColor;
            gameCamera.backgroundColor = new Color(0.015f, 0.025f, 0.06f, 1f);
            gameCamera.cullingMask = 1 << 0;
            ProjectionRigBuilder.ConfigureGameCamera(gameCamera, gameTexture);

            // No output stage: the warp is a single full-screen blit of Camera A's
            // render texture, done by ProjectorFeed. See ProjectorFeed for why the
            // blit runs at end-of-camera rather than end-of-frame.
            var lightObject = new GameObject("Game Directional Light", typeof(Light));
            lightObject.transform.SetParent(gameWorld, false);
            lightObject.transform.localRotation = Quaternion.Euler(48f, -32f, 0f);
            Light gameLight = lightObject.GetComponent<Light>();
            gameLight.type = LightType.Directional;
            gameLight.intensity = 1.25f;
            gameLight.color = new Color(0.82f, 0.9f, 1f, 1f);

            // The demo exists to look at the alignment, so its guides start on.
            ProjectionRigBuilder.Build(root, gameCamera, gameTexture, warpMaterial, guidesVisible: true);
            return root;
        }

        private static Transform CreateGameWorld(
            Transform parent,
            Material groundMaterial,
            Material blueMaterial,
            Material orangeMaterial,
            Material greenMaterial)
        {
            var world = new GameObject("Game World (Perspective 3D Scene)");
            world.transform.SetParent(parent, false);

            GameObject ground = GameObject.CreatePrimitive(PrimitiveType.Plane);
            ground.name = "Ground";
            ground.transform.SetParent(world.transform, false);
            ground.transform.localScale = new Vector3(1.3f, 1f, 1.3f);
            ground.GetComponent<MeshRenderer>().sharedMaterial = groundMaterial;

            CreateCube(
                "Blue Cube",
                world.transform,
                new Vector3(-2.2f, 0.8f, 0.25f),
                new Vector3(1.55f, 1.6f, 1.55f),
                new Vector3(0f, 24f, 0f),
                blueMaterial);
            CreateCube(
                "Orange Cube",
                world.transform,
                new Vector3(0f, 1.15f, 1.4f),
                new Vector3(1.5f, 2.3f, 1.5f),
                new Vector3(0f, -18f, 0f),
                orangeMaterial);
            CreateCube(
                "Green Cube",
                world.transform,
                new Vector3(2.15f, 0.65f, -0.3f),
                new Vector3(1.3f, 1.3f, 1.3f),
                new Vector3(0f, 36f, 0f),
                greenMaterial);
            CreateCube(
                "Back Cube",
                world.transform,
                new Vector3(-1.4f, 0.45f, 3.35f),
                new Vector3(0.9f, 0.9f, 0.9f),
                new Vector3(0f, 45f, 0f),
                orangeMaterial);
            CreateCube(
                "Left Visual-Only Cube",
                world.transform,
                new Vector3(-5.1f, 0.75f, 1.6f),
                new Vector3(1.25f, 1.5f, 1.25f),
                new Vector3(0f, 18f, 0f),
                greenMaterial);
            CreateCube(
                "Right Visual-Only Cube",
                world.transform,
                new Vector3(5.1f, 0.9f, 1.2f),
                new Vector3(1.35f, 1.8f, 1.35f),
                new Vector3(0f, -26f, 0f),
                blueMaterial);

            return world.transform;
        }

        private static void CreateCube(
            string name,
            Transform parent,
            Vector3 position,
            Vector3 scale,
            Vector3 rotation,
            Material material)
        {
            GameObject cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
            cube.name = name;
            cube.transform.SetParent(parent, false);
            cube.transform.localPosition = position;
            cube.transform.localScale = scale;
            cube.transform.localEulerAngles = rotation;
            cube.GetComponent<MeshRenderer>().sharedMaterial = material;
        }

        private static Material CreateOrLoadLitMaterial(
            string path,
            Color color,
            float metallic,
            float smoothness)
        {
            Shader shader = Shader.Find("Universal Render Pipeline/Lit");
            if (shader == null)
            {
                shader = Shader.Find("Standard");
            }

            Material material = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (material == null)
            {
                material = new Material(shader)
                {
                    name = System.IO.Path.GetFileNameWithoutExtension(path)
                };
                AssetDatabase.CreateAsset(material, path);
            }
            else
            {
                material.shader = shader;
            }

            if (material.HasProperty("_BaseColor"))
            {
                material.SetColor("_BaseColor", color);
            }
            if (material.HasProperty("_Color"))
            {
                material.SetColor("_Color", color);
            }
            if (material.HasProperty("_Metallic"))
            {
                material.SetFloat("_Metallic", metallic);
            }
            if (material.HasProperty("_Smoothness"))
            {
                material.SetFloat("_Smoothness", smoothness);
            }
            return material;
        }

        private static void EnsureFolders()
        {
            ProjectionRigBuilder.EnsureFolder(SceneFolder);
            ProjectionRigBuilder.EnsureFolder(PrefabFolder);
            ProjectionRigBuilder.EnsureFolder(MaterialFolder);
            ProjectionRigBuilder.EnsureFolder(ProjectionRigBuilder.RenderTextureFolder);
        }

        public static void AddToBuildSettings(string scenePath)
        {
            var scenes = new List<EditorBuildSettingsScene>(EditorBuildSettings.scenes);
            if (scenes.Exists(scene => scene.path == scenePath))
            {
                return;
            }

            scenes.Add(new EditorBuildSettingsScene(scenePath, true));
            EditorBuildSettings.scenes = scenes.ToArray();
        }
    }
}
