using System;
using System.IO;
using UnityEngine;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// 从已标定的单应反算**投影仪在垫子坐标系里的位姿**(2026-08-17)。
    ///
    /// ⚠ **2026-08-31 起已退役，运行时无人引用**：实物上色改走「单应锚定射线层」
    /// （见 <see cref="ProjectorCameraRig"/> 类注释）—— 那条链不需要内参、不需要位姿，
    /// 对近垂直吊装（单应≈仿射，位姿反解在数学上不存在）也成立。本文件保留作参考实现，
    /// 别再把它接回上色链。离线对照:Tools/projector_pose_from_homography.py。
    ///
    /// 用途:给「投影仪相机」摆位 —— 要把颜色投到立起来的实体棋子表面上,平面单应就不够了,
    /// 必须知道光线是从三维空间的哪一点、以什么姿态射出来的。平面内容照旧走预畸变链,与此无关。
    ///
    /// 数学:标定给的 <c>projectorToBoard</c> 是「投影帧 UV ↔ 垫子 UV」的平面单应。垫子物理尺寸已知,
    /// 于是 <c>G = K·[r1 r2 t]</c>(G: 垫面毫米 → 投影帧像素)。压三条假设 —— 方形像素、
    /// 主点水平居中、忽略畸变 —— 未知内参只剩焦距 f 与主点纵移 cy。
    ///
    /// ⚠ **单张平面单应解 f 与 cy 是欠定的**:r1⊥r2、|r1|=|r2| 两条约束下存在一条连续解谷
    /// (合成验证:cy 偏 800px,残差仍是机器零)。所以必须外部锚一个数 —— 这里用**投射比**,
    /// 它只在变焦拧到端点时才是已知量(极米 Z9X:广角端 0.98 / 长焦端 1.30)。
    /// 停在中间挡位的话厂商没有公布值,这个解就没有意义,故 <see cref="ZoomStop"/> 只有两档。
    ///
    /// 依赖:只吃 <c>ProjectionAlignmentController</c> 已有的标定结果,不需要相机、不需要卷尺。
    /// 精度天花板由「垫子尺寸 + 规格书投射比 + 戳点标定残差」共同决定;体检不过就别用。
    /// 参考实现与合成自检:<c>Tools/projector_pose_from_homography.py</c>。
    /// </summary>
    public static class ProjectorPoseSolver
    {
        /// <summary>变焦端点。中间挡位的投射比厂商没公布,不是可选项。</summary>
        public enum ZoomStop
        {
            /// <summary>界面 1.0x = 画面最小那头 = 投射比 1.30(垫子占的像素最多,画质最好)。</summary>
            Narrow_1_0x,

            /// <summary>界面 1.3x = 画面最大那头 = 投射比 0.98。</summary>
            Wide_1_3x,

            /// <summary>
            /// **不信规格书,按标定数据拟合投射比**(默认)。
            ///
            /// 起因(2026-08-17 实测):按 1.0x=1.30 解出来,垫子四角最大偏 17.5mm,
            /// 现场看就是「框和画面对不上」。扫一遍投射比发现拟合残差有个很尖的极小值 ——
            /// 0.75 处 0.3px,1.30 处 16.1px,差 50 倍。规格书那两个端点值在这台机器的
            /// 实际光路上根本不成立(窗口不是投影仪原生全屏、或机内还有一层数字缩放,都会
            /// 让「有效投射比」偏离镜头的光学投射比)。
            ///
            /// 拟合出来的值必须拿**卷尺**核对:解出的高度和实测镜头高对得上才可信。
            /// 这不是可选步骤 —— 拟合只保证「和标定自洽」,不保证「和物理一致」。
            /// </summary>
            AutoFit,
        }

        /// <summary>
        /// 现场拧出来的两个常数存在这两个 PlayerPrefs 键里。**单机预览与托管两条路都要读它们**，
        /// 所以放在求解器上作为唯一来源，别在各自那边再写一份字符串。
        /// </summary>
        public const string PrefThrowKey = "ProjectionAlignment.PoseThrow";
        public const string PrefMirrorKey = "ProjectionAlignment.MirrorAcrossY";

        /// <summary>这台装置实测出来的默认值（2026-08-18 灰模上色成功那一组）。见 README 6.5。</summary>
        public const float DefaultThrowRatio = 1.59f;
        public const bool DefaultMirrorAcrossY = true;

        /// <summary>拟合档的搜索范围与步长。0.6~1.7 覆盖了家用短焦到长焦的现实区间。</summary>
        const float AutoLo = 0.60f, AutoHi = 1.70f, AutoStep = 0.01f;

        public static float ThrowRatioOf(ZoomStop stop)
            => stop == ZoomStop.Narrow_1_0x ? 1.30f : (stop == ZoomStop.Wide_1_3x ? 0.98f : 0f);

        public static string LabelOf(ZoomStop stop)
        {
            if (stop == ZoomStop.Narrow_1_0x) return "1.0x（画面最小，投射比 1.30）";
            if (stop == ZoomStop.Wide_1_3x) return "1.3x（画面最大，投射比 0.98）";
            return "自动拟合（按标定数据反推投射比）";
        }

        /// <summary>
        /// 在 <paramref name="throwRatio"/> 处,K[R|t] 对标定单应的重投残差(像素)。
        /// 这是「这个投射比对不对」的直接判据 —— 位姿模型只有在投射比正确时才能贴合单应。
        /// </summary>
        public static float FitResidualPx(
            Matrix4x4 projectorToBoard, float matWidthMm, float matHeightMm,
            int pw, int ph, float throwRatio)
        {
            var r = Solve(projectorToBoard, matWidthMm, matHeightMm, pw, ph, throwRatio);
            if (!r.Solved) return float.MaxValue;
            if (!HomographyUtility.TryInvert(projectorToBoard, out Matrix4x4 inv)) return float.MaxValue;

            Matrix4x4 R = r.MatToProjector;
            Vector3 c0 = R.GetColumn(0), c1 = R.GetColumn(1), c2 = R.GetColumn(2);
            Vector3 C = r.PositionMm;
            var t = -new Vector3(c0.x * C.x + c1.x * C.y + c2.x * C.z,
                                 c0.y * C.x + c1.y * C.y + c2.y * C.z,
                                 c0.z * C.x + c1.z * C.y + c2.z * C.z);
            double sum = 0; int n = 0;
            for (int i = 0; i <= 4; i++)
            {
                for (int j = 0; j <= 4; j++)
                {
                    float u = i / 4f, v = j / 4f;
                    float mx = (r.MirroredX ? 1f - u : u) * matWidthMm;
                    float my = (r.MirroredY ? 1f - v : v) * matHeightMm;
                    if (!HomographyUtility.TryApply(inv, new Vector2(u, v), out Vector2 puv)) continue;
                    var expect = new Vector2(puv.x * pw, (1f - puv.y) * ph);
                    var p = new Vector3(c0.x * mx + c1.x * my + t.x,
                                        c0.y * mx + c1.y * my + t.y,
                                        c0.z * mx + c1.z * my + t.z);
                    if (Mathf.Abs(p.z) < 1e-6f) continue;
                    float px = r.FocalPx * p.x / p.z + pw * 0.5f;
                    float pyr = r.FocalPx * p.y / p.z + r.PrincipalY;
                    var got = new Vector2(px, r.FlippedV ? pyr : ph - pyr);
                    sum += (got - expect).sqrMagnitude; n++;
                }
            }
            return n < 4 ? float.MaxValue : Mathf.Sqrt((float)(sum / n));
        }

        /// <summary>扫出重投残差最小的投射比。返回 0 表示扫不出来。</summary>
        public static float FitThrowRatio(
            Matrix4x4 projectorToBoard, float matWidthMm, float matHeightMm,
            int pw, int ph, out float bestResidualPx)
        {
            bestResidualPx = float.MaxValue;
            float best = 0f;
            for (float th = AutoLo; th <= AutoHi + 1e-4f; th += AutoStep)
            {
                float res = FitResidualPx(projectorToBoard, matWidthMm, matHeightMm, pw, ph, th);
                if (res < bestResidualPx) { bestResidualPx = res; best = th; }
            }
            return best;
        }

        public struct Result
        {
            public bool Solved;
            public string Message;

            public float FocalPx;          // 方形像素,fx = fy
            public float PrincipalY;       // 主点纵坐标(常在帧外)
            public float VerticalFovDeg;   // 给 Unity 相机用
            public float LensShiftY;       // 给 Unity Physical Camera 用(帧高的倍数)
            public Vector3 PositionMm;     // 投影仪光心,垫子坐标系
            public Matrix4x4 MatToProjector;  // 垫子系 → 投影仪系的旋转(3x3 塞在左上角)
            public float PitchDeg;         // 光轴对垫面的俯角
            public float FitResidual;      // 约束违背度,仅参考(分布重尾,不能当判据)
            public float ThrowRatioUsed;   // 实际用的投射比(拟合档下就是拟合出来的那个值)

            /// <summary>
            /// **这一支还认不认得桌面**(px)。把「内容用的那套垫面坐标」直接投出来,和标定说的位置比。
            ///
            /// ⚠ 这和 <see cref="FitResidual"/> / FitResidualPx 是两回事,别混:那两个在**本支自己的
            /// 镜像坐标系里**自洽度量,八支算出来一模一样,分辨不了任何东西。而内容(落脚圆、色带、
            /// 游戏画面)是按**未镜像的**垫面坐标摆的 —— 一支的镜像位没跟内容对上,桌面上的东西就整块搬家。
            /// 实测:八支里只有两支是 0px,其余偏 45px 到 970px(接近半个画面)。
            /// **这才是「这一支能不能用」的判据。**
            /// </summary>
            public float PlaneRmsPx;
            public bool ChecksPassed;
            public string ChecksText;

            /// <summary>解用的是哪一支极性。**渲染端必须照抄,不能猜** —— 垫面 X 轴与投影帧 v 轴的
            /// 正负是标定把 flipX/flipY 烘进单应之后才定下来的,四支里只有一支和真实几何一致。</summary>
            public bool MirroredX;

            /// <summary>
            /// 垫面 y 轴的极性。**这一支才是「投影仪在垫子的哪一侧」**(2026-08-18 补上) ——
            /// 早先只枚举了 x,于是 y 的极性被锁死在标定烘进来的那一个,解出来的投影仪永远在同一侧。
            /// 表现:实体棋子的阴影朝一边、虚拟色带朝另一边,差约 180°,而平面上分毫不差。
            /// </summary>
            public bool MirroredY;

            /// <summary>true = 主点纵坐标 <see cref="PrincipalY"/> 从**画面顶边**往下量(图像惯例);
            /// false = 从底边往上量(Unity UV 惯例)。造投影矩阵时决定 cy 要不要先翻。</summary>
            public bool FlippedV;

            /// <summary>留一自举出来的高度抖动(cm)。&lt;0 = 没跑(拿不到标定样本)。</summary>
            public float HeightSpreadCm;

            /// <summary>同上,位置整体抖动(mm)。这个数直接决定能不能给棋子上色(见 SpreadVerdict)。</summary>
            public float PositionSpreadMm;

            /// <summary>把位置抖动折算成「3cm 高的棋子顶面会偏多少毫米」并给判词。</summary>
            public string SpreadVerdict
            {
                get
                {
                    if (PositionSpreadMm < 0f) return "不确定度：未测（没有标定样本）";
                    float parallaxMm = 30f * PositionSpreadMm / Mathf.Max(1f, PositionMm.z);
                    string verdict = parallaxMm <= 1f ? "✓ 够用" : parallaxMm <= 3f ? "△ 勉强" : "✗ 偏大";
                    return $"不确定度：位置 ±{PositionSpreadMm / 10f:F1}cm → 3cm 高棋子顶面偏 "
                         + $"{parallaxMm:F1}mm {verdict}";
                }
            }
        }

        const int ValleySamples = 361;
        const float CyLow = -6000f, CyHigh = 6000f;

        /// <summary>
        /// 解位姿。<paramref name="projectorToBoard"/> = 标定矩阵(投影 UV → 垫子 UV,y 朝上)。
        /// 垫子尺寸用毫米。失败时 <see cref="Result.Solved"/> 为 false,原因在 Message 里。
        /// </summary>
        public static Result Solve(
            Matrix4x4 projectorToBoard,
            float matWidthMm,
            float matHeightMm,
            int projectorWidth,
            int projectorHeight,
            float throwRatio,
            int branch = -1)
        {
            var result = new Result();
            if (matWidthMm < 1f || matHeightMm < 1f || projectorWidth < 2 || projectorHeight < 2)
            {
                result.Message = "垫子尺寸或投影分辨率无效。";
                return result;
            }
            if (throwRatio < 0.1f || throwRatio > 10f)
            {
                result.Message = "投射比超出合理范围。";
                return result;
            }
            if (!HomographyUtility.TryInvert(projectorToBoard, out Matrix4x4 boardToProjector))
            {
                result.Message = "标定矩阵不可逆 —— 先做一次戳点校正。";
                return result;
            }

            // 末行前两项 ≈ 0 = 这个单应没有透视成分,是一次仿射。位姿在数学上不存在
            // (仿射等价于「投影仪在无穷远」),没什么可解的。两种成因:
            //   ① 还没做过真标定 —— 默认预览矩阵就是纯仿射(编辑器里没接压感板时必然如此);
            //   ② 投影仪正对桌面垂直投影 —— 这台是斜着架的,不会。
            // 早先这里直接落到「谷上无解」那条,报错张口就怪梯形校正,把人往错方向带。
            float perspective = Mathf.Abs(projectorToBoard.m20) + Mathf.Abs(projectorToBoard.m21);
            if (perspective < 1e-4f)
            {
                result.Message = "当前标定矩阵没有透视成分（是默认的未标定矩阵）—— "
                               + "先接上压感垫、做一次戳点校正，再按 Z。";
                return result;
            }

            double[,] hbp = ToArray3x3(boardToProjector);
            double targetF = throwRatio * projectorWidth;
            double cx = projectorWidth * 0.5;

            // 标定把 flipX/flipY 烘进了矩阵,垫面系可能因此成左手系;投影帧 UV 原点在左下、
            // 而针孔模型习惯 y 朝下 —— 两个极性各两种,四支全解,靠物理体检挑。
            //
            // ⚠ **体检挑不动 mirrorX(2026-08-18 实测)。** 把垫子的 u 镜像一次、再把位姿镜像
            // 一次,得到的是**同一个单应**,平面上的重投残差一模一样 —— 这不是判据能分辨的东西,
            // 是个规范(gauge)选择。ScoreOf 的四支于是常常并列 0 分,最后拿到的是循环顺序里的
            // 第一支,纯属偶然。它在桌面上完全看不出来,但它决定**投影仪在垫子的哪一侧**,
            // 于是所有有高度的东西都会朝反方向拖。照片实测:圆柱的实体阴影与虚拟色带**尺寸相同、
            // 方向差约 180°**,正是选错支的样子。所以 <paramref name="branch"/> 必须能由外面指定。
            Result best = default;
            double bestScore = double.MaxValue;
            for (int mirrorX = 0; mirrorX < 2; mirrorX++)
            {
                for (int mirrorY = 0; mirrorY < 2; mirrorY++)
                {
                    for (int flipV = 0; flipV < 2; flipV++)
                    {
                        if (branch >= 0 && branch != BranchIndex(mirrorX == 1, mirrorY == 1, flipV == 1)) continue;
                        double[,] G = BuildMetricToPixel(
                            hbp, matWidthMm, matHeightMm, projectorWidth, projectorHeight,
                            mirrorX == 1, mirrorY == 1, flipV == 1);
                        if (G == null) continue;

                        if (!TryAnchorOnValley(G, cx, targetF, out double cy)) continue;
                        double f = SolveFocalForCy(G, cx, cy, out double residual);
                        if (!Decompose(G, cx, f, cy, out Matrix4x4 R, out Vector3 posMm)) continue;

                        var candidate = Finish(f, cy, posMm, R, projectorWidth, projectorHeight,
                                               throwRatio, residual);
                        candidate.MirroredX = mirrorX == 1;
                        candidate.MirroredY = mirrorY == 1;
                        candidate.FlippedV = flipV == 1;
                        candidate.PlaneRmsPx = PlaneRms(
                            candidate, boardToProjector, matWidthMm, matHeightMm,
                            projectorWidth, projectorHeight);
                        // 先按「认不认得桌面」硬分层,再看体检 —— 反过来的话
                        // 会挑到一支高度好看、但把整块桌面搬走 970px 的解。
                        double score = ScoreOf(candidate)
                                     + (candidate.PlaneRmsPx > PlaneRmsLimitPx ? 1e6 + candidate.PlaneRmsPx : 0);
                        if (score < bestScore)
                        {
                            bestScore = score;
                            best = candidate;
                        }
                    }
                }
            }

            if (!best.Solved)
            {
                best.Message = "谷上找不到满足这个投射比的解 —— 十有八九是投影仪的自动梯形校正还开着"
                             + "（它会在单应里掺一层非针孔形变），关掉后重做戳点校正再试。";
            }
            return best;
        }

        /// <summary>
        /// 留一自举:每次抽掉一个标定点重拟合单应、重解位姿,看答案抖多少。
        /// **这才是可信度判据** —— 约束残差在噪声下重尾到没法用(见 Finish 的注释),
        /// 而「抽掉一个点答案就跑几十厘米」直接说明这份标定撑不住位姿反算。
        /// 拿不到样本(&lt;6 个)时把两个 Spread 留成 -1,由 SpreadVerdict 报「未测」。
        /// </summary>
        public static void AddBootstrapSpread(
            ref Result result,
            System.Collections.Generic.IReadOnlyList<CalibrationSample> samples,
            float matWidthMm, float matHeightMm, int pw, int ph, float throwRatio)
        {
            result.HeightSpreadCm = -1f;
            result.PositionSpreadMm = -1f;
            if (!result.Solved || samples == null || samples.Count < 6) return;

            var positions = new System.Collections.Generic.List<Vector3>();
            var subset = new System.Collections.Generic.List<CalibrationSample>(samples.Count - 1);
            for (int skip = 0; skip < samples.Count; skip++)
            {
                subset.Clear();
                for (int i = 0; i < samples.Count; i++)
                    if (i != skip) subset.Add(samples[i]);

                var fit = HomographySolver.Solve(subset);
                if (!fit.success) continue;
                var r = Solve(fit.projectorToBoard, matWidthMm, matHeightMm, pw, ph, throwRatio);
                if (r.Solved) positions.Add(r.PositionMm);
            }
            if (positions.Count < 3) return;

            Vector3 mean = Vector3.zero;
            foreach (var p in positions) mean += p;
            mean /= positions.Count;
            float sumSq = 0f, sumSqZ = 0f;
            foreach (var p in positions)
            {
                sumSq += (p - mean).sqrMagnitude;
                sumSqZ += (p.z - mean.z) * (p.z - mean.z);
            }
            result.PositionSpreadMm = Mathf.Sqrt(sumSq / positions.Count);
            result.HeightSpreadCm = Mathf.Sqrt(sumSqZ / positions.Count) / 10f;
        }

        // ---------- 组装 G:垫面毫米 → 投影帧像素 ----------

        static double[,] BuildMetricToPixel(
            double[,] boardToProjector, float wMm, float hMm, int pw, int ph,
            bool mirrorX, bool mirrorY, bool flipV)
        {
            double[] rx = mirrorX ? new[] { -1.0 / wMm, 0.0, 1.0 } : new[] { 1.0 / wMm, 0.0, 0.0 };
            double[] ry = mirrorY ? new[] { 0.0, -1.0 / hMm, 1.0 } : new[] { 0.0, 1.0 / hMm, 0.0 };
            double[,] mmToUv = { { rx[0], rx[1], rx[2] }, { ry[0], ry[1], ry[2] }, { 0, 0, 1 } };
            double[,] uvToPx = flipV
                ? new double[,] { { pw, 0, 0 }, { 0, -ph, ph }, { 0, 0, 1 } }
                : new double[,] { { pw, 0, 0 }, { 0, ph, 0 }, { 0, 0, 1 } };

            double[,] G = Mul(uvToPx, Mul(boardToProjector, mmToUv));
            if (Math.Abs(G[2, 2]) < 1e-12) return null;
            double s = 1.0 / G[2, 2];
            for (int r = 0; r < 3; r++)
                for (int c = 0; c < 3; c++)
                    G[r, c] *= s;
            return G;
        }

        // ---------- 解谷 ----------

        /// <summary>两条内约束(r1⊥r2、|r1|=|r2|)的无量纲残差平方和。</summary>
        static double ConstraintResidual(double[,] G, double cx, double f, double cy)
        {
            if (f < 1e-6) return double.MaxValue;
            // A = K⁻¹G,逐列展开(K⁻¹ 只有三项非平凡,不必真的建矩阵)
            double a1x = (G[0, 0] - cx * G[2, 0]) / f;
            double a1y = (G[1, 0] - cy * G[2, 0]) / f;
            double a1z = G[2, 0];
            double a2x = (G[0, 1] - cx * G[2, 1]) / f;
            double a2y = (G[1, 1] - cy * G[2, 1]) / f;
            double a2z = G[2, 1];

            double n1 = a1x * a1x + a1y * a1y + a1z * a1z;
            double n2 = a2x * a2x + a2y * a2y + a2z * a2z;
            if (n1 < 1e-18 || n2 < 1e-18) return double.MaxValue;
            double dot = (a1x * a2x + a1y * a2y + a1z * a2z) / Math.Sqrt(n1 * n2);
            double iso = (n1 - n2) / (n1 + n2);
            return dot * dot + iso * iso;
        }

        /// <summary>cy 固定时把约束压到最低的 f:对数粗扫 + 黄金分割。</summary>
        static double SolveFocalForCy(double[,] G, double cx, double cy, out double residual)
        {
            const double lo = 200.0, hi = 20000.0;
            const int coarse = 300;
            double bestF = lo, bestC = double.MaxValue;
            double logLo = Math.Log(lo), step = (Math.Log(hi) - logLo) / (coarse - 1);
            for (int i = 0; i < coarse; i++)
            {
                double f = Math.Exp(logLo + step * i);
                double c = ConstraintResidual(G, cx, f, cy);
                if (c < bestC) { bestC = c; bestF = f; }
            }

            double a = bestF / Math.Exp(step), b = bestF * Math.Exp(step);
            const double phi = 0.6180339887498949;
            for (int i = 0; i < 90; i++)
            {
                double c1 = b - phi * (b - a), c2 = a + phi * (b - a);
                if (ConstraintResidual(G, cx, c1, cy) < ConstraintResidual(G, cx, c2, cy)) b = c2;
                else a = c1;
            }
            double f2 = (a + b) * 0.5;
            residual = ConstraintResidual(G, cx, f2, cy);
            return f2;
        }

        /// <summary>沿谷找「f 正好等于目标投射比对应值」的那个 cy(符号变化处线性插值)。</summary>
        static bool TryAnchorOnValley(double[,] G, double cx, double targetF, out double cy)
        {
            cy = 0;
            double prevCy = CyLow, prevDiff = 0;
            bool havePrev = false;
            double step = (CyHigh - CyLow) / (ValleySamples - 1);
            for (int i = 0; i < ValleySamples; i++)
            {
                double c = CyLow + step * i;
                double f = SolveFocalForCy(G, cx, c, out double res);
                if (res > 5e-3) { havePrev = false; continue; }   // 不在谷上
                double diff = f - targetF;
                if (havePrev && (diff == 0 || prevDiff * diff < 0))
                {
                    // 二分精化(线性插值只在谷近似线性时够准)。区间端点的符号在进入前就定了,
                    // 循环里只算中点 —— 早先每轮重算 loC 的符号,白跑一倍的求解。
                    double loC = prevCy, hiC = c, loDiff = prevDiff;
                    for (int k = 0; k < 60; k++)
                    {
                        double mid = (loC + hiC) * 0.5;
                        double dm = SolveFocalForCy(G, cx, mid, out _) - targetF;
                        if (loDiff * dm > 0) { loC = mid; loDiff = dm; }
                        else hiC = mid;
                    }
                    cy = (loC + hiC) * 0.5;
                    return true;
                }
                prevCy = c;
                prevDiff = diff;
                havePrev = true;
            }
            return false;
        }

        // ---------- 分解 ----------

        /// <summary>
        /// G ≅ K[r1 r2 t] → R、位置。R 的正交化用 Malis-Vargas 闭式解(不需要 SVD)。
        ///
        /// ⚠ 整体符号两支 (R,t) 与 (−R,−t),**必须按 t.z &gt; 0(垫子在相机前方)挑**。
        /// 曾经改成按「相机在桌面上方 C.z 最大」挑,那是个空判据:C = −Rᵀt,
        /// 对 (−R,−t) 算出来 C' = −(−R)ᵀ(−t) = −Rᵀt = C —— **两支的 C 完全相同**,
        /// 于是实际选中的是任意一支。症状:自检算出来 0.0002px 完美通过,
        /// 但投影仪相机渲出来整幅全透明 —— 因为整块垫子都在相机背后(clip.w 为负,
        /// 齐次除法把符号吃掉了,数值上照样"对齐")。
        /// 「相机在桌面上方」这条由 <see cref="physics_checks"/> 的高度项去查,不在这里判。
        /// </summary>
        static bool Decompose(double[,] G, double cx, double f, double cy,
                              out Matrix4x4 rotation, out Vector3 positionMm)
        {
            rotation = Matrix4x4.identity;
            positionMm = Vector3.zero;
            if (f < 1e-6) return false;

            var a1 = new Vector3d((G[0, 0] - cx * G[2, 0]) / f, (G[1, 0] - cy * G[2, 0]) / f, G[2, 0]);
            var a2 = new Vector3d((G[0, 1] - cx * G[2, 1]) / f, (G[1, 1] - cy * G[2, 1]) / f, G[2, 1]);
            var a3 = new Vector3d((G[0, 2] - cx * G[2, 2]) / f, (G[1, 2] - cy * G[2, 2]) / f, G[2, 2]);

            double n1 = a1.Length, n2 = a2.Length;
            if (n1 < 1e-12 || n2 < 1e-12) return false;
            double lambda = 2.0 / (n1 + n2);

            bool found = false;
            foreach (double sign in new[] { 1.0, -1.0 })
            {
                Vector3d r1 = a1 * (sign * lambda);
                Vector3d r2 = a2 * (sign * lambda);
                Vector3d t = a3 * (sign * lambda);
                if (t.Z <= 0) continue;      // 垫子必须在相机**前方**;见方法注释
                if (!Orthonormalize(r1, r2, out Vector3d o1, out Vector3d o2, out Vector3d o3)) continue;

                // ⚠ o1/o2/o3 是 R 的**列**(G = K[r1 r2 t] 里 r1、r2 就是 R 的前两列)。
                // C = -Rᵀt,而 Rᵀ 的行才是 o1/o2/o3 —— 所以每个分量是一次 oi·t 的点乘。
                var C = new Vector3d(
                    -(o1.X * t.X + o1.Y * t.Y + o1.Z * t.Z),
                    -(o2.X * t.X + o2.Y * t.Y + o2.Z * t.Z),
                    -(o3.X * t.X + o3.Y * t.Y + o3.Z * t.Z));
                var m = Matrix4x4.identity;
                m.m00 = (float)o1.X; m.m10 = (float)o1.Y; m.m20 = (float)o1.Z;   // 第一列
                m.m01 = (float)o2.X; m.m11 = (float)o2.Y; m.m21 = (float)o2.Z;   // 第二列
                m.m02 = (float)o3.X; m.m12 = (float)o3.Y; m.m22 = (float)o3.Z;   // 第三列
                rotation = m;
                positionMm = new Vector3((float)C.X, (float)C.Y, (float)C.Z);
                found = true;
            }
            return found;
        }

        /// <summary>
        /// 给一对近似正交的向量求「最接近的正交单位对」(Malis &amp; Vargas 闭式解):
        /// c 平分两者,d 是 c 在两者张成平面内的垂线,取 c±d 方向各转 45° 即得。
        /// </summary>
        static bool Orthonormalize(Vector3d r1, Vector3d r2,
                                   out Vector3d o1, out Vector3d o2, out Vector3d o3)
        {
            o1 = o2 = o3 = default;
            Vector3d c = r1 + r2;
            Vector3d p = Vector3d.Cross(r1, r2);
            Vector3d d = Vector3d.Cross(c, p);
            if (c.Length < 1e-12 || d.Length < 1e-12) return false;
            Vector3d cn = c.Normalized, dn = d.Normalized;
            const double invSqrt2 = 0.7071067811865476;
            o1 = (cn + dn) * invSqrt2;
            o2 = (cn - dn) * invSqrt2;
            o3 = Vector3d.Cross(o1, o2);
            return o3.Length > 1e-9;
        }

        // ---------- 收尾与体检 ----------

        static Result Finish(double f, double cy, Vector3 posMm, Matrix4x4 R,
                             int pw, int ph, float throwRatio, double residual)
        {
            var r = new Result
            {
                Solved = true,
                FocalPx = (float)f,
                PrincipalY = (float)cy,
                PositionMm = posMm,
                MatToProjector = R,
                VerticalFovDeg = 2f * Mathf.Rad2Deg * Mathf.Atan(ph / (2f * (float)f)),
                LensShiftY = (float)((cy - ph * 0.5) / ph),
                ThrowRatioUsed = throwRatio,
            };
            // 光轴在垫子系里的方向 = R 的第三行
            float axisZ = Mathf.Clamp(Mathf.Abs(R.m22), 0f, 1f);
            r.PitchDeg = Mathf.Rad2Deg * Mathf.Asin(axisZ);

            float heightCm = posMm.z / 10f;
            float shift = r.LensShiftY;
            // 只查两项「像不像一台真摆在灯架上的投影仪」。投射比不查 —— 它是输入(端点查表值),
            // 查它等于查自己。
            //
            // ⚠ **约束残差不能当判据**(2026-08-17 实测):拿合成的纯针孔投影仪 + 10 个标定点、
            // 加 6mm 取点噪声(= 真机 RMS 1.21 格的量级)重拟合,残差的中位数是 6.8e-8 而**最大值
            // 到 2.0e-3** —— 分布重尾跨五个数量级。早先按 1e-4 卡「数据非针孔」会把纯噪声误判成
            // 梯形校正污染(真机那份 9.2e-4 就被误报过)。残差只作参考打印。
            // 真正的可信度看 <see cref="Result.HeightSpreadCm"/>(留一自举出来的位姿抖动)。
            bool okHeight = heightCm >= 30f && heightCm <= 300f;
            bool okShift = Mathf.Abs(shift) <= 1.6f;
            r.FitResidual = (float)residual;
            r.ChecksPassed = okHeight && okShift;
            r.ChecksText =
                $"高度 {heightCm:F0}cm {(okHeight ? "✓" : "✗ 应在 30~300")}　" +
                $"lens-shift {shift:+0.00;-0.00} {(okShift ? "✓" : "✗ |值| 应 ≲1.6")}　" +
                $"拟合 {residual:0.0e+0}（仅参考）";
            r.Message = r.ChecksPassed
                ? $"位姿已解出：高 {heightCm:F0}cm、俯角 {r.PitchDeg:F0}°、垂直FOV {r.VerticalFovDeg:F1}°、"
                  + $"投射比 {throwRatio:F2}。"
                : "位姿解出来了，但物理体检没过 —— 先确认投影仪的自动梯形校正已关、变焦停在端点（1.0x 或 1.3x），"
                  + "并且戳点校正是关掉梯形校正之后重做的。";
            return r;
        }

        /// <summary>四个极性分支里挑哪一支:体检项越像一台真投影仪越小。</summary>
        /// <summary>
        /// 把**未镜像的**垫面坐标经这一支的 K[R|t] 投成投影像素,和标定单应说的位置比,取 RMS。
        /// 见 <see cref="Result.PlaneRmsPx"/> —— 这是挑支的唯一硬判据。
        /// </summary>
        static float PlaneRms(in Result r, Matrix4x4 boardToProjector,
                              float matWidthMm, float matHeightMm, int pw, int ph)
        {
            Matrix4x4 R = r.MatToProjector;
            Vector3 c0 = R.GetColumn(0), c1 = R.GetColumn(1), c2 = R.GetColumn(2);
            Vector3 C = r.PositionMm;
            var t = -new Vector3(c0.x * C.x + c1.x * C.y + c2.x * C.z,
                                 c0.y * C.x + c1.y * C.y + c2.y * C.z,
                                 c0.z * C.x + c1.z * C.y + c2.z * C.z);
            double sum = 0; int n = 0;
            for (int i = 0; i <= 4; i++)
            {
                for (int j = 0; j <= 4; j++)
                {
                    float u = i / 4f, v = j / 4f;
                    if (!HomographyUtility.TryApply(boardToProjector, new Vector2(u, v), out Vector2 puv)) continue;
                    var expect = new Vector2(puv.x * pw, (1f - puv.y) * ph);
                    float mx = u * matWidthMm, my = v * matHeightMm;
                    var p = new Vector3(c0.x * mx + c1.x * my + t.x,
                                        c0.y * mx + c1.y * my + t.y,
                                        c0.z * mx + c1.z * my + t.z);
                    if (p.z <= 1e-6f) return float.MaxValue;
                    float px = r.FocalPx * p.x / p.z + pw * 0.5f;
                    float py = r.FocalPx * p.y / p.z + r.PrincipalY;
                    sum += (new Vector2(px, py) - expect).sqrMagnitude; n++;
                }
            }
            return n < 4 ? float.MaxValue : Mathf.Sqrt((float)(sum / n));
        }

        /// <summary>桌面偏差超过这个就说明这一支和内容坐标系没对上,不是可选项。</summary>
        public const float PlaneRmsLimitPx = 3f;

        /// <summary>(mirrorX, mirrorY, flipV) → 0..7。见 Solve 里关于「体检挑不动镜像支」的注释。</summary>
        public static int BranchIndex(bool mirroredX, bool mirroredY, bool flippedV)
            => (mirroredX ? 4 : 0) + (mirroredY ? 2 : 0) + (flippedV ? 1 : 0);

        static double ScoreOf(Result r)
        {
            if (!r.Solved) return double.MaxValue;
            double score = 0;
            float heightCm = r.PositionMm.z / 10f;
            if (heightCm < 30f || heightCm > 300f) score += 1000 + Math.Abs(heightCm - 120f);
            if (Mathf.Abs(r.LensShiftY) > 1.6f) score += 100 + Math.Abs(r.LensShiftY);
            if (r.PitchDeg < 10f || r.PitchDeg > 89f) score += 50;
            return score;
        }

        // ---------- 存盘 ----------

        public const string FileName = "projector_pose.json";

        public static string FilePath => Path.Combine(
            Application.persistentDataPath, "ProjectionAlignment", FileName);

        [Serializable]
        private sealed class Payload
        {
            public string createdUtc;
            public float throwRatio;
            public int projectorWidth, projectorHeight;
            public float focalPx, principalX, principalY;
            public float verticalFovDeg, lensShiftY;
            public float[] positionMm;
            public float[] matToProjector;   // 行主序 3x3
            public float pitchDeg;
            public bool checksPassed;
            public string checksText;
            public bool mirroredX;
            public bool mirroredY;
            public bool flippedV;
            public float matWidthMm, matHeightMm;
            public float positionSpreadMm;
        }

        public static bool TrySave(Result r, float throwRatio, int pw, int ph, out string error)
            => TrySave(r, throwRatio, pw, ph, 0f, 0f, out error);

        public static bool TrySave(Result r, float throwRatio, int pw, int ph,
                                   float matWidthMm, float matHeightMm, out string error)
        {
            error = string.Empty;
            if (!r.Solved) { error = "没有可保存的解。"; return false; }
            try
            {
                var m = r.MatToProjector;
                var payload = new Payload
                {
                    createdUtc = DateTime.UtcNow.ToString("o"),
                    throwRatio = throwRatio,
                    projectorWidth = pw,
                    projectorHeight = ph,
                    focalPx = r.FocalPx,
                    principalX = pw * 0.5f,
                    principalY = r.PrincipalY,
                    verticalFovDeg = r.VerticalFovDeg,
                    lensShiftY = r.LensShiftY,
                    positionMm = new[] { r.PositionMm.x, r.PositionMm.y, r.PositionMm.z },
                    matToProjector = new[]
                    {
                        m.m00, m.m01, m.m02,
                        m.m10, m.m11, m.m12,
                        m.m20, m.m21, m.m22,
                    },
                    pitchDeg = r.PitchDeg,
                    checksPassed = r.ChecksPassed,
                    checksText = r.ChecksText,
                    mirroredX = r.MirroredX,
                    mirroredY = r.MirroredY,
                    flippedV = r.FlippedV,
                    matWidthMm = matWidthMm,
                    matHeightMm = matHeightMm,
                    positionSpreadMm = r.PositionSpreadMm,
                };
                string folder = Path.GetDirectoryName(FilePath);
                if (!string.IsNullOrEmpty(folder)) Directory.CreateDirectory(folder);
                File.WriteAllText(FilePath, JsonUtility.ToJson(payload, true));
                return true;
            }
            catch (Exception e)
            {
                error = e.Message;
                return false;
            }
        }

        // ---------- 小工具 ----------

        static double[,] ToArray3x3(Matrix4x4 m) => new double[,]
        {
            { m.m00, m.m01, m.m02 },
            { m.m10, m.m11, m.m12 },
            { m.m20, m.m21, m.m22 },
        };

        static double[,] Mul(double[,] a, double[,] b)
        {
            var r = new double[3, 3];
            for (int i = 0; i < 3; i++)
                for (int j = 0; j < 3; j++)
                {
                    double s = 0;
                    for (int k = 0; k < 3; k++) s += a[i, k] * b[k, j];
                    r[i, j] = s;
                }
            return r;
        }

        /// <summary>分解要 double 精度:焦距量级 1e3、位置量级 1e3,float 会在正交化那步吃掉两位有效数字。</summary>
        private struct Vector3d
        {
            public double X, Y, Z;
            public Vector3d(double x, double y, double z) { X = x; Y = y; Z = z; }
            public double Length => Math.Sqrt(X * X + Y * Y + Z * Z);
            public Vector3d Normalized
            {
                get { double n = Length; return n < 1e-15 ? this : new Vector3d(X / n, Y / n, Z / n); }
            }
            public static Vector3d operator +(Vector3d a, Vector3d b) => new Vector3d(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
            public static Vector3d operator -(Vector3d a, Vector3d b) => new Vector3d(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
            public static Vector3d operator *(Vector3d a, double s) => new Vector3d(a.X * s, a.Y * s, a.Z * s);
            public static Vector3d Cross(Vector3d a, Vector3d b) => new Vector3d(
                a.Y * b.Z - a.Z * b.Y, a.Z * b.X - a.X * b.Z, a.X * b.Y - a.Y * b.X);
        }
    }
}
