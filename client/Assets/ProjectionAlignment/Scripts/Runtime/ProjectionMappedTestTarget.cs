using System.Collections.Generic;
using UnityEngine;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// 投影映射的验证靶(2026-08-17)。给 <see cref="ProjectorCameraRig"/> 造真实尺寸的虚拟孪生体,
    /// 用来对着 3D 打印件判断「光有没有准确落在实物表面上」。
    ///
    /// 全部物件挂在 rig 底下、放 <c>ProjectionMapped</c> 层；位置走
    /// <see cref="ProjectorCameraRig.MatCmToWorld"/> —— 和镜头位置 C、合成 shader 用的是**同一个**
    /// 板框架，尺寸用厘米填，由 <see cref="ProjectorCameraRig.UnitsPerCentimetre"/> 折算。
    ///
    /// 两个靶,按顺序用:
    ///
    /// 1. **垫子轮廓线**(<see cref="showMatOutline"/>)。四条边投出来应当压在压感垫的物理边缘上。
    ///    这是**第一个该看的东西** —— 它一次验完整条链(位姿 + 内参 + 尺度 + 锚点),
    ///    而且不需要任何打印件,肉眼一看就知道成没成。
    ///
    /// 2. **立体件**(默认**隐藏**,按 `N` 点出来、长按 `N` 收回去):
    ///    · **圆柱**(默认 ⌀2cm × 高 4cm,对着打印件填)。刻意**不贴贴图**,而是拿每 1cm 一段的
    ///      实心色块**堆**出来 —— 段与段之间是硬几何边界,不依赖任何 UV 约定,
    ///      错位一两毫米都看得出来。顶面另加一片薄盘(默认洋红):
    ///      光准的话洋红只出现在实物顶面那个圆上,歪了就会溢到侧面或桌面。
    ///    · **2cm 方块**,站在圆柱**两格外**(默认 8.6cm = 2 × 4.3cm 一格)。跟着圆柱一起
    ///      巡游/显隐。它在那儿是为了读**同一帧里两个落点的差异** —— 单个件对不准时,
    ///      「整体偏了」和「越远越偏」看起来一样;两件隔开两格摆着,一眼就能分开这两种病:
    ///      两件同向同量偏 = 镜头左右/前后不对,一件准另一件糊 = 高度不对。
    ///      方块另有直边,比圆柱更容易判「有没有转过一点」。
    ///
    /// ⚠ **实物要立在那片白色底盘上,不是立在彩色光斑上。** 空桌上看到的那摊彩色是圆柱
    /// **侧面**被斜投出来的影子,长度比圆柱本身还长,而且「底在哪一端」毫无线索 ——
    /// 2026-08-17 实测:用户照着光斑摆,放到了另一端,整整差了一个光斑长(2.4cm)。
    /// 底盘画在高度 0、没有视差,落在哪就是哪,是唯一无歧义的落脚点标记。
    ///
    /// 判读方式:**看色带边界落在实物的哪个高度**。四段颜色应当各占 1cm、上沿正好齐平顶面;
    /// 若色带整体偏高/偏矮,是位姿的高度不准;若在某一侧糊开,是位姿的水平位置或姿态不准。
    /// 底盘那一圈白边匀不匀,则单独告诉你水平位置准不准(与高度无关)。
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class ProjectionMappedTestTarget : MonoBehaviour
    {
        [Header("圆柱（对着 3D 打印件填，单位厘米）")]
        // ⚠ 默认**关**：上色层一架起来就先只投垫子轮廓线（外加游戏自己的内容），
        // 桌上不平白多一摊彩色光斑。要看靶按 `N` 点出来，长按 `N` 收回去。
        [SerializeField] private bool showCylinder = false;
        [SerializeField] private float cylinderDiameterCm = 2f;
        [SerializeField] private float cylinderHeightCm = 4f;
        [Tooltip("圆柱底面圆心在垫子上的位置（厘米，从垫子 (0,0) 角量）。\n"
               + "留 (-1,-1) = 第一块板的正中 —— 刻意不用整块垫子的正中：两块板时那儿正好是接缝，"
               + "有死区、还有板缝，圆柱站不稳")]
        [SerializeField] private Vector2 cylinderPositionCm = new Vector2(-1f, -1f);
        [Tooltip("每一段的高度（厘米）。1cm 一段 = 4 段，边界正好落在整厘米上，最好读")]
        [SerializeField] private float bandHeightCm = 1f;
        [Tooltip("底盘比圆柱每边宽出多少（毫米）。摆正时四周露出的这一圈应当均匀")]
        [SerializeField] private float baseHaloMm = 3f;

        [Header("方块（跟着圆柱走，单位厘米）")]
        [SerializeField] private bool showCube = true;
        [SerializeField] private float cubeSizeCm = 2f;
        [Tooltip("方块中心离圆柱中心多远（厘米）。默认 8.6 = **两格**（Darkwater 一格 4.3cm）。\n"
               + "沿垫面 U 方向摆；那一侧放不下时自动翻到另一侧")]
        [SerializeField] private float cubeOffsetCm = 8.6f;

        [Header("垫子轮廓线")]
        [SerializeField] private bool showMatOutline = true;
        [Tooltip("轮廓线宽（毫米）")]
        [SerializeField] private float outlineWidthMm = 4f;

        // 高饱和、彼此差异大,投在深色桌面和白色打印件上都读得出来。
        // ⚠ 顶盘色必须和**每一段**都拉开距离 —— 第一版顶盘用洋红、第 4 段用粉,
        // 渲出来这两块糊成一团,顶面到底有没有被盖住根本判不出来(这正是这个靶要避免的事)。
        static readonly Color[] BandColors =
        {
            new Color(0.10f, 1f, 0.90f),   // 青
            new Color(1f, 0.95f, 0.25f),   // 黄
            new Color(0.25f, 0.55f, 1f),   // 蓝
            new Color(1f, 0.50f, 0.10f),   // 橙
        };
        static readonly Color TopColor = new Color(1f, 0.10f, 0.85f);   // 顶面:洋红(与四段都远)
        // 方块自己的两段。**刻意不复用圆柱那四色**:两件隔着两格同时亮着,颜色一样的话
        // 「哪摊光斑是谁的」在斜投影里根本分不出来 —— 而这两件摆在一起就是为了对比。
        static readonly Color[] CubeBandColors =
        {
            new Color(0.20f, 0.95f, 0.35f),   // 绿
            new Color(0.65f, 0.35f, 1f),      // 紫
        };
        // 红色:刻意和装置自带的**青色**交互区框拉开距离。两个框来路完全不同 ——
        // 青框走预畸变(单应),红框走投影仪相机(位姿),它们重不重合就是位姿准不准的直读。
        // 第一版用的春绿,在照片里被当成青色,谁是谁根本分不出来。
        static readonly Color OutlineColor = new Color(1f, 0.12f, 0.10f);
        static readonly Color BaseDiscColor = new Color(1f, 1f, 1f);   // 底盘:白,与四段色带都不撞

        readonly List<GameObject> _built = new List<GameObject>();
        readonly List<Material> _mats = new List<Material>();

        public string LastReport { get; private set; } = string.Empty;

        /// <summary>
        /// 摆放模式:只画底盘,不画色带。
        ///
        /// 为什么需要它:色带是圆柱**侧面**的斜投影,会从底盘往近边方向压过去,把底盘遮掉大半 ——
        /// 剩下的那道白弧虽然能读,但摆实物时不好瞄。这个模式先给一个干净完整的白色落脚圆,
        /// 把实物立稳了再关掉它看色带。**这是几何决定的,不是可以靠调参数绕开的**:
        /// 要让近边那侧也露出白边,底盘得比圆柱大出一整个光斑长(2cm 的柱子要配 4.4cm 的盘),
        /// 那就不叫落脚点标记了。
        /// </summary>
        public bool PlacementMode { get; private set; }


        /// <summary>当前落点（厘米，垫面坐标）。(-1,-1) = 用默认的第一块板正中。</summary>
        public Vector2 CylinderPositionCm => cylinderPositionCm;

        /// <summary>
        /// 立体件（圆柱 + 方块）现在投不投。默认 **false** —— 架上色层时桌面是干净的。
        /// 改完要调用方自己重建（<see cref="Build"/>）才生效。
        /// </summary>
        public bool CylinderVisible { get { return showCylinder; } set { showCylinder = value; } }

        /// <summary>上一次巡游停在第几个预设。</summary>
        public int PresetIndex { get; private set; } = -1;

        /// <summary>
        /// 巡游范围（厘米，垫面坐标）。默认整块垫子；`width <= 0` = 还没人设过。
        ///
        /// ⚠ **就是要用整块垫子，别再收到棋盘上**（2026-08-31 之前收过一版，已撤）：
        /// 射线层的误差随「离镜头铅垂点的距离」长，棋盘只占垫子正中的 53.5 × 34.5 cm，
        /// 落点全挤在中间的话最容易露馅的地方一个都验不到。落到棋盘外的空垫面上是**故意的**。
        /// </summary>
        Rect _cycleAreaCm = new Rect(0f, 0f, -1f, -1f);

        /// <summary>限定巡游落点的范围（厘米，垫面坐标）。传空矩形 = 恢复成整块垫子。</summary>
        public void SetCycleAreaCm(Rect areaCm) => _cycleAreaCm = areaCm;

        /// <summary>巡游/摆件的可用范围（厘米）。没人设过就用整块垫子。</summary>
        Rect ResolveAreaCm(float matWidthMm, float matHeightMm)
            => _cycleAreaCm.width > 0f && _cycleAreaCm.height > 0f
                ? _cycleAreaCm
                : new Rect(0f, 0f, matWidthMm / 10f, matHeightMm / 10f);

        /// <summary>
        /// 垫子轮廓线的开关。改完要调用方自己重建（<see cref="Build"/>）才生效。
        /// 标定流程里它是第一个该看的东西（一次验完位姿+内参+尺度+锚点），但在**游戏画面**上它
        /// 只是一圈红框 —— DarkwaterM0 接管时会关掉它。
        /// </summary>
        public bool ShowMatOutline { get { return showMatOutline; } set { showMatOutline = value; } }

        /// <summary>
        /// 巡游到下一个预设落点并返回它的名字。调用方负责重建（<see cref="Build"/>）。
        /// 预设 = **正中 + 四条边的中点 + 四个角**，一路往外铺：越靠边离镜头铅垂点越远，
        /// 误差越大，**判据就在最外面那几个点上**（中间那个准不说明什么）。
        /// 边和角都贴着**垫子**取，因此除了正中，全部落在棋盘（53.5×34.5cm）外面 —— 故意的。
        /// </summary>
        public string CyclePreset(float matWidthMm, float matHeightMm)
        {
            Rect a = ResolveAreaCm(matWidthMm, matHeightMm);
            // 只留落脚标记的半径 + 一点余量。再往外就压在垫子边框上了，那儿反光、也放不住实物。
            const float Margin = 3.5f;
            float cx = a.x + a.width * 0.5f, cy = a.y + a.height * 0.5f;
            float x0 = a.x + Margin, x1 = a.xMax - Margin;
            float y0 = a.y + Margin, y1 = a.yMax - Margin;
            var presets = new (string name, Vector2 cm)[]
            {
                ("正中",   new Vector2(cx, cy)),
                ("左中",   new Vector2(x0, cy)),
                ("右中",   new Vector2(x1, cy)),
                ("近边中", new Vector2(cx, y0)),
                ("远边中", new Vector2(cx, y1)),
                ("左近角", new Vector2(x0, y0)),
                ("右近角", new Vector2(x1, y0)),
                ("左远角", new Vector2(x0, y1)),
                ("右远角", new Vector2(x1, y1)),
            };
            PresetIndex = (PresetIndex + 1) % presets.Length;
            cylinderPositionCm = presets[PresetIndex].cm;
            return $"{presets[PresetIndex].name}（{cylinderPositionCm.x:0.#}, {cylinderPositionCm.y:0.#} cm）";
        }

        /// <summary>直接指定落点（厘米，垫面坐标）。调用方负责重建。</summary>
        public void SetCylinderPositionCm(Vector2 cm)
        {
            cylinderPositionCm = cm;
            PresetIndex = -1;
        }

        /// <summary>切换摆放模式。返回切换后的状态。调用方负责重建(<see cref="Build"/>)。</summary>
        public bool TogglePlacementMode()
        {
            PlacementMode = !PlacementMode;
            return PlacementMode;
        }

        /// <summary>重建全部靶件。重复调用 = 先清后建(幂等)。</summary>
        public void Build(ProjectorCameraRig rig, float matWidthMm, float matHeightMm)
        {
            Clear();
            if (rig == null)
            {
                LastReport = "没有投影仪相机装置，靶建不出来。";
                return;
            }
            int layer = LayerMask.NameToLayer(ProjectorCameraRig.MappedLayerName);
            if (layer < 0)
            {
                LastReport = $"缺 {ProjectorCameraRig.MappedLayerName} 层，靶会被投影仪相机滤掉。";
                return;
            }

            _rig = rig;
            float upc = Mathf.Max(1e-4f, rig.UnitsPerCentimetre);

            if (showMatOutline) BuildOutline(layer, upc, matWidthMm, matHeightMm);

            int bands = 0;
            if (showCylinder)
            {
                Vector2 posCm = cylinderPositionCm;
                if (posCm.x < 0f || posCm.y < 0f)
                {
                    // 第一块板的正中(垫深是单板边长,所以取它的一半就是板心),不是整垫的正中
                    float half = matHeightMm / 20f;
                    posCm = new Vector2(half, half);
                }
                bands = BuildCylinder(layer, upc, posCm);

                string cubeNote = string.Empty;
                if (showCube)
                {
                    Vector2 cubeCm = ResolveCubePositionCm(posCm, matWidthMm, matHeightMm);
                    BuildCube(layer, upc, cubeCm);
                    cubeNote = $"　{cubeSizeCm:0.#}cm 方块在 ({cubeCm.x:0.#}, {cubeCm.y:0.#}) cm"
                             + $"（两格外，绿/紫）。";
                }

                LastReport = PlacementMode
                    ? $"【摆放模式】只投了落脚标记（圆 ⌀{cylinderDiameterCm + baseHaloMm / 5f:0.#}cm"
                      + $" 在垫上 {posCm.x:0.#}, {posCm.y:0.#} cm{(showCube ? " + 方块的白框" : string.Empty)}）。"
                      + "把实物立在白标记正中、四周白边匀了，再按 V 点亮色带。"
                    : $"靶已就位：⌀{cylinderDiameterCm:0.#}×{cylinderHeightCm:0.#}cm 圆柱"
                      + $"（{bands} 段 + 顶盘）在垫上 ({posCm.x:0.#}, {posCm.y:0.#}) cm。" + cubeNote
                      + "**实物要立在白色落脚标记上**（不是彩色光斑上，那是侧面的斜影，按 V 可只看落脚标记）"
                      + (showMatOutline ? "；含垫子轮廓线。" : "。");
            }
            else
            {
                LastReport = showMatOutline
                    ? "只投了垫子轮廓线（立体件是收起来的，按 N 点出来）。"
                    : "什么都没投（立体件收起来了，按 N 点出来）。";
            }
        }

        /// <summary>
        /// 方块的落点：从圆柱沿垫面 U 方向让开 <see cref="cubeOffsetCm"/>（默认两格）。
        /// 那一侧顶到范围边缘就翻到另一侧 —— 圆柱巡游到「右中」时 +U 已经出界了。
        /// 两侧都放不下（范围本身比一个偏移还窄）就贴着范围内夹住，宁可近也别投到垫子外面。
        /// </summary>
        Vector2 ResolveCubePositionCm(Vector2 cylinderCm, float matWidthMm, float matHeightMm)
        {
            Rect a = ResolveAreaCm(matWidthMm, matHeightMm);
            float half = cubeSizeCm * 0.5f + Mathf.Max(0f, baseHaloMm) / 10f;
            float x = cylinderCm.x + cubeOffsetCm;
            if (x + half > a.xMax) x = cylinderCm.x - cubeOffsetCm;
            x = Mathf.Clamp(x, a.x + half, Mathf.Max(a.x + half, a.xMax - half));
            return new Vector2(x, cylinderCm.y);
        }

        void BuildOutline(int layer, float upc, float matWidthMm, float matHeightMm)
        {
            float wCm = matWidthMm / 10f, hCm = matHeightMm / 10f;
            float tCm = Mathf.Max(0.05f, outlineWidthMm / 10f);
            // 四条边的中心与尺寸(厘米)。刻意画在**垫内侧**:线的外沿与垫边重合,
            // 这样"线压在边缘上"是个可判定的状态,而跨在边上就看不出偏了多少。
            var edges = new (Vector3 centre, Vector3 size)[]
            {
                (new Vector3(wCm * 0.5f, tCm * 0.5f, 0f),        new Vector3(wCm, tCm, tCm)),   // 近边
                (new Vector3(wCm * 0.5f, hCm - tCm * 0.5f, 0f),  new Vector3(wCm, tCm, tCm)),   // 远边
                (new Vector3(tCm * 0.5f, hCm * 0.5f, 0f),        new Vector3(tCm, hCm, tCm)),   // 左边
                (new Vector3(wCm - tCm * 0.5f, hCm * 0.5f, 0f),  new Vector3(tCm, hCm, tCm)),   // 右边
            };
            foreach (var (centre, size) in edges)
            {
                var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
                Strip(go, layer, OutlineColor);
                go.name = "MatOutlineEdge";
                Place(go, centre, upc);
                go.transform.localScale = new Vector3(size.x, size.z, size.y) * upc;   // 垫面 Z 是高度
                _built.Add(go);
            }
        }

        int BuildCylinder(int layer, float upc, Vector2 posCm)
        {
            // ---- 底盘:平贴桌面的实心圆,标出**落脚点** ----
            // 2026-08-17 实测踩的坑:空桌上那摊彩色是圆柱**侧面**的斜投影,不是它的底。
            // 用户照着光斑摆实物,把圆柱放在了光斑的另一端 —— 差了整整一个光斑长(实测 2.4cm)。
            // 从投影仪那个刁钻角度看,4cm 高的圆柱会在桌面上拖出一条比它自己还长的斜影,
            // 而「底在哪一端」没有任何线索。这片盘画在高度 0,**没有视差**,落在哪就是哪,
            // 是唯一能无歧义指出落脚点的东西。摆正之后它会从实物底部四周露出均匀一圈 ——
            // 判据是「看一圈匀不匀」,比「盖没盖住」好判得多。
            var disc = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            Strip(disc, layer, BaseDiscColor);
            disc.name = "TestCylinderBaseDisc";
            const float discThickCm = 0.04f;
            Place(disc, new Vector3(posCm.x, posCm.y, discThickCm * 0.5f), upc);
            float discDiaCm = cylinderDiameterCm + 2f * Mathf.Max(0f, baseHaloMm) / 10f;
            disc.transform.localScale = new Vector3(
                discDiaCm, discThickCm * 0.5f, discDiaCm) * upc;
            _built.Add(disc);

            if (PlacementMode) return 0;   // 只留底盘,把实物立稳了再点亮色带

            float band = Mathf.Max(0.1f, bandHeightCm);
            int count = Mathf.Max(1, Mathf.RoundToInt(cylinderHeightCm / band));
            float actual = cylinderHeightCm / count;   // 整除不了时略调段高,总高恒等于填的值

            for (int i = 0; i < count; i++)
            {
                var go = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
                Strip(go, layer, BandColors[i % BandColors.Length]);
                go.name = $"TestCylinderBand{i}";
                float zCm = actual * (i + 0.5f);       // 段中心高度
                Place(go, new Vector3(posCm.x, posCm.y, zCm), upc);
                // Unity 内置 Cylinder:直径 1、高 2 → Y 缩放取段高的一半
                go.transform.localScale = new Vector3(
                    cylinderDiameterCm, actual * 0.5f, cylinderDiameterCm) * upc;
                _built.Add(go);
            }

            // 顶盘:一片薄圆片贴在顶面上。光准的话洋红只落在实物顶面那个圆里
            var cap = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            Strip(cap, layer, TopColor);
            cap.name = "TestCylinderTop";
            const float capThickCm = 0.08f;
            Place(cap, new Vector3(posCm.x, posCm.y, cylinderHeightCm - capThickCm * 0.5f), upc);
            cap.transform.localScale = new Vector3(
                cylinderDiameterCm, capThickCm * 0.5f, cylinderDiameterCm) * upc;
            _built.Add(cap);
            return count;
        }

        /// <summary>
        /// 2cm 方块。和圆柱同一套读法（白落脚标记 + 每 1cm 一段的实心色块 + 洋红顶盘），
        /// 只换了颜色和形状。直边是它多出来的那点用处：圆柱怎么转都一样，方块转了几度一眼就看得见。
        /// </summary>
        int BuildCube(int layer, float upc, Vector2 posCm)
        {
            float side = Mathf.Max(0.2f, cubeSizeCm);

            // 落脚标记:平贴桌面的白色方框底片(高度 0、无视差),理由与圆柱那片底盘完全相同
            var pad = GameObject.CreatePrimitive(PrimitiveType.Cube);
            Strip(pad, layer, BaseDiscColor);
            pad.name = "TestCubeBasePad";
            const float padThickCm = 0.04f;
            Place(pad, new Vector3(posCm.x, posCm.y, padThickCm * 0.5f), upc);
            float padSideCm = side + 2f * Mathf.Max(0f, baseHaloMm) / 10f;
            pad.transform.localScale = new Vector3(padSideCm, padThickCm, padSideCm) * upc;
            _built.Add(pad);

            if (PlacementMode) return 0;

            float band = Mathf.Max(0.1f, bandHeightCm);
            int count = Mathf.Max(1, Mathf.RoundToInt(side / band));
            float actual = side / count;

            for (int i = 0; i < count; i++)
            {
                var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
                Strip(go, layer, CubeBandColors[i % CubeBandColors.Length]);
                go.name = $"TestCubeBand{i}";
                Place(go, new Vector3(posCm.x, posCm.y, actual * (i + 0.5f)), upc);
                go.transform.localScale = new Vector3(side, actual, side) * upc;
                _built.Add(go);
            }

            var cap = GameObject.CreatePrimitive(PrimitiveType.Cube);
            Strip(cap, layer, TopColor);
            cap.name = "TestCubeTop";
            const float capThickCm = 0.08f;
            Place(cap, new Vector3(posCm.x, posCm.y, side - capThickCm * 0.5f), upc);
            cap.transform.localScale = new Vector3(side, capThickCm, side) * upc;
            _built.Add(cap);
            return count;
        }

        ProjectorCameraRig _rig;

        /// <summary>
        /// 垫面厘米 (x, y, 高) → 世界。走 rig 的板框架（<see cref="ProjectorCameraRig.MatCmToWorld"/>），
        /// 和镜头位置、合成 shader 是同一套坐标 —— 靶件、C、警示线之间没有极性可错。
        /// 父节点只管生命周期，位置朝向全用世界值写。
        /// </summary>
        void Place(GameObject go, Vector3 matCm, float upc)
        {
            go.transform.SetParent(_rig.transform, false);
            go.transform.SetPositionAndRotation(_rig.MatCmToWorld(matCm), _rig.FrameRotation);
        }

        /// <summary>
        /// 收拾成一个纯粹的「被投的形状」:去碰撞体、不投也不收阴影、Unlit 实心色。
        /// **必须 Unlit** —— 这些物件的颜色就是要投出去的光本身,
        /// 让场景灯光再乘一遍等于把标定验证变成打光验证。
        /// </summary>
        void Strip(GameObject go, int layer, Color colour)
        {
            var col = go.GetComponent<Collider>();
            if (col != null) Destroy(col);
            go.layer = layer;

            var mr = go.GetComponent<MeshRenderer>();
            if (mr != null)
            {
                var shader = Shader.Find("Universal Render Pipeline/Unlit") ?? Shader.Find("Unlit/Color");
                var mat = new Material(shader) { name = $"ProjMappedTarget ({colour})" };
                if (mat.HasProperty("_BaseColor")) mat.SetColor("_BaseColor", colour);
                if (mat.HasProperty("_Color")) mat.SetColor("_Color", colour);
                mr.sharedMaterial = mat;
                mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
                mr.receiveShadows = false;
                _mats.Add(mat);
            }
        }

        public void Clear()
        {
            foreach (var go in _built)
                if (go != null) DestroyImmediate(go);
            _built.Clear();
            foreach (var m in _mats)
                if (m != null) DestroyImmediate(m);
            _mats.Clear();
        }

        void OnDestroy() => Clear();
    }
}
