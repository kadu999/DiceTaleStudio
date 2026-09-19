using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 遮罩图组件（MaskImage）：只负责持有/更新遮罩纹理，不依赖任何渲染组件。
    /// 场景中代表一张黑色遮罩（临时内存态，不持久化）：
    /// - 运行时创建 GPU <see cref="RenderTexture"/>（maskRT）作为**唯一真源**，通过 <see cref="MaskTexture"/> 直接暴露
    ///   给外部渲染组件采样（如 BoxComposite 的 _MaskTex）。RT 随组件常驻（OnDestroy 才释放），实例身份永不更换，
    ///   外部持有引用始终有效；无 CPU 侧输出纹理与同步读回；
    /// - 上报尺寸（maskWidth/maskHeight）与软边厚度（edgeFeather）给后台（组件自己上报，IBackendComponentData），GM 页面在弹框里用鼠标擦除黑色；
    /// - 擦除结果经 erase_mask 命令（笔画轨迹）同步回来：MaskEraseStamp shader 沿轨迹打点（GPU），
    ///   软边由 softness 控制（与 GM 画布预览同一公式），外部渲染组件直接采样 RT 看到最新结果。
    /// - **变更动作触发**：擦除是连续轨迹（每笔一条 erase_mask），本组件不是值组件（Satisfies 恒 false，
    ///   条件动作走常规评估永不满足）；因此**首次擦除时经 <see cref="ExecuteActionsIgnoringCondition"/> 触发一次
    ///   动作列表**（忽略条件，同点击区域语义），**之后不再触发**（重载场景后组件重建才复位）。
    /// 对象 ID 与显示名称由枢纽统一提供（默认自动生成唯一 ID；显示名在 BackendObject.displayName 配置）。
    /// </summary>
    public class MaskImage : BackendComponent
    {
        /// <summary>组件 ID（与客户端组件类同名，GM 面板据此渲染遮罩编辑区）。</summary>
        public override string ComponentId => "MaskImage";

        [SerializeField, Tooltip("遮罩纹理宽度（像素），GM 页面据此生成编辑画布")]
        private int maskWidth = 960;

        [SerializeField, Tooltip("遮罩纹理高度（像素），GM 页面据此生成编辑画布")]
        private int maskHeight = 540;

        [SerializeField, Range(0f, 1f), Tooltip("擦除笔刷软边带比例（0=硬边，1=全程衰减）：羽化带宽 = 笔刷半径 × 该值（默认 1）")]
        private float edgeFeather = 1f;

        private RenderTexture maskRT;    // 遮罩当前状态/唯一真源（MaskTexture，随组件常驻，身份永不更换）
        private RenderTexture blendRT;   // 擦除 ping-pong 缓冲（不能边读边写同一 RT）
        private Texture2D loadTexture;   // 复用的加载纹理（整图导入用，LoadImage 原地重设尺寸）
        private Material stampMaterial;  // 硬笔刷材质（MaskEraseStamp，沿轨迹打点用）

        /// <summary>首次擦除已触发过动作（只触发一次，之后不再触发）。</summary>
        private bool eraseActionTriggered;

        private static readonly int StampCenterId = Shader.PropertyToID("_StampCenter");
        private static readonly int StampRadiusId = Shader.PropertyToID("_StampRadius");
        private static readonly int StampSoftnessId = Shader.PropertyToID("_StampSoftness");
        private static readonly int MaskSizeId = Shader.PropertyToID("_MaskSize");

        private const string StampShaderName = "DiceTale/MaskEraseStamp";

        /// <summary>遮罩纹理宽度（上报给 GM 页面）。</summary>
        public int MaskWidth => maskWidth;

        /// <summary>遮罩纹理高度（上报给 GM 页面）。</summary>
        public int MaskHeight => maskHeight;

        /// <summary>擦除笔刷软边带比例（0~1，0=硬边，1=全程衰减；上报给 GM，GM 笔刷 softness 与该值一致，羽化带宽 = 笔刷半径 × 该值）。</summary>
        public float EdgeFeather => edgeFeather;

        /// <summary>组件数据上报：遮罩尺寸（GM 属性面板的遮罩编辑区）。</summary>
        public override void AppendToInfo(Server.ServerObjectInfo info)
        {
            AppendData(info, new MaskData { maskWidth = maskWidth, maskHeight = maskHeight, edgeFeather = edgeFeather });
        }

        [System.Serializable]
        private class MaskData
        {
            public int maskWidth;
            public int maskHeight;
            public float edgeFeather;
        }

        /// <summary>当前遮罩纹理（RenderTexture，唯一真源；初始全黑，随组件常驻，外部持有引用始终有效）。由外部渲染组件采样。</summary>
        public RenderTexture MaskTexture => maskRT;

        /// <summary>命令处理：set_mask_image / erase_mask（遮罩命令由本组件自己解析并执行，不再经枢纽转发）。</summary>
        public override bool CanHandle(string commandType) =>
            commandType == "set_mask_image" || commandType == "erase_mask";

        public override bool HandleCommand(Dictionary<string, object> msg)
        {
            switch (Server.JsonParser.GetString(msg, "type"))
            {
                case "set_mask_image":
                    return ApplyMaskImage(Server.JsonParser.GetString(msg, "image"));

                case "erase_mask":
                    return HandleEraseStroke(msg);

                default:
                    return false;
            }
        }

        /// <summary>解析 GM 擦除笔画轨迹（归一化点 + 归一化半径 + 软边比例）并应用。
        /// 单点（单击/笔画尾部）也接受：在点处打一个擦除圆。
        /// **首次擦除时触发一次动作列表（忽略条件），之后不再触发**。</summary>
        private bool HandleEraseStroke(Dictionary<string, object> msg)
        {
            var stroke = Server.JsonParser.GetObject(msg, "stroke");
            if (stroke == null)
            {
                return false;
            }

            var rawPoints = Server.JsonParser.GetArray(stroke, "points");
            if (rawPoints == null || rawPoints.Count < 1)
            {
                return false;
            }

            var points = new List<Vector2>();
            for (int i = 0; i < rawPoints.Count; i++)
            {
                if (rawPoints[i] is Dictionary<string, object> p &&
                    p.ContainsKey("x") && p.ContainsKey("y"))
                {
                    points.Add(new Vector2(
                        Mathf.Clamp01((float)Server.JsonParser.GetNumber(p, "x")),
                        Mathf.Clamp01((float)Server.JsonParser.GetNumber(p, "y"))));
                }
                else
                {
                    Debug.LogWarning($"[MaskImage] {name}: 擦除轨迹第 {i} 个点非法（非对象或缺少 x/y），已跳过");
                }
            }

            var radius = Mathf.Max(0f, (float)Server.JsonParser.GetNumber(stroke, "radius"));
            var softness = Mathf.Max(0f, (float)Server.JsonParser.GetNumber(stroke, "softness"));
            ApplyEraseStroke(points.ToArray(), radius, softness);

            // 只第一次擦除触发一次动作列表（忽略条件；之后不再触发；本组件非值组件，条件动作走
            // 常规评估永不满足，见类注释）
            if (!eraseActionTriggered)
            {
                eraseActionTriggered = true;
                ExecuteActionsIgnoringCondition();
                Debug.Log($"[MaskImage] {name}: 首次擦除，动作列表已触发一次");
            }

            return true;
        }

        protected override void OnEnable()
        {
            base.OnEnable(); // 通知枢纽刷新能力组件列表（基类内置）

            EnsureMaskRT();
            EnsureStampMaterial();
        }

        // 注意：不覆写 OnDisable 释放资源——maskRT 是 MaskTexture 的身份本体，必须跨 disable 常驻；
        // 资源统一在 OnDestroy 释放（见 ReleaseResources）。

        private void OnDestroy()
        {
            ReleaseResources();
        }

        /// <summary>创建 GPU 擦除用 RenderTexture（maskRT = 当前状态/唯一真源，blendRT = ping-pong 缓冲；只创建一次）。
        /// 初始内容清为全黑（新 RT 内容不保证为黑）；RT 随组件常驻，跨 disable 保留擦除状态。</summary>
        private void EnsureMaskRT()
        {
            var width = Mathf.Max(8, maskWidth);
            var height = Mathf.Max(8, maskHeight);

            if (maskRT != null)
            {
                return;
            }

            maskRT = new RenderTexture(width, height, 0, RenderTextureFormat.ARGB32);
            maskRT.name = "MaskRT";
            maskRT.wrapMode = TextureWrapMode.Clamp;
            maskRT.filterMode = FilterMode.Bilinear;
            blendRT = new RenderTexture(width, height, 0, RenderTextureFormat.ARGB32);
            blendRT.name = "MaskBlendRT";
            blendRT.wrapMode = TextureWrapMode.Clamp;
            blendRT.filterMode = FilterMode.Bilinear;

            // 新 RT 内容未定义，显式清一次黑（唯一真源从全黑开始）
            var prev = RenderTexture.active;
            RenderTexture.active = maskRT;
            GL.Clear(true, true, Color.black);
            RenderTexture.active = prev;
        }

        /// <summary>确保复用的加载纹理存在（LoadImage 会按图尺寸原地重设，实例保持一个，减少 GC）。</summary>
        private void EnsureLoadTexture()
        {
            if (loadTexture != null)
            {
                return;
            }

            loadTexture = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            loadTexture.name = "MaskLoadTexture";
            loadTexture.wrapMode = TextureWrapMode.Clamp;
            loadTexture.filterMode = FilterMode.Bilinear;
        }

        /// <summary>确保硬笔刷材质存在（MaskEraseStamp，仅 Blit 用）。</summary>
        private void EnsureStampMaterial()
        {
            if (stampMaterial != null)
            {
                return;
            }

            var shader = Shader.Find(StampShaderName);
            if (shader == null)
            {
                Debug.LogError($"[MaskImage] 找不到 Shader：{StampShaderName}");
                return;
            }

            stampMaterial = new Material(shader);
            stampMaterial.name = "MaskEraseStampMat";
        }

        /// <summary>后台命令入口：整图导入（base64 PNG）——直接替换当前遮罩，无过渡。
        /// 自下而上（UV 0,0 在左下），因此映射到纹理像素时 y 要翻转（1 - y）。
        /// 应用成功时触发基类 <see cref="BackendComponent.Changed"/>。</summary>
        public bool ApplyMaskImage(string base64Png)
        {
            if (string.IsNullOrEmpty(base64Png))
            {
                Debug.LogWarning($"[MaskImage] {name}: 遮罩图数据为空，拒绝应用");
                return false;
            }

            EnsureMaskRT();
            EnsureLoadTexture();

            byte[] raw;
            try
            {
                raw = System.Convert.FromBase64String(base64Png);
            }
            catch (System.FormatException)
            {
                Debug.LogWarning($"[MaskImage] {name}: 遮罩图 base64 解码失败，拒绝应用");
                return false;
            }

            if (!loadTexture.LoadImage(raw))
            {
                Debug.LogWarning($"[MaskImage] Failed to decode mask image: {name}");
                return false;
            }

            if (loadTexture.width > 4096 || loadTexture.height > 4096)
            {
                Debug.LogWarning($"[MaskImage] {name}: 遮罩图尺寸超限（{loadTexture.width}x{loadTexture.height}），拒绝应用");
                return false;
            }

            Graphics.Blit(loadTexture, maskRT);
            NotifyChanged();
            Debug.Log($"[MaskImage] {name}: mask image applied ({loadTexture.width}x{loadTexture.height})");
            return true;
        }

        /// <summary>后台命令入口：应用 GM 擦除的笔画轨迹。
        /// 用 MaskEraseStamp shader 沿线段打擦除圆（幂等 min 擦除——同一位置擦 N 次 = 擦 1 次，渐变带不被叠加抹平；ping-pong 到 maskRT），
        /// 结果直接留在 maskRT（唯一真源）。软边（与 GM 画布预览同一公式）：全擦核半径 core = radius*(1-softness)，
        /// 核内全擦、核外 core ~ radius 线性渐隐——离中心越远擦除越小（softness=0 硬边，1 全程衰减）。
        /// 坐标约定：GM 画布为左上原点、y 向下（归一化 0=顶 1=底）；shader 的 Blit 空间是
        /// 自下而上（UV 0,0 在左下），因此映射到纹理像素时 y 要翻转（1 - y）。
        /// 应用成功时触发基类 <see cref="BackendComponent.Changed"/>。</summary>
        public void ApplyEraseStroke(Vector2[] points, float radius, float softness)
        {
            if (points == null || points.Length < 1)
            {
                return;
            }

            EnsureMaskRT();
            EnsureStampMaterial();
            if (maskRT == null || blendRT == null || stampMaterial == null)
            {
                Debug.LogWarning($"[MaskImage] {name}: 擦除被跳过（RT/材质未就绪，请检查 MaskEraseStamp Shader 是否导入）");
                return;
            }

            var maskSize = new Vector2(maskRT.width, maskRT.height);
            var radiusTex = Mathf.Max(1f, radius * maskRT.width); // 归一化半径 → 纹理像素

            stampMaterial.SetVector(MaskSizeId, maskSize);
            stampMaterial.SetFloat(StampRadiusId, radiusTex);
            stampMaterial.SetFloat(StampSoftnessId, Mathf.Clamp01(softness)); // 软边带比例（0=硬边，1=全程衰减，与 GM 画布预览一致）

            // 单点（单击/笔画尾部）：只打一个擦除圆；多点：沿线段打擦除圆（shader：软边渐隐）。
            // 归一化 y（GM 上→下）翻转为 shader 的自下而上像素坐标，避免擦除轨迹上下镜像。
            if (points.Length == 1)
            {
                var dot = new Vector2(points[0].x * maskRT.width, (1f - points[0].y) * maskRT.height);
                stampMaterial.SetVector(StampCenterId, dot);
                Graphics.Blit(maskRT, blendRT, stampMaterial);
                Graphics.Blit(blendRT, maskRT);
            }
            else
            {
                var step = Mathf.Max(1f, radiusTex * 0.5f);
                for (int i = 0; i < points.Length - 1; i++)
                {
                    var from = new Vector2(points[i].x * maskRT.width, (1f - points[i].y) * maskRT.height);
                    var to = new Vector2(points[i + 1].x * maskRT.width, (1f - points[i + 1].y) * maskRT.height);
                    var distance = (to - from).magnitude;
                    var samples = Mathf.Max(1, Mathf.CeilToInt(distance / step));
                    for (int s = 0; s <= samples; s++)
                    {
                        var center = Vector2.Lerp(from, to, s / (float)samples);

                        // 幂等擦除打点（min）：ping-pong（读 maskRT 写 blendRT，再拷回 maskRT）
                        stampMaterial.SetVector(StampCenterId, center);
                        Graphics.Blit(maskRT, blendRT, stampMaterial);
                        Graphics.Blit(blendRT, maskRT);
                    }
                }
            }

            NotifyChanged();
            Debug.Log($"[MaskImage] {name}: erase stroke ({points.Length} points, r={radiusTex}, soft={softness})");
        }

        /// <summary>释放资源（仅组件 OnDestroy 时调用）：maskRT/blendRT 是 MaskTexture 身份本体，跨 disable 常驻。</summary>
        private void ReleaseResources()
        {
            if (loadTexture != null)
            {
                Destroy(loadTexture);
                loadTexture = null;
            }

            if (maskRT != null)
            {
                maskRT.Release();
                Destroy(maskRT);
                maskRT = null;
            }

            if (blendRT != null)
            {
                blendRT.Release();
                Destroy(blendRT);
                blendRT = null;
            }

            if (stampMaterial != null)
            {
                Destroy(stampMaterial);
                stampMaterial = null;
            }
        }
    }
}