using System.Collections.Generic;

namespace DiceTale
{
    /// <summary>
    /// 把服务端推下来的场景 JSON 解析成镜像模型（<see cref="MirrorScene"/>）。
    ///
    /// 为什么不用 `JsonUtility`：场景里的网格是 RLE 元组数组（`"runs": [[掩码, 格数], …]`），
    /// JsonUtility 读不了嵌套数组；而且服务端字段是可选的、还允许 `null`。
    /// 这里复用项目自带的 <see cref="JsonParser"/>，顺便把 RLE 直接解成掩码数组。
    ///
    /// 解析失败一律返回 null（调用方只记一条日志），**不抛**：一条坏消息不该让镜像崩掉。
    /// </summary>
    public static class SceneParser
    {
        /// <summary>解析场景节点（`scene_sync` 消息里的 `scene` 字段）。节点为空时返回 null。</summary>
        public static MirrorScene Parse(Dictionary<string, object> sceneNode)
        {
            if (sceneNode == null)
            {
                return null;
            }

            var scene = new MirrorScene
            {
                name = JsonParser.GetString(sceneNode, "name") ?? "",
            };

            var rawObjects = JsonParser.GetArray(sceneNode, "objects");
            if (rawObjects == null)
            {
                return scene;
            }

            foreach (var raw in rawObjects)
            {
                if (!(raw is Dictionary<string, object> node))
                {
                    continue;
                }

                var obj = ParseObject(node);
                if (!string.IsNullOrEmpty(obj.id))
                {
                    scene.objects.Add(obj);
                }
            }

            return scene;
        }

        /// <summary>解析一个场景对象。缺 `id` 的对象会被丢弃（镜像按 id 对齐，没 id 没法对）。</summary>
        public static MirrorObject ParseObject(Dictionary<string, object> node)
        {
            var obj = new MirrorObject
            {
                id = JsonParser.GetString(node, "id") ?? "",
                name = JsonParser.GetString(node, "name") ?? "",
                kind = JsonParser.GetString(node, "kind") ?? "SceneObject",
                active = JsonParser.GetBool(node, "active", true),
                sortingOrder = (int)JsonParser.GetNumber(node, "sortingOrder"),
                rotation = (float)JsonParser.GetNumber(node, "rotation"),
                scale = (float)JsonParser.GetNumber(node, "scale", 1),
            };

            if (obj.scale <= 0f)
            {
                obj.scale = 1f;
            }

            var position = JsonParser.GetObject(node, "position");
            if (position != null)
            {
                // `"position": null` 或字段缺失 = 还没落位：镜像里保留对象，但不建视图
                obj.hasPosition = true;
                obj.x = (float)JsonParser.GetNumber(position, "x");
                obj.y = (float)JsonParser.GetNumber(position, "y");
            }

            obj.image = ParseImage(JsonParser.GetObject(node, "image"));
            obj.map = ParseMap(JsonParser.GetObject(node, "map"));
            obj.sound = ParseSound(JsonParser.GetObject(node, "sound"));
            return obj;
        }

        private static MirrorImage ParseImage(Dictionary<string, object> node)
        {
            if (node == null)
            {
                return null;
            }

            var id = JsonParser.GetString(node, "id");
            if (string.IsNullOrEmpty(id))
            {
                return null;
            }

            return new MirrorImage
            {
                id = id,
                width = (int)JsonParser.GetNumber(node, "width"),
                height = (int)JsonParser.GetNumber(node, "height"),
            };
        }

        private static MirrorMap ParseMap(Dictionary<string, object> node)
        {
            if (node == null)
            {
                return null;
            }

            var map = new MirrorMap
            {
                image = ParseImage(JsonParser.GetObject(node, "image")),
            };

            var grid = JsonParser.GetObject(node, "grid");
            if (grid != null)
            {
                map.gridWidth = (int)JsonParser.GetNumber(grid, "width");
                map.gridHeight = (int)JsonParser.GetNumber(grid, "height");
            }

            var cells = JsonParser.GetObject(node, "cells");
            if (cells != null)
            {
                map.cells = GridRle.Decode(JsonParser.GetArray(cells, "runs"), map.gridWidth * map.gridHeight);
            }

            var fog = JsonParser.GetObject(node, "fog");
            if (fog != null)
            {
                map.fogRegions = GridRle.FlattenInts(JsonParser.GetArray(fog, "regions"));
            }

            return map;
        }

        private static MirrorSound ParseSound(Dictionary<string, object> node)
        {
            if (node == null)
            {
                return null;
            }

            var sound = new MirrorSound
            {
                picked = JsonParser.GetString(node, "picked") ?? "",
                layer = JsonParser.GetString(node, "layer") ?? "sfx",
            };

            var clips = JsonParser.GetArray(node, "clips");
            if (clips != null)
            {
                foreach (var raw in clips)
                {
                    if (raw is string clip && !string.IsNullOrEmpty(clip))
                    {
                        sound.clips.Add(clip);
                    }
                }
            }

            return sound;
        }
    }
}
