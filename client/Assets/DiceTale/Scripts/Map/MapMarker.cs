using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 地图位置标记：挂在地图上标记一个位置（传送目标、事件点等）。
    /// 用 <see cref="Id"/> 在运行时查找（同一地图内唯一），
    /// 传送动作（<see cref="TeleportAction"/> / <see cref="TeleportZoneAction"/>）
    /// 通过 targetMapName + targetMarkerId 定位目标位置。
    /// </summary>
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
