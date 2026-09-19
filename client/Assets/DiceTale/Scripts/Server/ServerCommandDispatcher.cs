using System;
using System.Collections.Generic;
using UnityEngine;

namespace DiceTale.Server
{
    /// <summary>
    /// 解析并执行服务器下发的命令：
    /// sync_state / set_map / teleport_player / set_option / set_object_items / set_mask_image / erase_mask /
    /// set_input_config。
    /// 对象命令按 ObjectId 定位枢纽后，由枢纽路由给对应能力组件处理（组件自己解析参数）。
    /// 注：协议命令/字段名（set_map、mapName 等）保持「地图」命名以兼容现有服务端，内部语义为场景切换。
    /// </summary>
    public class ServerCommandDispatcher : MonoBehaviour
    {
        public void Dispatch(string json)
        {
            try
            {
                var msg = JsonParser.ParseObject(json);
                if (msg == null)
                {
                    return;
                }

                switch (JsonParser.GetString(msg, "type"))
                {
                    case "set_option":
                    case "set_object_items":
                    case "set_mask_image":
                    case "erase_mask":
                    case "set_float":
                    case "set_int":
                    case "set_bool":
                        HandleObjectCommand(msg);
                        break;
                    case "set_scene_state":
                        HandleSetSceneState(msg);
                        break;
                    case "start_recording":
                        HandleStartRecording();
                        break;
                    case "stop_recording":
                        HandleStopRecording();
                        break;
                    case "set_input_config":
                        HandleSetInputConfig(msg);
                        break;
                    case "teleport_player":
                        HandleTeleportPlayer(msg);
                        break;
                    case "set_map":
                        HandleSetMap(msg);
                        break;
                    case "sync_state":
                        HandleSyncState(msg);
                        break;
                    case "character_cards":
                        HandleCharacterCards(msg);
                        break;
                    default:
                        Debug.LogWarning($"[ServerCommandDispatcher] Unknown command: {JsonParser.GetString(msg, "type")}");
                        break;
                }
            }
            catch (Exception ex)
            {
                Debug.LogError($"[ServerCommandDispatcher] Failed to dispatch: {ex.Message}");
            }
        }

        /// <summary>
        /// 对象命令（set_option / set_object_items / set_mask_image / erase_mask）：
        /// 按 ObjectId 定位枢纽，由枢纽通用路由给能处理该命令的能力组件（组件自己解析参数并执行）。
        /// </summary>
        private void HandleObjectCommand(Dictionary<string, object> msg)
        {
            var objectId = JsonParser.GetString(msg, "objectId");
            var obj = FindBackendObject(objectId);
            if (obj == null)
            {
                Debug.LogWarning($"[ServerCommandDispatcher] BackendObject not found in scene: {objectId}");
                return;
            }

            var type = JsonParser.GetString(msg, "type");
            if (obj.DispatchCommand(type, msg))
            {
                Debug.Log($"[ServerCommandDispatcher] {objectId} ({obj.DisplayName}): {type} OK");
            }
            else
            {
                Debug.LogWarning($"[ServerCommandDispatcher] {objectId}: no component handled command '{type}'");
            }
        }

        /// <summary>GM 切换场景状态（set_scene_state）：当前场景脚本应用（激活对应状态 GameObject，其余隐藏）。</summary>
        private void HandleSetSceneState(Dictionary<string, object> msg)
        {
            var index = (int)JsonParser.GetNumber(msg, "index");
            var sceneManager = DiceTale.Game.Instance != null ? DiceTale.Game.Instance.GameSceneManager : null;
            if (sceneManager != null && sceneManager.CurrentSceneScript != null)
            {
                sceneManager.CurrentSceneScript.ApplyState(index);
            }
        }

        /// <summary>GM 开始录音：交给宿主上的录音管理器（一局一个文件夹、按开始时间命名文件）。</summary>
        private void HandleStartRecording()
        {
            var recorder = DiceTale.Game.Instance != null ? DiceTale.Game.Instance.RecordingManager : null;
            if (recorder == null)
            {
                Debug.LogWarning("[ServerCommandDispatcher] start_recording: 录音管理器不可用（无游戏实例？）");
                return;
            }

            recorder.StartRecording();
        }

        /// <summary>GM 停止录音：结束当前一段并保存为 WAV（文件名 = 录音开始时间）。</summary>
        private void HandleStopRecording()
        {
            var recorder = DiceTale.Game.Instance != null ? DiceTale.Game.Instance.RecordingManager : null;
            if (recorder == null)
            {
                Debug.LogWarning("[ServerCommandDispatcher] stop_recording: 录音管理器不可用（无游戏实例？）");
                return;
            }

            recorder.StopRecording();
        }

        /// <summary>全局输入配置（set_input_config，无 objectId，与场景状态同级）：目前支持 key=first_contact_id——
        /// 指挥 Id（CommandId）：0=不覆盖、1..5=玩家 1..5、6=拍照、7=多点触屏（压板源转全触点口径）。
        /// **任何输入源下都可设置**：值始终落盘
        /// PlayerPrefs 并回执（GM 页立即回显）；当前源是 DevicePipeInputSource2 时同时写入实例立即生效，
        /// 其它源先预定，切到 v2（工厂恢复持久化值）自动生效。</summary>
        private void HandleSetInputConfig(Dictionary<string, object> msg)
        {
            var key = JsonParser.GetString(msg, "key");
            if (key != "first_contact_id")
            {
                Debug.LogWarning($"[ServerCommandDispatcher] set_input_config: 未识别的 key '{key}'（目前仅支持 first_contact_id）");
                return;
            }

            var value = (int)JsonParser.GetNumber(msg, "value");
            if (value < (int)DiceTale.PointerId.Unassigned || value > (int)DiceTale.PointerId.MultiTouch)
            {
                Debug.LogWarning($"[ServerCommandDispatcher] set_input_config: first_contact_id 值域 0..7，收到 {value}，忽略");
                return;
            }

            var input = DiceTale.Game.Instance != null ? DiceTale.Game.Instance.InputManager : null;
            if (input == null)
            {
                Debug.LogWarning("[ServerCommandDispatcher] set_input_config: 无游戏实例，忽略");
                return;
            }

            // 放宽：任何输入源下都可设置——值始终落盘（重启/切源后恢复）并回执（GM 页立即回显）；
            // 当前源是 v2 时同时写入实例立即生效，其它源先预定，切到 v2（工厂恢复持久化值）自动生效
            var overrideId = (DiceTale.PointerId)value;
            DiceTale.InputConfigPrefs.SaveCommandId(overrideId);
            if (input.CurrentInputSource is DiceTale.DevicePipeInputSource2 target)
            {
                target.CommandId = overrideId;
                Debug.Log($"[ServerCommandDispatcher] set_input_config: first_contact_id → {overrideId}（当前源 {input.CurrentInputSource.GetType().Name}，已立即生效）");
            }
            else
            {
                Debug.Log($"[ServerCommandDispatcher] set_input_config: first_contact_id → {overrideId}（当前源 {input.CurrentInputSource.GetType().Name} 非 DevicePipeInputSource2，已预定，切到 v2 生效）");
            }

            // 变更即时回播给服务器/GM 页（回显当前值；未连接时忽略，重连后的全量上报会补上）
            var connection = DiceTale.Game.Instance != null ? DiceTale.Game.Instance.ServerConnection : null;
            connection?.Send(new ReportInputConfigMessage { key = "first_contact_id", value = value });
        }

        private void HandleTeleportPlayer(Dictionary<string, object> msg)
        {
            var mapName = JsonParser.GetString(msg, "mapName");
            var spawnId = JsonParser.GetString(msg, "spawnId");
            var sceneManager = DiceTale.Game.Instance != null ? DiceTale.Game.Instance.GameSceneManager : null;
            sceneManager?.LoadScene(mapName, spawnId);
        }

        private void HandleSetMap(Dictionary<string, object> msg)
        {
            var mapName = JsonParser.GetString(msg, "mapName");
            var spawnId = JsonParser.GetString(msg, "spawnId");
            var sceneManager = DiceTale.Game.Instance != null ? DiceTale.Game.Instance.GameSceneManager : null;
            sceneManager?.LoadScene(mapName, spawnId);
        }

        private void HandleSyncState(Dictionary<string, object> msg)
        {
            var state = JsonParser.GetObject(msg, "state");
            if (state == null)
            {
                return;
            }

            var currentMap = JsonParser.GetString(state, "currentMap");
            var sceneManager = DiceTale.Game.Instance != null ? DiceTale.Game.Instance.GameSceneManager : null;
            if (!string.IsNullOrEmpty(currentMap) && sceneManager != null)
            {
                sceneManager.LoadScene(currentMap);
            }
        }

        /// <summary>角色卡下发（request_character_cards 的响应）：解析并缓存，供玩家创建时初始化身份与属性。</summary>
        private void HandleCharacterCards(Dictionary<string, object> msg)
        {
            var cards = JsonParser.GetArray(msg, "cards");
            if (cards == null)
            {
                return;
            }

            var list = new List<CharacterCardData>();
            foreach (var raw in cards)
            {
                if (!(raw is Dictionary<string, object> card))
                {
                    continue;
                }

                var data = new CharacterCardData
                {
                    id = JsonParser.GetString(card, "id"),
                    displayName = JsonParser.GetString(card, "displayName"),
                    role = JsonParser.GetString(card, "role")
                };

                var rawAttrs = JsonParser.GetArray(card, "attributes");
                if (rawAttrs != null)
                {
                    foreach (var rawAttr in rawAttrs)
                    {
                        if (rawAttr is Dictionary<string, object> a)
                        {
                            data.attributes.Add(new AttributeDef
                            {
                                key = JsonParser.GetString(a, "key"),
                                group = JsonParser.GetString(a, "group"),
                                value = (int)JsonParser.GetNumber(a, "value"),
                                maxValue = (int)JsonParser.GetNumber(a, "maxValue")
                            });
                        }
                    }
                }

                list.Add(data);
            }

            CharacterManager.SetCharacterCards(list);
            Debug.Log($"[ServerCommandDispatcher] character_cards: {list.Count} cards cached");
        }

        private BackendObject FindBackendObject(string objectId)
        {
            // 含 inactive 物体：被 ShowHideAction 隐藏（SetActive(false)）的对象仍须能被 GM 命令控制，
            // 否则隐藏对象从命令路由里消失（与「显隐」能力自相矛盾）
            foreach (var obj in UnityEngine.Object.FindObjectsByType<BackendObject>(FindObjectsInactive.Include, FindObjectsSortMode.None))
            {
                if (obj.ObjectId == objectId)
                {
                    return obj;
                }
            }

            return null;
        }
    }
}
