using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 战争雾（镜像驱动）：**把被引用地图里那些雾格画成一层雾，再按后台发来的鼠标轨迹把它擦掉**。
    ///
    /// **v15 起雾是独立的场景对象**（`kind: "Fog"`）：它带 `FogOfWar` 协议组件（由
    /// <see cref="SceneObjectView.Create"/> 挂上），但自己**没有地图数据**（没有 `GridMap`）——
    /// 挂在哪个对象身上就跟随哪个对象的 position / rotation（雾对象可自由摆放）；
    /// 「哪些区域位涂了雾」由自己的 `regions` 说，而「这些区域位对应哪些格子」要看被引用地图
    /// （`mapId`）的 `GridMap`：调用方把它解析成 <see cref="MirrorMap"/> 再传进来。
    /// 渲染用的面片是它自己管的一个**子物体** `FogOverlay`（见 <see cref="OverlayName"/>）：
    /// 挂在**本组件所在 GameObject 下**，位置 / 旋转 / 缩放自动跟着雾对象走，不用谁替它摆一遍；
    /// 尺寸交给子物体上的 <see cref="ImageLayer"/> 烘进网格（世界尺寸 = 被引用地图的显示图声明
    /// 尺寸 × 雾对象 scale，由调用方乘好），离地 = 父级抬升 + <see cref="OverlayLift"/>；
    /// 显示顺序取 <see cref="SortingOrder"/>（最前面）——未探索的地方连地图上的对象一起盖住
    /// （`sortingOrder` 是全局的，挂成子物体不改变这一点）。
    ///
    /// **子物体只在三个条件都满足时才存在**，每次收到场景推送都重新判断（<see cref="Apply"/>）：
    /// 被引用地图的数据到了（方法参数 `map` 非 null）、`FogOfWar.enabled`（编辑器那个总开关）
    /// 开着、`regions` 非空。任一不满足就把子物体拆掉，别留一块盖着旧遮罩的面片。
    ///
    /// **语义变化（组件袋化，有意为之）**：组件现在**常驻**——开关关掉 / 没绑雾区时只是没有
    /// 渲染子物体，组件自己的遮罩与操作记录都还留着（以前整个组件随开关销毁，重开等于重新探索；
    /// 现在再打开开关，已揭示的部分原样恢复）。雾对象被隐藏（`active=false` / 未落位）时
    /// 子物体跟着隐藏；视图销毁时子物体作为子物体自动带走，不需要谁替它收尸。
    ///
    /// **怎么揭示**：后台只发**轨迹**（`erase_mask`：归一化点 + 归一化半径 + 软边比例），前端照轨迹擦；
    /// 「整区开关」发 `reveal_fog_region`。擦除公式与编辑器 Mask 窗口**逐字对齐**
    /// （`apps/editor/src/services/mask-math.ts`，也就是参考实现 `MaskImage.ApplyEraseStroke`
    /// + `MaskEraseStamp.shader` 那一套，只是这里用 CPU 算）：
    /// 半径纹素 = 归一化半径 × 遮罩宽；沿线段按 `半径 / 2` 补点、两端各打一个圆；
    /// 每个落点按**纹素中心**距离算软边（核内全擦、核外线性收尾）、`min` 幂等（同一处擦 N 次 = 一次）、
    /// 只改 alpha。所以**同一笔在编辑器预览与投影上覆盖同一片图像区域**。
    ///
    /// **遮罩与编辑器预览是同一张**（`mask-math.ts` 的 `previewMaskSizeFor`：960 宽、高按贴图比例推、
    /// 长边超 2048 等比缩）——两边像素级对齐，而不是「归一化范围大致一致」。
    /// 两个常量（<see cref="MaskPreviewWidth"/> / <see cref="MaxPreviewEdge"/>）**必须与编辑器同步改**。
    ///
    /// **边缘羽化**：遮罩是按格子填的方块，直接画出来就是一个一个方格；所以显示前先过一条 GPU 模糊链
    /// （`DiceTale/FogBlur`，模糊纹理每格 <see cref="BlurTexelsPerCell"/> 个纹素、跑
    /// <see cref="blurPasses"/> 遍，羽化宽度约一格）——与参考实现
    /// （`backend_diceTale` / `LLMNPC_NEWLIGHT_EX` 的 `FogOfWar` + `FogBlur.shader`）同一套做法。
    /// 已擦透的地方（alpha≈0）由 shader 挡在模糊之外，不会被相邻的雾回填。
    ///
    /// **揭示状态只在前端**（不写文档、也不随场景推送回来）：组件里留一份 CPU 遮罩 + 一份**有序的
    /// 操作记录**，地图数据一变（换了雾区 / 涂了格子 / 网格尺寸变了）就「重填初始态 + 按顺序重放」——
    /// 于是「整区盖回」能按顺序盖掉它之前的笔画（与编辑器预览一致），已揭示的部分也不会因为后台推了
    /// 一份新场景就丢。切场景 / 重连 / 开关重开（视图与组件都不销毁）都保留，Unity 重启才回到未探索。
    /// </summary>
    [DisallowMultipleComponent]
    public class FogOfWar : MonoBehaviour
    {
        /// <summary>雾色（默认黑不透明：未探索 = 完全看不见底图）。编辑器预览按区域配色，前端是统一的雾色。</summary>
        [SerializeField]
        private Color fogColor = new Color(0f, 0f, 0f, 1f);

        /// <summary>
        /// 雾边缘羽化：模糊链跑几遍（每遍 3×3 高斯，羽化约 1 个模糊纹素）。
        ///
        /// 模糊纹素见 <see cref="BlurTexelsPerCell"/>：每格 4 个纹素时，**4 遍 ≈ 羽化一格**。
        /// 想更柔就加遍数（每加一遍多柔一点、代价是一次全屏 Blit，很小）。
        /// </summary>
        [SerializeField]
        private int blurPasses = 4;

        /// <summary>模糊纹理的分辨率：**每格几个纹素**（参考实现是每格 2 个；这里取 4，擦除形状保留得细一些）。</summary>
        private const int BlurTexelsPerCell = 4;

        /// <summary>模糊纹理的边长上限（超大网格别把显存吃光；超了就整体等比缩）。</summary>
        private const int MaxBlurEdge = 1024;

        /// <summary>模糊用的 shader（在 `Resources/Shaders/` 下，打包一定会带上）。</summary>
        private const string BlurShaderName = "DiceTale/FogBlur";

        /// <summary>预览遮罩的宽度（`mask-math.ts` 的 `MASK_PREVIEW_WIDTH`）：与编辑器**必须一致**。</summary>
        private const int MaskPreviewWidth = 960;

        /// <summary>预览遮罩长边的上限（`mask-math.ts` 的 `MAX_PREVIEW_EDGE`）：极端长宽比等比缩一下。</summary>
        private const int MaxPreviewEdge = 2048;

        /// <summary>可绘制的 8 个区域位（区域1..区域8 = 位 1|2|4|8|16|32|64|128）：绑定里的脏位丢掉。</summary>
        private const int PaintableMask = 0xFF;

        /// <summary>贴图缺失时的兜底遮罩比例（16:9，与参考实现 `MaskImage` 的默认 960×540 同一张）。</summary>
        private const int FallbackMaskHeight = 540;

        /// <summary>渲染子物体的名字（一眼看出层级里多出来的这一块是什么）。</summary>
        private const string OverlayName = "FogOverlay";

        /// <summary>
        /// 雾层的显示顺序：**盖在所有东西前面**（未探索 = 连上面的令牌一起看不见）。
        ///
        /// 文档里的 `sortingOrder` 是给对象自己排前后用的（默认范围很小），雾不该跟它们比大小；
        /// 取 `short.MaxValue`（Unity 的 `sortingOrder` 是 16 位有符号），实际就是「最前面」。
        /// 已经揭示的地方雾是透明的，所以不会挡住该看见的东西。
        /// </summary>
        private const int SortingOrder = short.MaxValue;

        /// <summary>
        /// 雾层比自己那张地图高多少（**世界单位**）：只求比地图抬升高一档、别跟地图共面。
        ///
        /// 地图自己的抬升按 `sortingOrder` 每档差 `0.0005`（`SceneObjectView` 的 `LiftFor`），
        /// 所以这里给 `0.002` 就够——高了会在斜视角下看起来「浮起来」。
        /// 子物体的局部 y = 父级抬升 + 这个值（世界高度口径与以前同级摆放逐字一致）。
        /// </summary>
        private const float OverlayLift = 0.002f;

        // ---------------------------------------------------------------- 地图数据（由调用方从被引用地图解析后传入）

        /// <summary>这张地图的格子掩码（`rowOrder: bottom-up`，`gridWidth * gridHeight` 个）。</summary>
        private int[] cells = new int[0];
        private int gridWidth;
        private int gridHeight;

        /// <summary>已指定雾区的区域位并集（0 = 没绑雾区，这一层不该存在）。</summary>
        private int fogMask;

        /// <summary>已指定雾区的区域位（原样保留，`reveal_fog_region` 要按它校验）。</summary>
        private readonly List<int> fogRegions = new List<int>();

        /// <summary>地图数据的指纹（网格 / 雾区 / 格子 / 遮罩尺寸）：变了就重建遮罩。</summary>
        private string signature = "";

        /// <summary>数据不全的提示只打一次（每次推送都刷会把控制台淹掉）。</summary>
        private bool warnedMissingData;

        /// <summary>缺 `FogBlur` shader 的提示也只打一次（雾照常显示，只是不羽化）。</summary>
        private bool warnedMissingBlurShader;

        // ---------------------------------------------------------------- 遮罩（CPU 是真源，纹理是显示副本）

        private Color32[] pixels = new Color32[0];
        private Texture2D texture;
        private int maskWidth;
        private int maskHeight;

        /// <summary>有序的操作记录：地图数据变了要「重填初始态 + 重放」。**顺序有意义**——盖回要盖掉之前的笔画。</summary>
        private readonly List<MaskOp> ops = new List<MaskOp>();

        // ---------------------------------------------------------------- 羽化（GPU 模糊链）

        /// <summary>模糊链的每一级（显示用的是最后一级；网格尺寸变了整条重建）。</summary>
        private RenderTexture[] blurRTs;
        private Material blurMaterial;
        private int blurWidth;
        private int blurHeight;

        /// <summary>
        /// 渲染子物体（`FogOverlay`）上的 <see cref="ImageLayer"/>；**null = 渲染子物体没建**
        /// （overlay 建了才取——lazy，不再有 `Awake` 预热）。
        /// </summary>
        private ImageLayer overlayRenderer;

        private static readonly Color32 Transparent = new Color32(0, 0, 0, 0);

        private void OnDestroy()
        {
            ReleaseBlurChain();

            if (blurMaterial != null)
            {
                Release(blurMaterial);
                blurMaterial = null;
            }

            if (texture != null)
            {
                Release(texture);
                texture = null;
            }

            // 渲染子物体（`FogOverlay`）是**本 GameObject 的子物体**：视图销毁时它自动跟着走，
            // 这里不需要收；要收的是不挂在层级上的模糊链 / 材质 / 遮罩纹理。
        }

        // ---------------------------------------------------------------- 每份场景推送

        /// <summary>
        /// 按这份战争雾组件数据刷新自己（每次收到场景推送都会调；**建不建渲染子物体由它自己拿主意**）。
        ///
        /// v15 起雾是独立对象、自己不带地图数据，所以被引用地图由调用方解析好后经
        /// <paramref name="map"/> 传进来（见 <see cref="SceneObjectView.Apply"/>）。
        ///
        /// 三个条件缺一不可——<paramref name="map"/> 非 null（被引用地图的数据到了）、
        /// <paramref name="fogData"/> 的总开关开着、`regions` 非空（空数组 = 不生成雾层，与旧版对
        /// 「开着但没指定雾区」的处理一致）。任一不满足就把渲染子物体拆掉，别留一块盖着旧遮罩的面片。
        ///
        /// <paramref name="worldWidth"/> / <paramref name="worldHeight"/> 是**雾面片的世界尺寸**
        /// （= 被引用地图的显示图声明尺寸 × 雾对象 scale × <see cref="SceneObjectView.GlobalScale"/>，
        /// 调用方已经算好），雾面片与它同大小；<paramref name="mapLift"/> 是调用方给这一层的离地抬升，
        /// 雾层在它的基础上再加 <see cref="OverlayLift"/>。雾层**恒定取最前面**（<see cref="SortingOrder"/>，
        /// 未探索要连排得比地图还高的对象一起盖住），不再需要调用方交代对象的显示顺序。
        /// </summary>
        public void Apply(MirrorMap map, MirrorImage mapImage, MirrorFog fogData, float worldWidth, float worldHeight, float mapLift)
        {
            var wantsOverlay =
                map != null
                && fogData != null
                && fogData.enabled
                && fogData.regions != null
                && fogData.regions.Length > 0;

            if (!wantsOverlay)
            {
                TearDownOverlay();
                return;
            }

            if (!Adopt(map, mapImage, fogData.regions))
            {
                // 没绑有效雾区（掩码算出来是 0）/ 格子数据不全：同样不画
                TearDownOverlay();
                return;
            }

            EnsureOverlay();

            if (overlayRenderer != null)
            {
                // 白色染色 = 原样显示（雾色已经在遮罩里了）；离地 = 父级抬升 + OverlayLift，
                // 世界高度与以前「同级、按同一份数值摆」逐字一致（x/z 留在局部原点，跟随父级）
                overlayRenderer.Apply(DisplayTexture, worldWidth, worldHeight, Color.white, SortingOrder, mapLift + OverlayLift);
            }
        }

        // ---------------------------------------------------------------- 渲染子物体（自建自拆）

        /// <summary>
        /// 建渲染子物体（幂等）：**本组件所在 GameObject 下**挂一个 `FogOverlay` 子物体，
        /// 上面挂 <see cref="ImageLayer"/> 当渲染器（`ImageLayer` 的 RequireComponent 链会把
        /// MeshFilter / MeshRenderer 一起带上）。挂成子物体：位置 / 旋转 / 缩放自动跟随雾对象，
        /// 对象被隐藏时一起隐藏，视图销毁时自动带走。
        /// </summary>
        private void EnsureOverlay()
        {
            if (overlayRenderer != null)
            {
                return;
            }

            var go = new GameObject(OverlayName);
            go.transform.SetParent(transform, false);
            overlayRenderer = go.AddComponent<ImageLayer>();
        }

        /// <summary>
        /// 拆渲染子物体（幂等）：把 `FogOverlay` 子物体整个销毁，它上面那块面片由
        /// <see cref="ImageLayer"/> 自己的 `OnDestroy` 释放。运行时 `Destroy`、
        /// 编辑器 `DestroyImmediate`（见 <see cref="Release"/>）。
        /// </summary>
        private void TearDownOverlay()
        {
            if (overlayRenderer == null)
            {
                return;
            }

            Release(overlayRenderer.gameObject);
            overlayRenderer = null;
        }

        // ---------------------------------------------------------------- 后台命令

        /// <summary>
        /// 擦一笔（`erase_mask`）：沿轨迹打软边擦除圆。
        ///
        /// `points` 是归一化点（`[0,1]`、**y 向下**，与编辑器画布一致；越界点夹到边界），
        /// `radius` 是**半径 / 遮罩宽**（编辑器固定 `0.05`），`softness` 是软边带比例（编辑器固定 `1`）。
        /// 单点也接受（在那一处打一个圆）。遮罩还没建好时返回 false（命令路由会如实回失败）。
        /// </summary>
        public bool EraseStroke(IReadOnlyList<Vector2> points, float radius, float softness)
        {
            if (points == null || points.Count == 0 || texture == null)
            {
                return false;
            }

            var op = new MaskOp
            {
                kind = MaskOpKind.Stroke,
                radius = Mathf.Max(0f, radius),
                softness = Mathf.Clamp01(softness),
                points = new List<Vector2>(points),
            };

            ops.Add(op);
            ApplyOp(op);
            Upload();
            return true;
        }

        /// <summary>
        /// 整片揭示 / 整片盖回某个雾区（`reveal_fog_region`）。
        ///
        /// 「含该位的**每个**格子」一起变——与编辑器 Mask 窗口右侧那个开关同一口径，
        /// 所以**盖回会连带盖掉这一区里手动擦掉的部分**。该位不是这张地图的雾区时返回 false。
        /// </summary>
        public bool RevealRegion(int region, bool revealed)
        {
            if (texture == null || !fogRegions.Contains(region))
            {
                return false;
            }

            var op = new MaskOp { kind = MaskOpKind.Region, region = region, revealed = revealed };
            ops.Add(op);
            ApplyOp(op);
            Upload();
            return true;
        }

        // ---------------------------------------------------------------- 收下数据 / 重建

        /// <summary>
        /// 收下这份地图数据；**数据变了才重建**（网格 / 雾区 / 格子 / 遮罩尺寸任一变化）。
        ///
        /// 重建 = 重填初始态（雾格盖满）+ 按顺序重放操作，所以已揭示的部分不会丢；
        /// 数据没变时只是把引用换成最新那份（同一份内容，抓着旧数组没意义）。
        /// </summary>
        private bool Adopt(MirrorMap mapData, MirrorImage mapImage, int[] regions)
        {
            if (mapData == null)
            {
                return false;
            }

            var nextFogMask = RegionsToMask(regions);
            if (nextFogMask == 0)
            {
                WarnOnce($"「{name}」的雾区一个有效区域位都没有，这一层先不画");
                return false;
            }

            if (mapData.gridWidth <= 0 || mapData.gridHeight <= 0 ||
                mapData.cells == null || mapData.cells.Length < mapData.gridWidth * mapData.gridHeight)
            {
                WarnOnce($"「{name}」引用的地图数据不全（网格 / 格子），这一层先不画");
                return false;
            }

            var size = MaskSizeFor(mapImage);
            var next = string.Format(
                "{0}x{1}|{2}|{3}x{4}|{5}",
                mapData.gridWidth,
                mapData.gridHeight,
                nextFogMask,
                size.x,
                size.y,
                HashCells(mapData.cells, mapData.gridWidth * mapData.gridHeight)
            );

            if (next == signature)
            {
                cells = mapData.cells;
                return true;
            }

            signature = next;
            gridWidth = mapData.gridWidth;
            gridHeight = mapData.gridHeight;
            fogMask = nextFogMask;
            cells = mapData.cells;
            maskWidth = size.x;
            maskHeight = size.y;

            // 绑定位也留一份（`reveal_fog_region` 要按它校验；只认可绘制的位、去重）
            fogRegions.Clear();
            if (regions != null)
            {
                for (int i = 0; i < regions.Length; i++)
                {
                    var bit = regions[i] & PaintableMask;
                    if (bit != 0 && !fogRegions.Contains(bit))
                    {
                        fogRegions.Add(bit);
                    }
                }
            }

            // 绑定 / 格子 / 尺寸都变了：旧的操作记录是按旧数据算的，重放它没有意义
            ops.Clear();
            Rebuild();
            return true;
        }

        /// <summary>重填遮罩 = 初始态（雾格盖满、其余透明）+ 按顺序重放操作，再推给纹理。</summary>
        private void Rebuild()
        {
            EnsureBuffers();
            FillInitial();

            for (int i = 0; i < ops.Count; i++)
            {
                ApplyOp(ops[i]);
            }

            Upload();

            // 一条日志说明这一层建成了什么样：现场排查「投影上一片都没有」时先看这行在不在
            // （在 = 雾层建起来了，问题在命令 / 显示；不在 = 数据没到这一层）。
            Debug.Log(
                $"[战争雾] {name}：雾区 {DescribeRegions()}，雾格 {CountFogCells()} 个，" +
                $"遮罩 {maskWidth}×{maskHeight}，羽化 {blurWidth}×{blurHeight}×{blurRTs?.Length ?? 0} 遍，" +
                $"已重放 {ops.Count} 步");
        }

        /// <summary>已指定的雾区（写成面板上的名字：区域1+区域4）。</summary>
        private string DescribeRegions()
        {
            if (fogRegions.Count == 0)
            {
                return "(无)";
            }

            var parts = new List<string>(fogRegions.Count);
            for (int i = 0; i < fogRegions.Count; i++)
            {
                parts.Add($"区域{RegionIndex(fogRegions[i])}");
            }

            return string.Join("+", parts);
        }

        /// <summary>位 → 面板上的编号（区域1 = 位 1、区域4 = 位 8……与编辑器的 `MASK_LABELS` 同序）。</summary>
        private static int RegionIndex(int bit)
        {
            var index = 1;
            for (var value = 1; value < bit; value <<= 1)
            {
                index += 1;
            }

            return index;
        }

        /// <summary>含已指定雾区位的格子数（只看数据，不看揭示状态）。</summary>
        private int CountFogCells()
        {
            var count = 0;
            var total = gridWidth * gridHeight;
            for (int i = 0; i < total; i++)
            {
                if ((cells[i] & fogMask) != 0)
                {
                    count += 1;
                }
            }

            return count;
        }

        /// <summary>建 / 换 CPU 遮罩与纹理（尺寸变了就重建；旧纹理自己释放）。</summary>
        private void EnsureBuffers()
        {
            var count = Mathf.Max(1, maskWidth * maskHeight);
            if (pixels.Length != count)
            {
                pixels = new Color32[count];
            }

            if (texture != null && texture.width == maskWidth && texture.height == maskHeight)
            {
                return;
            }

            if (texture != null)
            {
                Release(texture);
            }

            texture = new Texture2D(maskWidth, maskHeight, TextureFormat.RGBA32, false)
            {
                name = "FogMask",
                filterMode = FilterMode.Bilinear,
                wrapMode = TextureWrapMode.Clamp,
                hideFlags = HideFlags.DontSave,
            };
        }

        /// <summary>初始态：只给**含已指定雾区位**的格子盖色，其余透明（与编辑器预览同一形状）。</summary>
        private void FillInitial()
        {
            for (int i = 0; i < pixels.Length; i++)
            {
                pixels[i] = Transparent;
            }

            var fog = (Color32)fogColor;
            for (int y = 0; y < gridHeight; y++)
            {
                for (int x = 0; x < gridWidth; x++)
                {
                    if ((cells[y * gridWidth + x] & fogMask) == 0)
                    {
                        continue;
                    }

                    PaintCell(x, y, fog);
                }
            }
        }

        // ---------------------------------------------------------------- 操作

        /// <summary>做一次操作（首次、重放、命令都走它，保证三条路的结果一模一样）。</summary>
        private void ApplyOp(MaskOp op)
        {
            if (op.kind == MaskOpKind.Region)
            {
                var color = op.revealed ? Transparent : (Color32)fogColor;
                for (int y = 0; y < gridHeight; y++)
                {
                    for (int x = 0; x < gridWidth; x++)
                    {
                        if ((cells[y * gridWidth + x] & op.region) != 0)
                        {
                            PaintCell(x, y, color);
                        }
                    }
                }

                return;
            }

            var points = op.points;
            if (points == null || points.Count == 0)
            {
                return;
            }

            var radiusTex = Mathf.Max(1f, op.radius * maskWidth);
            if (points.Count == 1)
            {
                // 单点（单击 / 笔画尾巴）：只打一个擦除圆
                Stamp(ToTexel(points[0]), radiusTex, op.softness);
                return;
            }

            // 与编辑器同式：step = max(1, 半径 / 2)，两端各打一个圆（快拖也不断线）
            var step = Mathf.Max(1f, radiusTex * 0.5f);
            for (int i = 0; i < points.Count - 1; i++)
            {
                var from = ToTexel(points[i]);
                var to = ToTexel(points[i + 1]);
                var distance = (to - from).magnitude;
                var samples = Mathf.Max(1, Mathf.CeilToInt(distance / step));

                for (int s = 0; s <= samples; s++)
                {
                    Stamp(Vector2.Lerp(from, to, s / (float)samples), radiusTex, op.softness);
                }
            }
        }

        /// <summary>
        /// 在遮罩的某个纹素位置打一个软边擦除圆：核内全擦、核外到半径处线性收尾。
        ///
        /// 与编辑器 `applyEraseToPixels` / `MaskEraseStamp.shader` 同式：距离从**纹素中心**量起
        /// （`x + 0.5`），`min` 取小（同一处擦多次 = 擦一次，渐变带不被叠加抹平），**只改 alpha**。
        /// </summary>
        private void Stamp(Vector2 center, float radius, float softness)
        {
            var core = radius * (1f - Mathf.Clamp01(softness));
            var band = Mathf.Max(radius - core, 1e-5f);

            var x0 = Mathf.Max(0, Mathf.FloorToInt(center.x - radius));
            var x1 = Mathf.Min(maskWidth - 1, Mathf.CeilToInt(center.x + radius));
            var y0 = Mathf.Max(0, Mathf.FloorToInt(center.y - radius));
            var y1 = Mathf.Min(maskHeight - 1, Mathf.CeilToInt(center.y + radius));

            for (int y = y0; y <= y1; y++)
            {
                for (int x = x0; x <= x1; x++)
                {
                    var dx = x + 0.5f - center.x;
                    var dy = y + 0.5f - center.y;
                    var distance = Mathf.Sqrt(dx * dx + dy * dy);
                    if (distance > radius)
                    {
                        // 半径之外算出来也是「不动」，直接跳过（等价，快得多）
                        continue;
                    }

                    var erased = (byte)Mathf.RoundToInt(Mathf.Clamp01((distance - core) / band) * 255f);
                    var index = y * maskWidth + x;
                    var current = pixels[index];
                    if (erased < current.a)
                    {
                        pixels[index] = new Color32(current.r, current.g, current.b, erased);
                    }
                }
            }
        }

        /// <summary>
        /// 把一格对应的那块纹素刷成一个颜色。
        ///
        /// 格子 `y = 0` 是**贴图最下一行**（协议 `rowOrder: bottom-up`），而 Unity 的像素数组本来就是
        /// 自下而上（`SetPixels32` 的第 0 行在底部、shader 的 `uv.y = 0` 也在底部），所以**不用翻**；
        /// 块边界与编辑器 `fillCellTexels` 同一套取整。
        /// </summary>
        private void PaintCell(int cellX, int cellY, Color32 color)
        {
            var cellWidth = maskWidth / (float)gridWidth;
            var cellHeight = maskHeight / (float)gridHeight;

            var x0 = Mathf.Max(0, Mathf.FloorToInt(cellX * cellWidth));
            var x1 = Mathf.Min(maskWidth, Mathf.CeilToInt((cellX + 1) * cellWidth));
            var y0 = Mathf.Max(0, Mathf.FloorToInt(cellY * cellHeight));
            var y1 = Mathf.Min(maskHeight, Mathf.CeilToInt((cellY + 1) * cellHeight));

            for (int y = y0; y < y1; y++)
            {
                var row = y * maskWidth;
                for (int x = x0; x < x1; x++)
                {
                    pixels[row + x] = color;
                }
            }
        }

        // ---------------------------------------------------------------- 坐标与工具

        /// <summary>
        /// 归一化点（左上原点、**y 向下**）→ 遮罩纹素坐标。
        ///
        /// 纹理数组是自下而上的，所以 y 翻一次（`(1 - y) × 高`）——与参考实现
        /// `MaskImage.ApplyEraseStroke` 的 `(1f - y) * maskRT.height` 同一行。
        /// </summary>
        private Vector2 ToTexel(Vector2 point)
        {
            return new Vector2(
                Mathf.Clamp01(point.x) * maskWidth,
                (1f - Mathf.Clamp01(point.y)) * maskHeight
            );
        }

        /// <summary>
        /// 遮罩尺寸：**与编辑器预览同一张**（`mask-math.ts` 的 `previewMaskSizeFor`）——
        /// 960 宽、高按贴图比例推（圆刷在屏幕上不变形），长边超 2048 等比缩一下。
        /// </summary>
        private static Vector2Int MaskSizeFor(MirrorImage image)
        {
            if (image == null)
            {
                return new Vector2Int(MaskPreviewWidth, FallbackMaskHeight);
            }

            var imageWidth = Mathf.Max(1, image.width);
            var aspect = Mathf.Max(1, image.height) / (float)imageWidth;
            var width = MaskPreviewWidth;
            var height = Mathf.Max(1, Mathf.RoundToInt(width * aspect));

            var longest = Mathf.Max(width, height);
            if (longest > MaxPreviewEdge)
            {
                var scale = MaxPreviewEdge / (float)longest;
                width = Mathf.Max(1, Mathf.RoundToInt(width * scale));
                height = Mathf.Max(1, Mathf.RoundToInt(height * scale));
            }

            return new Vector2Int(width, height);
        }

        /// <summary>把「哪几个区域算雾区」并成一个掩码；只认可绘制的 8 个位（手写文件里的脏位丢掉）。</summary>
        private static int RegionsToMask(int[] regions)
        {
            if (regions == null)
            {
                return 0;
            }

            var mask = 0;
            for (int i = 0; i < regions.Length; i++)
            {
                mask |= regions[i] & PaintableMask;
            }

            return mask;
        }

        /// <summary>格子数据的廉价指纹（FNV-1a）：涂了格子 / 换了绑定才重建，没变就别白干。</summary>
        private static uint HashCells(int[] cells, int count)
        {
            unchecked
            {
                var hash = 2166136261u;
                for (int i = 0; i < count; i++)
                {
                    hash = (hash ^ (uint)cells[i]) * 16777619u;
                }

                return hash;
            }
        }

        /// <summary>把 CPU 遮罩推给纹理，再重新羽化一次（雾边缘统一柔化）。
        /// 整张上传：960×540 这个量级一次几毫秒，一条命令一次，够用。</summary>
        private void Upload()
        {
            if (texture == null)
            {
                return;
            }

            texture.SetPixels32(pixels);
            texture.Apply(false);
            BlurFog();
        }

        // ---------------------------------------------------------------- 羽化

        /// <summary>要显示的那张图：羽化链的最后一级；链还没建起来时退回没羽化的遮罩。</summary>
        private Texture DisplayTexture =>
            blurRTs != null && blurRTs.Length > 0 && blurRTs[blurRTs.Length - 1] != null
                ? blurRTs[blurRTs.Length - 1]
                : texture;

        /// <summary>
        /// 把遮罩过一遍模糊链：`maskTexture → blurRTs[0] → … → blurRTs[last]`（最后一级给显示用）。
        ///
        /// 每一级都是「上一级的 3×3 高斯」，所以羽化宽度 ≈ 级数 × (1 / 每格纹素数) 格。
        /// **不写回遮罩**：遮罩永远是没羽化的真状态（擦除 / 重放都按它算），羽化只影响显示。
        /// </summary>
        private void BlurFog()
        {
            if (texture == null || !EnsureBlurChain())
            {
                return;
            }

            Graphics.Blit(texture, blurRTs[0], blurMaterial);
            for (int i = 1; i < blurRTs.Length; i++)
            {
                Graphics.Blit(blurRTs[i - 1], blurRTs[i], blurMaterial);
            }
        }

        /// <summary>
        /// 建 / 换模糊链（网格尺寸变了才重建）。每格 <see cref="BlurTexelsPerCell"/> 个纹素、边长封顶
        /// <see cref="MaxBlurEdge"/>，超出就整体等比缩——网格特别大时羽化会相对细一点，但不会吃光显存。
        /// </summary>
        private bool EnsureBlurChain()
        {
            if (blurMaterial == null)
            {
                var shader = Shader.Find(BlurShaderName);
                if (shader == null)
                {
                    // 找不到 shader 只提示一次：雾还能显示（没羽化），别每次推送都刷一条错误
                    if (!warnedMissingBlurShader)
                    {
                        warnedMissingBlurShader = true;
                        Debug.LogError($"[战争雾] 找不到 Shader「{BlurShaderName}」：雾能显示，但边缘不会羽化");
                    }

                    return false;
                }

                blurMaterial = new Material(shader) { hideFlags = HideFlags.DontSave };
            }

            var factor = Mathf.Min(BlurTexelsPerCell, MaxBlurEdge / (float)Mathf.Max(1, Mathf.Max(gridWidth, gridHeight)));
            var width = Mathf.Max(8, Mathf.RoundToInt(gridWidth * factor));
            var height = Mathf.Max(8, Mathf.RoundToInt(gridHeight * factor));

            if (blurRTs != null && blurWidth == width && blurHeight == height)
            {
                return true;
            }

            ReleaseBlurChain();
            blurWidth = width;
            blurHeight = height;

            var passes = Mathf.Max(1, blurPasses);
            blurRTs = new RenderTexture[passes];
            for (int i = 0; i < passes; i++)
            {
                blurRTs[i] = new RenderTexture(width, height, 0, RenderTextureFormat.ARGB32)
                {
                    name = $"FogBlur{i}",
                    filterMode = FilterMode.Bilinear,
                    wrapMode = TextureWrapMode.Clamp,
                    hideFlags = HideFlags.DontSave,
                };
            }

            return true;
        }

        private void ReleaseBlurChain()
        {
            if (blurRTs != null)
            {
                for (int i = 0; i < blurRTs.Length; i++)
                {
                    if (blurRTs[i] != null)
                    {
                        blurRTs[i].Release();
                        Release(blurRTs[i]);
                    }
                }

                blurRTs = null;
            }

            blurWidth = 0;
            blurHeight = 0;
        }

        private void WarnOnce(string message)
        {
            if (warnedMissingData)
            {
                return;
            }

            warnedMissingData = true;
            Debug.LogWarning($"[战争雾] {message}");
        }

        /// <summary>
        /// 释放自建的 Unity 对象：运行时用 `Destroy`，编辑器（退出播放的收尾 / EditMode 测试）
        /// 用 `DestroyImmediate`。本组件自己与 <see cref="SceneObjectView"/>（拆视频层）共用这一份
        /// ——同样的切换逻辑别留两份。
        /// </summary>
        internal static void Release(UnityEngine.Object owned)
        {
            if (Application.isPlaying)
            {
                Destroy(owned);
            }
            else
            {
                DestroyImmediate(owned);
            }
        }

        /// <summary>一次揭示操作：擦一笔，或整区开合。</summary>
        private struct MaskOp
        {
            public MaskOpKind kind;

            /// <summary>整区操作：区域位 + 是揭示还是盖回。</summary>
            public int region;
            public bool revealed;

            /// <summary>笔画：归一化半径 / 软边比例 / 归一化轨迹点（y 向下）。</summary>
            public float radius;
            public float softness;
            public List<Vector2> points;
        }

        private enum MaskOpKind
        {
            Stroke,
            Region,
        }
    }
}
