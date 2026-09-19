using NUnit.Framework;
using UnityEngine;

namespace NuLight.ProjectionAlignment.Tests
{
    public sealed class OperatorPressurePointerTests
    {
        private OperatorPressurePointer pointer;
        private int clicks;
        private static readonly Rect ButtonRect = new Rect(200, 100, 120, 60);
        private static readonly Vector2 ButtonPoint = ButtonRect.center;

        [SetUp]
        public void SetUp()
        {
            pointer = new OperatorPressurePointer(); clicks = 0;
            DrawButton("first");
        }

        private void DrawButton(string key)
        {
            pointer.BeginTargets();
            pointer.AddTarget(key, ButtonRect, () => clicks++);
            pointer.EndTargets();
        }

        [Test]
        public void OpeningWhileHeldRequiresReleaseThenOneTapFiresExactlyOnce()
        {
            pointer.Sample(true, 1, ButtonPoint);
            pointer.Sample(true, 0, ButtonPoint);
            Assert.That(clicks, Is.Zero);
            pointer.Sample(true, 1, ButtonPoint);
            for (int i = 0; i < 100; i++) { DrawButton("first"); pointer.Sample(true, 1, ButtonPoint); }
            Assert.That(clicks, Is.Zero);
            pointer.Sample(true, 0, ButtonPoint);
            pointer.Sample(true, 0, ButtonPoint);
            Assert.That(clicks, Is.EqualTo(1));
        }

        [Test]
        public void PressOutsideCannotBecomeAClickBySlidingInside()
        {
            pointer.Sample(true, 0, Vector2.zero);
            pointer.Sample(true, 1, Vector2.zero);
            pointer.Sample(true, 1, ButtonPoint);
            pointer.Sample(true, 0, ButtonPoint);
            Assert.That(clicks, Is.Zero);
        }

        [Test]
        public void ReleasingOutsideCancelsClick()
        {
            pointer.Sample(true, 0, Vector2.zero);
            pointer.Sample(true, 1, ButtonPoint);
            pointer.Sample(true, 1, Vector2.zero);
            pointer.Sample(true, 0, Vector2.zero);
            Assert.That(clicks, Is.Zero);
        }

        [TestCase("different-page")] [TestCase("disabled")] [TestCase("moved")]
        public void PageChangesAndDisabledOrMovedControlsCannotReuseAStalePress(string change)
        {
            pointer.Sample(true, 0, ButtonPoint); pointer.Sample(true, 1, ButtonPoint);
            pointer.BeginTargets();
            if (change == "different-page") pointer.AddTarget("second", ButtonRect, () => clicks++);
            if (change == "moved") pointer.AddTarget("first", new Rect(201, 100, 120, 60), () => clicks++);
            pointer.EndTargets();
            pointer.Sample(true, 0, ButtonPoint);
            Assert.That(clicks, Is.Zero);
        }

        [Test]
        public void DisconnectAndMultipleFingersCancelWithoutClicking()
        {
            pointer.Sample(true, 0, ButtonPoint); pointer.Sample(true, 1, ButtonPoint);
            pointer.Sample(false, 0, ButtonPoint);
            pointer.Sample(true, 1, ButtonPoint); pointer.Sample(true, 0, ButtonPoint);
            Assert.That(clicks, Is.Zero);
            pointer.Sample(true, 1, ButtonPoint); pointer.Sample(true, 2, ButtonPoint);
            pointer.Sample(true, 1, ButtonPoint); pointer.Sample(true, 0, ButtonPoint);
            Assert.That(clicks, Is.Zero);
        }

        [Test]
        public void SliderReceivesHeldPositionsAndStopsAfterRelease()
        {
            Vector2 last = default; int drags = 0;
            pointer.BeginTargets();
            pointer.AddTarget("slider", ButtonRect, null, point => { last = point; drags++; });
            pointer.EndTargets();
            pointer.Sample(true, 0, ButtonPoint); pointer.Sample(true, 1, ButtonPoint);
            pointer.Sample(true, 1, ButtonPoint + Vector2.right * 15);
            pointer.Sample(true, 0, ButtonPoint); pointer.Sample(true, 0, ButtonPoint);
            Assert.That(drags, Is.EqualTo(2));
            Assert.That(last, Is.EqualTo(ButtonPoint + Vector2.right * 15));
            Assert.That(pointer.Pressed, Is.False);
        }

        [Test]
        public void PressureUsesRawTopLeftProjectorPixelsWithHomography()
        {
            Matrix4x4 matrix = Matrix4x4.identity;
            matrix.m00 = .5f; matrix.m11 = .6f; matrix.m02 = .2f; matrix.m12 = .1f;
            Assert.That(ProjectionCalibrationController.TryOperatorPressurePixel(matrix, new Vector2(.4f, .5f),
                new Vector2(1920, 1080), out var point), Is.True);
            Assert.That(point.x, Is.EqualTo(768).Within(.001));
            Assert.That(point.y, Is.EqualTo(432).Within(.001), "IMGUI y is top-down; no game-viewport crop or screen-Y flip.");
            matrix.m02 = 2;
            Assert.That(ProjectionCalibrationController.TryOperatorPressurePixel(matrix, Vector2.one * .5f,
                new Vector2(1920, 1080), out _), Is.False, "Out-of-frame contacts must not be clamped onto edge buttons.");
        }

        [Test]
        public void MenuFitRequiresAllCornersInsideTheMatAndOutput()
        {
            Vector2 size = new Vector2(1920, 1080);
            Assert.That(ProjectionCalibrationController.OperatorWindowFitsMat(new Rect(500, 200, 600, 600), size, Matrix4x4.identity), Is.True);
            Assert.That(ProjectionCalibrationController.OperatorWindowFitsMat(new Rect(0, 0, 600, 600), size, Matrix4x4.identity), Is.False);
            Matrix4x4 narrowMat = Matrix4x4.identity; narrowMat.m00 = 3; narrowMat.m02 = -1;
            Assert.That(ProjectionCalibrationController.OperatorWindowFitsMat(new Rect(500, 200, 600, 600), size, narrowMat), Is.False);
        }

        [Test]
        public void OutputBorderCoversFull1920By1080InsideTheEdges()
        {
            Vector2 size = new Vector2(1920, 1080);
            Assert.That(ProjectionCalibrationController.OperatorOutputBorderEdge(size, 0), Is.EqualTo(new Rect(0, 0, 1920, 5)));
            Assert.That(ProjectionCalibrationController.OperatorOutputBorderEdge(size, 1), Is.EqualTo(new Rect(0, 1075, 1920, 5)));
            Assert.That(ProjectionCalibrationController.OperatorOutputBorderEdge(size, 2), Is.EqualTo(new Rect(0, 5, 5, 1070)));
            Assert.That(ProjectionCalibrationController.OperatorOutputBorderEdge(size, 3), Is.EqualTo(new Rect(1915, 5, 5, 1070)));
        }
    }
}
