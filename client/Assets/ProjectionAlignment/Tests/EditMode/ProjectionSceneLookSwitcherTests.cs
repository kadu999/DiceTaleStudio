using System.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace NuLight.ProjectionAlignment.Tests
{
    public sealed class ProjectionSceneLookSwitcherTests
    {
        [TestCase(0, 4, 1)]
        [TestCase(1, 4, 2)]
        [TestCase(2, 4, 3)]
        [TestCase(3, 4, 0)]
        [TestCase(-1, 4, 0)]
        public void GetNextIndex_CyclesThroughAllLooks(int current, int count, int expected)
        {
            Assert.That(
                ProjectionSceneLookSwitcher.GetNextIndex(current, count),
                Is.EqualTo(expected));
        }

        [Test]
        public void GetNextIndex_EmptyLookList_ReturnsSentinel()
        {
            Assert.That(ProjectionSceneLookSwitcher.GetNextIndex(0, 0), Is.EqualTo(-1));
        }

        [TestCase(-1, 4, 3)]
        [TestCase(-5, 4, 3)]
        [TestCase(4, 4, 0)]
        [TestCase(9, 4, 1)]
        public void NormalizeIndex_WrapsInBothDirections(int index, int count, int expected)
        {
            Assert.That(
                ProjectionSceneLookSwitcher.NormalizeIndex(index, count),
                Is.EqualTo(expected));
        }

        [TestCase("Assets/Scenes/DMGameLibrary.unity")]
        [TestCase("Assets/ProjectionAlignment/Scenes/DMGameLibraryProjection.unity")]
        public void LibraryScene_PreservesAuthoredLooksAndCameraBackground(string path)
        {
            // Check the source as well as the generated scene: rebuild copies the former.
            var scene = EditorSceneManager.OpenPreviewScene(path);
            try
            {
                var roots = scene.GetRootGameObjects();
                var switchers = roots.SelectMany(
                    root => root.GetComponentsInChildren<ProjectionSceneLookSwitcher>(true)).ToArray();
                Assert.That(switchers, Has.Length.EqualTo(1));
                var switcher = switchers[0];
                Assert.That(switcher.isActiveAndEnabled, Is.True);
                Assert.That(switcher.gameObject.name, Is.EqualTo("Global Volume"),
                    "Keep the switcher on a shell root that is suspended during hosted games.");

                var settings = new SerializedObject(switcher);
                var looks = settings.FindProperty("looks");
                Assert.That(looks.arraySize, Is.EqualTo(4));
                for (int index = 0; index < looks.arraySize; index++)
                {
                    var look = looks.GetArrayElementAtIndex(index).objectReferenceValue
                        as ProjectionSceneLookProfile;
                    Assert.That(look, Is.Not.Null, $"Look {index}");
                    Assert.That(look.SkyboxMaterial, Is.Not.Null);
                    Assert.That(look.SkyboxMaterial.shader, Is.Not.Null);
                    Assert.That(look.SkyboxMaterial.GetTexture("_MainTex"), Is.Not.Null);
                    Assert.That(new SerializedObject(look).FindProperty("volumeProfile")
                        .objectReferenceValue, Is.Not.Null);
                }

                Assert.That(settings.FindProperty("globalVolume").objectReferenceValue, Is.Not.Null);
                Assert.That(settings.FindProperty("directionalLight").objectReferenceValue, Is.Not.Null);
                Assert.That(settings.FindProperty("applyInitialLookOnAwake").boolValue, Is.True);
                foreach (Camera camera in roots.SelectMany(root => root.GetComponentsInChildren<Camera>(true)))
                    Assert.That(camera.clearFlags, Is.EqualTo(camera.CompareTag("MainCamera")
                        ? CameraClearFlags.Skybox : CameraClearFlags.SolidColor), camera.name);
            }
            finally
            {
                EditorSceneManager.ClosePreviewScene(scene);
            }
        }

        [Test]
        public void ApplyLook_InactiveScene_LeavesActiveEnvironmentAndSelectionUntouched()
        {
            var skybox = RenderSettings.skybox;
            float ambientIntensity = RenderSettings.ambientIntensity;
            bool fog = RenderSettings.fog;
            Color fogColor = RenderSettings.fogColor;
            var scene = EditorSceneManager.OpenPreviewScene("Assets/Scenes/DMGameLibrary.unity");
            try
            {
                var switcher = scene.GetRootGameObjects().SelectMany(
                    root => root.GetComponentsInChildren<ProjectionSceneLookSwitcher>(true)).Single();
                switcher.ApplyLook(0);
                switcher.NextLook();
                Assert.That(switcher.CurrentLookIndex, Is.EqualTo(-1));
                Assert.That(RenderSettings.skybox, Is.EqualTo(skybox));
                Assert.That(RenderSettings.ambientIntensity, Is.EqualTo(ambientIntensity));
                Assert.That(RenderSettings.fog, Is.EqualTo(fog));
                Assert.That(RenderSettings.fogColor, Is.EqualTo(fogColor));
            }
            finally
            {
                EditorSceneManager.ClosePreviewScene(scene);
            }
        }
    }
}
