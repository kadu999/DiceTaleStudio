using NUnit.Framework;
using UnityEngine;

namespace DiceTale.Tests
{
    public class ComponentDrivenMirrorTests
    {
        [Test]
        public void ActionComponentsSuppressViewsRegardlessOfKind()
        {
            var sound = ParseObject(
                "{\"id\":\"sound\",\"kind\":\"Sprite\",\"components\":[" +
                "{\"type\":\"PlaySound\",\"data\":{\"clips\":[\"clip-a\"],\"layer\":\"sfx\"}}]}");
            var teleport = ParseObject(
                "{\"id\":\"teleport\",\"kind\":\"Map\",\"components\":[" +
                "{\"type\":\"Teleport\",\"data\":{\"targets\":[\"Map002\"]}}]}");

            Assert.That(sound.sound, Is.Not.Null);
            Assert.That(sound.sound.clips, Is.EqualTo(new[] { "clip-a" }));
            Assert.That(SceneObjectView.NeedsView(sound), Is.False);
            Assert.That(SceneObjectView.NeedsView(teleport), Is.False);
        }

        [Test]
        public void ImageComponentsRequireViewsRegardlessOfKind()
        {
            var image = ParseObject(
                "{\"id\":\"image\",\"kind\":\"PlaySound\",\"components\":[" +
                "{\"type\":\"ImageLayer\",\"data\":{\"id\":\"asset.png\",\"width\":32,\"height\":16}}]}");
            var map = ParseObject(
                "{\"id\":\"map\",\"kind\":\"Sprite\",\"components\":[" +
                "{\"type\":\"GridMap\",\"data\":{\"image\":{\"id\":\"map.png\",\"width\":64,\"height\":32}}}]}");

            Assert.That(image.image, Is.Not.Null);
            Assert.That(image.image.width, Is.EqualTo(32));
            Assert.That(map.map, Is.Not.Null);
            Assert.That(SceneObjectView.NeedsView(image), Is.True);
            Assert.That(SceneObjectView.NeedsView(map), Is.True);
        }

        [Test]
        public void VideoAndUnknownComponentsSurviveParsingOnMismatchedKind()
        {
            var video = ParseObject(
                "{\"id\":\"video\",\"kind\":\"Teleport\",\"components\":[" +
                "{\"type\":\"VideoOverlay\",\"data\":{\"enabled\":true,\"autoPlay\":true," +
                "\"clips\":[\"intro.mp4\"],\"picked\":\"intro.mp4\",\"loop\":false,\"audio\":false}}," +
                "{\"type\":\"FutureComponent\",\"data\":{\"preserved\":true}}]}");

            Assert.That(video.video, Is.Not.Null);
            Assert.That(video.video.enabled, Is.True);
            Assert.That(video.video.autoPlay, Is.True);
            Assert.That(video.video.clips, Is.EqualTo(new[] { "intro.mp4" }));
            Assert.That(video.HasComponent("VideoOverlay"), Is.True);
            Assert.That(video.HasComponent("FutureComponent"), Is.True);
            Assert.That(video.ComponentBool("FutureComponent", "preserved"), Is.True);
        }

        [Test]
        public void GenericComponentReadersUseFallbackOnlyForMissingOrWrongTypes()
        {
            var obj = ParseObject(
                "{\"id\":\"fields\",\"kind\":\"Image\",\"components\":[" +
                "{\"type\":\"VideoOverlay\",\"data\":{\"audio\":\"invalid\",\"duration\":1.5}}]}");

            Assert.That(obj.ComponentBool("VideoOverlay", "audio", true), Is.True);
            Assert.That(obj.ComponentBool("VideoOverlay", "missing", true), Is.True);
            Assert.That(obj.ComponentBool("Missing", "audio", true), Is.True);
            Assert.That(obj.ComponentNumber("VideoOverlay", "duration"), Is.EqualTo(1.5));
            Assert.That(obj.ComponentString("VideoOverlay", "missing"), Is.Null);
        }

        [Test]
        public void SpriteLayerIdentityComesFromComponentNotKind()
        {
            var spriteLayer = ParseObject(
                "{\"id\":\"sprite\",\"kind\":\"Image\",\"components\":[" +
                "{\"type\":\"SpriteLayer\",\"data\":{\"id\":\"atlas.png\",\"width\":64,\"height\":64}}]}");

            Assert.That(spriteLayer.hasSpriteLayer, Is.True);
            Assert.That(spriteLayer.image, Is.Not.Null);
            Assert.That(SceneObjectView.NeedsView(spriteLayer), Is.True);
        }

        private static MirrorObject ParseObject(string json)
        {
            var node = JsonParser.ParseObject(json);
            Assert.That(node, Is.Not.Null);
            return SceneParser.ParseObject(node);
        }
    }
}
