using NUnit.Framework;
using UnityEngine;

namespace NuLight.ProjectionAlignment.Tests
{
    /// <summary>
    /// 「相机 = 投影仪」的裁剪范围：垫面与站在垫面上的实物必须整块落在近/远面之间，
    /// 与镜头位置无关。镜头偏离垫子正中时 w 行带透视项，z 行若沿用基准锥的，
    /// 远裁剪面会斜切过桌面（打包版里露出清屏色的那块蓝三角，2026-09-08）。
    /// </summary>
    public sealed class ProjectorFrustumTests
    {
        const float MatW = 100f, MatH = 50f, UnitsPerCm = 0.2014f;

        static Matrix4x4 Frame() => ProjectorFrustum.BuildBoardFrame(
            Vector3.zero, MatW, MatH, UnitsPerCm, Vector3.right, Vector3.forward, Vector3.up);

        static Vector3 MatToWorld(Matrix4x4 frame, Vector3 cm) => ProjectorFrustum.MatCmToWorld(frame, cm, MatW, MatH);

        [TestCase(50f, 25f, 50f, TestName = "Apply_MatStaysInsideClipRange_CentredLens")]
        [TestCase(52f, 19f, 47f, TestName = "Apply_MatStaysInsideClipRange_LensTunedOnPackagedBuild")]
        [TestCase(20f, -30f, 60f, TestName = "Apply_MatStaysInsideClipRange_FrontMountedLensOutsideMat")]
        public void Apply_MatAndPropsStayInsideClipRange(float lensX, float lensY, float lensH)
        {
            var go = new GameObject("ProjectorFrustum test camera", typeof(Camera));
            try
            {
                var cam = go.GetComponent<Camera>();
                cam.aspect = MatW / MatH;
                Matrix4x4 frame = Frame();
                Assert.That(ProjectorFrustum.Apply(cam, frame, new Vector3(lensX, lensY, lensH), MatW, MatH, out string message),
                            Is.True, message);

                Matrix4x4 vp = cam.projectionMatrix * cam.worldToCameraMatrix;
                for (int i = 0; i <= 10; i++)
                for (int j = 0; j <= 10; j++)
                for (int k = 0; k < 3; k++)   // 垫面、5 cm、10 cm 高
                {
                    var cm = new Vector3(i / 10f * MatW, j / 10f * MatH, k * 5f);
                    Vector3 w = MatToWorld(frame, cm);
                    Vector4 clip = vp * new Vector4(w.x, w.y, w.z, 1f);
                    Assert.That(clip.w, Is.GreaterThan(0f), $"{cm} 在镜头背后");
                    Assert.That(Mathf.Abs(clip.z / clip.w), Is.LessThan(1f), $"{cm} 被近/远面裁掉：z/w = {clip.z / clip.w}");
                    if (k == 0)
                    {
                        // NDC ≡ 板 UV：x = 2u − 1，y = 1 − 2v
                        Assert.That(clip.x / clip.w, Is.EqualTo(2f * i / 10f - 1f).Within(1e-3f), $"{cm} NDC x");
                        Assert.That(clip.y / clip.w, Is.EqualTo(1f - 2f * j / 10f).Within(1e-3f), $"{cm} NDC y");
                    }
                }
            }
            finally
            {
                Object.DestroyImmediate(go);
            }
        }

        [Test]
        public void Apply_WithBoardUvWindow_MapsTheWindowToNdc()
        {
            var go = new GameObject("ProjectorFrustum test camera", typeof(Camera));
            try
            {
                var cam = go.GetComponent<Camera>();
                cam.aspect = MatW / MatH;
                Matrix4x4 frame = Frame();
                // 2 cm / 3 cm of extra picture on every side of the mat.
                var window = new Rect(-0.02f, -0.06f, 1.04f, 1.12f);
                Assert.That(ProjectorFrustum.Apply(cam, frame, new Vector3(52f, 19f, 47f), MatW, MatH, out string message, window),
                            Is.True, message);

                Matrix4x4 vp = cam.projectionMatrix * cam.worldToCameraMatrix;
                foreach (Vector2 uv in new[] { new Vector2(-0.02f, -0.06f), new Vector2(0.5f, 0.5f), new Vector2(1.02f, 1.06f), new Vector2(0f, 1f) })
                {
                    Vector3 w = MatToWorld(frame, new Vector3(uv.x * MatW, uv.y * MatH, 0f));
                    Vector4 clip = vp * new Vector4(w.x, w.y, w.z, 1f);
                    float x = (uv.x - window.xMin) / window.width * 2f - 1f;
                    float y = 1f - (uv.y - window.yMin) / window.height * 2f;
                    Assert.That(clip.x / clip.w, Is.EqualTo(x).Within(1e-3f), $"{uv} NDC x");
                    Assert.That(clip.y / clip.w, Is.EqualTo(y).Within(1e-3f), $"{uv} NDC y");
                }
            }
            finally
            {
                Object.DestroyImmediate(go);
            }
        }

        [Test]
        public void Apply_DepthIncreasesAlongEveryRay()
        {
            var go = new GameObject("ProjectorFrustum test camera", typeof(Camera));
            try
            {
                var cam = go.GetComponent<Camera>();
                cam.aspect = MatW / MatH;
                Matrix4x4 frame = Frame();
                var lensCm = new Vector3(52f, 19f, 47f);
                Assert.That(ProjectorFrustum.Apply(cam, frame, lensCm, MatW, MatH, out string message), Is.True, message);

                Vector3 lens = MatToWorld(frame, lensCm);
                Matrix4x4 vp = cam.projectionMatrix * cam.worldToCameraMatrix;
                for (int i = 0; i <= 4; i++)
                for (int j = 0; j <= 4; j++)
                {
                    Vector3 floor = MatToWorld(frame, new Vector3(i / 4f * MatW, j / 4f * MatH, 0f));
                    float previous = float.NegativeInfinity;
                    foreach (float t in new[] { 0.5f, 0.9f, 1f, 1.5f })
                    {
                        Vector3 p = lens + (floor - lens) * t;
                        Vector4 clip = vp * new Vector4(p.x, p.y, p.z, 1f);
                        float depth = clip.z / clip.w;
                        Assert.That(depth, Is.GreaterThan(previous), $"射线 ({i},{j}) t={t} 深度不单调");
                        previous = depth;
                    }
                }
            }
            finally
            {
                Object.DestroyImmediate(go);
            }
        }
    }
}
