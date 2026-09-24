using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace DiceTale.Tests
{
    public class SceneMirrorComponentPlayModeTests
    {
        private GameObject host;
        private SceneMirror mirror;

        [UnitySetUp]
        public IEnumerator SetUp()
        {
            host = new GameObject("SceneMirrorComponentPlayModeTests");
            var session = host.AddComponent<ClientSession>();
            mirror = host.AddComponent<SceneMirror>();
            mirror.Initialize(session, null);
            yield return null;
        }

        [UnityTearDown]
        public IEnumerator TearDown()
        {
            if (host != null)
            {
                Object.Destroy(host);
            }

            yield return null;
        }

        [UnityTest]
        public IEnumerator ImageComponentChangesRebuildTheRuntimeRenderer()
        {
            mirror.Apply(SceneOf(ImageObject("image", "Image", "ImageLayer")));
            var imageView = mirror.FindView("image");

            Assert.That(imageView, Is.Not.Null);
            Assert.That(imageView.GetComponent<ImageLayer>(), Is.Not.Null);
            Assert.That(imageView.GetComponent<SpriteLayer>(), Is.Null);

            mirror.Apply(SceneOf(ImageObject("image", "Image", "SpriteLayer")));
            var spriteView = mirror.FindView("image");

            Assert.That(spriteView, Is.Not.Null);
            Assert.That(spriteView, Is.Not.SameAs(imageView));
            Assert.That(spriteView.GetComponent<SpriteLayer>(), Is.Not.Null);
            Assert.That(spriteView.GetComponent<ImageLayer>(), Is.Not.Null);
            yield return null;
            Assert.That(imageView == null, Is.True);
        }

        [UnityTest]
        public IEnumerator ActionComponentRemovesViewButKeepsItsMirrorModel()
        {
            mirror.Apply(SceneOf(ImageObject("object", "Teleport", "ImageLayer")));
            var view = mirror.FindView("object");
            Assert.That(view, Is.Not.Null);

            mirror.Apply(SceneOf(ActionObject("object", "Sprite", "PlaySound")));

            Assert.That(mirror.FindView("object"), Is.Null);
            Assert.That(mirror.Find("object"), Is.Not.Null);
            Assert.That(mirror.Find("object").sound, Is.Not.Null);
            yield return null;
            Assert.That(view == null, Is.True);

            mirror.Apply(SceneOf(ImageObject("object", "PlaySound", "ImageLayer")));
            Assert.That(mirror.FindView("object"), Is.Not.Null);
            Assert.That(mirror.Find("object"), Is.Not.Null);
        }

        private static MirrorScene SceneOf(MirrorObject obj)
        {
            var scene = new MirrorScene { name = "component-playmode" };
            scene.objects.Add(obj);
            return scene;
        }

        private static MirrorObject ImageObject(string id, string kind, string componentType)
        {
            return SceneParser.ParseObject(JsonParser.ParseObject(
                "{\"id\":\"" + id + "\",\"kind\":\"" + kind + "\",\"active\":true," +
                "\"position\":{\"x\":3,\"y\":4},\"components\":[" +
                "{\"type\":\"" + componentType + "\",\"data\":{\"id\":\"asset.png\",\"width\":32,\"height\":16}}]}"));
        }

        private static MirrorObject ActionObject(string id, string kind, string componentType)
        {
            return SceneParser.ParseObject(JsonParser.ParseObject(
                "{\"id\":\"" + id + "\",\"kind\":\"" + kind + "\",\"components\":[" +
                "{\"type\":\"" + componentType + "\",\"data\":{\"clips\":[\"clip-a\"]}}]}"));
        }
    }
}
