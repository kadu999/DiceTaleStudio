using UnityEngine;

namespace NuLight.ProjectionAlignment
{
    /// <summary>
    /// 把一台 Unity 相机变成**投影仪本身**：站在镜头位置 `C`，投影矩阵使得它的 NDC 恰好落在板 UV 上。
    ///
    /// 依据：真实投影仪里经过某个像素的光线穿过 `C`；这条光线打到桌面的点 `M` 由标定单应 `H` 唯一确定。
    /// 所以「世界点 X → 从 C 中心投影到桌面得 M → M 的板 UV」这个映射，就是投影仪的成像映射
    /// （差一个 `H`，而 `H` 正是预畸变 shader 已经在做的那一步）。两段都是射影变换，合起来仍是一个 4×4。
    ///
    /// **不需要投影仪内参**：焦距、lens shift、机内数字形变全在 `H` 里，本类只用 `C` 的三个厘米数。
    /// **不需要分解 `H`**：旧的 <see cref="ProjectorPoseSolver"/> 要把 H 拆成 K[R|t]，近垂直吊装下无解；
    /// 这里从头到尾没有分解，`C` 是量出来的物理量。
    ///
    /// 用法：<see cref="Apply"/> 每帧调一次（相机 rect 被改动时 Unity 会重算隐式投影，显式矩阵要补回去）。
    /// </summary>
    public static class ProjectorFrustum
    {
        /// <summary>
        /// 按「垫子中心 + 尺寸 + 高度方向」搭一个板 UV 框架。
        /// 列 0 = 板 U 方向 × 垫宽、列 1 = 板 V 方向 × 垫深、列 2 = 高度方向 × 每厘米单位数、列 3 = 板 (0,0) 角。
        /// 板 (0,0) 取**左上**（U 沿 +right、V 沿 −forward），与预畸变链的游戏 UV 左上原点一致。
        /// </summary>
        public static Matrix4x4 BuildBoardFrame(
            Vector3 matCentre, float matWidthCm, float matHeightCm, float unitsPerCm,
            Vector3 right, Vector3 forward, Vector3 up)
        {
            Vector3 ex = right.normalized * (matWidthCm * unitsPerCm);
            Vector3 ey = -forward.normalized * (matHeightCm * unitsPerCm);
            Vector3 eh = up.normalized * unitsPerCm;
            Vector3 origin = matCentre - ex * 0.5f - ey * 0.5f;
            return new Matrix4x4(
                new Vector4(ex.x, ex.y, ex.z, 0f),
                new Vector4(ey.x, ey.y, ey.z, 0f),
                new Vector4(eh.x, eh.y, eh.z, 0f),
                new Vector4(origin.x, origin.y, origin.z, 1f));
        }

        /// <summary>板框架下的「垫面厘米 + 高度厘米」→ 世界。</summary>
        public static Vector3 MatCmToWorld(Matrix4x4 frame, Vector3 cm, float matWidthCm, float matHeightCm)
        {
            return (Vector3)frame.GetColumn(3)
                 + (Vector3)frame.GetColumn(0) * (cm.x / matWidthCm)
                 + (Vector3)frame.GetColumn(1) * (cm.y / matHeightCm)
                 + (Vector3)frame.GetColumn(2) * cm.z;
        }

        /// <summary>
        /// 把相机摆到 `C` 并写死投影矩阵，使 NDC ≡ 板 UV（x: u→[-1,1]，y: v→[1,-1]，v 朝下）。
        /// 给了 <paramref name="boardUvWindow"/> 就 ≡ 那个窗口：装置把画面往垫子外多画一圈（外扩）时，
        /// 视口比垫子大那一圈，NDC 要盖住的是视口，否则垫子会被拉伸到整个视口上。
        /// 返回 false 表示自检没过（垫角落在相机背后 / 解不出来），此时相机不会被改动。
        /// </summary>
        public static bool Apply(Camera cam, Matrix4x4 frame, Vector3 lensCm,
                                 float matWidthCm, float matHeightCm, out string message,
                                 Rect boardUvWindow = default)
        {
            message = string.Empty;
            if (cam == null) { message = "没有相机。"; return false; }

            Vector3 lensWorld = MatCmToWorld(frame, lensCm, matWidthCm, matHeightCm);
            Vector3 centre = MatCmToWorld(frame, new Vector3(matWidthCm * 0.5f, matHeightCm * 0.5f, 0f),
                                          matWidthCm, matHeightCm);
            Vector3 fwd = centre - lensWorld;
            if (fwd.sqrMagnitude < 1e-10f) { message = "镜头位置和垫子中心重合。"; return false; }

            // up 提示取**板 V 的反向**（画面上方 = 板 V 小的一侧），镜头近垂直时它与视线接近垂直、永不退化。
            // 取正 V 会让校正单应变成 180° 旋转、`m11` 变负 —— URP 把负 m11 当成「投影已翻转」
            // 又补一次 Y 翻转，叠起来就是左右镜像（踩过）。反向之后单应接近恒等，符号问题从源头消失。
            Vector3 upHint = -(Vector3)frame.GetColumn(1);
            if (Vector3.Cross(fwd, upHint).sqrMagnitude < 1e-10f) upHint = frame.GetColumn(0);

            var prevPos = cam.transform.position;
            var prevRot = cam.transform.rotation;
            cam.transform.SetPositionAndRotation(lensWorld, Quaternion.LookRotation(fwd.normalized, upHint.normalized));

            // ① 先搭一个「罩得住垫子」的普通透视基准锥。它的内参无所谓 —— 下一步的单应会把它拧到位。
            cam.ResetProjectionMatrix();
            cam.usePhysicalProperties = false;
            cam.orthographic = false;
            float aspect = cam.aspect > 1e-4f ? cam.aspect : 16f / 9f;
            float halfTan = 0.05f, minZ = float.MaxValue, maxZ = 0f;
            Rect window = boardUvWindow.width > 1e-6f && boardUvWindow.height > 1e-6f
                ? boardUvWindow
                : new Rect(0f, 0f, 1f, 1f);
            var cornersWorld = new Vector3[4];
            for (int i = 0; i < 4; i++)
            {
                float u = window.xMin + (i & 1) * window.width;
                float v = window.yMin + ((i >> 1) & 1) * window.height;
                cornersWorld[i] = MatCmToWorld(frame,
                    new Vector3(u * matWidthCm, v * matHeightCm, 0f), matWidthCm, matHeightCm);
                Vector3 local = cam.transform.InverseTransformPoint(cornersWorld[i]);
                if (local.z < 1e-4f)
                {
                    cam.transform.SetPositionAndRotation(prevPos, prevRot);
                    message = "✗ 垫子有角落落在镜头背后 —— 镜头高度是不是拧成了负数？";
                    return false;
                }
                halfTan = Mathf.Max(halfTan, Mathf.Abs(local.y) / local.z);
                halfTan = Mathf.Max(halfTan, Mathf.Abs(local.x) / local.z / aspect);
                minZ = Mathf.Min(minZ, local.z);
                maxZ = Mathf.Max(maxZ, local.z);
            }
            cam.fieldOfView = 2f * Mathf.Rad2Deg * Mathf.Atan(halfTan * 1.25f);
            cam.nearClipPlane = Mathf.Max(1e-4f, minZ * 0.02f);
            cam.farClipPlane = maxZ * 8f;

            // ② 基准锥与目标成像**共用光心 C**，所以两者之间只差一个 2D 单应，与深度无关。
            //    拿窗口四角标定它：基准 NDC ↦ 目标 NDC(= 板 UV 窗口)。
            Matrix4x4 baseVp = cam.projectionMatrix * cam.worldToCameraMatrix;
            var src = new Vector2[4];
            var dst = new Vector2[4];
            for (int i = 0; i < 4; i++)
            {
                Vector3 w = cornersWorld[i];
                Vector4 clip = baseVp * new Vector4(w.x, w.y, w.z, 1f);
                src[i] = new Vector2(clip.x / clip.w, clip.y / clip.w);
                float u = i & 1, v = (i >> 1) & 1;
                dst[i] = new Vector2(2f * u - 1f, 1f - 2f * v);   // 板 V 朝下 → NDC y 取反
            }
            if (!SolveHomography(src, dst, out Matrix4x4 lift))
            {
                cam.transform.SetPositionAndRotation(prevPos, prevRot);
                cam.ResetProjectionMatrix();
                message = "✗ 垫子四角解不出单应（框架退化？）。";
                return false;
            }

            // ③ lift 作用在裁剪坐标的 (x, y, w) 上。同一像素上 w 被缩放同一个系数，
            //    所以 z/w 沿每条光线的**大小关系不变** —— 遮挡不需要另外修正。
            Matrix4x4 corrected = lift * cam.projectionMatrix;
            if (corrected.m11 <= 0f)
            {
                // 负的 m11 会被 URP 当成「投影已翻转」再补一次 Y 翻 —— 画面会左右镜像。
                cam.transform.SetPositionAndRotation(prevPos, prevRot);
                cam.ResetProjectionMatrix();
                message = "✗ 校正单应把 y 轴翻了过来（m11 ≤ 0）—— 板框架的 V 方向或 up 提示写反了。";
                return false;
            }

            // ④ 但 z 行不能原样透传。裁剪判据是 −w ≤ z ≤ w：w 行已经换成 lift 之后的 w'，z 行若还是
            //    基准锥的，近/远两张裁剪面就是 z = ±w' 解出来的两张**斜面**，不再是基准锥的近/远面。
            //    镜头在垫子正中时 w' ≡ w，看不出差别；镜头一偏离正中（lift 带透视项），远面就斜切过
            //    桌面，背对镜头那半边桌面被裁掉、露出清屏色（打包版里那块蓝三角，2026-09-08）。
            //    w' 是沿投影仪光轴的深度：NDC ≡ 板 UV 在垫面上是仿射的，所以 w' 在垫面上恒定，
            //    它的等值面是与垫面平行的平面。按它把 z 行重写成标准的 near/far 形式，近/远面
            //    就是两张与垫面平行的平面，垫面恒落在 [near, far] 内、与镜头位置无关。
            Vector4 wRow = corrected.GetRow(3);
            Vector4 centreEye = cam.worldToCameraMatrix * new Vector4(centre.x, centre.y, centre.z, 1f);
            float matDepth = Vector4.Dot(wRow, centreEye);
            if (matDepth <= 1e-6f)
            {
                cam.transform.SetPositionAndRotation(prevPos, prevRot);
                cam.ResetProjectionMatrix();
                message = "✗ 垫面落在了投影仪光轴的背面（w ≤ 0）—— 镜头高度是不是拧成了负数？";
                return false;
            }
            float near = matDepth * 0.02f;
            float far = matDepth * 8f;
            float zScale = (far + near) / (far - near);
            float zOffset = -2f * far * near / (far - near);
            corrected.SetRow(2, wRow * zScale + new Vector4(0f, 0f, 0f, zOffset));
            // 与矩阵保持一致：URP 的 _ZBufferParams / 线性深度、阴影级联都按这两个数算。
            cam.nearClipPlane = near;
            cam.farClipPlane = far;
            cam.projectionMatrix = corrected;
            message = $"相机已接管为投影仪：镜头在垫面 ({lensCm.x:F0}, {lensCm.y:F0}) cm、高 {lensCm.z:F0} cm。";
            return true;
        }

        /// <summary>
        /// 在已经写好的投影矩阵上叠一层**图像空间**的平移（NDC 单位，±2 = 整屏）。
        /// 光心 `C` 一动不动 ——「NDC ≡ 板 UV」的构造没变，只是那张图整体挪了一下，
        /// 归零就逐字回到标定位置。震屏因此重新可见，而实物上色的机制不受影响。
        ///
        /// 只平移、**不做旋转/缩放**：NDC 是各向异性的（垫子 100×50 映到同一个 ±1 方框里），
        /// 绕中心转会把画面拉斜。`clip.x += dx * clip.w`，透视除法之后正好是 NDC 的整体平移；
        /// `z/w` 不变，遮挡照旧正确。
        /// </summary>
        public static void ApplyImageShake(Camera cam, Vector2 ndcOffset)
        {
            if (cam == null || ndcOffset.sqrMagnitude < 1e-12f) return;
            var t = Matrix4x4.identity;
            t.m03 = ndcOffset.x;
            t.m13 = ndcOffset.y;
            cam.projectionMatrix = t * cam.projectionMatrix;
        }

        /// <summary>四点解 3×3 单应，抬进 4×4 的 (x, y, w) 三行，z 行保持 (0,0,1,0)。</summary>
        static bool SolveHomography(Vector2[] src, Vector2[] dst, out Matrix4x4 lift)
        {
            lift = Matrix4x4.identity;
            var a = new double[8, 9];
            for (int i = 0; i < 4; i++)
            {
                a[2 * i, 0] = src[i].x; a[2 * i, 1] = src[i].y; a[2 * i, 2] = 1.0;
                a[2 * i, 6] = -src[i].x * dst[i].x; a[2 * i, 7] = -src[i].y * dst[i].x; a[2 * i, 8] = dst[i].x;
                a[2 * i + 1, 3] = src[i].x; a[2 * i + 1, 4] = src[i].y; a[2 * i + 1, 5] = 1.0;
                a[2 * i + 1, 6] = -src[i].x * dst[i].y; a[2 * i + 1, 7] = -src[i].y * dst[i].y; a[2 * i + 1, 8] = dst[i].y;
            }
            for (int c = 0; c < 8; c++)
            {
                int piv = c;
                for (int r = c + 1; r < 8; r++) if (System.Math.Abs(a[r, c]) > System.Math.Abs(a[piv, c])) piv = r;
                if (System.Math.Abs(a[piv, c]) < 1e-12) return false;
                for (int k = 0; k < 9; k++) { double t = a[c, k]; a[c, k] = a[piv, k]; a[piv, k] = t; }
                for (int r = 0; r < 8; r++)
                {
                    if (r == c) continue;
                    double f = a[r, c] / a[c, c];
                    for (int k = 0; k < 9; k++) a[r, k] -= f * a[c, k];
                }
            }
            var g = new double[9];
            for (int i = 0; i < 8; i++) g[i] = a[i, 8] / a[i, i];
            g[8] = 1.0;

            lift.m00 = (float)g[0]; lift.m01 = (float)g[1]; lift.m02 = 0f; lift.m03 = (float)g[2];
            lift.m10 = (float)g[3]; lift.m11 = (float)g[4]; lift.m12 = 0f; lift.m13 = (float)g[5];
            lift.m20 = 0f;          lift.m21 = 0f;          lift.m22 = 1f; lift.m23 = 0f;
            lift.m30 = (float)g[6]; lift.m31 = (float)g[7]; lift.m32 = 0f; lift.m33 = (float)g[8];
            return true;
        }
    }
}
