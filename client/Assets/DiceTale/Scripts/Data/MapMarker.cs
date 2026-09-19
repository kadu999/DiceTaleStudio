using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 地图位置标记：挂在场景里标记一个位置（传送落点、事件点等）。
    /// 用 <see cref="Id"/> 在运行时查找（同一地图内唯一）。
    /// </summary>
    /// <remarks>
    /// 旧模型里由传送动作（`TeleportAction` / `TeleportZoneAction`，已删除）按
    /// targetMapName + targetMarkerId 定位；新方向下「传到哪个标记」由后端下发的命令决定。
    /// </remarks>
    public class MapMarker : MonoBehaviour
    {
        [SerializeField, Tooltip("标记 ID（同一地图内唯一，供传送目标查找）")]
        private string id;

        public string Id => id;

        /// <summary>标记所在的世界位置。</summary>
        public Vector3 Position => transform.position;

        private void OnDrawGizmos()
        {
            // 场景视图里可视化标记位置（青色圆环）
            Gizmos.color = new Color(0f, 0.9f, 1f, 0.8f);
            Gizmos.DrawWireSphere(transform.position, 0.3f);
        }
    }
}
