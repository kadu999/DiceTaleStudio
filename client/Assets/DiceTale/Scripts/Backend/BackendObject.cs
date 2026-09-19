using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 后台对象枢纽（组件模型）：挂在物体（主体）上的「后台对象」本体，只负责与后台（backend）的通信、身份与聚合，
    /// 具体能力（状态机 / 背包 / 道具货源 / 遮罩）由同一主体上的能力组件
    /// （继承 <see cref="BackendComponent"/>）经 <see cref="IBackendComponentData"/>、
    /// <see cref="IBackendCommandHandler"/> 提供。
    ///
    /// 主体 = 挂了本枢纽的 GameObject；能力组件挂在同一个主体上。枢纽在初始化（OnEnable）时
    /// 扫描一次缓存能力组件列表（不序列化、不显示、不对外暴露），聚合上报与命令转发都以该缓存为来源。
    ///
    /// 枢纽自动完成：
    /// - 启用/销毁时注册/注销到 <see cref="BackendRegistry"/>；
    /// - 提供统一的对象 ID（ObjectId：自定义 ID（隐藏字段）优先，默认自动生成唯一 ID）与类型显示名（ObjectKind）；
    /// - 提供向后台发送消息、世界坐标转图片归一化坐标的工具；
    /// - 收集能力组件的数据统一上报（各能力组件经 <see cref="IBackendComponentData"/> 自己填充状态/物品/道具/遮罩字段）；
    /// - 通用命令路由：后台命令按类型转发给能处理它的能力组件（组件实现 <see cref="IBackendCommandHandler"/> 自己解析并执行）；
    ///
    /// 用法：主体（GameObject）上挂枢纽 + 任意组合的能力组件（门=枢纽+状态机、道具=枢纽+道具货源、
    /// 玩家=枢纽+角色+物品、宝箱=枢纽+状态机+道具货源…）。
    /// 后台命令经 ServerCommandDispatcher 按 ObjectId 定位枢纽。
    /// </summary>
    [DisallowMultipleComponent]
    public class BackendObject : MonoBehaviour
    {

        [SerializeField, Tooltip("后台对象类型（GM 页面分类展示用；新增类型在 BackendObjectKind 末尾追加）")]
        private BackendObjectKind objectKind = BackendObjectKind.SceneObject;

        [SerializeField, Tooltip("GM 页面显示的名称（后台看名字识别对象）；为空时回退道具动态显示名或对象 ID")]
        private string displayName;

        [SerializeField, HideInInspector, Tooltip("自定义对象 ID 覆盖（高级用途：需要稳定/可读 ID 时设置，如 Debug 模式或代码里写入）；为空时自动生成唯一 ID")]
        private string objectId;

        private string generatedId;

        /// <summary>角色卡编号（"1".."4"，创建角色时由 CharacterManager 写入；GM 核对玩家↔角色卡对应）。</summary>
        private string characterId;

        /// <summary>主体上的能力组件缓存（初始化时扫描获取，不序列化不显示）；上报与命令路由以此列表为来源。</summary>
        private readonly List<BackendComponent> capabilityComponents = new List<BackendComponent>();

        /// <summary>后台使用的唯一对象 ID：自定义 ID（隐藏字段）优先，默认自动生成唯一 ID。</summary>
        public string ObjectId
        {
            get
            {
                if (!string.IsNullOrEmpty(objectId))
                {
                    return objectId;
                }

                if (generatedId == null)
                {
                    generatedId = $"{name}_{System.Guid.NewGuid():N}";
                }

                return generatedId;
            }
        }

        /// <summary>对象类型显示名（GM 页面展示用）：序列化 BackendObjectKind 枚举的字符串形式。</summary>
        public string ObjectKind => objectKind.ToString();

        /// <summary>设置后台对象类型（玩家等由代码创建的枢纽在运行时设置，如 kind=Player）。</summary>
        public void SetKind(BackendObjectKind kind)
        {
            objectKind = kind;
        }

        /// <summary>设置 GM 页面显示的名称（后台看名字识别对象）。</summary>
        public void SetDisplayName(string name)
        {
            displayName = name;
        }

        /// <summary>设置角色卡编号（创建角色时按玩家序号写入："1".."4"）。</summary>
        public void SetCharacterId(string id)
        {
            characterId = id;
        }

        /// <summary>角色卡编号（GM 核对「创建玩家 ↔ 角色卡」是否对得上）。</summary>
        public string CharacterId => characterId;

        /// <summary>GM 页面显示的名称：静态显示名（本枢纽）优先，回退对象 ID。</summary>
        public string DisplayName
        {
            get
            {
                if (!string.IsNullOrEmpty(displayName))
                {
                    return displayName;
                }

                return ObjectId;
            }
        }

        /// <summary>GM 页面显示的名称（Player 主体专用）：优先取 PlayerStats.DisplayName（角色卡 displayName，
        /// 与游戏内面板一致），空时回退枢纽静态显示名（Player_N 占位）。
        /// register_map_objects（objects）与 register_players（players）两条上报统一用它，
        /// 保证 GM 属性面板/玩家卡显示的是角色名而不是 Player_N 占位。</summary>
        public string GmDisplayName
        {
            get
            {
                if (ObjectKind == "Player")
                {
                    var stats = GetComponent<PlayerStats>();
                    if (stats != null && !string.IsNullOrEmpty(stats.DisplayName))
                    {
                        return stats.DisplayName;
                    }
                }

                return DisplayName;
            }
        }

        private void OnEnable()
        {
            RefreshCapabilityComponents();
            var registry = Game.Instance != null ? Game.Instance.BackendRegistry : null;
            if (registry != null)
            {
                registry.Register(this);
                registry.RequestReport(); // 显示 → 帧末补报，GM 页面立即出现该物体
            }
        }

        private void OnDisable()
        {
            var registry = Game.Instance != null ? Game.Instance.BackendRegistry : null;
            if (registry != null)
            {
                registry.Unregister(this);
                registry.RequestReport(); // 隐藏 → 帧末补报，GM 页面立即移除该物体
            }
        }

        /// <summary>重新扫描主体上的能力组件并同步缓存（初始化/启用时自动调用；运行时动态 AddComponent 后也可手动调用）。
        /// 能力组件统一继承 <see cref="BackendComponent"/>，扫描即全量。 </summary>
        public void RefreshCapabilityComponents()
        {
            capabilityComponents.Clear();
            foreach (var comp in GetComponents<BackendComponent>())
            {
                if (comp != null)
                {
                    capabilityComponents.Add(comp);
                }
            }
        }

        /// <summary>填充 GM 上报信息的能力数据：遍历能力组件调用 <see cref="IBackendComponentData.AppendToInfo"/>
        /// （组件自己填自己的字段，本处不关心任何具体字段）。</summary>
        public void FillReportData(Server.ServerObjectInfo info)
        {
            foreach (var comp in capabilityComponents)
            {
                if (comp is IBackendComponentData data)
                {
                    data.AppendToInfo(info);
                }
            }
        }

        /// <summary>
        /// 把自身信息追加到上报消息：kind=Player 的主体登记为玩家（玩家实体 = BackendObject + Backpack，
        /// 身份用 ObjectId、名字用 DisplayName）。出生点名单由 GameSceneManager 按 Spawn_* 名字收集。
        /// 通用状态信息已由注册表统一加入 objects（本枢纽聚合各能力组件）。
        /// </summary>
        public void AppendToReport(
            Server.RegisterMapObjectsMessage mapObjects,
            Server.RegisterPlayersMessage players)
        {
            if (ObjectKind == "Player")
            {
                // name/role：显示名与职称优先取 PlayerStats（来自角色卡 displayName/role，与游戏内面板
                // PlayerSwitcherUI 一致）；显示名空时回退枢纽 DisplayName（Player_N 占位）。
                // characterId：角色卡编号。GM 用 ID/名称/职称/角色 核对「创建的玩家 ↔ 角色卡」是否对得上。
                var stats = GetComponent<PlayerStats>();
                players.players.Add(new Server.PlayerInfo
                {
                    id = ObjectId,
                    name = GmDisplayName,
                    role = stats != null ? (stats.Role ?? string.Empty) : string.Empty,
                    characterId = characterId ?? string.Empty
                });
            }
        }

        /// <summary>
        /// 命令路由（通用）：把后台命令转发给能处理它的能力组件——组件实现
        /// <see cref="IBackendCommandHandler"/>，自己解析参数并执行；本处不写任何具体命令逻辑，
        /// 新增命令只需在对应组件实现接口，无需改动主体与分派器。
        /// </summary>
        /// <param name="commandType">后台消息 type（如 "set_option"）。</param>
        /// <param name="msg">后台消息字典（组件自己解析参数）。</param>
        /// <returns>有组件处理并执行成功返回 true；无组件处理返回 false。</returns>
        public bool DispatchCommand(string commandType, Dictionary<string, object> msg)
        {
            if (string.IsNullOrEmpty(commandType) || msg == null)
            {
                return false;
            }

            foreach (var comp in capabilityComponents)
            {
                if (comp == null || !(comp is IBackendCommandHandler handler))
                {
                    continue;
                }

                if (!handler.CanHandle(commandType))
                {
                    continue;
                }

                // 第一个「成功处理」的组件即返回；处理失败（缺参/参数不匹配）时继续尝试下一个可处理组件，
                // 避免同物体多组件（如 IntValue + AttributeList 都认 set_int）时路由被第一个组件短路
                var ok = handler.HandleCommand(msg);
                if (ok)
                {
                    // 命令成功处理后的统一通知（子类钩子 OnCommandHandled；Changed 由组件修改方法自己触发）
                    comp.NotifyCommandHandled(commandType, msg);
                    return true;
                }
            }

            return false;
        }

        /// <summary>向后台发送一条消息（JSON 自动序列化）。</summary>
        public void SendToBackend(object message)
        {
            var connection = Game.Instance != null ? Game.Instance.ServerConnection : null;
            if (connection != null && connection.IsConnected)
            {
                connection.Send(message);
            }
        }

        /// <summary>对象自身位置的归一化坐标（上报给 GM 页面在地图上定位目标）。</summary>
        public Server.Position GetNormalizedPosition()
        {
            return NormalizePosition(transform.position);
        }

        /// <summary>把世界坐标换算为当前场景地图图片的归一化坐标（y 向下，左上角为原点）。</summary>
        public Server.Position NormalizePosition(Vector3 worldPosition)
        {
            var sceneManager = Game.Instance != null ? Game.Instance.GameSceneManager : null;
            if (sceneManager == null)
            {
                return new Server.Position { x = 0.5f, y = 0.5f };
            }

            return sceneManager.GetNormalizedPosition(worldPosition);
        }

        /// <summary>
        /// 位置同步（所有主体通用）：上报自身当前位置（归一化图片坐标）。
        /// 玩家主体（kind=Player）走玩家位置消息（后台 players 名单）；
        /// 普通主体走通用对象位置消息（后台 objects 位置更新）。
        /// </summary>
        public void ReportPosition()
        {
            var position = NormalizePosition(transform.position);
            // 协议字段名保持 mapName（兼容现有服务端），语义为当前场景名
            var mapName = GetCurrentSceneName();

            if (ObjectKind == "Player")
            {
                SendToBackend(new Server.ReportPlayerPositionMessage
                {
                    playerId = ObjectId,
                    position = position,
                    mapName = mapName
                });
            }
            else
            {
                SendToBackend(new Server.ReportObjectPositionMessage
                {
                    objectId = ObjectId,
                    position = position,
                    mapName = mapName
                });
            }
        }

        private string GetCurrentSceneName()
        {
            var sceneManager = Game.Instance != null ? Game.Instance.GameSceneManager : null;
            return sceneManager != null ? sceneManager.CurrentSceneName : null;
        }
    }
}
