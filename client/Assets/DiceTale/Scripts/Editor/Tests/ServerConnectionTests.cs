using System.Collections.Generic;
using DiceTale.Server;
using NUnit.Framework;
using UnityEngine;

namespace DiceTale.Editor.Tests
{
    public class ServerConnectionTests
    {
        [Test]
        public void RegisterMapObjectsMessage_SerializesSpawnsAndObjects()
        {
            var msg = new RegisterMapObjectsMessage { mapName = "Map001" };
            msg.spawnPoints.Add(new SpawnInfo { id = "Default" });
            msg.objects.Add(new ServerObjectInfo
            {
                id = "Lever_1",
                name = "大厅拉杆",
                kind = "Lever",
                position = new Position { x = 0.4f, y = 0.3f },
                componentData = new List<ComponentData>
                {
                    new ComponentData
                    {
                        component = "OptionValue",
                        displayName = "选项值",
                        data = JsonUtility.ToJson(new StateData { currentOption = "off", options = new List<string> { "off", "on" } })
                    }
                }
            });

            var json = JsonUtility.ToJson(msg);
            Assert.IsTrue(json.Contains("\"type\":\"register_map_objects\""));
            Assert.IsTrue(json.Contains("\"mapName\":\"Map001\""));
            Assert.IsTrue(json.Contains("\"Default\""));
            Assert.IsTrue(json.Contains("\"Lever_1\""));
            Assert.IsTrue(json.Contains("\"大厅拉杆\""));
            Assert.IsTrue(json.Contains("\"component\":\"OptionValue\""));
            Assert.IsTrue(json.Contains("\"displayName\":\"选项值\""));
            // 组件数据是 JSON 字符串：内嵌引号被 JsonUtility 转义为 \"，消费端 JSON.parse 还原
            Assert.IsTrue(json.Contains("\\\"currentOption\\\":\\\"off\\\""));
            Assert.IsTrue(json.Contains("\"position\":{\"x\":0.4"));
        }

        [Test]
        public void RequestTeleportMessage_SerializesCorrectly()
        {
            var msg = new RequestTeleportMessage { mapName = "Map002", spawnId = "North" };
            var json = JsonUtility.ToJson(msg);
            Assert.IsTrue(json.Contains("\"type\":\"request_teleport\""));
            Assert.IsTrue(json.Contains("\"mapName\":\"Map002\""));
            Assert.IsTrue(json.Contains("\"spawnId\":\"North\""));
        }

        [Test]
        public void ServerObjectInfo_SerializesBackpackComponentData()
        {
            var msg = new RegisterMapObjectsMessage { mapName = "Map001" };
            msg.objects.Add(new ServerObjectInfo
            {
                id = "Player_1",
                name = "小明",
                kind = "Player",
                componentData = new List<ComponentData>
                {
                    new ComponentData
                    {
                        component = "Backpack",
                        data = JsonUtility.ToJson(new BackpackData { items = new List<string> { "小刀", "草药" } })
                    }
                }
            });

            var json = JsonUtility.ToJson(msg);
            Assert.IsTrue(json.Contains("\"type\":\"register_map_objects\""));
            Assert.IsTrue(json.Contains("\"component\":\"Backpack\""));
            Assert.IsTrue(json.Contains("\\\"items\\\":[\\\"小刀\\\",\\\"草药\\\"]"));
        }

        [Test]
        public void JsonParser_ParsesSyncStateWithObjectDictionary()
        {
            const string json = "{\"type\":\"sync_state\",\"state\":{\"currentMap\":\"Map001\"," +
                                "\"player\":{\"position\":{\"x\":1.5,\"y\":2.5}}," +
                                "\"objects\":{\"Lever_1\":{\"kind\":\"Lever\",\"componentData\":" +
                                "[{\"component\":\"OptionValue\",\"data\":\"{\\\"currentOption\\\":\\\"off\\\",\\\"options\\\":[\\\"off\\\",\\\"on\\\"]}\"}]}}," +
                                "\"spawnPoints\":{\"Map001\":[{\"id\":\"Default\"}]}}}";

            var msg = JsonParser.ParseObject(json);
            Assert.AreEqual("sync_state", JsonParser.GetString(msg, "type"));

            var state = JsonParser.GetObject(msg, "state");
            Assert.AreEqual("Map001", JsonParser.GetString(state, "currentMap"));

            var objects = JsonParser.GetObject(state, "objects");
            Assert.IsNotNull(objects);
            Assert.IsTrue(objects.ContainsKey("Lever_1"));
            var objState = objects["Lever_1"] as Dictionary<string, object>;
            Assert.IsNotNull(objState);
            Assert.AreEqual("Lever", JsonParser.GetString(objState, "kind"));

            // 组件数据段：component = 组件类型，data = JSON 字符串（解析后得到组件参数）
            var componentData = JsonParser.GetArray(objState, "componentData");
            Assert.IsNotNull(componentData);
            Assert.AreEqual(1, componentData.Count);
            var block = componentData[0] as Dictionary<string, object>;
            Assert.IsNotNull(block);
            Assert.AreEqual("OptionValue", JsonParser.GetString(block, "component"));
            var parsed = JsonParser.ParseObject(JsonParser.GetString(block, "data"));
            Assert.AreEqual("off", JsonParser.GetString(parsed, "currentOption"));

            var player = JsonParser.GetObject(state, "player");
            var position = JsonParser.GetObject(player, "position");
            Assert.AreEqual(1.5, JsonParser.GetNumber(position, "x"), 0.0001);
            Assert.AreEqual(2.5, JsonParser.GetNumber(position, "y"), 0.0001);

            var spawnPoints = JsonParser.GetObject(state, "spawnPoints");
            var mapSpawns = JsonParser.GetArray(spawnPoints, "Map001");
            Assert.IsNotNull(mapSpawns);
            Assert.AreEqual(1, mapSpawns.Count);
        }

        [Test]
        public void JsonParser_HandlesEscapedStrings()
        {
            const string json = "{\"name\":\"line\\nbreak \\\"quoted\\\"\"}";
            var msg = JsonParser.ParseObject(json);
            Assert.AreEqual("line\nbreak \"quoted\"", JsonParser.GetString(msg, "name"));
        }

        [Test]
        public void JsonParser_ReturnsNullForInvalidJson()
        {
            Assert.IsNull(JsonParser.ParseObject("not json"));
            Assert.IsNull(JsonParser.ParseObject("{ broken"));
        }

        // 组件数据载体（与客户端组件内部数据形状一致：组件类型 + JSON 字符串）
        [System.Serializable]
        private class StateData
        {
            public string currentOption;
            public List<string> options;
        }

        [System.Serializable]
        private class BackpackData
        {
            public List<string> items;
        }
    }
}
