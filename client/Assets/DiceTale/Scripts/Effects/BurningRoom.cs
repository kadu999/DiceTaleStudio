using System.Collections;
using System.Collections.Generic;
using UnityEngine;
#if UNITY_EDITOR
using UnityEditor;
#endif

namespace DiceTale
{
    /// <summary>
    /// 房间燃烧效果（垂直俯视 2D），纯参数驱动，不依赖 SpriteRenderer。
    ///
    /// 用法：把组件挂到房间中心（空物体即可），填好房间参数：
    ///   roomWidth / roomHeight：房间内宽内高（世界单位）；
    ///   wallThickness：墙的厚度（火焰条带深度、烧痕基础深度）。
    /// 激活该 GameObject（或调用 <see cref="Play"/>）即自动播放：
    ///   - 四面墙起火（单面 Quad 中间镂空，火舌从墙线向房间内舔，转角圆滑无接缝）；
    ///   - 地面燃烧（单平面单 shader：alpha 混合，焦痕变暗 + 烧焦边缘火光变亮）；
    ///   - 墙边火星 / 地面火星 / 烟雾粒子。
    ///
    /// 全部特效在运行时按参数自动生成，无需手工摆放；
    /// 停用/销毁物体时特效随之消失（切图自动清理）。
    /// 需要 DiceTale/FlameStrip、DiceTale/ScorchFloor、DiceTale/SoftParticle 三个 shader。
    /// 注意：打包后若 Shader.Find 失效，把这三个 shader 加入
    /// Project Settings > Graphics > Always Included Shaders。
    /// </summary>
    [DisallowMultipleComponent]
    public class BurningRoom : MonoBehaviour
    {
        [Header("房间参数（世界单位）")]
        [Tooltip("房间宽度（左右墙线之间的内宽）")]
        [SerializeField] private float roomWidth = 3f;
        [Tooltip("房间高度（上下墙线之间的内高）")]
        [SerializeField] private float roomHeight = 3f;
        [Tooltip("墙的厚度：火焰条带深度（火苗从墙线窜进房间的距离）")]
        [SerializeField] private float wallThickness = 0.45f;

        [Header("播放节奏")]
        [Tooltip("激活即播放")]
        [SerializeField] private bool playOnEnable = true;
        [Tooltip("燃烧总时长（秒）：墙火常亮、地面烧焦从透明直接扩散到全盛，无点燃阶段")]
        [SerializeField] private float burnDuration = 60f;

        [Header("火焰（四面墙）")]
        [SerializeField] private Color flameOuter = new Color(1f, 0.35f, 0.06f, 1f);
        [SerializeField] private Color flameCore = new Color(1f, 0.85f, 0.4f, 1f);
        [SerializeField] private float flameIntensity = 1.6f;
        [Tooltip("墙线渐隐：靠近墙线处火焰的透明过渡（占墙带的比例，越大渐隐越宽，墙线越柔和）")]
        [SerializeField] private float wallEdgeFade = 0.25f;
        [Tooltip("边缘留白：火焰带从墙线内缩的距离（占墙厚的比例，给房间边缘留空间）")]
        [SerializeField] private float wallEdgeMargin = 0.15f;
        [Tooltip("转角圆角半径：墙带角部的圆弧半径（×墙厚；1=一个墙厚，越大转角越圆）")]
        [SerializeField] private float cornerRadius = 1.5f;

        [Header("地面烧痕")]
        [Tooltip("烧焦后的颜色（近黑）")]
        [SerializeField] private Color scorchColor = new Color(0.03f, 0.02f, 0.02f, 1f);
        [Tooltip("火焰 HDR 颜色（黄橘，RGB 可超 1）")]
        [SerializeField] private Color emberColor = new Color(1.5f, 0.6f, 0.08f, 1f);
        [Tooltip("火焰高亮强度")]
        [SerializeField] private float emberStrength = 1.6f;
        [Tooltip("灰烬过渡色（火焰与原始地板之间的灰色带）")]
        [SerializeField] private Color grayColor = new Color(0.42f, 0.4f, 0.37f, 1f);
        [Tooltip("燃烧扩散量：h = 波纹图 + 扩散量×时间，越大全盛时烧得越满")]
        [SerializeField] private float burnSpread = 0.9f;

        [Header("粒子")]
        [Tooltip("墙边火星每秒数量（单个空心框发射器沿四面墙发射）")]
        [SerializeField] private float embersPerSecond = 70f;
        [Tooltip("地面火星每秒数量（覆盖整个房间的发射器，从烧焦地面迸出）")]
        [SerializeField] private float floorSparksPerSecond = 40f;
        [Tooltip("烟粒子每秒数量（单个空心框发射器沿四面墙发射，默认较少避免黑烟堆积）")]
        [SerializeField] private float smokePerSecond = 8f;

        /// <summary>房间宽度（编辑器脚本可设置）。</summary>
        public float RoomWidth
        {
            get => roomWidth;
            set => roomWidth = value;
        }

        /// <summary>房间高度（编辑器脚本可设置）。</summary>
        public float RoomHeight
        {
            get => roomHeight;
            set => roomHeight = value;
        }

        private const string FlameShaderName = "DiceTale/FlameStrip";
        private const string ScorchShaderName = "DiceTale/ScorchFloor";
        private const string ParticleShaderName = "DiceTale/SoftParticle";

        private float halfWidth;
        private float halfHeight;
        private bool built;
        private Coroutine routine;

        private readonly List<Material> stripMaterials = new List<Material>();
        private readonly List<Material> ownedMaterials = new List<Material>();
        private readonly List<ParticleSystem> emberSystems = new List<ParticleSystem>();
        private readonly List<ParticleSystem> smokeSystems = new List<ParticleSystem>();
        private Material scorchMat;
        private static Texture2D sharedSoftCircle;
        private static Texture2D sharedCharTex;

        private void OnEnable()
        {
            if (playOnEnable)
            {
                Play();
            }
        }

        private void OnDisable()
        {
            // 协程会被 Unity 自动停止；这里把特效状态复位
            if (routine != null)
            {
                routine = null;
            }

            SetState(0f, 0f);
            SetEmissions(false, false);
        }

        private void OnDestroy()
        {
            foreach (var mat in ownedMaterials)
            {
                if (mat != null)
                {
                    Destroy(mat);
                }
            }

            ownedMaterials.Clear();
        }

        // ---------------------------------------------------------------- 公开接口

        /// <summary>开始播放燃烧效果（激活 GameObject 也会自动调用）。</summary>
        [ContextMenu("Play 播放燃烧效果")]
        public void Play()
        {
            if (!isActiveAndEnabled)
            {
                Debug.LogWarning("[BurningRoom] 物体未激活，无法播放；请先激活 GameObject。", this);
                return;
            }

            EnsureBuilt();
            if (!built)
            {
                return;
            }

            if (routine != null)
            {
                StopCoroutine(routine);
            }

            routine = StartCoroutine(BurnTimeline());
        }

        /// <summary>停止并复位（火焰熄灭、烧痕清空）。</summary>
        [ContextMenu("Stop 停止/复位")]
        public void StopBurning()
        {
            if (routine != null && isActiveAndEnabled)
            {
                StopCoroutine(routine);
            }

            routine = null;
            SetState(0f, 0f);
            SetEmissions(false, false);
        }

        // ---------------------------------------------------------------- 编辑器范围可视化

        private void OnDrawGizmos()
        {
            DrawBurningRange(false);
        }

        private void OnDrawGizmosSelected()
        {
            DrawBurningRange(true);
        }

        /// <summary>
        /// 在 Scene 视图画出组件描述的范围：
        /// 黄色线框 = 房间范围（墙线）；橙色半透明块 = 四面墙的火焰条带范围；
        /// 黑色线框 = 烧痕最大蔓延范围；选中时附带尺寸文字。
        /// </summary>
        private void DrawBurningRange(bool selected)
        {
            if (roomWidth <= 0f || roomHeight <= 0f || wallThickness <= 0f)
            {
                return;
            }

            float halfW = roomWidth * 0.5f;
            float halfH = roomHeight * 0.5f;
            float wt = wallThickness;

            // 用"位置+旋转（不含缩放）"的矩阵：roomWidth 等是世界单位，
            // 物体带缩放（如 0.6）时 gizmo 也按世界尺寸画，与特效/房间一致
            Gizmos.matrix = Matrix4x4.TRS(transform.position, transform.rotation, Vector3.one);

            // 房间范围（墙线）
            Gizmos.color = selected
                ? new Color(1f, 0.85f, 0.3f, 1f)
                : new Color(1f, 0.85f, 0.3f, 0.35f);
            Gizmos.DrawWireCube(Vector3.zero, new Vector3(roomWidth, roomHeight, 0.01f));

            // 四面墙的火焰范围（单面 Quad 的墙边带，全部在房间内侧、从墙线内缩留白，与运行时一致）
            Gizmos.color = selected
                ? new Color(1f, 0.4f, 0.1f, 0.5f)
                : new Color(1f, 0.4f, 0.1f, 0.2f);
            float edgeM = wallEdgeMargin * wt;
            DrawLocalBand(new Vector2(0f, halfH - edgeM - wt * 0.5f), new Vector2(roomWidth, wt));   // 上墙（火舌向房间内）
            DrawLocalBand(new Vector2(0f, -halfH + edgeM + wt * 0.5f), new Vector2(roomWidth, wt));  // 下墙
            DrawLocalBand(new Vector2(-halfW + edgeM + wt * 0.5f, 0f), new Vector2(wt, roomHeight)); // 左墙
            DrawLocalBand(new Vector2(halfW - edgeM - wt * 0.5f, 0f), new Vector2(wt, roomHeight));  // 右墙

            // 烧焦范围（固定在全盛位置：房间短边一半，无蔓延动画）
            float scorch = Mathf.Min(halfW, halfH) * 0.98f;
            var scorchSize = new Vector3(roomWidth - scorch * 2f, roomHeight - scorch * 2f, 0.01f);
            if (scorchSize.x > 0.01f && scorchSize.y > 0.01f)
            {
                Gizmos.color = selected
                    ? new Color(0.15f, 0.15f, 0.15f, 0.9f)
                    : new Color(0.15f, 0.15f, 0.15f, 0.45f);
                Gizmos.DrawWireCube(Vector3.zero, scorchSize);
            }

            // 中心标记
            Gizmos.color = selected ? new Color(1f, 0.3f, 0.3f, 1f) : new Color(1f, 0.3f, 0.3f, 0.4f);
            const float cross = 0.08f;
            Gizmos.DrawLine(new Vector3(-cross, 0f, 0f), new Vector3(cross, 0f, 0f));
            Gizmos.DrawLine(new Vector3(0f, -cross, 0f), new Vector3(0f, cross, 0f));

            Gizmos.matrix = Matrix4x4.identity;

            if (selected)
            {
#if UNITY_EDITOR
                var labelPos = transform.TransformPoint(new Vector3(halfW, halfH + 0.4f, 0f));
                Handles.Label(labelPos, $"房间 {roomWidth:F2} x {roomHeight:F2}   墙厚 {wt:F2}   烧痕 {scorch:F2}");
#endif
            }
        }

        /// <summary>在局部空间画一个轴对齐条带（与运行时火焰条带位置/尺寸一致）。</summary>
        private void DrawLocalBand(Vector2 center, Vector2 size)
        {
            Gizmos.DrawCube(center, new Vector3(size.x, size.y, 0.01f));
        }

        // ---------------------------------------------------------------- 构建

        private void EnsureBuilt()
        {
            if (built)
            {
                return;
            }

            if (roomWidth <= 0f || roomHeight <= 0f || wallThickness <= 0f)
            {
                Debug.LogError("[BurningRoom] 房间参数无效：roomWidth / roomHeight / wallThickness 必须大于 0。", this);
                enabled = false;
                return;
            }

            halfWidth = roomWidth * 0.5f;
            halfHeight = roomHeight * 0.5f;

            // 特效根节点挂在组件所在物体（视为房间中心）；
            // 抵消父级缩放：roomWidth/roomHeight 是世界单位，特效在任意物体缩放下都保持世界尺寸
            // （否则物体带缩放（如测试房间 0.6）时尺寸会被乘两遍）
            var rootGo = new GameObject("BurningFx");
            rootGo.transform.SetParent(transform, false);
            rootGo.transform.localPosition = Vector3.zero;
            var lossy = transform.lossyScale;
            rootGo.transform.localScale = new Vector3(
                lossy.x != 0f ? 1f / lossy.x : 1f,
                lossy.y != 0f ? 1f / lossy.y : 1f,
                1f);
            var fxRoot = rootGo.transform;

            BuildFlameStrips(fxRoot);
            BuildScorch(fxRoot);
            BuildParticles(fxRoot);

            SetState(0f, 0f);
            SetEmissions(false, false);
            built = true;
        }

        private void BuildFlameStrips(Transform fxRoot)
        {
            var shader = Shader.Find(FlameShaderName);
            if (shader == null)
            {
                Debug.LogError("[BurningRoom] 找不到 shader: " + FlameShaderName, this);
                return;
            }

            // 单面墙火：一块房间大小的 Quad，shader 按 UV 只在四条墙边内画火焰（中间镂空）。
            // 四条边属于同一块面，墙角天然连续，不会凸出/接缝。
            var mat = new Material(shader);
            mat.SetColor("_ColorA", flameOuter);
            mat.SetColor("_ColorB", flameCore);
            mat.SetFloat("_Intensity", flameIntensity);
            mat.SetFloat("_Height", 0.9f);
            mat.SetFloat("_WallFade", wallEdgeFade);
            mat.SetFloat("_EdgeMargin", wallEdgeMargin);
            mat.SetFloat("_CornerRadius", cornerRadius);
            mat.SetFloat("_Speed", 1f);
            mat.SetFloat("_Seed", 0.53f);
            mat.SetVector("_RoomSize", new Vector4(roomWidth, roomHeight, 0f, 0f));
            mat.SetFloat("_WallThickness", wallThickness);
            mat.SetFloat("_Spread", 0f);
            ownedMaterials.Add(mat);
            stripMaterials.Add(mat);

            var go = new GameObject("WallFire");
            go.transform.SetParent(fxRoot, false);
            go.transform.localScale = new Vector3(roomWidth, roomHeight, 1f);

            var mf = go.AddComponent<MeshFilter>();
            mf.mesh = Resources.GetBuiltinResource<Mesh>("Quad.fbx");

            var mr = go.AddComponent<MeshRenderer>();
            mr.material = mat;
            mr.sortingOrder = 4; // 加色层，在乘法烧焦(3)之上
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            mr.receiveShadows = false;
        }

        private void BuildScorch(Transform fxRoot)
        {
            // 地面单材质单 shader：alpha 混合，焦痕变暗 + 烧焦边缘火光变亮
            var scorchShader = Shader.Find(ScorchShaderName);
            if (scorchShader == null)
            {
                Debug.LogError("[BurningRoom] 找不到 shader: " + ScorchShaderName, this);
                return;
            }

            scorchMat = new Material(scorchShader);
            scorchMat.SetColor("_BlackColor", scorchColor);
            scorchMat.SetColor("_FlameColor", emberColor);
            scorchMat.SetColor("_GrayColor", grayColor);
            scorchMat.SetFloat("_FlameIntensity", emberStrength);
            scorchMat.SetFloat("_BurnLevel", 0f);
            scorchMat.SetFloat("_Spread", burnSpread);
            // 波纹图：Clamp 环绕铺满房间一次（无平铺接缝）
            var rippleTex = GetCharTexture();
            if (rippleTex != null)
            {
                rippleTex.wrapMode = TextureWrapMode.Clamp;
                scorchMat.SetTexture("_CharTex", rippleTex);
            }

            ownedMaterials.Add(scorchMat);

            CreateFloorQuad(fxRoot, "Ground", scorchMat, 3);
        }

        private void CreateFloorQuad(Transform fxRoot, string name, Material mat, int sortingOrder)
        {
            var go = new GameObject(name);
            go.transform.SetParent(fxRoot, false);
            go.transform.localScale = new Vector3(roomWidth, roomHeight, 1f);

            var mf = go.AddComponent<MeshFilter>();
            mf.mesh = Resources.GetBuiltinResource<Mesh>("Quad.fbx");

            var mr = go.AddComponent<MeshRenderer>();
            mr.material = mat;
            mr.sortingOrder = sortingOrder; // 盖在迷雾(2)之上
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            mr.receiveShadows = false;
        }

        private void BuildParticles(Transform fxRoot)
        {
            var shader = Shader.Find(ParticleShaderName);
            if (shader == null)
            {
                Debug.LogError("[BurningRoom] 找不到 shader: " + ParticleShaderName, this);
                return;
            }

            var emberParticleMat = new Material(shader);
            emberParticleMat.SetTexture("_MainTex", GetSoftCircleTexture());
            emberParticleMat.SetFloat("_SrcBlend", 5f);  // SrcAlpha
            emberParticleMat.SetFloat("_DstBlend", 1f);  // One（预乘加色：柔圆衰减生效，火星是亮的发光点）
            emberParticleMat.SetColor("_Color", Color.white);
            ownedMaterials.Add(emberParticleMat);

            var smokeMat = new Material(shader);
            smokeMat.SetTexture("_MainTex", GetSoftCircleTexture());
            smokeMat.SetFloat("_SrcBlend", 5f);  // SrcAlpha
            smokeMat.SetFloat("_DstBlend", 10f); // OneMinusSrcAlpha（透明）
            smokeMat.SetColor("_Color", new Color(0.12f, 0.10f, 0.09f, 1f));
            ownedMaterials.Add(smokeMat);

            // 单个火星发射器：Box 形状 + boxThickness 空心框，只沿四面墙发射；
            // 框尺寸 = 房间 + 半个墙厚：发射带骑在墙线上，火星只超墙 1/4 墙厚（左右不再外飘太多）
            var emberPs = CreateFrameEmitter(fxRoot, "Embers",
                new Vector2(roomWidth + wallThickness * 0.5f, roomHeight + wallThickness * 0.5f),
                wallThickness, emberParticleMat, 5, embersPerSecond);
            ConfigureEmbers(emberPs);
            emberSystems.Add(emberPs);

            // 地面火星：Rectangle 形状铺满房间，火星从烧焦地面各处迸出
            var floorPs = CreateAreaEmitter(fxRoot, "FloorSparks",
                new Vector2(roomWidth, roomHeight), emberParticleMat, 5, floorSparksPerSecond);
            ConfigureFloorSparks(floorPs);
            emberSystems.Add(floorPs);

            // 单个烟雾发射器：同样用空心框沿四面墙出烟（与火星一致，一个对象即可）
            var smokePs = CreateFrameEmitter(fxRoot, "Smoke",
                new Vector2(roomWidth + wallThickness * 0.5f, roomHeight + wallThickness * 0.5f),
                wallThickness, smokeMat, 5, smokePerSecond);
            ConfigureSmoke(smokePs);
            smokeSystems.Add(smokePs);
        }

        /// <summary>创建空心框发射器：粒子只沿矩形边缘（四面墙）发射。</summary>
        private static ParticleSystem CreateFrameEmitter(Transform parent, string name, Vector2 size,
            float thickness, Material mat, int sortingOrder, float rate)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);

            var ps = go.AddComponent<ParticleSystem>();
            var main = ps.main;
            main.playOnAwake = false;
            main.loop = true;
            main.simulationSpace = ParticleSystemSimulationSpace.Local;

            var shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Box;
            shape.scale = new Vector3(size.x, size.y, 0.05f);
            shape.boxThickness = new Vector3(thickness, thickness, 0f); // 空心框：沿边缘发射

            var emission = ps.emission;
            emission.enabled = false; // 由时间线控制
            emission.rateOverTime = rate;

            var pr = go.GetComponent<ParticleSystemRenderer>();
            pr.material = mat;
            pr.sortingOrder = sortingOrder;
            pr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            pr.receiveShadows = false;

            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            return ps;
        }

        /// <summary>创建矩形区域发射器：粒子在矩形面积内随机产生（地面火星用）。</summary>
        private static ParticleSystem CreateAreaEmitter(Transform parent, string name, Vector2 size,
            Material mat, int sortingOrder, float rate)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);

            var ps = go.AddComponent<ParticleSystem>();
            var main = ps.main;
            main.playOnAwake = false;
            main.loop = true;
            main.simulationSpace = ParticleSystemSimulationSpace.Local;

            var shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Rectangle;
            shape.scale = new Vector3(size.x, size.y, 0.05f);

            var emission = ps.emission;
            emission.enabled = false; // 由时间线控制
            emission.rateOverTime = rate;

            var pr = go.GetComponent<ParticleSystemRenderer>();
            pr.material = mat;
            pr.sortingOrder = sortingOrder;
            pr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            pr.receiveShadows = false;

            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            return ps;
        }

        private static void ConfigureFloorSparks(ParticleSystem ps)
        {
            var main = ps.main;
            main.startColor = Color.white;
            main.startSize = new ParticleSystem.MinMaxCurve(0.03f, 0.08f);
            main.startLifetime = new ParticleSystem.MinMaxCurve(0.3f, 0.7f);
            main.startSpeed = new ParticleSystem.MinMaxCurve(0.3f, 0.8f); // 从地面迸出
            main.gravityModifier = -0.25f; // 向上

            var vel = ps.velocityOverLifetime;
            vel.enabled = true;
            vel.space = ParticleSystemSimulationSpace.World;
            vel.y = new ParticleSystem.MinMaxCurve(0.3f);

            var col = ps.colorOverLifetime;
            col.enabled = true;
            var grad = new Gradient();
            grad.SetKeys(
                new[]
                {
                    new GradientColorKey(Color.white, 0f),
                    new GradientColorKey(new Color(1f, 0.5f, 0.1f, 1f), 0.5f),
                    new GradientColorKey(new Color(0.4f, 0.05f, 0f, 1f), 1f),
                },
                new[]
                {
                    new GradientAlphaKey(1f, 0f),
                    new GradientAlphaKey(0.8f, 0.4f),
                    new GradientAlphaKey(0f, 1f),
                });
            col.color = new ParticleSystem.MinMaxGradient(grad);
        }

        private static void ConfigureEmbers(ParticleSystem ps)
        {
            var main = ps.main;
            main.startColor = Color.white;
            main.startSize = new ParticleSystem.MinMaxCurve(0.04f, 0.1f);
            main.startLifetime = new ParticleSystem.MinMaxCurve(0.4f, 0.9f);
            main.startSpeed = new ParticleSystem.MinMaxCurve(0.05f, 0.15f);
            main.gravityModifier = -0.1f; // 轻微上浮（不会飘出房间太多）

            var vel = ps.velocityOverLifetime;
            vel.enabled = true;
            vel.space = ParticleSystemSimulationSpace.World;
            vel.y = new ParticleSystem.MinMaxCurve(0.12f);

            var col = ps.colorOverLifetime;
            col.enabled = true;
            var grad = new Gradient();
            grad.SetKeys(
                new[]
                {
                    new GradientColorKey(Color.white, 0f),
                    new GradientColorKey(new Color(1f, 0.5f, 0.1f, 1f), 0.55f),
                    new GradientColorKey(new Color(0.4f, 0.05f, 0f, 1f), 1f),
                },
                new[]
                {
                    new GradientAlphaKey(1f, 0f),
                    new GradientAlphaKey(0.7f, 0.55f),
                    new GradientAlphaKey(0f, 1f),
                });
            col.color = new ParticleSystem.MinMaxGradient(grad);
        }

        private static void ConfigureSmoke(ParticleSystem ps)
        {
            var main = ps.main;
            main.startColor = new Color(0.12f, 0.1f, 0.09f, 0.3f);
            main.startSize = new ParticleSystem.MinMaxCurve(0.2f, 0.45f);
            main.startLifetime = new ParticleSystem.MinMaxCurve(1.2f, 2.2f);
            main.startSpeed = new ParticleSystem.MinMaxCurve(0.05f, 0.15f);

            // 单发射器无法按墙分方向：烟雾统一轻微上飘 + 缓慢扩散
            // 注意：velocityOverLifetime 的 x/y/z 必须同为一种 MinMaxCurve 模式（都用双值构造函数）
            var vel = ps.velocityOverLifetime;
            vel.enabled = true;
            vel.space = ParticleSystemSimulationSpace.World;
            vel.x = new ParticleSystem.MinMaxCurve(-0.05f, 0.05f);
            vel.y = new ParticleSystem.MinMaxCurve(0.08f, 0.08f);
            vel.z = new ParticleSystem.MinMaxCurve(0f, 0f);

            var col = ps.colorOverLifetime;
            col.enabled = true;
            var grad = new Gradient();
            grad.SetKeys(
                new[] { new GradientColorKey(Color.black, 0f) },
                new[]
                {
                    new GradientAlphaKey(0f, 0f),
                    new GradientAlphaKey(0.25f, 0.25f),
                    new GradientAlphaKey(0.08f, 1f),
                });
            col.color = new ParticleSystem.MinMaxGradient(grad);
        }

        private static Texture2D GetSoftCircleTexture()
        {
            if (sharedSoftCircle == null)
            {
                const int size = 32;
                sharedSoftCircle = new Texture2D(size, size, TextureFormat.RGBA32, false);
                sharedSoftCircle.name = "BurningRoom_SoftCircle";
                sharedSoftCircle.wrapMode = TextureWrapMode.Clamp;
                sharedSoftCircle.filterMode = FilterMode.Bilinear;

                var cols = new Color[size * size];
                float center = (size - 1) * 0.5f;
                for (int y = 0; y < size; y++)
                {
                    for (int x = 0; x < size; x++)
                    {
                        float dx = (x - center) / center;
                        float dy = (y - center) / center;
                        float d = Mathf.Sqrt(dx * dx + dy * dy);
                        float a = Mathf.Clamp01(1f - d);
                        a = a * a * (3f - 2f * a); // smoothstep 衰减
                        cols[y * size + x] = new Color(1f, 1f, 1f, a);
                    }
                }

                sharedSoftCircle.SetPixels(cols);
                sharedSoftCircle.Apply();
            }

            return sharedSoftCircle;
        }

        /// <summary>焦痕贴图资源路径（烘焙到本地后从这里加载）。</summary>
        public const string CharTexAssetPath = "Assets/DiceTale/Resources/BurningRoom_Char.png";
        private const string CharTexResourceName = "BurningRoom_Char";

        /// <summary>
        /// 获取焦痕贴图：优先加载本地烘焙的资源（编辑器 AssetDatabase / 打包 Resources.Load），
        /// 找不到时回退为运行时程序化生成。
        /// </summary>
        public static Texture2D GetCharTexture()
        {
            if (sharedCharTex != null)
            {
                return sharedCharTex;
            }

            Texture2D loaded = null;
#if UNITY_EDITOR
            loaded = UnityEditor.AssetDatabase.LoadAssetAtPath<Texture2D>(CharTexAssetPath);
#else
            loaded = Resources.Load<Texture2D>(CharTexResourceName);
#endif
            sharedCharTex = loaded != null ? loaded : GenerateCharTexture();
            return sharedCharTex;
        }

        /// <summary>
        /// 程序化生成平滑灰色高度图（512²，山峰/湖泊，R=G=B=高度），
        /// 供运行时回退（烘焙 PNG 缺失时）与编辑器烘焙使用。
        /// </summary>
        public static Texture2D GenerateCharTexture()
        {
            const int size = 512;
            var tex = new Texture2D(size, size, TextureFormat.RGBA32, false);
            tex.name = "BurningRoom_Char";
            tex.wrapMode = TextureWrapMode.Repeat;
            tex.filterMode = FilterMode.Bilinear;

            var cols = new Color[size * size];
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    float u = (float)x / size;
                    float v = (float)y / size;
                    // 低频多倍频噪声：平滑起伏（山峰/湖泊）
                    float h = Fbm(u * 2.0f, v * 2.0f, 5);
                    // 对比拉伸：峰谷分明
                    h = Mathf.Clamp01((h - 0.35f) / 0.3f);
                    cols[y * size + x] = new Color(h, h, h, 1f);
                }
            }

            tex.SetPixels(cols);
            tex.Apply();
            return tex;
        }

        private static float Hash01(float x, float y)
        {
            float h = Mathf.Sin(x * 127.1f + y * 311.7f) * 43758.5453f;
            return h - Mathf.Floor(h);
        }

        private static float ValueNoise(float x, float y)
        {
            int xi = Mathf.FloorToInt(x);
            int yi = Mathf.FloorToInt(y);
            float xf = x - xi;
            float yf = y - yi;
            xf = xf * xf * (3f - 2f * xf);
            yf = yf * yf * (3f - 2f * yf);
            float a = Hash01(xi, yi);
            float b = Hash01(xi + 1, yi);
            float c = Hash01(xi, yi + 1);
            float d = Hash01(xi + 1, yi + 1);
            return Mathf.Lerp(Mathf.Lerp(a, b, xf), Mathf.Lerp(c, d, xf), yf);
        }

        private static float Fbm(float x, float y, int octaves)
        {
            float v = 0f;
            float amp = 0.5f;
            float fx = x;
            float fy = y;
            for (int i = 0; i < octaves; i++)
            {
                v += amp * ValueNoise(fx, fy);
                fx = fx * 2.03f + 1.7f;
                fy = fy * 2.03f + 9.2f;
                amp *= 0.5f;
            }

            return v;
        }

        // ---------------------------------------------------------------- 时间线

        private IEnumerator BurnTimeline()
        {
            // 直接扩散：无点燃阶段——墙火全亮、粒子全开，地面烧焦随 _BurnLevel 直接扩散
            SetState(1f, 0f);
            SetEmissions(true, true);

            float t = 0f;
            while (t < burnDuration)
            {
                t += Time.deltaTime;
                float k = Mathf.SmoothStep(0f, 1f, t / burnDuration);
                SetState(1f, k); // 墙火亮度恒为 1，只驱动地面烧焦扩散
                yield return null;
            }

            // 全盛燃烧（保持）
            SetState(1f, 1f);
            routine = null;
        }

        private void SetState(float wallLevel, float burnLevel)
        {
            // 墙火：整圈同时燃烧，_Spread 作整体亮度（无沿墙蔓延）
            foreach (var mat in stripMaterials)
            {
                mat.SetFloat("_Spread", Mathf.Clamp01(wallLevel));
            }

            if (scorchMat != null)
            {
                scorchMat.SetFloat("_BurnLevel", Mathf.Clamp01(burnLevel));
            }
        }

        private void SetEmissions(bool embers, bool smoke)
        {
            foreach (var ps in emberSystems)
            {
                if (ps == null)
                {
                    continue;
                }

                var emission = ps.emission;
                emission.enabled = embers;
                if (embers && !ps.isPlaying)
                {
                    ps.Play();
                }
            }

            foreach (var ps in smokeSystems)
            {
                if (ps == null)
                {
                    continue;
                }

                var emission = ps.emission;
                emission.enabled = smoke;
                if (smoke && !ps.isPlaying)
                {
                    ps.Play();
                }
            }
        }
    }
}
