using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;

namespace NuLight.ProjectionAlignment.Tests
{
    /// <summary>
    /// The two-mat layout: how the interactive area is shaped, how ports are counted, and
    /// the one property the automatic left/right detection rests on.
    /// </summary>
    public sealed class DualBoardGeometryTests
    {
        /// <summary>A trapezoid, standing in for a projector thrown at an angle.</summary>
        private static readonly Vector2[] ProjectorQuad =
        {
            new Vector2(0.11f, 0.22f),
            new Vector2(0.88f, 0.14f),
            new Vector2(0.94f, 0.86f),
            new Vector2(0.06f, 0.79f)
        };

        [Test]
        public void MatRect_OneMat_IsUnchangedFromTheSingleBoardRig()
        {
            Rect single = ProjectionCoordinateMapper.CenteredMatRect(0.75f);

            Assert.That(single.height, Is.EqualTo(0.75f).Within(1e-6f));
            Assert.That(single.width, Is.EqualTo(0.421875f).Within(1e-6f));
            Assert.That(single.center.x, Is.EqualTo(0.5f).Within(1e-6f));
            Assert.That(single.center.y, Is.EqualTo(0.5f).Within(1e-6f));
            Assert.That(ProjectionCoordinateMapper.BoardCountOf(single), Is.EqualTo(1));
        }

        [Test]
        public void MatRect_TwoMats_IsTwiceAsWideAndStillCentred()
        {
            Rect dual = ProjectionCoordinateMapper.CenteredMatRect(0.75f, 2f);

            Assert.That(dual.height, Is.EqualTo(0.75f).Within(1e-6f));
            Assert.That(dual.width, Is.EqualTo(0.84375f).Within(1e-6f));
            Assert.That(dual.center.x, Is.EqualTo(0.5f).Within(1e-6f));
            Assert.That(dual.width, Is.EqualTo(
                ProjectionCoordinateMapper.CenteredMatRect(0.75f).width * 2f).Within(1e-6f));
        }

        [Test]
        public void MatRect_ShapeRoundTripsThroughTheBoardCount()
        {
            for (int boards = 1; boards <= 2; boards++)
            {
                Rect rect = ProjectionCoordinateMapper.DefaultInteractionRectFor(boards);
                Assert.That(ProjectionCoordinateMapper.BoardCountOf(rect), Is.EqualTo(boards),
                    $"a {boards}-mat rect must read back as {boards} mats");
                Assert.That(ProjectionCoordinateMapper.MatAspectOf(rect),
                    Is.EqualTo((float)boards).Within(1e-5f));
            }
        }

        [Test]
        public void MatRect_TwoMats_StopsGrowingWhenItRunsOutOfFrameWidth()
        {
            float ceiling = ProjectionCoordinateMapper.MaximumMatHeightInFrame(2f);
            Assert.That(ceiling, Is.EqualTo(8f / 9f).Within(1e-5f));

            Rect clamped = ProjectionCoordinateMapper.CenteredMatRect(1f, 2f);
            Assert.That(clamped.width, Is.EqualTo(1f).Within(1e-5f));
            Assert.That(clamped.height, Is.EqualTo(ceiling).Within(1e-5f));
            Assert.That(ProjectionCoordinateMapper.IsValidInteractionRect(clamped), Is.True);
        }

        [Test]
        public void PortScan_CountsHardwareNotDeviceNodes()
        {
            // macOS lists every real device twice and pads the list with pseudo-terminals.
            // Counting device nodes would report two mats with one plugged in.
            string[] listed =
            {
                "/dev/tty.usbmodem1101",
                "/dev/cu.usbmodem1101",
                "/dev/ttyp0",
                "/dev/cu.Bluetooth-Incoming-Port",
                "/dev/ttywf"
            };

            List<string> found = DevicePipePressureSource.PickLikelySerialPorts(listed);

            Assert.That(found.Count, Is.EqualTo(1));
            Assert.That(found[0], Is.EqualTo("/dev/cu.usbmodem1101"));
        }

        [Test]
        public void PortScan_TwoMats_YieldsTwoCuPorts()
        {
            string[] listed =
            {
                "/dev/tty.usbmodem1101",
                "/dev/cu.usbmodem1101",
                "/dev/tty.usbmodem2201",
                "/dev/cu.usbmodem2201",
                "/dev/cu.Bluetooth-Incoming-Port"
            };

            List<string> found = DevicePipePressureSource.PickLikelySerialPorts(listed);

            Assert.That(found.Count, Is.EqualTo(2));
            Assert.That(found, Does.Contain("/dev/cu.usbmodem1101"));
            Assert.That(found, Does.Contain("/dev/cu.usbmodem2201"));
        }

        [TestCase(true, -1, false, TestName = "ViewportCrop_BeforeHardwareConfirmation_UsesFullFrame")]
        [TestCase(true, 0, false, TestName = "ViewportCrop_ZeroSerialPorts_UsesFullFrame")]
        [TestCase(true, 1, true, TestName = "ViewportCrop_ConfirmedMatPresent_UsesInteractionArea")]
        [TestCase(false, 1, false, TestName = "ViewportCrop_SceneSettingCanStillForceFullFrame")]
        public void ViewportCrop_FollowsSerialAvailability(
            bool configuredFit,
            int serialPortCount,
            bool expected)
        {
            Assert.That(
                ProjectionGameCameraBinder.ShouldFitGameToInteractionArea(configuredFit, serialPortCount),
                Is.EqualTo(expected));
        }

        [Test]
        public void MouseSimulation_MapsAcrossTheWholeRenderTexture()
        {
            Vector2 pixel = ProjectionVirtualTouchscreen.SimulationPointerToScreenPixels(
                new Vector2(0.75f, 0.25f),
                new Vector2(1920f, 1080f));

            Assert.That(pixel.x, Is.EqualTo(1440f).Within(1e-5f));
            Assert.That(pixel.y, Is.EqualTo(810f).Within(1e-5f));
        }

        [Test]
        public void PressureTouch_DirectProjectorFeed_UsesBoardToProjectorHomography()
        {
            var samples = new List<CalibrationSample>
            {
                new CalibrationSample(ProjectorQuad[0], new Vector2(0f, 0f)),
                new CalibrationSample(ProjectorQuad[1], new Vector2(1f, 0f)),
                new CalibrationSample(ProjectorQuad[2], new Vector2(1f, 1f)),
                new CalibrationSample(ProjectorQuad[3], new Vector2(0f, 1f))
            };
            HomographySolveResult solved = HomographySolver.Solve(samples);
            Assert.That(solved.success, Is.True, solved.error);

            Vector2 boardUv = new Vector2(0.23f, 0.67f);
            Rect interactionRect = ProjectionCoordinateMapper.DefaultInteractionRect;
            Assert.That(HomographyUtility.TryApply(
                solved.boardToProjector, boardUv, out Vector2 expectedProjectorUv), Is.True);

            Vector2 directUv = ProjectionVirtualTouchscreen.ResolveBoardPixelUv(
                boardUv,
                interactionRect,
                solved.boardToProjector,
                ProjectionTouchPixelSpace.ProjectorOutput);
            Vector2 preWarpUv = ProjectionVirtualTouchscreen.ResolveBoardPixelUv(
                boardUv,
                interactionRect,
                solved.boardToProjector,
                ProjectionTouchPixelSpace.GameSource);

            Assert.That(Vector2.Distance(directUv, expectedProjectorUv), Is.LessThan(1e-5f));
            Assert.That(Vector2.Distance(
                preWarpUv,
                ProjectionCoordinateMapper.BoardToSourceUv(boardUv, interactionRect)), Is.LessThan(1e-5f));
            Assert.That(Vector2.Distance(directUv, preWarpUv), Is.GreaterThan(0.05f),
                "a moved/angled projector must not silently collapse back to the old interaction rect");
        }

        /// <summary>
        /// The property the automatic left/right detection is built on: plugging the mats in
        /// the other way round offsets one mat's readings by half the area, which no single
        /// homography can absorb — so the wrong hypothesis fits far worse than the right one.
        /// </summary>
        [Test]
        public void MatOrder_WrongOrderFitsFarWorse_WhenThePrimarySetHasFivePoints()
        {
            Vector2[] targets =
            {
                new Vector2(0.10f, 0.10f),
                new Vector2(0.90f, 0.10f),
                new Vector2(0.90f, 0.90f),
                new Vector2(0.10f, 0.90f),
                new Vector2(0.30f, 0.50f)
            };

            List<CalibrationSample> correct = BuildSamples(targets, false);
            List<CalibrationSample> reversed = BuildSamples(targets, true);

            HomographySolveResult correctFit = HomographySolver.Solve(correct);
            HomographySolveResult reversedFit = HomographySolver.Solve(reversed);

            Assert.That(correctFit.success, Is.True, correctFit.error);
            Assert.That(correctFit.rmsError, Is.LessThan(1e-4f));
            if (reversedFit.success)
            {
                Assert.That(reversedFit.rmsError, Is.GreaterThan(correctFit.rmsError * 20f),
                    "a reversed pair must lose by a wide margin, or the detection is a coin flip");
            }
        }

        /// <summary>
        /// Why that fifth point exists. Four correspondences determine a homography exactly,
        /// so both hypotheses fit perfectly and the residual says nothing — the mat order
        /// would then only surface as a failed validation nine steps later.
        /// </summary>
        [Test]
        public void MatOrder_FourCornersAlone_CannotTellTheOrder()
        {
            Vector2[] corners =
            {
                new Vector2(0.10f, 0.10f),
                new Vector2(0.90f, 0.10f),
                new Vector2(0.90f, 0.90f),
                new Vector2(0.10f, 0.90f)
            };

            HomographySolveResult correctFit = HomographySolver.Solve(BuildSamples(corners, false));
            HomographySolveResult reversedFit = HomographySolver.Solve(BuildSamples(corners, true));

            Assert.That(correctFit.success, Is.True, correctFit.error);
            Assert.That(reversedFit.success, Is.True, reversedFit.error);
            Assert.That(correctFit.rmsError, Is.LessThan(1e-4f));
            Assert.That(reversedFit.rmsError, Is.LessThan(1e-4f));
        }

        [Test]
        public void Seam_WidensTheAreaAndTheRectThatDrawsIt()
        {
            Assert.That(ProjectionCoordinateMapper.MatAspectFor(2, 0f), Is.EqualTo(2f).Within(1e-5f));
            Assert.That(ProjectionCoordinateMapper.MatAspectFor(2, 2f), Is.EqualTo(2.04f).Within(1e-5f));
            Assert.That(ProjectionCoordinateMapper.AreaWidthCm(2, 2f), Is.EqualTo(102f).Within(1e-4f));
            Assert.That(ProjectionCoordinateMapper.AreaWidthCm(1, 2f), Is.EqualTo(50f).Within(1e-4f),
                "a single mat has no seam to widen it");

            // The seam rides in the rect's shape, so it survives being saved and reloaded
            // without a field of its own.
            Rect rect = ProjectionCoordinateMapper.CenteredMatRect(
                0.75f, ProjectionCoordinateMapper.MatAspectFor(2, 2f));
            Assert.That(ProjectionCoordinateMapper.BoardCountOf(rect), Is.EqualTo(2));
            float recovered = (ProjectionCoordinateMapper.MatAspectOf(rect) - 2f)
                * ProjectionCoordinateMapper.MatEdgeCm;
            Assert.That(recovered, Is.EqualTo(2f).Within(0.02f));
        }

        [Test]
        public void SeamSpan_IsTheDeadStripAndNothingElse()
        {
            Vector2 span = ProjectionCoordinateMapper.SeamSpanInBoardUv(0, 2, 2f);

            Assert.That(span.x, Is.EqualTo(50f / 102f).Within(1e-5f));
            Assert.That(span.y, Is.EqualTo(52f / 102f).Within(1e-5f));
            Assert.That(span.y - span.x, Is.EqualTo(2f / 102f).Within(1e-5f));

            Vector2 none = ProjectionCoordinateMapper.SeamSpanInBoardUv(0, 2, 0f);
            Assert.That(none.y - none.x, Is.EqualTo(0f).Within(1e-6f),
                "no gap means no dead strip, even though the bezels are still there physically");
        }

        [Test]
        public void ReexpressAcrossSeam_RoundTripsAndKeepsTheMatItLandedOn()
        {
            foreach (bool flipX in new[] { false, true })
            {
                foreach (float uv in new[] { 0.05f, 0.30f, 0.49f, 0.51f, 0.70f, 0.95f })
                {
                    float widened = ProjectionCoordinateMapper.ReexpressAcrossSeam(uv, 2, 0f, 2f, flipX);
                    float back = ProjectionCoordinateMapper.ReexpressAcrossSeam(widened, 2, 2f, 0f, flipX);
                    Assert.That(back, Is.EqualTo(uv).Within(1e-4f), $"uv={uv} flipX={flipX}");

                    // Widening the model must not move a reading onto the other mat.
                    bool leftBefore = flipX ? uv > 0.5f : uv < 0.5f;
                    bool leftAfter = flipX
                        ? widened > ProjectionCoordinateMapper.SeamSpanInBoardUv(0, 2, 2f).y
                        : widened < ProjectionCoordinateMapper.SeamSpanInBoardUv(0, 2, 2f).x;
                    Assert.That(leftAfter, Is.EqualTo(leftBefore), $"uv={uv} flipX={flipX}");
                }
            }
        }

        [Test]
        public void ReexpressAcrossSeam_IsIdentityOnOneMat()
        {
            Assert.That(ProjectionCoordinateMapper.ReexpressAcrossSeam(0.3f, 1, 0f, 3f, false),
                Is.EqualTo(0.3f).Within(1e-6f));
        }

        /// <summary>
        /// What the seam estimator rests on: readings taken across a real gap fit a homography
        /// best when the model uses that same gap, and clearly worse when it assumes none.
        /// Without this the whole "let calibration measure the seam" idea is guesswork.
        /// </summary>
        [Test]
        public void SeamEstimate_TrueGapFitsBetterThanNoGap()
        {
            const float trueGapCm = 2f;
            var samples = BuildSeamSamples(trueGapCm, trueGapCm);
            var ignoringSeam = BuildSeamSamples(trueGapCm, 0f);

            HomographySolveResult withSeam = HomographySolver.Solve(samples);
            HomographySolveResult withoutSeam = HomographySolver.Solve(ignoringSeam);

            Assert.That(withSeam.success, Is.True, withSeam.error);
            Assert.That(withoutSeam.success, Is.True, withoutSeam.error);
            Assert.That(withSeam.rmsError, Is.LessThan(1e-4f));
            Assert.That(withoutSeam.rmsError, Is.GreaterThan(withSeam.rmsError * 20f),
                "ignoring a 2 cm seam has to cost enough for a search to find it");
        }

        /// <summary>
        /// Ten readings taken across a real gap, expressed as if the model's gap were
        /// <paramref name="modelGapCm"/>. Noise-free: this measures model error alone.
        /// </summary>
        private static List<CalibrationSample> BuildSeamSamples(float trueGapCm, float modelGapCm)
        {
            var quad = new List<CalibrationSample>
            {
                new CalibrationSample(ProjectorQuad[0], new Vector2(0f, 0f)),
                new CalibrationSample(ProjectorQuad[1], new Vector2(1f, 0f)),
                new CalibrationSample(ProjectorQuad[2], new Vector2(1f, 1f)),
                new CalibrationSample(ProjectorQuad[3], new Vector2(0f, 1f))
            };
            HomographySolveResult truth = HomographySolver.Solve(quad);
            Assert.That(truth.success, Is.True, truth.error);

            float edge = ProjectionCoordinateMapper.MatEdgeCm;
            float trueWidth = ProjectionCoordinateMapper.AreaWidthCm(2, trueGapCm);
            float modelWidth = ProjectionCoordinateMapper.AreaWidthCm(2, modelGapCm);
            var locals = new[]
            {
                new Vector3(0, 0.20f, 0.10f), new Vector3(1, 0.80f, 0.10f), new Vector3(1, 0.80f, 0.90f),
                new Vector3(0, 0.20f, 0.90f), new Vector3(0, 0.60f, 0.50f), new Vector3(1, 0.50f, 0.15f),
                new Vector3(0, 0.50f, 0.85f), new Vector3(1, 0.50f, 0.50f), new Vector3(1, 0.20f, 0.50f),
                new Vector3(0, 0.80f, 0.50f)
            };

            var samples = new List<CalibrationSample>(locals.Length);
            foreach (Vector3 local in locals)
            {
                float mat = local.x;
                float trueX = (mat * (edge + trueGapCm) + local.y * edge) / trueWidth;
                float modelX = (mat * (edge + modelGapCm) + local.y * edge) / modelWidth;
                Assert.That(HomographyUtility.TryApply(
                    truth.boardToProjector, new Vector2(trueX, local.z), out Vector2 projectorUv), Is.True);
                samples.Add(new CalibrationSample(projectorUv, new Vector2(modelX, local.z)));
            }

            return samples;
        }

        /// <summary>
        /// Board readings for the given targets under a synthetic projector trapezoid.
        /// <paramref name="matsReversed"/> shifts each reading to the other mat, which is
        /// exactly what a reversed pair of serial ports produces.
        /// </summary>
        private static List<CalibrationSample> BuildSamples(Vector2[] targets, bool matsReversed)
        {
            var quadSamples = new List<CalibrationSample>
            {
                new CalibrationSample(ProjectorQuad[0], new Vector2(0f, 0f)),
                new CalibrationSample(ProjectorQuad[1], new Vector2(1f, 0f)),
                new CalibrationSample(ProjectorQuad[2], new Vector2(1f, 1f)),
                new CalibrationSample(ProjectorQuad[3], new Vector2(0f, 1f))
            };

            HomographySolveResult truth = HomographySolver.Solve(quadSamples);
            Assert.That(truth.success, Is.True, truth.error);

            var samples = new List<CalibrationSample>(targets.Length);
            for (int index = 0; index < targets.Length; index++)
            {
                Assert.That(HomographyUtility.TryApply(
                    truth.boardToProjector, targets[index], out Vector2 projectorUv), Is.True);

                Vector2 measured = targets[index];
                if (matsReversed)
                {
                    measured.x = measured.x < 0.5f ? measured.x + 0.5f : measured.x - 0.5f;
                }

                samples.Add(new CalibrationSample(projectorUv, measured));
            }

            return samples;
        }
    }
}
