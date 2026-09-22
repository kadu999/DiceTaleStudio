using System.Collections.Generic;
using UnityEngine;

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

            // 对象特性一律从 `components` 里读（协议 v9 起）——**不再读扁平字段**：
            // 握手是版本化的（不一致直接 close 4002），所以这里收到的场景一定是 v9 形状，
            // 留一条「老字段也认」的旁路只会让「数据到底存在哪」又多一种答案。
            ParseComponents(obj, JsonParser.GetArray(node, "components"));
            return obj;
        }

        /// <summary>
        /// 把 `components[]` 填进镜像对象。
        ///
        /// 判据是**组件类型**而不是 `kind`：这样编辑器加一个新组件时，前端只需要在这里多一个
        /// `case`（或者干脆什么都不做——未知类型会被安静地留下），不必再维护一份
        /// 「哪种 kind 有什么」的清单。
        /// </summary>
        private static void ParseComponents(MirrorObject obj, List<object> rawComponents)
        {
            if (rawComponents == null)
            {
                return;
            }

            foreach (var raw in rawComponents)
            {
                if (!(raw is Dictionary<string, object> component))
                {
                    continue;
                }

                var type = JsonParser.GetString(component, "type");
                if (string.IsNullOrEmpty(type))
                {
                    continue;
                }

                var data = JsonParser.GetObject(component, "data");
                if (data == null)
                {
                    continue;
                }

                obj.components.Add(new MirrorComponent { type = type, data = data });

                switch (type)
                {
                    case Protocol.ComponentType.Map:
                        obj.map = ParseMap(data);
                        break;
                    // 「对象自己显示的图」有两种组件（v11）：精灵 `SpriteLayer`（会取图集里的一格）
                    // 与贴图 `ImageLayer`（整张铺满）。数据形状一样，都填进 `obj.image`，
                    // 只多记一位「这是精灵那一份」——前端据此认得这两种对象。
                    case Protocol.ComponentType.Sprite:
                        obj.image = ParseImage(data);
                        obj.hasSpriteLayer = true;
                        break;
                    case Protocol.ComponentType.Image:
                        obj.image = ParseImage(data);
                        break;
                    case Protocol.ComponentType.Sound:
                        obj.sound = ParseSound(data);
                        break;
                    case Protocol.ComponentType.Video:
                        obj.video = ParseVideo(data);
                        break;
                    default:
                        // 不认识的组件（将来的新特性 / 编辑器侧的组件）：数据留在 components 里就够了
                        break;
                }
            }
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
                sprite = ParseSprite(JsonParser.GetObject(node, "sprite"), JsonParser.GetObject(node, "spriteGrid")),
            };
        }

        /// <summary>
        /// 子图（v10）：把「第几格」与「几列几行」合成一份。
        ///
        /// 服务端推的是两项、还可能是手写 / 老载荷，所以这里一路兜底：
        /// - 没有 `sprite` → `null`（整张图，与 v9 同义）；
        /// - 缺 `spriteGrid` → 按 **1×1** 算（那种载荷里「第几格」没有意义，只能当整图）；
        /// - 越界的格子 → **夹到最后一格**（切分被改小之后老对象仍然画得出来，
        ///   与服务端推送时的夹取同一条规矩；坏数字不该把整块面片画没）。
        /// </summary>
        private static MirrorSprite ParseSprite(
            Dictionary<string, object> sprite,
            Dictionary<string, object> grid)
        {
            if (sprite == null)
            {
                return null;
            }

            var columns = Mathf.Max(1, grid == null ? 1 : (int)JsonParser.GetNumber(grid, "columns"));
            var rows = Mathf.Max(1, grid == null ? 1 : (int)JsonParser.GetNumber(grid, "rows"));

            return new MirrorSprite
            {
                columns = columns,
                rows = rows,
                // 格子从**左上**数（与 Unity 的 Sprite Editor 一致）：0 起、夹进范围
                column = Mathf.Clamp((int)JsonParser.GetNumber(sprite, "column"), 0, columns - 1),
                row = Mathf.Clamp((int)JsonParser.GetNumber(sprite, "row"), 0, rows - 1),
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
                // 总开关缺省算开：老场景（协议 v3 及更早）只有 regions，「有 fog」就等于「开着」
                map.fogEnabled = JsonParser.GetBool(fog, "enabled", true);
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

        /// <summary>
        /// 视频列表（地图 / 精灵上的 `video`）；没有这个字段时返回 null（= 这个对象不放视频）。
        ///
        /// 三个开关**缺省**都有各自的默认：**开着**（老编辑器不发这一项，而「有 video 字段」
        /// 就等于「在用」）、不循环、静音。
        /// </summary>
        private static MirrorVideo ParseVideo(Dictionary<string, object> node)
        {
            if (node == null)
            {
                return null;
            }

            var video = new MirrorVideo
            {
                enabled = JsonParser.GetBool(node, "enabled", true),
                picked = JsonParser.GetString(node, "picked") ?? "",
                loop = JsonParser.GetBool(node, "loop", false),
                audio = JsonParser.GetBool(node, "audio", false),
            };

            var clips = JsonParser.GetArray(node, "clips");
            if (clips != null)
            {
                foreach (var raw in clips)
                {
                    if (raw is string clip && !string.IsNullOrEmpty(clip))
                    {
                        video.clips.Add(clip);
                    }
                }
            }

            return video;
        }
    }
}
