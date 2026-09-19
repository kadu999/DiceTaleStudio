using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;

namespace NuLight.ProjectionAlignment.Tests
{
    public sealed class HomographySolverTests
    {
        [Test]
        public void Solve_IdentitySamples_ReturnsIdentityMapping()
        {
            var samples = new List<CalibrationSample>
            {
                new CalibrationSample(new Vector2(0f, 0f), new Vector2(0f, 0f)),
                new CalibrationSample(new Vector2(1f, 0f), new Vector2(1f, 0f)),
                new CalibrationSample(new Vector2(1f, 1f), new Vector2(1f, 1f)),
                new CalibrationSample(new Vector2(0f, 1f), new Vector2(0f, 1f))
            };

            HomographySolveResult result = HomographySolver.Solve(samples);

            Assert.That(result.success, Is.True, result.error);
            Assert.That(HomographyUtility.TryApply(result.projectorToBoard, new Vector2(0.37f, 0.62f), out Vector2 mapped), Is.True);
            Assert.That(mapped.x, Is.EqualTo(0.37f).Within(1e-4f));
            Assert.That(mapped.y, Is.EqualTo(0.62f).Within(1e-4f));
        }

        [Test]
        public void Solve_TrapezoidSamples_ReproducesCornerMappings()
        {
            Vector2[] projector =
            {
                new Vector2(0.18f, 0.12f),
                new Vector2(0.82f, 0.18f),
                new Vector2(0.92f, 0.88f),
                new Vector2(0.08f, 0.82f)
            };
            Vector2[] board =
            {
                new Vector2(0f, 0f),
                new Vector2(1f, 0f),
                new Vector2(1f, 1f),
                new Vector2(0f, 1f)
            };
            var samples = new List<CalibrationSample>();
            for (int index = 0; index < 4; index++)
            {
                samples.Add(new CalibrationSample(projector[index], board[index]));
            }

            HomographySolveResult result = HomographySolver.Solve(samples);

            Assert.That(result.success, Is.True, result.error);
            for (int index = 0; index < 4; index++)
            {
                Assert.That(HomographyUtility.TryApply(result.projectorToBoard, projector[index], out Vector2 mapped), Is.True);
                Assert.That(Vector2.Distance(mapped, board[index]), Is.LessThan(1e-4f));
            }
        }

        [Test]
        public void Solve_CollinearSamples_IsRejected()
        {
            var samples = new List<CalibrationSample>
            {
                new CalibrationSample(new Vector2(0f, 0f), new Vector2(0f, 0f)),
                new CalibrationSample(new Vector2(0.25f, 0.25f), new Vector2(0.2f, 0.2f)),
                new CalibrationSample(new Vector2(0.5f, 0.5f), new Vector2(0.4f, 0.4f)),
                new CalibrationSample(new Vector2(1f, 1f), new Vector2(1f, 1f))
            };

            HomographySolveResult result = HomographySolver.Solve(samples);

            Assert.That(result.success, Is.False);
        }

        [Test]
        public void BoardToSource_UsesConfigurableInteractionRectInsideFullGame()
        {
            Rect interactionRect = new Rect(0.2f, 0.1f, 0.5f, 0.7f);
            Vector2 leftTop = ProjectionCoordinateMapper.BoardToSourceUv(
                Vector2.zero,
                interactionRect);
            Vector2 rightBottom = ProjectionCoordinateMapper.BoardToSourceUv(
                Vector2.one,
                interactionRect);

            Assert.That(leftTop.x, Is.EqualTo(0.2f).Within(1e-6f));
            Assert.That(leftTop.y, Is.EqualTo(0.1f).Within(1e-6f));
            Assert.That(rightBottom.x, Is.EqualTo(0.7f).Within(1e-6f));
            Assert.That(rightBottom.y, Is.EqualTo(0.8f).Within(1e-6f));
        }

        [Test]
        public void InteractionPreview_MapsConfiguredProjectorRectToBoard()
        {
            Rect interactionRect = new Rect(0.16f, 0.12f, 0.62f, 0.74f);
            Matrix4x4 projectorToBoard = ProjectionCoordinateMapper
                .CreateProjectorToBoardPreviewMatrix(interactionRect);

            Assert.That(HomographyUtility.TryApply(
                projectorToBoard,
                interactionRect.min,
                out Vector2 leftTop), Is.True);
            Assert.That(HomographyUtility.TryApply(
                projectorToBoard,
                interactionRect.max,
                out Vector2 rightBottom), Is.True);
            Assert.That(leftTop.x, Is.EqualTo(0f).Within(1e-6f));
            Assert.That(leftTop.y, Is.EqualTo(0f).Within(1e-6f));
            Assert.That(rightBottom.x, Is.EqualTo(1f).Within(1e-6f));
            Assert.That(rightBottom.y, Is.EqualTo(1f).Within(1e-6f));

            Assert.That(HomographyUtility.TryApply(
                projectorToBoard,
                new Vector2(0f, 0.5f),
                out Vector2 leftBand), Is.True);
            Assert.That(leftBand.x, Is.LessThan(0f));
        }

        [Test]
        public void FullFrame_SourceEdgesExtendBeyondInteractionCoordinates()
        {
            Rect interactionRect = ProjectionCoordinateMapper.DefaultInteractionRect;
            Vector2 leftSourceEdge = ProjectionCoordinateMapper.SourceToBoardUv(
                new Vector2(0f, 0.5f),
                interactionRect);
            Vector2 rightSourceEdge = ProjectionCoordinateMapper.SourceToBoardUv(
                new Vector2(1f, 0.5f),
                interactionRect);

            Assert.That(leftSourceEdge.x, Is.LessThan(0f));
            Assert.That(rightSourceEdge.x, Is.GreaterThan(1f));
            Assert.That(leftSourceEdge.y, Is.EqualTo(0.5f).Within(1e-6f));
            Assert.That(rightSourceEdge.y, Is.EqualTo(0.5f).Within(1e-6f));
        }

        [Test]
        public void PhysicalMapping_InversePlacesDesiredBoardPointAtCorrectProjectorPixel()
        {
            var samples = new List<CalibrationSample>
            {
                new CalibrationSample(new Vector2(0.25f, 0.18f), new Vector2(0f, 0f)),
                new CalibrationSample(new Vector2(0.72f, 0.12f), new Vector2(1f, 0f)),
                new CalibrationSample(new Vector2(0.76f, 0.82f), new Vector2(1f, 1f)),
                new CalibrationSample(new Vector2(0.30f, 0.88f), new Vector2(0f, 1f))
            };

            HomographySolveResult result = HomographySolver.Solve(samples);
            Assert.That(result.success, Is.True, result.error);
            Assert.That(HomographyUtility.TryInvert(result.projectorToBoard, out Matrix4x4 boardToProjector), Is.True);

            Vector2 desiredBoardPoint = new Vector2(0.37f, 0.62f);
            Assert.That(HomographyUtility.TryApply(boardToProjector, desiredBoardPoint, out Vector2 projectorPoint), Is.True);
            Assert.That(HomographyUtility.TryApply(result.projectorToBoard, projectorPoint, out Vector2 landedBoardPoint), Is.True);
            Assert.That(Vector2.Distance(landedBoardPoint, desiredBoardPoint), Is.LessThan(1e-4f));
        }

        [Test]
        public void RawToBoard_CellCenter_PreservesHalfCellInset()
        {
            Vector2 first = ProjectionCoordinateMapper.RawToBoardUv(
                Vector2.zero,
                new Vector2Int(100, 100),
                SensorPointMode.CellCenter,
                false,
                false,
                false);
            Vector2 last = ProjectionCoordinateMapper.RawToBoardUv(
                new Vector2(99f, 99f),
                new Vector2Int(100, 100),
                SensorPointMode.CellCenter,
                false,
                false,
                false);

            Assert.That(first.x, Is.EqualTo(0.005f).Within(1e-6f));
            Assert.That(last.x, Is.EqualTo(0.995f).Within(1e-6f));
        }
    }
}
