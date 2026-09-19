using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 后台对象注册表：收集场景中所有 <see cref="BackendObject"/>，
    /// 在后台连接建立/地图变化时统一组装并上报（物体、出生点、玩家名单）。
    /// 管理器由 <see cref="Game"/> 初始化并持有（Game.Awake 挂到宿主物体），不再使用单例。
    /// </summary>
    public class BackendRegistry : MonoBehaviour
    {
        private readonly List<BackendObject> objects = new List<BackendObject>();

        /// <summary>补报排队标记：物体显示/隐藏（注册/注销）变化时置位，帧末合并补报一次，
        /// 让 GM 页面及时反映物体可见性（避免隐藏后 GM 还显示旧条目，直到切场景/重连）。</summary>
        private bool reportPending;

        /// <summary>排队一次补报（帧末合并）。同一帧内多次变化（如场景加载时大量 Instantiate）只补报一次。</summary>
        public void RequestReport()
        {
            reportPending = true;
        }

        private void LateUpdate()
        {
            if (!reportPending)
            {
                return;
            }

            reportPending = false;
            ReportAll();
        }

        public void Register(BackendObject obj)
        {
            if (obj != null && !objects.Contains(obj))
            {
                objects.Add(obj);
            }
        }

        public void Unregister(BackendObject obj)
        {
            objects.Remove(obj);
        }

        /// <summary>
        /// 统一向后台上报所有已注册对象：
        /// 物体/出生点 → register_map_objects，玩家 → register_players。
        /// </summary>
        public void ReportAll()
        {
            reportPending = false; // 显式全量上报满足排队中的补报请求，避免帧末重复补报
            var connection = Game.Instance != null ? Game.Instance.ServerConnection : null;
            if (connection == null || !connection.IsConnected)
            {
                return;
            }

            var sceneManager = Game.Instance != null ? Game.Instance.GameSceneManager : null;
            // 协议字段仍叫 mapName（兼容现有服务端），语义为当前场景名
            var mapName = sceneManager != null ? sceneManager.CurrentSceneName : null;
            var mapMsg = new Server.RegisterMapObjectsMessage
            {
                mapName = mapName
            };
            var playerMsg = new Server.RegisterPlayersMessage();

            foreach (var obj in objects)
            {
                if (obj == null)
                {
                    continue;
                }

                // 只上报当前世界的物体：切场景时旧场景物体在帧末才销毁（Destroy 延迟），
                // 残留物体会把旧场景的对象混进上报，造成后台跨场景串图
                if (sceneManager != null && sceneManager.IsFromOtherScene(obj.transform))
                {
                    continue;
                }

                obj.AppendToReport(mapMsg, playerMsg);

                // 通用对象状态信息：枢纽只填身份/位置；组件数据由各能力组件自己填充
                // （FillReportData → AppendData：组件类型 + JSON 字符串数据段）。
                // 名字用 GmDisplayName：Player 主体显示角色卡名（与 register_players 口径一致），
                // 普通主体回退静态显示名 —— GM 属性面板头部读的就是这条 objects 的 name。
                var info = new Server.ServerObjectInfo
                {
                    id = obj.ObjectId,
                    name = obj.GmDisplayName,
                    kind = obj.ObjectKind,
                    mapName = mapName,
                    position = obj.GetNormalizedPosition()
                };

                obj.FillReportData(info);

                mapMsg.objects.Add(info);
            }

            // 出生点名单：由 GameSceneManager 按名字（Spawn_* 物体）收集登记
            sceneManager?.FillSpawnPoints(mapMsg);

            // 场景状态列表：由 GameSceneManager 从当前场景脚本收集（GM 页地图下方显示）
            sceneManager?.FillSceneStates(mapMsg);

            if (!string.IsNullOrEmpty(mapMsg.mapName))
            {
                connection.Send(mapMsg);
            }

            // 玩家名单总是发送（即使为空）：后端按整体替换语义维护，玩家清空时也要把旧名单清掉，
            // 否则只增不减会把已移除的玩家残留在地图/GM 页面上
            connection.Send(playerMsg);

            // 输入配置同步（GM 页回显指挥 Id；0=不覆盖）：与对象/玩家名单同批次上报。
            // 值与当前源类型无关：上报 GM 最近的设置（PlayerPrefs 持久化）——v2 活跃时与实例一致，
            // 非 v2 时上报"已预定"值，保证 GM 页刷新/全量上报不回跳（配合服务端断开不清快照）
            int commandId = (int)InputConfigPrefs.LoadCommandId();
            connection.Send(new Server.ReportInputConfigMessage
            {
                key = "first_contact_id",
                value = commandId,
            });

            // 统一补报玩家位置：必须在 register_players（上面已发送）之后——
            // 后端对「未知玩家」的位置上报只记日志不落状态，若位置早于注册到达会被丢弃，
            // players 名单里的位置就会停留在默认 (0.5,0.5)，GM 玩家标记全部叠在地图中间。
            var characterManager = Game.Instance != null ? Game.Instance.CharacterManager : null;
            if (characterManager != null)
            {
                foreach (var player in characterManager.Players)
                {
                    if (player != null)
                    {
                        player.ReportPosition();
                    }
                }
            }
        }
    }
}
