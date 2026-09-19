using NUnit.Framework;
using UnityEngine;

namespace NuLight.ProjectionAlignment.Tests
{
    public sealed class RenderMarginTests
    {
        private const int TwoMats = 2;

        [Test]
        public void ZeroMargin_LeavesTheRectAlone()
        {
            Rect rect = ProjectionCoordinateMapper.CenteredMatRect(0.75f, ProjectionCoordinateMapper.MatAspectFor(TwoMats));

            Rect expanded = ProjectionCoordinateMapper.ExpandRectByMarginCm(rect, Vector2.zero, TwoMats, 0f, out Vector2 applied);

            Assert.That(expanded, Is.EqualTo(rect));
            Assert.That(applied, Is.EqualTo(Vector2.zero));
        }

        [Test]
        public void OneCentimetre_GrowsEachSideByItsShareOfTheFrame()
        {
            // Two mats at 0.75: 100 cm across 0.84375 of the frame, 50 cm across 0.75 of it.
            Rect rect = ProjectionCoordinateMapper.CenteredMatRect(0.75f, ProjectionCoordinateMapper.MatAspectFor(TwoMats));

            Rect expanded = ProjectionCoordinateMapper.ExpandRectByMarginCm(rect, Vector2.one, TwoMats, 0f, out Vector2 applied);

            Assert.That(applied.x, Is.EqualTo(1f).Within(1e-6f));
            Assert.That(applied.y, Is.EqualTo(1f).Within(1e-6f));
            Assert.That(expanded.xMin, Is.EqualTo(rect.xMin - 0.84375f / 100f).Within(1e-6f));
            Assert.That(expanded.xMax, Is.EqualTo(rect.xMax + 0.84375f / 100f).Within(1e-6f));
            Assert.That(expanded.yMin, Is.EqualTo(rect.yMin - 0.75f / 50f).Within(1e-6f));
            Assert.That(expanded.yMax, Is.EqualTo(rect.yMax + 0.75f / 50f).Within(1e-6f));
            Assert.That(expanded.center, Is.EqualTo(rect.center));
        }

        [Test]
        public void NoRoomOnAnAxis_AppliesNothingThereAndStaysCentred()
        {
            // At the two-mat ceiling the area already spans the frame's full width.
            float ceiling = ProjectionCoordinateMapper.MaximumMatHeightInFrame(ProjectionCoordinateMapper.MatAspectFor(TwoMats));
            Rect rect = ProjectionCoordinateMapper.CenteredMatRect(ceiling, ProjectionCoordinateMapper.MatAspectFor(TwoMats));

            Rect expanded = ProjectionCoordinateMapper.ExpandRectByMarginCm(rect, new Vector2(2f, 2f), TwoMats, 0f, out Vector2 applied);

            Assert.That(applied.x, Is.EqualTo(0f).Within(1e-6f));
            Assert.That(applied.y, Is.EqualTo(2f).Within(1e-6f));
            Assert.That(expanded.xMin, Is.EqualTo(0f).Within(1e-6f));
            Assert.That(expanded.xMax, Is.EqualTo(1f).Within(1e-6f));
            Assert.That(expanded.center.y, Is.EqualTo(rect.center.y).Within(1e-6f));
            Assert.That(expanded.yMin, Is.LessThan(rect.yMin));
        }

        [Test]
        public void MoreThanTheRoom_IsCappedToWhatFitsOnBothSides()
        {
            float ceiling = ProjectionCoordinateMapper.MaximumMatHeightInFrame(ProjectionCoordinateMapper.MatAspectFor(TwoMats));
            Rect rect = ProjectionCoordinateMapper.CenteredMatRect(ceiling, ProjectionCoordinateMapper.MatAspectFor(TwoMats));

            Rect expanded = ProjectionCoordinateMapper.ExpandRectByMarginCm(rect, new Vector2(0f, 9f), TwoMats, 0f, out Vector2 applied);

            float roomCm = rect.yMin / (rect.height / ProjectionCoordinateMapper.MatEdgeCm);
            Assert.That(applied.y, Is.EqualTo(roomCm).Within(1e-4f));
            Assert.That(expanded.yMin, Is.EqualTo(0f).Within(1e-5f));
            Assert.That(expanded.yMax, Is.EqualTo(1f).Within(1e-5f));
        }

        [Test]
        public void NegativeMargin_IsNotAMargin()
        {
            Rect rect = ProjectionCoordinateMapper.CenteredMatRect(0.75f, ProjectionCoordinateMapper.MatAspectFor(TwoMats));

            Rect expanded = ProjectionCoordinateMapper.ExpandRectByMarginCm(rect, new Vector2(-3f, -3f), TwoMats, 0f, out Vector2 applied);

            Assert.That(expanded, Is.EqualTo(rect));
            Assert.That(applied, Is.EqualTo(Vector2.zero));
        }
    }
}
