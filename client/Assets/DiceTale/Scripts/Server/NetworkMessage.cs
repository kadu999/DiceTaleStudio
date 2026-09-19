using System;
using System.Collections.Generic;

namespace DiceTale.Server
{
    /// <summary>
    /// 客户端 -> 服务器的消息类（配合 JsonUtility 序列化）。
    /// </summary>

    [Serializable]
    public class RequestJoinMessage
    {
        public string type = "request_join";
    }

    [Serializable]
    public class RegisterMapObjectsMessage
    {
        public string type = "register_map_objects";
        public string mapName;
        public List<SpawnInfo> spawnPoints = new List<SpawnInfo>();
        /// <summary>场景状态列表（场景脚本 GameScene 的状态 GameObject；GM 页地图下方显示）。</summary>
        public List<SceneStateInfo> states = new List<SceneStateInfo>();
        /// <summary>所有 BackendObject 的通用状态信息（供 GM 页面展示与切换状态）。</summary>
        public List<ServerObjectInfo> objects = new List<ServerObjectInfo>();
    }

    [Serializable]
    public class SpawnInfo
    {
        public string id;
    }

    /// <summary>场景状态条目（id = 状态下标串；name = GM 按钮文字；active = 是否激活中）。</summary>
    [Serializable]
    public class SceneStateInfo
    {
        public string id;
        public string name;
        public bool active;
    }

    /// <summary>
    /// 通用后台对象状态信息：对象 ID、显示名称、类型显示名、所属地图、归一化位置，
    /// 以及各能力组件的数据段（组件类型 + JSON 字符串，谁要用谁解析）。
    /// 由 BackendRegistry 对每个 BackendObject 统一收集。
    /// </summary>
    [Serializable]
    public class ServerObjectInfo
    {
        public string id;
        public string name;
        public string kind;
        /// <summary>对象所属地图名（客户端按对象实际所在的地图上报，避免跨图串图）。</summary>
        public string mapName;
        /// <summary>对象在地图图片上的归一化位置 [0,1]，y 向下（左上角为原点）。</summary>
        public Position position;
        /// <summary>能力组件数据段：每个组件一段（component=组件类型，data=该组件数据的 JSON 字符串）。</summary>
        public List<ComponentData> componentData = new List<ComponentData>();
    }

    /// <summary>组件数据段：组件类型 + 组件显示名 + JSON 字符串数据（GM/后端按组件类型解析出最终数据）。</summary>
    [Serializable]
    public class ComponentData
    {
        public string component;
        /// <summary>组件显示名（GM 属性面板分区标题，如「状态机」「背包」）。</summary>
        public string displayName;
        public string data;
    }

    [Serializable]
    public class RegisterPlayersMessage
    {
        public string type = "register_players";
        public List<PlayerInfo> players = new List<PlayerInfo>();
    }

    [Serializable]
    public class PlayerInfo
    {
        public string id;
        public string name;
        /// <summary>角色职称（角色卡 role；GM 玩家卡「职称」显示；无则空字符串）。</summary>
        public string role;
        /// <summary>角色卡编号（"1".."4"；GM 据此核对「创建玩家 ↔ 角色卡」是否对应）。</summary>
        public string characterId;
    }

    [Serializable]
    public class ReportPlayerPositionMessage
    {
        public string type = "report_player_position";
        public string playerId;
        public Position position;
        public string mapName;
    }

    /// <summary>通用主体位置上报（report_object_position）：后台据此更新 objects 中的位置。</summary>
    [Serializable]
    public class ReportObjectPositionMessage
    {
        public string type = "report_object_position";
        public string objectId;
        public Position position;
        public string mapName;
    }

    /// <summary>请求后台下发 teleport_player 命令切换地图。</summary>
    [Serializable]
    public class RequestTeleportMessage
    {
        public string type = "request_teleport";
        public string mapName;
        public string spawnId;
    }

    /// <summary>应用层心跳：周期上报，供后台判断连接是否半开（后台据此清理死连接）。</summary>
    [Serializable]
    public class HeartbeatMessage
    {
        public string type = "heartbeat";
    }

    /// <summary>输入配置上报（report_input_config）：客户端把当前输入源的关键配置同步给服务器/GM 页回显。
    /// 目前 key=first_contact_id（指挥 Id CommandId）：0=不覆盖、1..5=玩家、6=拍照、7=多点触屏。连上全量上报时附带 + 值变更时即时发送。</summary>
    [Serializable]
    public class ReportInputConfigMessage
    {
        public string type = "report_input_config";
        public string key;
        public int value;
    }

    /// <summary>请求角色卡（4 张角色卡 JSON 配置；创建玩家时按角色 ID 初始化身份与属性）。</summary>
    [Serializable]
    public class RequestCharacterCardsMessage
    {
        public string type = "request_character_cards";
    }

    /// <summary>GM 切换场景状态（服务器下发）：客户端激活 index 对应状态 GameObject、隐藏其余。</summary>
    [Serializable]
    public class SetSceneStateMessage
    {
        public string type = "set_scene_state";
        public int index;
    }

    [Serializable]
    public class Position
    {
        public float x;
        public float y;
    }
}
