using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 遮罩显示：把 <see cref="MaskImage"/> 的遮罩纹理推送到输出渲染器材质的遮罩槽（默认 _MaskTex，如 BoxComposite）。
    /// 只推送纹理，不创建/替换材质——材质（如 DiceTale/BoxComposite）由使用方自行配置在 outputRenderer 上。
    /// 遮罩初始为黑色，GM 在后台弹框擦除后纹理原地更新（LoadImage 保持实例不变），本组件自动跟随。
    /// 用法：挂到任意物体，Inspector 指定 mask 与输出 renderer（缺省取本物体上的 MaskImage / Renderer）。
    /// </summary>
    public class MaskObjectDisplay : MonoBehaviour
    {
        [Header("数据源")]
        [Tooltip("遮罩图组件（提供 MaskTexture）；为空时取本物体上的 MaskImage")]
        [SerializeField]
        private MaskImage mask;

        [Header("输出")]
        [Tooltip("输出渲染器（其材质需含遮罩纹理槽，如 BoxComposite 的 _MaskTex）；为空时取本物体上的 Renderer")]
        [SerializeField]
        private Renderer outputRenderer;

        [Tooltip("遮罩纹理写入的材质属性名（BoxComposite 为 _StaticTex）")]
        [SerializeField]
        private string maskPropertyName = "_MaskTex";

        protected virtual void Awake()
        {
            if (mask == null)
            {
                mask = GetComponent<MaskImage>();
            }

            if (outputRenderer == null)
            {
                outputRenderer = GetComponent<Renderer>();
            }

            PushTexture(); // 首帧立即推送
        }

        protected virtual void Update()
        {
            if (outputRenderer != null && mask != null && mask.MaskTexture != null)
            {
                PushTexture();
            }
        }

        /// <summary>把遮罩纹理写入输出材质的遮罩槽（值变化时才写）。</summary>
        private void PushTexture()
        {
            if (outputRenderer == null || mask == null || mask.MaskTexture == null)
            {
                return;
            }

            var mat = outputRenderer.material;
            if (mat == null || !mat.HasProperty(maskPropertyName))
            {
                return; // 材质没有该槽（如未配 BoxComposite）时静默跳过，不影响其他逻辑
            }

            // 每帧都写入：防止同材质上的其他效果（BoxMaskEffect/WipeMaskEffect）把 _MaskTex 覆盖掉
            mat.SetTexture(maskPropertyName, mask.MaskTexture);
        }
    }
}
