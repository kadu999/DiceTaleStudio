using NUnit.Framework;
using UnityEngine;

namespace NuLight.ProjectionAlignment.Tests
{
    public sealed class ImageShiftTests
    {
        // A solve from the two-mat rig, perspective terms included.
        private static readonly Matrix4x4 Rig = HomographyUtility.FromCoefficients(
            1.0786, 0.0258, -0.0783,
            -0.0094, 1.2621, -0.0790,
            -0.0191, 0.0539, 1.0);

        private static readonly Vector2[] Points =
        {
            new Vector2(0.1f, 0.2f),
            new Vector2(0.9f, 0.85f),
            new Vector2(0.5f, 0.5f),
            new Vector2(0.98f, 0.07f)
        };

        [Test]
        public void Translate_MovesEveryMappedPointByTheDelta()
        {
            var delta = new Vector2(-0.007f, 0.014f);

            Matrix4x4 shifted = HomographyUtility.Translate(Rig, delta);

            foreach (Vector2 point in Points)
            {
                Assert.That(HomographyUtility.TryApply(Rig, point, out Vector2 before), Is.True);
                Assert.That(HomographyUtility.TryApply(shifted, point, out Vector2 after), Is.True);
                Assert.That(after.x - before.x, Is.EqualTo(delta.x).Within(1e-5f));
                Assert.That(after.y - before.y, Is.EqualTo(delta.y).Within(1e-5f));
            }
        }

        [Test]
        public void Translate_ByTheNegation_RestoresTheOriginal()
        {
            var delta = new Vector2(0.02f, -0.03f);

            Matrix4x4 roundTrip = HomographyUtility.Translate(HomographyUtility.Translate(Rig, delta), -delta);

            for (int row = 0; row < 3; row++)
            {
                for (int column = 0; column < 3; column++)
                {
                    Assert.That(roundTrip[row, column], Is.EqualTo(Rig[row, column]).Within(1e-6f));
                }
            }
        }

        [Test]
        public void Translate_KeepsTheMappingInvertible()
        {
            Matrix4x4 shifted = HomographyUtility.Translate(Rig, new Vector2(0.05f, 0.05f));

            Assert.That(HomographyUtility.TryInvert(shifted, out Matrix4x4 inverse), Is.True);
            Assert.That(HomographyUtility.TryApply(shifted, Points[1], out Vector2 board), Is.True);
            Assert.That(HomographyUtility.TryApply(inverse, board, out Vector2 back), Is.True);
            Assert.That(Vector2.Distance(back, Points[1]), Is.LessThan(1e-4f));
        }
    }
}
