using System.Collections;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 拍照点击发光：拍照指针（<see cref="PointerId.Photo"/>，压板 v2 由 CommandId 控制）在地面按下时，
    /// 在**点击位置**点亮一盏点光并持续 <see cref="duration"/> 秒后自动熄灭；连续点击会移到新位置重新计时。
    /// 发光体运行时自建（参考预设 Scene002/Photograps/Photograph02 的 Point Light：白/强度 300/范围 20），
    /// 不依赖场景预制体，任何地图生效。挂在 Game 宿主上，与其他管理器同生命周期。
    /// </summary>
    public class PhotoClickGlow : MonoBehaviour
    {
        [SerializeField, Tooltip("发光时长（秒），到点自动熄灭")]
        private float duration = 0.5f;

        [SerializeField, Tooltip("点光颜色")]
        private Color lightColor = Color.white;

        [SerializeField, Tooltip("点光强度（URP 物理单位，对齐 Photograph02 预设）")]
        private float lightIntensity = 300f;

        [SerializeField, Tooltip("点光范围")]
        private float lightRange = 20f;

        [SerializeField, Tooltip("点光离地高度（对齐 Photograph02 预设 2.14）")]
        private float lightHeight = 2.1f;

        private GameObject glow;
        private Coroutine flashRoutine;

        private void Awake()
        {
            glow = new GameObject("PhotoClickGlow");
            glow.transform.SetParent(transform, false);

            var light = glow.AddComponent<Light>();
            light.type = LightType.Point;
            light.color = lightColor;
            light.intensity = lightIntensity;
            light.range = lightRange;
            light.shadows = LightShadows.None;

            glow.SetActive(false);
        }

        /// <summary>在 worldPosition（网格平面）处点亮发光，duration 秒后自动熄灭。</summary>
        public void ShowAt(Vector3 worldPosition)
        {
            if (glow == null)
            {
                return;
            }

            glow.transform.position = worldPosition + Vector3.up * lightHeight;
            if (flashRoutine != null)
            {
                StopCoroutine(flashRoutine);
            }

            flashRoutine = StartCoroutine(Flash());
        }

        private IEnumerator Flash()
        {
            glow.SetActive(true);
            yield return new WaitForSeconds(duration);
            glow.SetActive(false);
            flashRoutine = null;
        }
    }
}
