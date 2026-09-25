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

        [Test]
        public void FogOfWarComponentParsesEnabledAndRegions()
        {
            var obj = ParseObject(
                "{\"id\":\"fog\",\"kind\":\"Map\",\"components\":[" +
                "{\"type\":\"GridMap\",\"data\":{\"image\":{\"id\":\"map.png\",\"width\":64,\"height\":32}}}," +
                "{\"type\":\"FogOfWar\",\"data\":{\"enabled\":false,\"regions\":[1,4]}}]}");

            Assert.That(obj.map, Is.Not.Null);
            Assert.That(obj.fog, Is.Not.Null);
            Assert.That(obj.fog.enabled, Is.False);
            Assert.That(obj.fog.regions, Is.EqualTo(new[] { 1, 4 }));
        }

        [Test]
        public void FogOfWarComponentDefaultsToEnabled()
        {
            var obj = ParseObject(
                "{\"id\":\"fog\",\"kind\":\"Map\",\"components\":[" +
                "{\"type\":\"FogOfWar\",\"data\":{\"regions\":[8]}}]}");

            Assert.That(obj.fog, Is.Not.Null);
            Assert.That(obj.fog.enabled, Is.True);
            Assert.That(obj.fog.regions, Is.EqualTo(new[] { 8 }));
        }

        [Test]
        public void MissingFogOfWarComponentMeansNoFog()
        {
            // v13 起 `GridMap` 数据里不再有 `fog`：老字段被忽略，没有 `FogOfWar` 组件 = 没开战争雾
            var obj = ParseObject(
                "{\"id\":\"map\",\"kind\":\"Map\",\"components\":[" +
                "{\"type\":\"GridMap\",\"data\":{\"image\":{\"id\":\"map.png\",\"width\":64,\"height\":32}," +
                "\"fog\":{\"enabled\":true,\"regions\":[1]}}}]}");

            Assert.That(obj.map, Is.Not.Null);
            Assert.That(obj.fog, Is.Null);
            Assert.That(obj.HasComponent("FogOfWar"), Is.False);
        }

        [Test]
        public void GridMapViewAdoptsMapData()
        {
            // 组件袋：`GridMap` 协议组件的数据座位是 GridMapView，Adopt 收下的就是当前生效那份
            var go = new GameObject("grid-map-view-test");
            try
            {
                var gridMap = go.AddComponent<GridMapView>();
                var map = new MirrorMap { gridWidth = 2, gridHeight = 2, cells = new int[4] };

                gridMap.Adopt(map);

                Assert.That(gridMap.Map, Is.SameAs(map));
            }
            finally
            {
                Object.DestroyImmediate(go);
            }
        }

        [Test]
        public void FogOfWarBuildsAndTearsDownItsOwnOverlay()
        {
            // 组件自治：FogOfWar 直接挂在对象 GameObject 上（组件袋一员），渲染子物体
            // `FogOverlay` 由它自己建（开关开着 + 绑了雾区 + 对象有地图数据）、自己拆。
            var go = new GameObject("fog-owner-test");
            try
            {
                // 对象那袋组件：GridMapView 收地图数据（FogOfWar 从它取格子），ImageLayer 是
                // 对象自己那张图（GroundLayer 的 RequireComponent 链会把 MeshFilter / MeshRenderer
                // 一起带上）；FogOfWar 自己**不** RequireComponent(ImageLayer)——子物体才挂它
                var gridMap = go.AddComponent<GridMapView>();
                gridMap.Adopt(new MirrorMap { gridWidth = 2, gridHeight = 2, cells = new int[4] });
                go.AddComponent<ImageLayer>();
                var fog = go.AddComponent<FogOfWar>();

                fog.Apply(new MirrorFog { enabled = true, regions = new[] { 1 } }, 1f, 1f, 0, 0.01f);

                var overlay = go.transform.Find("FogOverlay");
                Assert.That(overlay, Is.Not.Null);
                Assert.That(overlay.GetComponent<ImageLayer>(), Is.Not.Null);

                // 总开关关掉：渲染子物体被拆掉（EditMode 下走 DestroyImmediate，立即生效）
                fog.Apply(new MirrorFog { enabled = false, regions = new[] { 1 } }, 1f, 1f, 0, 0.01f);

                Assert.That(go.transform.Find("FogOverlay"), Is.Null);
            }
            finally
            {
                Object.DestroyImmediate(go);
            }
        }

        [Test]
        public void FogOfWarSkipsOverlayWhenRegionsEmpty()
        {
            // 开着开关但一个雾区都没绑：不生成雾层（与旧版同一口径）
            var go = new GameObject("fog-empty-regions-test");
            try
            {
                var gridMap = go.AddComponent<GridMapView>();
                gridMap.Adopt(new MirrorMap { gridWidth = 2, gridHeight = 2, cells = new int[4] });
                var fog = go.AddComponent<FogOfWar>();

                fog.Apply(new MirrorFog { enabled = true, regions = new int[0] }, 1f, 1f, 0, 0.01f);

                Assert.That(go.transform.Find("FogOverlay"), Is.Null);
            }
            finally
            {
                Object.DestroyImmediate(go);
            }
        }

        private static MirrorObject ParseObject(string json)
        {
            var node = JsonParser.ParseObject(json);
            Assert.That(node, Is.Not.Null);
            return SceneParser.ParseObject(node);
        }
    }
}
