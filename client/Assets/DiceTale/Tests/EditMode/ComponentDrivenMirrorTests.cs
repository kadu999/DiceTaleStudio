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
                "{\"id\":\"map\",\"kind\":\"Image\",\"components\":[" +
                "{\"type\":\"ImageLayer\",\"data\":{\"id\":\"map.png\",\"width\":64,\"height\":32}}," +
                "{\"type\":\"GridMap\",\"data\":{\"grid\":{\"width\":8,\"height\":6},\"rowOrder\":\"bottom-up\"," +
                "\"cells\":{\"encoding\":\"rle\",\"runs\":[[0,48]]}}}]}");

            Assert.That(image.image, Is.Not.Null);
            Assert.That(image.image.width, Is.EqualTo(32));
            Assert.That(map.map, Is.Not.Null);
            Assert.That(map.map.gridWidth, Is.EqualTo(8));
            Assert.That(map.image, Is.Not.Null);
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
            // v15 起雾是独立对象（kind "Fog"）：它自己不带地图数据，data 里用 mapId 引用被罩住的地图
            var obj = ParseObject(
                "{\"id\":\"fog\",\"kind\":\"Fog\",\"components\":[" +
                "{\"type\":\"FogOfWar\",\"data\":{\"mapId\":\"map_1\",\"enabled\":false,\"regions\":[1,4]}}]}");

            Assert.That(obj.map, Is.Null);
            Assert.That(obj.image, Is.Null);
            Assert.That(obj.fog, Is.Not.Null);
            Assert.That(obj.fog.mapId, Is.EqualTo("map_1"));
            Assert.That(obj.fog.enabled, Is.False);
            Assert.That(obj.fog.regions, Is.EqualTo(new[] { 1, 4 }));
        }

        [Test]
        public void FogObjectCarriesMapIdWithoutMapOrImageComponents()
        {
            // v15：`kind:"Fog"` 的独立雾对象 —— 带 mapId / enabled / regions，且**没有** map / image
            var obj = ParseObject(
                "{\"id\":\"fog_1\",\"kind\":\"Fog\",\"components\":[" +
                "{\"type\":\"FogOfWar\",\"data\":{\"mapId\":\"map_1\",\"enabled\":true,\"regions\":[1]}}]}");

            Assert.That(obj.fog, Is.Not.Null);
            Assert.That(obj.fog.mapId, Is.EqualTo("map_1"));
            Assert.That(obj.fog.enabled, Is.True);
            Assert.That(obj.fog.regions, Is.EqualTo(new[] { 1 }));
            Assert.That(obj.map, Is.Null);
            Assert.That(obj.image, Is.Null);
        }

        [Test]
        public void FogOfWarComponentDefaultsToEnabled()
        {
            var obj = ParseObject(
                "{\"id\":\"fog\",\"kind\":\"Fog\",\"components\":[" +
                "{\"type\":\"FogOfWar\",\"data\":{\"mapId\":\"map_1\",\"regions\":[8]}}]}");

            Assert.That(obj.fog, Is.Not.Null);
            Assert.That(obj.fog.enabled, Is.True);
            Assert.That(obj.fog.regions, Is.EqualTo(new[] { 8 }));
        }

        [Test]
        public void MissingFogOfWarComponentMeansNoFog()
        {
            // 没有 `FogOfWar` 组件 = 没开战争雾；网格数据里那个老 `fog` 字段（v13 前）一律忽略
            var obj = ParseObject(
                "{\"id\":\"map\",\"kind\":\"Image\",\"components\":[" +
                "{\"type\":\"GridMap\",\"data\":{\"grid\":{\"width\":8,\"height\":6},\"rowOrder\":\"bottom-up\"," +
                "\"cells\":{\"encoding\":\"rle\",\"runs\":[[0,48]]},\"fog\":{\"enabled\":true,\"regions\":[1]}}}]}");

            Assert.That(obj.map, Is.Not.Null);
            Assert.That(obj.fog, Is.Null);
            Assert.That(obj.HasComponent("FogOfWar"), Is.False);
        }

        [Test]
        public void SortingOrderComesFromRenderComponents()
        {
            // v14 起显示顺序住在渲染组件的数据里（对象级那一项没了）：一律取图片层（v16 起带网格的贴图也一样），
            // 没有图片层的对象兜底 0
            var map = ParseObject(
                "{\"id\":\"map\",\"kind\":\"Image\",\"components\":[" +
                "{\"type\":\"ImageLayer\",\"data\":{\"id\":\"map.png\",\"width\":64,\"height\":32,\"sortingOrder\":-10}}," +
                "{\"type\":\"GridMap\",\"data\":{\"grid\":{\"width\":8,\"height\":6},\"rowOrder\":\"bottom-up\"," +
                "\"cells\":{\"encoding\":\"rle\",\"runs\":[[0,48]]}}}]}");
            var image = ParseObject(
                "{\"id\":\"image\",\"kind\":\"Image\",\"components\":[" +
                "{\"type\":\"ImageLayer\",\"data\":{\"id\":\"a.png\",\"width\":32,\"height\":16,\"sortingOrder\":7}}]}");
            var sprite = ParseObject(
                "{\"id\":\"sprite\",\"kind\":\"Sprite\",\"components\":[" +
                "{\"type\":\"SpriteLayer\",\"data\":{\"id\":\"atlas.png\",\"width\":64,\"height\":64," +
                "\"sortingOrder\":3}}]}");
            var action = ParseObject(
                "{\"id\":\"sound\",\"kind\":\"PlaySound\",\"components\":[" +
                "{\"type\":\"PlaySound\",\"data\":{\"clips\":[],\"layer\":\"sfx\"}}]}");

            Assert.That(map.sortingOrder, Is.EqualTo(-10));
            Assert.That(image.sortingOrder, Is.EqualTo(7));
            Assert.That(sprite.sortingOrder, Is.EqualTo(3));
            Assert.That(action.sortingOrder, Is.EqualTo(0));
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
            // 组件自治：FogOfWar 挂在**独立雾对象**的 GameObject 上（它自己没有面片），渲染子物体
            // `FogOverlay` 由它自己建（开关开着 + 绑了雾区 + 被引用地图的数据传了进来）、自己拆。
            var go = new GameObject("fog-owner-test");
            try
            {
                var fog = go.AddComponent<FogOfWar>();
                // v15：被引用地图的数据由调用方（SceneObjectView）解析好后直接传进来
                var map = new MirrorMap { gridWidth = 2, gridHeight = 2, cells = new int[4] };

                fog.Apply(map, null, new MirrorFog { enabled = true, regions = new[] { 1 } }, 1f, 1f, 0.01f);

                var overlay = go.transform.Find("FogOverlay");
                Assert.That(overlay, Is.Not.Null);
                Assert.That(overlay.GetComponent<ImageLayer>(), Is.Not.Null);

                // 总开关关掉：渲染子物体被拆掉（EditMode 下走 DestroyImmediate，立即生效）
                fog.Apply(map, null, new MirrorFog { enabled = false, regions = new[] { 1 } }, 1f, 1f, 0.01f);

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
                var fog = go.AddComponent<FogOfWar>();
                var map = new MirrorMap { gridWidth = 2, gridHeight = 2, cells = new int[4] };

                fog.Apply(map, null, new MirrorFog { enabled = true, regions = new int[0] }, 1f, 1f, 0.01f);

                Assert.That(go.transform.Find("FogOverlay"), Is.Null);
            }
            finally
            {
                Object.DestroyImmediate(go);
            }
        }

        [Test]
        public void VideoBlendFieldsAreReadableThroughGenericReaders()
        {
            // v17/v18：视频混合**不加强类型镜像字段**——两条通道与 `autoPlay` 一律走泛型读取器
            // （见 MirrorObject 的「加新字段的规矩」）。`SceneMirror` / `CommandRouter` 的自动播放靠这条路。
            var obj = ParseObject(
                "{\"id\":\"blend\",\"kind\":\"Image\",\"components\":[" +
                "{\"type\":\"VideoBlend\",\"data\":{\"a\":{\"clips\":[\"a.mp4\"],\"picked\":\"a.mp4\"}," +
                "\"b\":{\"clips\":[\"b.mp4\"],\"picked\":\"b.mp4\"},\"loop\":false,\"autoPlay\":true," +
                "\"audio\":\"none\"}}]}");

            Assert.That(obj.HasComponent("VideoBlend"), Is.True);
            Assert.That(obj.ComponentBool("VideoBlend", "autoPlay"), Is.True);
            Assert.That(obj.ComponentBool("VideoBlend", "loop"), Is.False);
            Assert.That(obj.ComponentString("VideoBlend", "audio"), Is.EqualTo("none"));
            Assert.That(
                JsonParser.GetString(JsonParser.GetObject(obj.ComponentData("VideoBlend"), "a"), "picked"),
                Is.EqualTo("a.mp4"));
            Assert.That(obj.video, Is.Null); // 混合不是「视频」：不带强类型字段
        }

        private static MirrorObject ParseObject(string json)
        {
            var node = JsonParser.ParseObject(json);
            Assert.That(node, Is.Not.Null);
            return SceneParser.ParseObject(node);
        }
    }
}
